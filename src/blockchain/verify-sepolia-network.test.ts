import { describe, expect, it, vi } from 'vitest';

import {
  SepoliaChainMismatchError,
  SepoliaNetworkVerificationError,
  verifySepoliaNetwork,
  type ChainIdReader,
} from './verify-sepolia-network.js';

describe('verifySepoliaNetwork', () => {
  it('возвращает chain ID сети Sepolia', async () => {
    const getChainId = vi.fn<ChainIdReader['getChainId']>().mockResolvedValue(11_155_111);

    await expect(verifySepoliaNetwork({ getChainId })).resolves.toBe(11_155_111);
    expect(getChainId).toHaveBeenCalledOnce();
  });

  it('отклоняет RPC endpoint другой сети', async () => {
    const getChainId = vi.fn<ChainIdReader['getChainId']>().mockResolvedValue(1);

    try {
      await verifySepoliaNetwork({ getChainId });
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
        message: 'RPC endpoint returned chain ID 1; expected Sepolia (11155111).',
      });
    }

    expect(getChainId).toHaveBeenCalledOnce();
  });

  it.each([
    ['недоступный RPC', new Error('ECONNREFUSED')],
    ['таймаут RPC', Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })],
    ['некорректный RPC-ответ', new Error('Invalid JSON-RPC response')],
  ])('оборачивает ошибку: %s', async (_caseName, cause) => {
    const getChainId = vi.fn<ChainIdReader['getChainId']>().mockRejectedValue(cause);

    try {
      await verifySepoliaNetwork({ getChainId });
      expect.unreachable('Ожидалась ошибка проверки сети.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SepoliaNetworkVerificationError);

      if (!(error instanceof SepoliaNetworkVerificationError)) {
        throw error;
      }

      expect(error).not.toBeInstanceOf(SepoliaChainMismatchError);
      expect(error.message).toBe('Unable to read chain ID from the RPC endpoint.');
      expect(error.cause).toBe(cause);
    }
  });
});
