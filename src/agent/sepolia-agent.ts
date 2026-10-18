import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent, createMiddleware, dynamicSystemPromptMiddleware } from 'langchain';
import { z } from 'zod';

import type { AppConfig } from '../config/index.js';
import {
  createSepoliaTools,
  getErc20Balance,
  getNativeBalance,
  type Erc20BalanceResult,
  type SepoliaToolsClient,
} from '../tools/index.js';
import { validateEthereumAddress } from '../validation/index.js';
import { retryRateLimitedOperation } from './rate-limit-retry.js';
import { createSepoliaAgentSystemPrompt, SEPOLIA_AGENT_SYSTEM_PROMPT } from './system-prompt.js';

export const DEFAULT_AGENT_MAX_ITERATIONS = 8;
export const MAX_AGENT_MAX_ITERATIONS = 20;
export const MAX_AGENT_INPUT_CHARACTERS = 10_000;

const LOCAL_PROXY_API_KEY_PLACEHOLDER = 'not-required-by-opencode-llm-proxy';
const MAX_TOOL_ERROR_MESSAGE_CHARACTERS = 1_000;
const MAX_AGENT_HISTORY_MESSAGES = 12;
const ETHEREUM_ADDRESS_IN_TEXT_PATTERN = /(?<![0-9a-f])0x[0-9a-f]{40}(?![0-9a-f])/giu;
const ADDRESS_ARGUMENT_TOOL_NAMES = new Set([
  'get_native_balance',
  'get_contract_code',
  'get_logs',
  'read_contract',
]);
const ERC20_ADDRESS_ARGUMENT_NAMES = ['tokenAddress', 'ownerAddress'] as const;
const COMMON_TOKEN_SYMBOL_PATTERN = /\b(?:USDT|USDC|DAI|WETH|WBTC|LINK|UNI)\b/iu;
const TOKEN_WORD_PATTERN = /(?:токен|token|erc-?20)/iu;
const TOKEN_CONTRACT_ADDRESS_PATTERN =
  /(?:контракт(?:а|ом|у|е)?|token\s+contract|contract(?:\s+address)?)(?:\s+с)?(?:\s+адрес(?:ом|а|е)?)?[\s:,-]{0,12}(0x[0-9a-f]{40})/iu;
const TOKEN_OWNER_ADDRESS_PATTERN =
  /(?:кошел(?:[её]к|ьк)(?:а|е|ом|у)?|wallet|owner|holder|account)[\s:,-]{0,20}(0x[0-9a-f]{40})/iu;
const SAME_OWNER_REFERENCE_PATTERN =
  /(?:том\s+же\s+кошельке|того\s+же\s+кошелька|same\s+(?:wallet|address|account)|previous\s+(?:wallet|address|account))/iu;
const agentInputSchema = z.string().trim().min(1).max(MAX_AGENT_INPUT_CHARACTERS);
const conversationHistorySchema = z
  .array(
    z.strictObject({
      role: z.enum(['user', 'assistant']),
      content: agentInputSchema,
    }),
  )
  .max(MAX_AGENT_HISTORY_MESSAGES);
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

export interface CreateSepoliaChatModelOptions {
  disableToolValidation?: boolean;
}

export interface SepoliaAgentInvokeOptions {
  signal?: AbortSignal;
  history?: readonly SepoliaConversationMessage[];
}

