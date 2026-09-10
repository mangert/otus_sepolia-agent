import { config as loadDotEnv } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';

import { createSepoliaClient, type SepoliaClient } from '../../src/blockchain/index.js';
import { loadConfig } from '../../src/config/index.js';
import { getChainInfo, getNativeBalance, readContract } from '../../src/tools/index.js';

const SEPOLIA_CHAIN_ID = 11_155_111;
const SEPOLIA_WETH9_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const SEPOLIA_WETH9_SYMBOL_ABI = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

loadDotEnv({ quiet: true });

const hasSepoliaRpc =
  typeof process.env.SEPOLIA_RPC_URL === 'string' && process.env.SEPOLIA_RPC_URL.trim().length > 0;

describe.skipIf(!hasSepoliaRpc)('Sepolia live integration', () => {
  let client: SepoliaClient;

  beforeAll(() => {
    client = createSepoliaClient(loadConfig().blockchain);
  });

  it('подключается именно к Sepolia и возвращает актуальный блок', async () => {
    const result = await getChainInfo(client);

    expect(result.network).toEqual({
      name: 'Sepolia',
      chainId: SEPOLIA_CHAIN_ID,
      testnet: true,
    });
    expect(BigInt(result.latestBlockNumber)).toBeGreaterThan(0n);
    expect(result.connection).toEqual({
      status: 'connected',
      readOnly: true,
    });
  });

  it('читает нативный баланс известного Sepolia-адреса', async () => {
    const result = await getNativeBalance(client, {
      address: SEPOLIA_WETH9_ADDRESS,
    });

    expect(result.address).toBe(SEPOLIA_WETH9_ADDRESS);
    expect(BigInt(result.blockNumber)).toBeGreaterThan(0n);
    expect(BigInt(result.balanceWei)).toBeGreaterThanOrEqual(0n);
    expect(result.balanceEth).toMatch(/^\d+(?:\.\d+)?$/u);
  });

  it('вызывает простую view-функцию WETH9', async () => {
    const result = await readContract(client, {
      address: SEPOLIA_WETH9_ADDRESS,
      abi: SEPOLIA_WETH9_SYMBOL_ABI,
      functionSignature: 'symbol()',
      args: [],
    });

    expect(result.address).toBe(SEPOLIA_WETH9_ADDRESS);
    expect(BigInt(result.blockNumber)).toBeGreaterThan(0n);
    expect(result.functionSignature).toBe('symbol()');
    expect(result.stateMutability).toBe('view');
    expect(result.result).toBe('WETH');
  });
});
