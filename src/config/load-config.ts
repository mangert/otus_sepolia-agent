import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { config as loadDotEnv } from 'dotenv';
import { ZodError } from 'zod';

import { environmentSchema, llmFileConfigSchema, type LlmFileConfig } from './config.schema.js';

const SEPOLIA_CHAIN_ID = 11_155_111;
const DEFAULT_LLM_CONFIG_PATH = 'config/llm.config.json';

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AppConfig {
  blockchain: {
    network: 'sepolia';
    chainId: typeof SEPOLIA_CHAIN_ID;
    rpcUrl: string;
    timeoutMs: number;
    maxRetries: number;
    limits: {
      maxLogBlockRange: number;
      maxBatchSize: number;
    };
  };
  llm: LlmFileConfig & {
    apiKey?: string;
  };
}

export class ConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

/** Форматирует ошибки Zod для сообщения конфигурации. */
const formatZodError = (error: ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ');

/** Проверяет переменные окружения и возвращает типизированные настройки. */
const parseEnvironment = (env: NodeJS.ProcessEnv) => {
  try {
    return environmentSchema.parse(env);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      throw new ConfigurationError(`Invalid environment configuration: ${formatZodError(error)}`, {
        cause: error,
      });
    }

    throw error;
  }
};

/** Читает и проверяет файл настроек LLM. */
const loadLlmFileConfig = (path: string): LlmFileConfig => {
  let contents: string;

  try {
    contents = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    throw new ConfigurationError(`Unable to read LLM configuration file: ${path}`, {
      cause: error,
    });
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    throw new ConfigurationError(`LLM configuration file is not valid JSON: ${path}`, {
      cause: error,
    });
  }

  try {
    return llmFileConfigSchema.parse(parsedJson);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      throw new ConfigurationError(`Invalid LLM configuration: ${formatZodError(error)}`, {
        cause: error,
      });
    }

    throw error;
  }
};

/** Загружает и объединяет конфигурацию приложения. */
export const loadConfig = (options: LoadConfigOptions = {}): AppConfig => {
  const cwd = options.cwd ?? process.cwd();

  if (options.env === undefined) {
    loadDotEnv({ path: resolve(cwd, '.env'), quiet: true });
  }

  const environment = parseEnvironment(options.env ?? process.env);
  const configuredLlmPath = environment.LLM_CONFIG_PATH ?? DEFAULT_LLM_CONFIG_PATH;
  const llmPath = isAbsolute(configuredLlmPath)
    ? configuredLlmPath
    : resolve(cwd, configuredLlmPath);
  const llmFileConfig = loadLlmFileConfig(llmPath);

  return {
    blockchain: {
      network: 'sepolia',
      chainId: SEPOLIA_CHAIN_ID,
      rpcUrl: environment.SEPOLIA_RPC_URL,
      timeoutMs: environment.RPC_TIMEOUT_MS,
      maxRetries: environment.RPC_MAX_RETRIES,
      limits: {
        maxLogBlockRange: environment.RPC_MAX_LOG_BLOCK_RANGE,
        maxBatchSize: environment.RPC_MAX_BATCH_SIZE,
      },
    },
    llm: {
      ...llmFileConfig,
      ...(environment.OPENCODE_LLM_PROXY_TOKEN === undefined
        ? {}
        : { apiKey: environment.OPENCODE_LLM_PROXY_TOKEN }),
    },
  };
};
