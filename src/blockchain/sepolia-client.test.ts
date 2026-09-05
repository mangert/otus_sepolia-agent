import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSepoliaClient, type SepoliaClientConfig } from './sepolia-client.js';

const blockchainConfig: SepoliaClientConfig = {
  network: 'sepolia',
  chainId: 11_155_111,
  rpcUrl: 'https://sepolia-rpc.example',
  timeoutMs: 4_321,
  maxRetries: 4,
  limits: {
    maxLogBlockRange: 2_000,
    maxBatchSize: 20,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSepoliaClient', () => {
  it('создаёт публичный HTTP-клиент для Sepolia', () => {
    const client = createSepoliaClient(blockchainConfig);

    expect(client.type).toBe('publicClient');
    expect(client.chain).toMatchObject({
      id: 11_155_111,
      name: 'Sepolia',
      testnet: true,
    });
    expect(client.transport).toMatchObject({
      type: 'http',
      url: blockchainConfig.rpcUrl,
    });
  });

  it('передаёт timeout и количество повторов в HTTP transport', () => {
    const client = createSepoliaClient(blockchainConfig);

    expect(client.transport.timeout).toBe(blockchainConfig.timeoutMs);
    expect(client.transport.retryCount).toBe(blockchainConfig.maxRetries);
  });

  it('не выполняет сетевой запрос при создании', () => {
    const fetchMock = vi.fn<typeof fetch>();

    vi.stubGlobal('fetch', fetchMock);
    createSepoliaClient(blockchainConfig);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('использует настроенный RPC URL через mocked transport', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xaa36a7' }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const client = createSepoliaClient(blockchainConfig);
    const chainId = await client.getChainId();

    expect(chainId).toBe(11_155_111);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(blockchainConfig.rpcUrl).href,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
