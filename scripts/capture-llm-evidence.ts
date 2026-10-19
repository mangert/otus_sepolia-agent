import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createSepoliaAgent, type SepoliaAgentIntermediateStep } from '../src/agent/index.js';
import { createSepoliaClient } from '../src/blockchain/index.js';
import { loadConfig } from '../src/config/index.js';
import { configureOutboundProxy } from '../src/network/index.js';

const TRANSACTION_HASH = '0x11f7abbee3f9ff7fad1ddf01de713b8a42c42c5f9e4f22f5353a2a8d28b301da';
const WETH9_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const DEFAULT_DELAY_MS = 70_000;
const MAX_RECORDED_TEXT_CHARACTERS = 12_000;
const JSON_OUTPUT_PATH = 'docs/evidence/tool_calls.json';
const MARKDOWN_OUTPUT_PATH = 'docs/llm_requests.md';

interface EvidenceScenario {
  id: string;
  title: string;
  prompt: string;
  expectedTool: string | null;
}

interface RecordedToolCall {
  toolCallId: string;
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  status: SepoliaAgentIntermediateStep['status'];
  output?: string;
  outputTruncated: boolean;
}

interface EvidenceCaseResult {
  id: string;
  title: string;
  prompt: string;
  expectedTool: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'success' | 'error';
  answer?: string;
  error?: string;
  toolCalls: RecordedToolCall[];
}

interface EvidenceDocument {
  generatedAt: string;
  provider: string;
  model: string;
  network: 'Ethereum Sepolia';
  chainId: 11_155_111;
  cases: EvidenceCaseResult[];
}

const scenarios: readonly EvidenceScenario[] = [
  {
    id: 'capabilities',
    title: 'Обычный ответ без blockchain-инструмента',
    prompt:
      'Without calling any blockchain tools, briefly describe what this Sepolia read-only agent can do.',
    expectedTool: null,
  },
  {
    id: 'latest-block',
    title: 'Актуальный блок и chain ID',
    prompt:
      'What is the current latest block number on Ethereum Sepolia? Include the chain ID and use the appropriate blockchain tool.',
    expectedTool: 'get_chain_info',
  },
  {
    id: 'block',
    title: 'Чтение блока',
    prompt:
      'Read Ethereum Sepolia block 11948701 and summarize its hash, timestamp, gas usage, and transaction count. Use the block tool.',
    expectedTool: 'get_block',
  },
  {
    id: 'transaction',
    title: 'Чтение транзакции',
    prompt: `Read Sepolia transaction ${TRANSACTION_HASH} and report its sender, recipient, value, and block number. Use the transaction tool.`,
    expectedTool: 'get_transaction',
  },
  {
    id: 'receipt',
    title: 'Чтение receipt транзакции',
    prompt: `Call the tool named exactly get_transaction_receipt for Sepolia transaction ${TRANSACTION_HASH}. Report whether it succeeded, its block number, and gas used.`,
    expectedTool: 'get_transaction_receipt',
  },
  {
    id: 'read-contract',
    title: 'Вызов view-функции контракта',
    prompt: `Call the read-only symbol() function on Sepolia contract ${WETH9_ADDRESS} using this ABI: [{"type":"function","name":"symbol","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"string"}]}]. Use the contract read tool and report the returned value and observed block.`,
    expectedTool: 'read_contract',
  },
] as const;

/** Удаляет из отчётного текста URL и похожие на секреты значения. */
const sanitizeRecordedText = (value: string): string =>
  value
    .replace(/https?:\/\/\S+/giu, '[redacted-url]')
    .replace(/\b(api[-_ ]?key|authorization|token|bearer)\b\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/\b(?:gsk|sk)-[A-Za-z0-9_-]{16,}\b/gu, '[redacted-key]')
    .trim();