export interface SepoliaConversationMessage {
  role: 'user' | 'assistant';
  content: string;
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

/** Извлекает единственный корректный Ethereum-адрес из текста. */
const extractSingleEthereumAddress = (value: string): string | undefined => {
  const matches = value.match(ETHEREUM_ADDRESS_IN_TEXT_PATTERN) ?? [];

  if (matches.length !== 1) {
    return undefined;
  }

  try {
    return validateEthereumAddress(matches[0]);
  } catch {
    return undefined;
  }
};

/** Удаляет случайные обрамляющие символы из адресного аргумента тула. */
const repairToolCallArguments = (
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> => {
  if (toolName === 'get_erc20_balance') {
    return ERC20_ADDRESS_ARGUMENT_NAMES.reduce<Record<string, unknown>>((repairedArgs, key) => {
      const value = repairedArgs[key];
      if (typeof value !== 'string') return repairedArgs;

      const address = extractSingleEthereumAddress(value);
      return address === undefined || address === value
        ? repairedArgs
        : { ...repairedArgs, [key]: address };
    }, args);
  }

  if (!ADDRESS_ARGUMENT_TOOL_NAMES.has(toolName) || typeof args['address'] !== 'string') {
    return args;
  }

  const address = extractSingleEthereumAddress(args['address']);

  if (address === undefined || address === args['address']) {
    return args;
  }

  return { ...args, address };
};

/** Формирует локализованный ответ для прямого чтения нативного баланса. */
const formatNativeBalanceAnswer = (
  input: string,
  result: Awaited<ReturnType<typeof getNativeBalance>>,
): string => {
  if (/\p{Script=Cyrillic}/u.test(input)) {
    return `Баланс адреса ${result.address} в Sepolia: ${result.balanceEth} ETH (${result.balanceWei} wei). Данные получены на блоке ${result.blockNumber}.`;
  }

  return `Sepolia balance for ${result.address}: ${result.balanceEth} ETH (${result.balanceWei} wei), observed at block ${result.blockNumber}.`;
};

/** Извлекает и валидирует все Ethereum-адреса из текста. */
const extractEthereumAddresses = (value: string): string[] =>
  (value.match(ETHEREUM_ADDRESS_IN_TEXT_PATTERN) ?? []).flatMap((address) => {
    try {
      return [validateEthereumAddress(address)];
    } catch {
      return [];
    }
  });

/** Исправляет визуально похожую кириллическую С только для распознавания тикера. */
const normalizeTokenTickerText = (input: string): string => input.replace(/[Сс]/gu, 'C');

/** Определяет, что пользователь спрашивает именно ERC-20 баланс. */
const isTokenBalanceRequest = (input: string): boolean =>
  TOKEN_WORD_PATTERN.test(input) ||
  COMMON_TOKEN_SYMBOL_PATTERN.test(normalizeTokenTickerText(input));

/** Находит последний адрес из пользовательской истории диалога. */
const findLatestHistoricalAddress = (
  history: readonly SepoliaConversationMessage[],
  excludedAddress?: string,
): string | undefined => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== 'user') continue;

    const address = extractEthereumAddresses(message.content).find(
      (candidate) => candidate !== excludedAddress,
    );
    if (address !== undefined) return address;
  }

  return undefined;
};

/** Извлекает адрес, явно подписанный как контракт токена или владелец. */
const extractLabeledAddress = (input: string, pattern: RegExp): string | undefined => {
  const address = pattern.exec(input)?.[1];
  if (address === undefined) return undefined;

  try {
    return validateEthereumAddress(address);
  } catch {
    return undefined;
  }
};

interface Erc20AddressResolution {
  tokenAddress?: string;
  ownerAddress?: string;
}

/** Разделяет адрес контракта токена и адрес владельца без догадок по тикеру. */
const resolveErc20Addresses = (
  input: string,
  history: readonly SepoliaConversationMessage[],
): Erc20AddressResolution => {
  const currentAddresses = extractEthereumAddresses(input);
  const labeledTokenAddress = extractLabeledAddress(input, TOKEN_CONTRACT_ADDRESS_PATTERN);
  const labeledOwnerAddress = extractLabeledAddress(input, TOKEN_OWNER_ADDRESS_PATTERN);

  if (labeledTokenAddress !== undefined) {
    const ownerAddress =
      labeledOwnerAddress ??
      currentAddresses.find((address) => address !== labeledTokenAddress) ??
      (SAME_OWNER_REFERENCE_PATTERN.test(input)
        ? findLatestHistoricalAddress(history, labeledTokenAddress)
        : undefined);

    return {
      tokenAddress: labeledTokenAddress,
      ...(ownerAddress === undefined ? {} : { ownerAddress }),
    };
  }

  if (labeledOwnerAddress !== undefined) {
    const tokenAddress = currentAddresses.find((address) => address !== labeledOwnerAddress);
    return {
      ...(tokenAddress === undefined ? {} : { tokenAddress }),
      ownerAddress: labeledOwnerAddress,
    };
  }

  const ownerAddress = currentAddresses.length === 1 ? currentAddresses[0] : undefined;
  return ownerAddress === undefined ? {} : { ownerAddress };
};

