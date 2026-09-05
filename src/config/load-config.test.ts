import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from './load-config.js';

const temporaryDirectories: string[] = [];

/** Создаёт временный LLM-конфиг и возвращает путь к нему. */
const createLlmConfig = (contents: unknown, raw = false): string => {
  const directory = mkdtempSync(join(tmpdir(), 'sepolia-agent-config-'));
  const path = join(directory, 'llm.config.json');
  const serialized = raw ? String(contents) : JSON.stringify(contents);

  if (serialized === undefined) {
    throw new TypeError('Не удалось сериализовать тестовый LLM-конфиг.');
  }

  temporaryDirectories.push(directory);
  writeFileSync(path, serialized, 'utf8');

  return path;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('loadConfig', () => {
  it('загружает корректную конфигурацию со значениями по умолчанию', () => {
    const config = loadConfig({
      cwd: process.cwd(),
      env: { SEPOLIA_RPC_URL: 'https://sepolia-rpc.example' },
    });

    expect(config).toEqual({
      blockchain: {
        network: 'sepolia',
        chainId: 11_155_111,
        rpcUrl: 'https://sepolia-rpc.example',
        timeoutMs: 10_000,
        maxRetries: 2,
        limits: {
          maxLogBlockRange: 2_000,
          maxBatchSize: 20,
        },
      },
      llm: {
        provider: 'opencode-llm-proxy',
        protocol: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:4010/v1',
        model: 'opencode/nemotron-3-ultra-free',
        timeoutMs: 60_000,
        maxRetries: 2,
      },
    });
  });

  it('применяет числовые настройки и bearer token из окружения', () => {
    const config = loadConfig({
      cwd: process.cwd(),
      env: {
        SEPOLIA_RPC_URL: 'http://127.0.0.1:8545',
        OPENCODE_LLM_PROXY_TOKEN: ' local-token ',
        RPC_TIMEOUT_MS: '25000',
        RPC_MAX_RETRIES: '4',
        RPC_MAX_LOG_BLOCK_RANGE: '5000',
        RPC_MAX_BATCH_SIZE: '50',
      },
    });

    expect(config.blockchain).toMatchObject({
      rpcUrl: 'http://127.0.0.1:8545',
      timeoutMs: 25_000,
      maxRetries: 4,
      limits: {
        maxLogBlockRange: 5_000,
        maxBatchSize: 50,
      },
    });
    expect(config.llm.apiKey).toBe('local-token');
  });

  it('отклоняет отсутствующий SEPOLIA_RPC_URL', () => {
    expect(() => loadConfig({ cwd: process.cwd(), env: {} })).toThrow(ConfigurationError);
    expect(() => loadConfig({ cwd: process.cwd(), env: {} })).toThrow(/SEPOLIA_RPC_URL/);
  });

  it.each(['not-a-url', 'ftp://example.com'])('отклоняет некорректный RPC URL: %s', (rpcUrl) => {
    expect(() => loadConfig({ cwd: process.cwd(), env: { SEPOLIA_RPC_URL: rpcUrl } })).toThrow(
      /SEPOLIA_RPC_URL/,
    );
  });

  it.each([
    ['RPC_TIMEOUT_MS', '999'],
    ['RPC_TIMEOUT_MS', 'not-a-number'],
    ['RPC_MAX_RETRIES', '6'],
    ['RPC_MAX_LOG_BLOCK_RANGE', '0'],
    ['RPC_MAX_BATCH_SIZE', '101'],
  ] as const)('отклоняет некорректное значение %s=%s', (name, value) => {
    expect(() =>
      loadConfig({
        cwd: process.cwd(),
        env: { SEPOLIA_RPC_URL: 'https://sepolia-rpc.example', [name]: value },
      }),
    ).toThrow(new RegExp(name));
  });

  it('отклоняет отсутствующий файл настроек LLM', () => {
    expect(() =>
      loadConfig({
        cwd: process.cwd(),
        env: {
          SEPOLIA_RPC_URL: 'https://sepolia-rpc.example',
          LLM_CONFIG_PATH: 'config/missing.json',
        },
      }),
    ).toThrow(/Unable to read LLM configuration file/);
  });

  it('отклоняет синтаксически некорректный LLM JSON', () => {
    const path = createLlmConfig('{ invalid json', true);

    expect(() =>
      loadConfig({
        env: { SEPOLIA_RPC_URL: 'https://sepolia-rpc.example', LLM_CONFIG_PATH: path },
      }),
    ).toThrow(/not valid JSON/);
  });

  it('отклоняет LLM-конфиг с неподдерживаемым провайдером', () => {
    const path = createLlmConfig({
      provider: 'other-provider',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:4010/v1',
      model: 'some-model',
      timeoutMs: 60_000,
      maxRetries: 2,
    });

    expect(() =>
      loadConfig({
        env: { SEPOLIA_RPC_URL: 'https://sepolia-rpc.example', LLM_CONFIG_PATH: path },
      }),
    ).toThrow(/provider/);
  });

  it('нормализует завершающий слеш URL из отдельного LLM-конфига', () => {
    const path = createLlmConfig({
      provider: 'opencode-llm-proxy',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:4010/v1/',
      model: 'opencode/nemotron-3-ultra-free',
      timeoutMs: 30_000,
      maxRetries: 1,
    });

    const config = loadConfig({
      env: { SEPOLIA_RPC_URL: 'https://sepolia-rpc.example', LLM_CONFIG_PATH: path },
    });

    expect(config.llm.baseUrl).toBe('http://127.0.0.1:4010/v1');
  });
});