/** Ограничивает объём сохраняемого результата инструмента. */
const recordToolCall = (step: SepoliaAgentIntermediateStep): RecordedToolCall => {
  const sanitizedOutput = step.output === undefined ? undefined : sanitizeRecordedText(step.output);
  const outputTruncated =
    sanitizedOutput !== undefined && sanitizedOutput.length > MAX_RECORDED_TEXT_CHARACTERS;

  return {
    toolCallId: step.toolCallId,
    toolName: step.toolName,
    input: step.input,
    status: step.status,
    ...(sanitizedOutput === undefined
      ? {}
      : { output: sanitizedOutput.slice(0, MAX_RECORDED_TEXT_CHARACTERS) }),
    outputTruncated,
  };
};

/** Экранирует маркер fenced-блока в записываемом тексте. */
const escapeFence = (value: string): string => value.replace(/~~~/gu, '~ ~ ~');

/** Формирует читаемый Markdown-транскрипт запросов, вызовов инструментов и ответов. */
const renderMarkdown = (document: EvidenceDocument): string => {
  const sections = document.cases.map((result, index) => {
    const toolTrace =
      result.toolCalls.length === 0
        ? 'Инструменты не вызывались.'
        : result.toolCalls
            .map(
              (toolCall, toolIndex) => `#### Tool call ${toolIndex + 1}: \`${toolCall.toolName}\`

- Статус: \`${toolCall.status}\`
- ID: \`${toolCall.toolCallId}\`
- Результат усечён: \`${toolCall.outputTruncated.toString()}\`

Аргументы:

~~~json
${escapeFence(JSON.stringify(toolCall.input, null, 2))}
~~~

Результат:

~~~text
${escapeFence(toolCall.output ?? 'No output recorded.')}
~~~`,
            )
            .join('\n\n');

    return `## ${index + 1}. ${result.title}

- ID: \`${result.id}\`
- Статус сценария: \`${result.status}\`
- Ожидаемый инструмент: ${result.expectedTool === null ? 'не ожидается' : `\`${result.expectedTool}\``}
- Начало: \`${result.startedAt}\`
- Завершение: \`${result.completedAt}\`
- Длительность: \`${result.durationMs} ms\`

### Prompt

~~~text
${escapeFence(result.prompt)}
~~~

### Tool trace

${toolTrace}

### Final answer

~~~text
${escapeFence(result.answer ?? result.error ?? 'No final answer recorded.')}
~~~`;
  });

  return `# Примеры запросов к LLM и вызовов инструментов

Этот файл сгенерирован реальным запуском Sepolia-агента. Он содержит шесть
пользовательских промптов, финальные ответы и структурированные
\`intermediateSteps\` LangChain. Журнал фиксирует только вызовы инструментов и
не содержит скрытые рассуждения модели, API-ключи или RPC URL.

- Сформирован: \`${document.generatedAt}\`
- LLM-провайдер: \`${document.provider}\`
- Модель: \`${document.model}\`
- Сеть: \`${document.network}\`
- Chain ID: \`${document.chainId}\`
- Машиночитаемый журнал: [evidence/tool_calls.json](evidence/tool_calls.json)

${sections.join('\n\n')}
`;
};

/** Записывает текущие результаты одновременно в JSON и Markdown. */
const writeEvidence = async (document: EvidenceDocument): Promise<void> => {
  const jsonPath = resolve(JSON_OUTPUT_PATH);
  const markdownPath = resolve(MARKDOWN_OUTPUT_PATH);
  await mkdir(dirname(jsonPath), { recursive: true });
  await Promise.all([
    writeFile(jsonPath, JSON.stringify(document, null, 2) + '\n', 'utf8'),
    writeFile(markdownPath, renderMarkdown(document), 'utf8'),
  ]);
};