/** Формирует уточнение только для отсутствующего адреса ERC-20 запроса. */
const createErc20AddressClarification = (
  input: string,
  resolution: Erc20AddressResolution,
): SepoliaAgentResult => {
  const russian = /\p{Script=Cyrillic}/u.test(input);
  const answer =
    resolution.tokenAddress === undefined
      ? russian
        ? 'Укажите адрес контракта ERC-20 токена в сети Sepolia. Стандартный ABI для balanceOf(address), decimals() и symbol() уже встроен.'
        : 'Provide the ERC-20 token contract address on Sepolia. The standard balanceOf(address), decimals(), and symbol() ABI is built in.'
      : russian
        ? 'Адрес контракта токена получен. Укажите адрес кошелька, баланс которого нужно проверить.'
        : 'The token contract address is available. Provide the wallet address whose balance should be checked.';

  return { answer, intermediateSteps: [] };
};

/** Формирует локализованный ответ по результату ERC-20 чтения. */
const formatErc20BalanceAnswer = (input: string, result: Erc20BalanceResult): string => {
  const warnings = result.metadataWarnings?.join(' ') ?? '';
  const tokenLabel = result.symbol ?? 'ERC-20 token';

  if (/\p{Script=Cyrillic}/u.test(input)) {
    const balance =
      result.balanceFormatted === undefined
        ? `${result.balanceRaw} минимальных единиц ${tokenLabel}`
        : `${result.balanceFormatted} ${tokenLabel} (${result.balanceRaw} минимальных единиц, decimals: ${result.decimals})`;
    return `Баланс адреса ${result.ownerAddress}: ${balance}. Контракт токена: ${result.tokenAddress}. Данные получены на блоке ${result.blockNumber}.${warnings.length === 0 ? '' : ` Предупреждение: ${warnings}`}`;
  }

  const balance =
    result.balanceFormatted === undefined
      ? `${result.balanceRaw} smallest units of ${tokenLabel}`
      : `${result.balanceFormatted} ${tokenLabel} (${result.balanceRaw} smallest units, decimals: ${result.decimals})`;
  return `Balance of ${result.ownerAddress}: ${balance}. Token contract: ${result.tokenAddress}. Observed at block ${result.blockNumber}.${warnings.length === 0 ? '' : ` Warning: ${warnings}`}`;
};

/** Выполняет очевидный запрос нативного баланса без обращения к LLM. */
const tryExecuteDeterministicRequest = async (
  client: SepoliaToolsClient,
  input: string,
  history: readonly SepoliaConversationMessage[],
): Promise<SepoliaAgentResult | undefined> => {
  const normalizedInput = input.toLowerCase();
  const hasBalanceIntent =
    normalizedInput.includes('баланс') || /\bbalance\b/u.test(normalizedInput);

  if (!hasBalanceIntent) {
    return undefined;
  }

  if (isTokenBalanceRequest(input)) {
    const resolution = resolveErc20Addresses(input, history);

    if (resolution.tokenAddress === undefined || resolution.ownerAddress === undefined) {
      return createErc20AddressClarification(input, resolution);
    }

    const result = await getErc20Balance(client, {
      tokenAddress: resolution.tokenAddress,
      ownerAddress: resolution.ownerAddress,
    });

    return {
      answer: formatErc20BalanceAnswer(input, result),
      intermediateSteps: [
        {
          toolCallId: 'deterministic-get-erc20-balance',
          toolName: 'get_erc20_balance',
          input: {
            tokenAddress: resolution.tokenAddress,
            ownerAddress: resolution.ownerAddress,
          },
          status: 'success',
          output: JSON.stringify(result),
        },
      ],
    };
  }

  if (normalizedInput.includes('блок') || /\bblock\b/u.test(normalizedInput)) {
    return undefined;
  }

  const address = extractSingleEthereumAddress(input);

  if (address === undefined) {
    return undefined;
  }

  const result = await getNativeBalance(client, { address });

  return {
    answer: formatNativeBalanceAnswer(input, result),
    intermediateSteps: [
      {
        toolCallId: 'deterministic-get-native-balance',
        toolName: 'get_native_balance',
        input: { address },
        status: 'success',
        output: JSON.stringify(result),
      },
    ],
  };
};

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
      const repairedArguments = repairToolCallArguments(
        request.toolCall.name,
        request.toolCall.args,
      );
      const repairedRequest =
        repairedArguments === request.toolCall.args
          ? request
          : {
              ...request,
              toolCall: {
                ...request.toolCall,
                args: repairedArguments,
              },
            };

      return await handler(repairedRequest);
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

