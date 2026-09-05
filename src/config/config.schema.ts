import { z } from 'zod';

const httpUrlSchema = z.url({
  protocol: /^https?$/,
});

/** Создаёт схему целого числа для переменной окружения. */
const createEnvironmentIntegerSchema = (defaultValue: number, min: number, max: number) =>
  z.preprocess(
    (value) => (value === undefined ? defaultValue : value),
    z.coerce.number().int().min(min).max(max),
  );

export const environmentSchema = z.object({
  SEPOLIA_RPC_URL: httpUrlSchema,
  LLM_CONFIG_PATH: z.string().trim().min(1).optional(),
  OPENCODE_LLM_PROXY_TOKEN: z.string().trim().min(1).optional(),
  RPC_TIMEOUT_MS: createEnvironmentIntegerSchema(10_000, 1_000, 120_000),
  RPC_MAX_RETRIES: createEnvironmentIntegerSchema(2, 0, 5),
  RPC_MAX_LOG_BLOCK_RANGE: createEnvironmentIntegerSchema(2_000, 1, 10_000),
  RPC_MAX_BATCH_SIZE: createEnvironmentIntegerSchema(20, 1, 100),
});

export const llmFileConfigSchema = z.strictObject({
  provider: z.literal('opencode-llm-proxy'),
  protocol: z.literal('openai-compatible'),
  baseUrl: httpUrlSchema.transform((value) => value.replace(/\/+$/, '')),
  model: z.string().trim().min(1).regex(/^\S+$/, 'must not contain whitespace'),
  timeoutMs: z.number().int().min(1_000).max(300_000),
  maxRetries: z.number().int().min(0).max(5),
});

export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export type LlmFileConfig = z.infer<typeof llmFileConfigSchema>;