/** Читает ранее записанные результаты для точечного повторного запуска сценария. */
const readExistingEvidence = async (): Promise<EvidenceDocument | undefined> => {
  try {
    return JSON.parse(await readFile(resolve(JSON_OUTPUT_PATH), 'utf8')) as EvidenceDocument;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
};

/** Возвращает выбранные через --case сценарии или полный набор. */
const selectScenarios = (): readonly EvidenceScenario[] => {
  const selectedIds = process.argv
    .slice(2)
    .filter((argument) => argument.startsWith('--case='))
    .map((argument) => argument.slice('--case='.length));

  if (selectedIds.length === 0) {
    return scenarios;
  }

  const selected = scenarios.filter(({ id }) => selectedIds.includes(id));
  const unknownIds = selectedIds.filter((id) => !scenarios.some((scenario) => scenario.id === id));

  if (unknownIds.length > 0) {
    throw new Error(`Unknown evidence case: ${unknownIds.join(', ')}`);
  }

  return selected;
};

/** Ожидает следующего окна rate limit без параллельных LLM-запросов. */
const waitForNextRequest = async (delayMs: number): Promise<void> =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, delayMs);
  });

/** Выполняет live-сценарии и сохраняет проверяемые доказательства tool calls. */
const run = async (): Promise<void> => {
  const config = loadConfig();
  const restoreProxy = configureOutboundProxy(config.network);
  const client = createSepoliaClient(config.blockchain);
  const agent = createSepoliaAgent({ llm: config.llm, client });
  const selectedScenarios = selectScenarios();
  const configuredDelay = Number.parseInt(process.env['LLM_EVIDENCE_DELAY_MS'] ?? '', 10);
  const delayMs = Number.isFinite(configuredDelay)
    ? Math.max(0, configuredDelay)
    : DEFAULT_DELAY_MS;
  const existingEvidence = await readExistingEvidence();
  const resultsById = new Map(existingEvidence?.cases.map((result) => [result.id, result]) ?? []);
  let hasFailure = false;

  try {
    for (const [index, scenario] of selectedScenarios.entries()) {
      const startedAt = new Date();
      process.stdout.write(
        `[${index + 1}/${selectedScenarios.length}] ${scenario.id}: sending request\n`,
      );

      let result: EvidenceCaseResult;

      try {
        const agentResult = await agent.invoke(scenario.prompt);
        const toolCalls = agentResult.intermediateSteps.map(recordToolCall);
        const actualToolNames = toolCalls.map(({ toolName }) => toolName);
        const hasExpectedTool =
          scenario.expectedTool === null
            ? toolCalls.length === 0
            : actualToolNames.includes(scenario.expectedTool);

        if (!hasExpectedTool) {
          throw new Error(
            `Expected ${scenario.expectedTool ?? 'no tool call'}, received: ${actualToolNames.join(', ') || 'none'}.`,
          );
        }

        const completedAt = new Date();
        result = {
          ...scenario,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: completedAt.getTime() - startedAt.getTime(),
          status: 'success',
          answer: sanitizeRecordedText(agentResult.answer),
          toolCalls,
        };
        process.stdout.write(
          `[${index + 1}/${selectedScenarios.length}] ${scenario.id}: success (${actualToolNames.join(', ') || 'no tool'})\n`,
        );
      } catch (error: unknown) {
        hasFailure = true;
        const completedAt = new Date();
        const message =
          error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
        result = {
          ...scenario,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: completedAt.getTime() - startedAt.getTime(),
          status: 'error',
          error: sanitizeRecordedText(message),
          toolCalls: [],
        };
        process.stderr.write(
          `[${index + 1}/${selectedScenarios.length}] ${scenario.id}: ${result.error}\n`,
        );
      }

      resultsById.set(scenario.id, result);
      const orderedResults = scenarios.flatMap((item) => {
        const storedResult = resultsById.get(item.id);
        return storedResult === undefined ? [] : [storedResult];
      });
      await writeEvidence({
        generatedAt: new Date().toISOString(),
        provider: config.llm.provider,
        model: config.llm.model,
        network: 'Ethereum Sepolia',
        chainId: config.blockchain.chainId,
        cases: orderedResults,
      });

      if (index < selectedScenarios.length - 1 && delayMs > 0) {
        process.stdout.write(
          `Waiting ${delayMs.toString(10)} ms for the next rate-limit window.\n`,
        );
        await waitForNextRequest(delayMs);
      }
    }
  } finally {
    restoreProxy();
  }

  if (hasFailure) {
    process.exitCode = 1;
  }
};

await run();
