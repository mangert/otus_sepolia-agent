import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  SepoliaAgentExecutionError,
  type SepoliaAgent,
  type SepoliaAgentResult,
} from './agent/index.js';
import {
  CLI_EXIT_FAILURE,
  CLI_EXIT_SUCCESS,
  CLI_EXIT_USAGE,
  CliUsageError,
  parseCliArgs,
  runCli,
} from './cli.js';
import { ConfigurationError } from './config/index.js';

const defaultAgentResult: SepoliaAgentResult = {
  answer: 'Mock Sepolia answer.',
  intermediateSteps: [],
};

/** Создаёт локальный mock агента без LLM и RPC. */
const createMockAgent = (result: SepoliaAgentResult = defaultAgentResult) => {
  const invoke = vi.fn<SepoliaAgent['invoke']>().mockResolvedValue(result);
  const agent: SepoliaAgent = {
    maxIterations: 8,
    recursionLimit: 17,
    toolNames: [],
    invoke,
  };

  return { agent, invoke };
};

/** Создаёт in-memory поток и функцию чтения накопленного текста. */
const createCapturedStream = () => {
  const stream = new PassThrough();
  let contents = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    contents += chunk;
  });

  return {
    stream,
    read: (): string => contents,
  };
};

describe('CLI argument parsing', () => {
  it.each([
    { args: [], expected: { kind: 'interactive' } },
    { args: ['--'], expected: { kind: 'interactive' } },
    { args: ['--help'], expected: { kind: 'help' } },
    { args: ['-h'], expected: { kind: 'help' } },
    { args: ['--interactive'], expected: { kind: 'interactive' } },
    { args: ['-i'], expected: { kind: 'interactive' } },
  ])('разбирает $args', ({ args, expected }) => {
    expect(parseCliArgs(args)).toEqual(expected);
  });

  it('объединяет позиционные аргументы в один запрос', () => {
    expect(parseCliArgs(['Show', 'latest', 'block'])).toEqual({
      kind: 'single',
      query: 'Show latest block',
    });
  });

  it('отклоняет неизвестный параметр', () => {
    expect(() => parseCliArgs(['--unsupported'])).toThrowError(
      new CliUsageError('Unknown option: --unsupported'),
    );
  });

  it('не разрешает совмещать режим и запрос', () => {
    expect(() => parseCliArgs(['--interactive', 'Show block 42'])).toThrowError(
      'Interactive mode does not accept a question argument.',
    );
  });
});

describe('CLI execution', () => {
  it('показывает справку без создания агента', async () => {
    const output = createCapturedStream();
    const errorOutput = createCapturedStream();
    const agentFactory = vi.fn<() => SepoliaAgent>();

    const exitCode = await runCli({
      args: ['--help'],
      output: output.stream,
      errorOutput: errorOutput.stream,
      agentFactory,
    });

    expect(exitCode).toBe(CLI_EXIT_SUCCESS);
    expect(output.read()).toContain('Usage:');
    expect(errorOutput.read()).toBe('');
    expect(agentFactory).not.toHaveBeenCalled();
  });

  it('возвращает usage-код для неизвестного параметра', async () => {
    const output = createCapturedStream();
    const errorOutput = createCapturedStream();
    const agentFactory = vi.fn<() => SepoliaAgent>();

    const exitCode = await runCli({
      args: ['--unsupported'],
      output: output.stream,
      errorOutput: errorOutput.stream,
      agentFactory,
    });

    expect(exitCode).toBe(CLI_EXIT_USAGE);
    expect(output.read()).toBe('');
    expect(errorOutput.read()).toContain('CliUsageError: Unknown option: --unsupported');
    expect(errorOutput.read()).toContain('Usage:');
    expect(agentFactory).not.toHaveBeenCalled();
  });

  it('выполняет однократный запрос и печатает ответ', async () => {
    const output = createCapturedStream();
    const errorOutput = createCapturedStream();
    const mocks = createMockAgent();

    const exitCode = await runCli({
      args: ['Show', 'the', 'latest', 'block'],
      output: output.stream,
      errorOutput: errorOutput.stream,
      agentFactory: () => mocks.agent,
    });

    expect(exitCode).toBe(CLI_EXIT_SUCCESS);
    expect(mocks.invoke).toHaveBeenCalledWith('Show the latest block', {});
    expect(output.read()).toBe('Mock Sepolia answer.\n');
    expect(errorOutput.read()).toBe('');
  });

  it('читает запросы из stdin до команды выхода', async () => {
    const input = new PassThrough();
    const output = createCapturedStream();
    const errorOutput = createCapturedStream();
    const mocks = createMockAgent();
    input.end('First request\n\nSecond request\n/exit\nIgnored request\n');

    const exitCode = await runCli({
      args: [],
      input,
      output: output.stream,
      errorOutput: errorOutput.stream,
      agentFactory: () => mocks.agent,
    });

    expect(exitCode).toBe(CLI_EXIT_SUCCESS);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'First request', {});
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'Second request', {});
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(output.read()).toBe(
      'Sepolia read-only agent. Type /exit to quit.\n' +
        'Mock Sepolia answer.\n' +
        'Mock Sepolia answer.\n' +
        'Goodbye.\n',
    );
    expect(errorOutput.read()).toBe('');
  });

  it('печатает понятную ошибку конфигурации и возвращает failure-код', async () => {
    const output = createCapturedStream();
    const errorOutput = createCapturedStream();

    const exitCode = await runCli({
      args: ['Show block 42'],
      output: output.stream,
      errorOutput: errorOutput.stream,
      agentFactory: () => {
        throw new ConfigurationError(
          'Invalid SEPOLIA_RPC_URL: https://secret.example/rpc?apiKey=top-secret',
        );
      },
    });

    expect(exitCode).toBe(CLI_EXIT_FAILURE);
    expect(output.read()).toBe('');
    expect(errorOutput.read()).toBe(
      'Configuration error: Invalid SEPOLIA_RPC_URL: [redacted-url]\n',
    );
    expect(errorOutput.read()).not.toContain('top-secret');
  });

  it('печатает безопасную ошибку агента и возвращает failure-код', async () => {
    const output = createCapturedStream();
    const errorOutput = createCapturedStream();
    const mocks = createMockAgent();
    mocks.invoke.mockRejectedValueOnce(
      new SepoliaAgentExecutionError('Unable to complete request.', {
        cause: new Error(
          'RPC failed at https://secret.example/rpc?apiKey=top-secret token=another-secret',
        ),
      }),
    );

    const exitCode = await runCli({
      args: ['Show block 42'],
      output: output.stream,
      errorOutput: errorOutput.stream,
      agentFactory: () => mocks.agent,
    });

    expect(exitCode).toBe(CLI_EXIT_FAILURE);
    expect(output.read()).toBe('');
    expect(errorOutput.read()).toContain('Agent error: Unable to complete request.');
    expect(errorOutput.read()).toContain('[redacted-url]');
    expect(errorOutput.read()).toContain('token [redacted]');
    expect(errorOutput.read()).not.toContain('secret.example');
    expect(errorOutput.read()).not.toContain('top-secret');
    expect(errorOutput.read()).not.toContain('another-secret');
  });
});
