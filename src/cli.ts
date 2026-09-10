import { once } from 'node:events';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { ZodError } from 'zod';

import {
  SepoliaAgentExecutionError,
  SepoliaAgentOutputError,
  createSepoliaAgent,
  type SepoliaAgent,
} from './agent/index.js';
import { createSepoliaClient } from './blockchain/index.js';
import { ConfigurationError, loadConfig } from './config/index.js';

export const CLI_EXIT_SUCCESS = 0;
export const CLI_EXIT_FAILURE = 1;
export const CLI_EXIT_USAGE = 2;

const CLI_PROMPT = 'sepolia> ';
const CLI_INTRO = 'Sepolia read-only agent. Type /exit to quit.';
const CLI_GOODBYE = 'Goodbye.';
const MAX_CLI_ERROR_CHARACTERS = 1_000;
const EXIT_COMMANDS = new Set(['/exit', 'exit', 'quit']);
const CLI_USAGE = `Usage:
  npm run dev -- "<question>"       Run one request
  npm run dev -- --interactive      Start interactive mode
  npm run dev                       Start interactive mode
  npm run dev -- --help             Show this help

This agent reads public Ethereum Sepolia data only. It cannot sign or send transactions.
`;

type CliMode = { kind: 'help' } | { kind: 'interactive' } | { kind: 'single'; query: string };

type QueryOutcome = 'success' | 'failure' | 'cancelled';

