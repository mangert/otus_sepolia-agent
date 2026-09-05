import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

import type { AppConfig } from '../config/index.js';

export type SepoliaClientConfig = AppConfig['blockchain'];

/** Создаёт read-only клиент для сети Ethereum Sepolia. */
export const createSepoliaClient = (config: SepoliaClientConfig) =>
  createPublicClient({
    chain: sepolia,
    key: 'sepolia-public',
    name: 'Sepolia Public Client',
    transport: http(config.rpcUrl, {
      retryCount: config.maxRetries,
      timeout: config.timeoutMs,
    }),
  });

export type SepoliaClient = ReturnType<typeof createSepoliaClient>;
