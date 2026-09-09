import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent, createMiddleware } from 'langchain';
import { z } from 'zod';

import type { AppConfig } from '../config/index.js';
import { createSepoliaTools, type SepoliaToolsClient } from '../tools/index.js';
import { SEPOLIA_AGENT_SYSTEM_PROMPT } from './system-prompt.js';

export const DEFAULT_AGENT_MAX_ITERATIONS = 8;
export const MAX_AGENT_MAX_ITERATIONS = 20;
export const MAX_AGENT_INPUT_CHARACTERS = 10_000;

const LOCAL_PROXY_API_KEY_PLACEHOLDER = 'not-required-by-opencode-llm-proxy';
const MAX_TOOL_ERROR_MESSAGE_CHARACTERS = 1_000;
const agentInputSchema = z.string().trim().min(1).max(MAX_AGENT_INPUT_CHARACTERS);
const agentOptionsSchema = z.strictObject({
  maxIterations: z
    .number()
    .int()
    .min(1)
    .max(MAX_AGENT_MAX_ITERATIONS)
    .default(DEFAULT_AGENT_MAX_ITERATIONS),
});

export interface CreateSepoliaAgentOptions {
  llm: AppConfig['llm'];
  client: SepoliaToolsClient;
  model?: BaseChatModel;
  maxIterations?: number;
}

export interface SepoliaAgentInvokeOptions {
  signal?: AbortSignal;
}

export interface SepoliaAgentIntermediateStep {
  toolCallId: string;
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  status: 'requested' | 'success' | 'error';
  output?: string;
}

export interface SepoliaAgentResult {
  answer: string;
  intermediateSteps: SepoliaAgentIntermediateStep[];
}

export interface SepoliaAgent {
  readonly maxIterations: number;
  readonly recursionLimit: number;
  readonly toolNames: readonly string[];
  invoke(input: string, options?: SepoliaAgentInvokeOptions): Promise<SepoliaAgentResult>;
}

export class SepoliaAgentExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SepoliaAgentExecutionError';
  }
}

export class SepoliaAgentOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SepoliaAgentOutputError';
  }
}

/** Удаляет из технической причины URL и похожие на секреты значения. */
const sanitizeToolErrorMessage = (message: string): string =>
  message
    .replace(/https?:\/\/\S+/giu, '[redacted-url]')
    .replace(/\b(api[-_ ]?key|authorization|token|bearer)\b\s*[:=]?\s*\S+/giu, '$1 [redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_TOOL_ERROR_MESSAGE_CHARACTERS);

/** Формирует безопасную техническую причину ошибки тула. */
const formatToolError = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'Unknown tool error.';
  }

  const primaryError = error.name + ': ' + sanitizeToolErrorMessage(error.message);

  if (!(error.cause instanceof Error)) {
    return primaryError;
  }

  return (
    primaryError +
    ' Cause: ' +
    error.cause.name +
    ': ' +
    sanitizeToolErrorMessage(error.cause.message)
  );
};

const toolErrorMiddleware = createMiddleware({
  name: 'SepoliaToolErrorHandling',
  wrapToolCall: async (request, handler) => {
    try {
      return await handler(request);
    } catch (error: unknown) {
      return new ToolMessage({
        content: formatToolError(error),
        name: request.toolCall.name,
        status: 'error',
        tool_call_id: request.toolCall.id ?? 'unknown-tool-call',
      });
    }
  },
});
/** Создаёт ChatOpenAI для OpenAI-compatible opencode-llm-proxy. */
export const createSepoliaChatModel = (config: AppConfig['llm']): ChatOpenAI =>
  new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey ?? LOCAL_PROXY_API_KEY_PLACEHOLDER,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
    useResponsesApi: false,
    configuration: {
      baseURL: config.baseUrl,
    },
  });

/** Переводит лимит ReAct-итераций в лимит шагов LangGraph. */
const toRecursionLimit = (maxIterations: number): number => maxIterations * 2 + 1;

/** Собирает аудируемые вызовы тулов из истории сообщений агента. */
const collectIntermediateSteps = (
  messages: readonly BaseMessage[],
): SepoliaAgentIntermediateStep[] => {
  const steps: SepoliaAgentIntermediateStep[] = [];
  const stepIndexByCallId = new Map<string, number>();
  let generatedCallId = 0;

  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const toolCall of message.tool_calls ?? []) {
        const toolCallId = toolCall.id ?? 'generated-tool-call-' + (generatedCallId++).toString(10);
        stepIndexByCallId.set(toolCallId, steps.length);
        steps.push({
          toolCallId,
          toolName: toolCall.name,
          input: toolCall.args,
          status: 'requested',
        });
      }
    }

    if (ToolMessage.isInstance(message)) {
      const status = message.status ?? 'success';
      const stepIndex = stepIndexByCallId.get(message.tool_call_id);

      if (stepIndex === undefined) {
        steps.push({
          toolCallId: message.tool_call_id,
          toolName: message.name ?? 'unknown_tool',
          input: {},
          status,
          output: message.text,
        });
        continue;
      }

      const step = steps[stepIndex];

      if (step !== undefined) {
        steps[stepIndex] = {
          ...step,
          status,
          output: message.text,
        };
      }
    }
  }

  return steps;
};

/** Извлекает финальный текст и промежуточные результаты из state агента. */
const createAgentResult = (messages: readonly BaseMessage[]): SepoliaAgentResult => {
  const finalMessage = messages.findLast(
    (message) =>
      AIMessage.isInstance(message) &&
      (message.tool_calls?.length ?? 0) === 0 &&
      message.text.trim().length > 0,
  );

  if (finalMessage === undefined) {
    throw new SepoliaAgentOutputError('Agent completed without a final text response.');
  }

  return {
    answer: finalMessage.text.trim(),
    intermediateSteps: collectIntermediateSteps(messages),
  };
};

/** Создаёт ограниченного read-only LangChain-агента для Sepolia. */
export const createSepoliaAgent = (options: CreateSepoliaAgentOptions): SepoliaAgent => {
  const { maxIterations } = agentOptionsSchema.parse({
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
  });
  const recursionLimit = toRecursionLimit(maxIterations);
  const model = options.model ?? createSepoliaChatModel(options.llm);
  const tools = createSepoliaTools(options.client);
  const graphAgent = createAgent({
    model,
    tools: [...tools],
    systemPrompt: SEPOLIA_AGENT_SYSTEM_PROMPT,
    middleware: [toolErrorMiddleware],
  });

  return {
    maxIterations,
    recursionLimit,
    toolNames: tools.map(({ name }) => name),
    invoke: async (input, invokeOptions = {}) => {
      const validatedInput = agentInputSchema.parse(input);
      let state: Awaited<ReturnType<typeof graphAgent.invoke>>;

      try {
        state = await graphAgent.invoke(
          { messages: [new HumanMessage(validatedInput)] },
          {
            recursionLimit,
            ...(invokeOptions.signal === undefined ? {} : { signal: invokeOptions.signal }),
          },
        );
      } catch (error: unknown) {
        throw new SepoliaAgentExecutionError('Unable to complete the Sepolia agent request.', {
          cause: error,
        });
      }

      return createAgentResult(state.messages);
    },
  };
};