export interface RunCliOptions {
  args?: readonly string[];
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  agentFactory?: () => SepoliaAgent;
  signal?: AbortSignal;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** Создаёт агента из файловой конфигурации и переменных окружения. */
const createConfiguredAgent = (): SepoliaAgent => {
  const config = loadConfig();
  const client = createSepoliaClient(config.blockchain);

  return createSepoliaAgent({
    llm: config.llm,
    client,
  });
};

/** Разбирает аргументы командной строки в один из поддерживаемых режимов. */
export const parseCliArgs = (args: readonly string[]): CliMode => {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;

  if (normalizedArgs.length === 0) {
    return { kind: 'interactive' };
  }

  const firstArgument = normalizedArgs[0];

  if (firstArgument === '--help' || firstArgument === '-h') {
    if (normalizedArgs.length !== 1) {
      throw new CliUsageError('The help option cannot be combined with a question.');
    }

    return { kind: 'help' };
  }

  if (firstArgument === '--interactive' || firstArgument === '-i') {
    if (normalizedArgs.length !== 1) {
      throw new CliUsageError('Interactive mode does not accept a question argument.');
    }

    return { kind: 'interactive' };
  }

  if (firstArgument?.startsWith('-')) {
    throw new CliUsageError('Unknown option: ' + firstArgument);
  }

  const query = normalizedArgs.join(' ').trim();

  if (query.length === 0) {
    return { kind: 'interactive' };
  }

  return { kind: 'single', query };
};

/** Удаляет из CLI-ошибки URL и похожие на секреты значения. */
const sanitizeCliMessage = (message: string): string =>
  message
    .replace(/https?:\/\/\S+/giu, '[redacted-url]')
    .replace(/\b(api[-_ ]?key|authorization|token|bearer)\b\s*[:=]?\s*\S+/giu, '$1 [redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_CLI_ERROR_CHARACTERS);

/** Определяет отмену операции в цепочке причин. */
const isAbortError = (error: unknown): boolean => {
  let currentError = error;

  for (let depth = 0; depth < 4; depth += 1) {
    if (!(currentError instanceof Error)) {
      return false;
    }

    if (currentError.name === 'AbortError') {
      return true;
    }

    currentError = currentError.cause;
  }

  return false;
};

/** Проверяет, поддерживает ли поток интерактивный терминал. */
const isTerminalStream = (stream: object): boolean => 'isTTY' in stream && stream.isTTY === true;

/** Формирует понятное сообщение без stack trace и секретов. */
export const formatCliError = (error: unknown): string => {
  if (error instanceof ConfigurationError) {
    return 'Configuration error: ' + sanitizeCliMessage(error.message);
  }

  if (error instanceof ZodError) {
    const issues = error.issues
      .map((issue) => (issue.path.join('.') || 'input') + ': ' + issue.message)
      .join('; ');

    return 'Invalid input: ' + sanitizeCliMessage(issues);
  }

  if (error instanceof SepoliaAgentExecutionError) {
    const cause = error.cause;
    const causeMessage =
      cause instanceof Error
        ? ' Cause: ' + cause.name + ': ' + sanitizeCliMessage(cause.message)
        : '';

    return 'Agent error: ' + sanitizeCliMessage(error.message) + causeMessage;
  }

  if (error instanceof SepoliaAgentOutputError) {
    return 'Agent response error: ' + sanitizeCliMessage(error.message);
  }

  if (error instanceof Error) {
    return error.name + ': ' + sanitizeCliMessage(error.message);
  }

  return 'Unknown error.';
};

/** Выполняет один запрос и печатает только пользовательский результат. */
const executeQuery = async (
  agent: SepoliaAgent,
  query: string,
  output: NodeJS.WritableStream,
  errorOutput: NodeJS.WritableStream,
  signal?: AbortSignal,
): Promise<QueryOutcome> => {
  try {
    const result = await agent.invoke(query, signal === undefined ? {} : { signal });
    output.write(result.answer + '\n');
    return 'success';
  } catch (error: unknown) {
    if (isAbortError(error) || signal?.aborted === true) {
      return 'cancelled';
    }

    errorOutput.write(formatCliError(error) + '\n');
    return 'failure';
  }
};

/** Запускает последовательную интерактивную сессию до команды выхода или EOF. */
const runInteractiveMode = async (
  agent: SepoliaAgent,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  errorOutput: NodeJS.WritableStream,
  signal?: AbortSignal,
): Promise<number> => {
  const terminal = isTerminalStream(input) && isTerminalStream(output);
  const readline = createInterface({
    input,
    output,
    terminal,
    ...(signal === undefined ? {} : { signal }),
  });

  output.write(CLI_INTRO + '\n');

  if (terminal) {
    readline.setPrompt(CLI_PROMPT);
    readline.prompt();
  }

  try {
    for await (const line of readline) {
      const query = line.trim();

      if (EXIT_COMMANDS.has(query.toLowerCase())) {
        break;
      }

      if (query.length > 0) {
        await executeQuery(agent, query, output, errorOutput, signal);
      }

      if (signal?.aborted === true) {
        break;
      }

      if (terminal) {
        readline.prompt();
      }
    }
  } finally {
    readline.close();
  }

  output.write(CLI_GOODBYE + '\n');
  return CLI_EXIT_SUCCESS;
};

/** Запускает CLI с production-зависимостями или тестовыми подстановками. */
export const runCli = async (options: RunCliOptions = {}): Promise<number> => {
  const args = options.args ?? process.argv.slice(2);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  let mode: CliMode;

  try {
    mode = parseCliArgs(args);
  } catch (error: unknown) {
    errorOutput.write(formatCliError(error) + '\n');
    errorOutput.write(CLI_USAGE);
    return CLI_EXIT_USAGE;
  }

  if (mode.kind === 'help') {
    output.write(CLI_USAGE);
    return CLI_EXIT_SUCCESS;
  }

  let agent: SepoliaAgent;

  try {
    agent = (options.agentFactory ?? createConfiguredAgent)();
  } catch (error: unknown) {
    errorOutput.write(formatCliError(error) + '\n');
    return CLI_EXIT_FAILURE;
  }

  if (mode.kind === 'single') {
    const outcome = await executeQuery(agent, mode.query, output, errorOutput, options.signal);
    return outcome === 'failure' ? CLI_EXIT_FAILURE : CLI_EXIT_SUCCESS;
  }

  try {
    return await runInteractiveMode(agent, input, output, errorOutput, options.signal);
  } catch (error: unknown) {
    if (isAbortError(error) || options.signal?.aborted === true) {
      return CLI_EXIT_SUCCESS;
    }

    errorOutput.write(formatCliError(error) + '\n');
    return CLI_EXIT_FAILURE;
  }
};

/** Проверяет, запущен ли модуль как CLI entrypoint. */
const isDirectExecution = (): boolean => {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;
};

/** Подключает process-сигналы к AbortSignal и возвращает код завершения. */
const runMain = async (): Promise<number> => {
  const abortController = new AbortController();
  let signalExitCode: number | undefined;
  const handleSigint = () => {
    signalExitCode ??= 130;
    abortController.abort();
  };
  const handleSigterm = () => {
    signalExitCode ??= 143;
    abortController.abort();
  };

  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);

  try {
    const exitCode = await runCli({ signal: abortController.signal });
    return signalExitCode ?? exitCode;
  } finally {
    process.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGTERM', handleSigterm);
  }
};

/** Дожидается отправки буферизованного вывода перед завершением процесса. */
const flushProcessOutput = async (): Promise<void> => {
  const pendingDrains = [process.stdout, process.stderr]
    .filter((stream) => stream.writableNeedDrain)
    .map((stream) => once(stream, 'drain'));

  await Promise.all(pendingDrains);
};

if (isDirectExecution()) {
  const exitCode = await runMain();
  await flushProcessOutput();
  process.exit(exitCode);
}
