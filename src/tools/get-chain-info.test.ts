import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { SepoliaChainMismatchError, SepoliaNetworkVerificationError } from '../blockchain/index.js';
import { GetChainInfoError, getChainInfo, type ChainInfoClient } from './get-chain-info.js';

describe('getChainInfo', () => {
  it('возвращает проверенную информацию о Sepolia', async () => {
    const getChainId = vi.fn<ChainInfoClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi
      .fn<ChainInfoClient['getBlockNumber']>()
      .mockResolvedValue(9_007_199_254_740_993n);

    await expect(getChainInfo({ getChainId, getBlockNumber })).resolves.toEqual({
      network: {
        name: 'Sepolia',
        chainId: 11_155_111,
        testnet: true,
      },
      latestBlockNumber: '9007199254740993',
      connection: {
        status: 'connected',
        readOnly: true,
      },
    });
    expect(getChainId).toHaveBeenCalledOnce();
    expect(getBlockNumber).toHaveBeenCalledOnce();
  });

  it('отклоняет другую сеть до запроса номера блока', async () => {
    const getChainId = vi.fn<ChainInfoClient['getChainId']>().mockResolvedValue(1);
    const getBlockNumber = vi.fn<ChainInfoClient['getBlockNumber']>();

    try {
      await getChainInfo({ getChainId, getBlockNumber });
      expect.unreachable('Ожидалась ошибка несовпадения сети.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SepoliaChainMismatchError);

      if (!(error instanceof SepoliaChainMismatchError)) {
        throw error;
      }

      expect(error).toMatchObject({
        name: 'SepoliaChainMismatchError',
        actualChainId: 1,
        expectedChainId: 11_155_111,
      });
    }

    expect(getChainId).toHaveBeenCalledOnce();
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it('сохраняет причину сетевой ошибки при проверке chain ID', async () => {
    const cause = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    const getChainId = vi.fn<ChainInfoClient['getChainId']>().mockRejectedValue(cause);
    const getBlockNumber = vi.fn<ChainInfoClient['getBlockNumber']>();

    try {
      await getChainInfo({ getChainId, getBlockNumber });
      expect.unreachable('Ожидалась ошибка проверки сети.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SepoliaNetworkVerificationError);

      if (!(error instanceof SepoliaNetworkVerificationError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to read chain ID from the RPC endpoint.');
      expect(error.cause).toBe(cause);
    }

    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it('сохраняет причину RPC-ошибки при чтении актуального блока', async () => {
    const cause = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    const getChainId = vi.fn<ChainInfoClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<ChainInfoClient['getBlockNumber']>().mockRejectedValue(cause);

    try {
      await getChainInfo({ getChainId, getBlockNumber });
      expect.unreachable('Ожидалась ошибка чтения номера блока.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetChainInfoError);

      if (!(error instanceof GetChainInfoError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to read the latest Sepolia block number.');
      expect(error.cause).toBe(cause);
    }
  });

  it('отклоняет некорректный номер блока из RPC-ответа', async () => {
    const getChainId = vi.fn<ChainInfoClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<ChainInfoClient['getBlockNumber']>().mockResolvedValue(-1n);

    try {
      await getChainInfo({ getChainId, getBlockNumber });
      expect.unreachable('Ожидалась ошибка проверки номера блока.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetChainInfoError);

      if (!(error instanceof GetChainInfoError)) {
        throw error;
      }

      expect(error.cause).toBeInstanceOf(ZodError);
    }
  });
});
