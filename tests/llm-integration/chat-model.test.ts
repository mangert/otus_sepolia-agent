import { config as loadDotEnv } from 'dotenv';
import { describe, expect, it } from 'vitest';

import { createSepoliaChatModel } from '../../src/agent/index.js';
import { loadConfig } from '../../src/config/index.js';

const LLM_INTEGRATION_MODEL = 'opencode/big-pickle';

loadDotEnv({ quiet: true });

describe('LLM live integration', () => {
  it('получает реальный ответ big-pickle через LangChain', async () => {
    const config = loadConfig();
    const model = createSepoliaChatModel({
      ...config.llm,
      model: LLM_INTEGRATION_MODEL,
      maxRetries: 0,
    });
    const response = await model.invoke('Reply with exactly SEPOLIA_LLM_OK and no other text.');

    expect(response.text.trim()).toBe('SEPOLIA_LLM_OK');
  });
});
