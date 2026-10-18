import { config as loadDotEnv } from 'dotenv';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createSepoliaChatModel } from '../../src/agent/index.js';
import { loadConfig, type AppConfig } from '../../src/config/index.js';
import { configureOutboundProxy } from '../../src/network/index.js';

loadDotEnv({ quiet: true });

const hasGroqApiKey =
  typeof process.env.GROQ_API_KEY === 'string' && process.env.GROQ_API_KEY.trim().length > 0;

const getChainInfoTool = tool(async () => ({ chainId: 11_155_111, network: 'Sepolia' }), {
  name: 'get_chain_info',
  description: 'Returns read-only Ethereum Sepolia network metadata.',
  schema: z.strictObject({}),
});

describe.skipIf(!hasGroqApiKey)('LLM live integration', () => {
  let config: AppConfig;
  let restoreProxy: (() => void) | undefined;

  beforeAll(() => {
    config = loadConfig();
    restoreProxy = configureOutboundProxy(config.network);
  });

  afterAll(() => {
    restoreProxy?.();
  });

  it('получает реальный ответ настроенной Groq-модели через LangChain', async () => {
    const model = createSepoliaChatModel({
      ...config.llm,
      maxRetries: 0,
    });
    const response = await model.invoke('Reply with exactly SEPOLIA_LLM_OK and no other text.');

    expect(response.text.trim()).toBe('SEPOLIA_LLM_OK');
  });

  it('возвращает принудительный tool call в формате LangChain', async () => {
    const model = createSepoliaChatModel({ ...config.llm, maxRetries: 0 });
    const modelWithTools = model.bindTools([getChainInfoTool], {
      tool_choice: {
        type: 'function',
        function: { name: 'get_chain_info' },
      },
    });
    const response = await modelWithTools.invoke('Call get_chain_info now.');

    expect(AIMessage.isInstance(response)).toBe(true);
    expect(response.tool_calls).toEqual([
      expect.objectContaining({
        name: 'get_chain_info',
        args: {},
      }),
    ]);
  });
});