/** Создаёт middleware повторов модели с учётом Retry-After. */
const createRateLimitRetryMiddleware = (maxRetries: number) =>
  createMiddleware({
    name: 'SepoliaModelRateLimitRetry',
    wrapModelCall: async (request, handler) =>
      retryRateLimitedOperation(() => handler(request), { maxRetries }),
  });

const runtimeDateContextMiddleware = dynamicSystemPromptMiddleware(() =>
  createSepoliaAgentSystemPrompt(),
);

/** Создаёт ChatOpenAI для настроенного OpenAI-compatible провайдера. */
export const createSepoliaChatModel = (
  config: AppConfig['llm'],
  options: CreateSepoliaChatModelOptions = {},
): ChatOpenAI =>
  new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey ?? LOCAL_PROXY_API_KEY_PLACEHOLDER,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
    useResponsesApi: false,
    ...(config.provider === 'groq'
      ? {
          modelKwargs: {
            reasoning_format: 'hidden',
            reasoning_effort: 'none',
            ...(options.disableToolValidation === true ? { disable_tool_validation: true } : {}),
          },
        }
      : {}),
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

/** Удаляет случайно просочившееся рассуждение reasoning-модели. */
const sanitizeModelAnswer = (answer: string): string => {
  const trimmedAnswer = answer.trim();
  const closingThinkTagIndex = trimmedAnswer.lastIndexOf('</think>');

  if (closingThinkTagIndex >= 0) {
    return trimmedAnswer.slice(closingThinkTagIndex + '</think>'.length).trim();
  }

  return trimmedAnswer.replace(/<think>[\s\S]*?<\/think>/giu, '').trim();
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

  const answer = sanitizeModelAnswer(finalMessage.text);

  if (answer.length === 0) {
    throw new SepoliaAgentOutputError(
      'Agent completed without a final answer after reasoning removal.',
    );
  }

  return {
    answer,
    intermediateSteps: collectIntermediateSteps(messages),
  };
};

/** Создаёт ограниченного read-only LangChain-агента для Sepolia. */
export const createSepoliaAgent = (options: CreateSepoliaAgentOptions): SepoliaAgent => {
  const { maxIterations } = agentOptionsSchema.parse({
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
  });
  const recursionLimit = toRecursionLimit(maxIterations);
  const model =
    options.model ??
    createSepoliaChatModel({ ...options.llm, maxRetries: 0 }, { disableToolValidation: true });
  const tools = createSepoliaTools(options.client);
  const graphAgent = createAgent({
    model,
    tools: [...tools],
    systemPrompt: SEPOLIA_AGENT_SYSTEM_PROMPT,
    middleware: [
      runtimeDateContextMiddleware,
      createRateLimitRetryMiddleware(options.llm.maxRetries),
      toolErrorMiddleware,
    ],
  });

  return {
    maxIterations,
    recursionLimit,
    toolNames: tools.map(({ name }) => name),
    invoke: async (input, invokeOptions = {}) => {
      const validatedInput = agentInputSchema.parse(input);
      const validatedHistory = conversationHistorySchema.parse(invokeOptions.history ?? []);
      let state: Awaited<ReturnType<typeof graphAgent.invoke>>;

      try {
        const deterministicResult = await tryExecuteDeterministicRequest(
          options.client,
          validatedInput,
          validatedHistory,
        );

        if (deterministicResult !== undefined) {
          return deterministicResult;
        }

        state = await graphAgent.invoke(
          {
            messages: [
              ...validatedHistory.map(({ role, content }) =>
                role === 'user' ? new HumanMessage(content) : new AIMessage(content),
              ),
              new HumanMessage(validatedInput),
            ],
          },
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
