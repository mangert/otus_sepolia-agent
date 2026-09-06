import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { SepoliaChainMismatchError } from '../blockchain/index.js';
import {
  GetNativeBalanceError,
  getNativeBalance,
  type NativeBalanceClient,
} from './get-native-balance.js';

const lowercaseAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummedAddress = '0x52908400098527886E0F7030069857D2E4169EE7';

describe('getNativeBalance', () => {
  it('нормализует адрес и читает баланс на зафиксированном latest-блоке', async () => {
    const getChainId = vi.fn<NativeBalanceClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi
      .fn<NativeBalanceClient['getBlockNumber']>()
      .mockResolvedValue(12_345_678n);
    const getBalance = vi
      .fn<NativeBalanceClient['getBalance']>()
      .mockResolvedValue(1_500_000_000_000_000_000n);

    await expect(
      getNativeBalance({ getChainId, getBlockNumber, getBalance }, { address: lowercaseAddress }),
    ).resolves.toEqual({
      address: checksummedAddress,
      blockNumber: '12345678',
      balanceWei: '1500000000000000000',
      balanceEth: '1.5',
    });
    expect(getChainId).toHaveBeenCalledOnce();
    expect(getBlockNumber).toHaveBeenCalledOnce();
    expect(getBalance).toHaveBeenCalledOnce();
    expect(getBalance).toHaveBeenCalledWith({
      address: checksummedAddress,
      blockNumber: 12_345_678n,
    });
  });

  it('использует явный номер блока без запроса latest', async () => {
    const getChainId = vi.fn<NativeBalanceClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<NativeBalanceClient['getBlockNumber']>();
    const getBalance = vi.fn<NativeBalanceClient['getBalance']>().mockResolvedValue(1n);

    await expect(
      getNativeBalance(
        { getChainId, getBlockNumber, getBalance },
        { address: checksummedAddress, blockNumber: '42' },
      ),
    ).resolves.toMatchObject({
      blockNumber: '42',
      balanceWei: '1',
      balanceEth: '0.000000000000000001',
    });
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getBalance).toHaveBeenCalledWith({
      address: checksummedAddress,
      blockNumber: 42n,
    });
  });

  it('возвращает нулевой баланс одновременно в wei и ETH', async () => {
    const getChainId = vi.fn<NativeBalanceClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<NativeBalanceClient['getBlockNumber']>();
    const getBalance = vi.fn<NativeBalanceClient['getBalance']>().mockResolvedValue(0n);

    await expect(
      getNativeBalance(
        { getChainId, getBlockNumber, getBalance },
        { address: checksummedAddress, blockNumber: 0n },
      ),
    ).resolves.toMatchObject({
      blockNumber: '0',
      balanceWei: '0',
      balanceEth: '0',
    });
  });

  it('сохраняет точность большого баланса', async () => {
    const balance = 123_456_789_012_345_678_901_234_567_890n;
    const getChainId = vi.fn<NativeBalanceClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<NativeBalanceClient['getBlockNumber']>();
    const getBalance = vi.fn<NativeBalanceClient['getBalance']>().mockResolvedValue(balance);

    await expect(
      getNativeBalance(
        { getChainId, getBlockNumber, getBalance },
        { address: checksummedAddress, blockNumber: Number.MAX_SAFE_INTEGER },
      ),
    ).resolves.toMatchObject({
      blockNumber: '9007199254740991',
      balanceWei: '123456789012345678901234567890',
      balanceEth: '123456789012.34567890123456789',
    });
  });

  it('отклоняет неправильный адрес до RPC-вызовов', async () => {
    const getChainId = vi.fn<NativeBalanceClient['getChainId']>();
    const getBlockNumber = vi.fn<NativeBalanceClient['getBlockNumber']>();
    const getBalance = vi.fn<NativeBalanceClient['getBalance']>();

    await expect(
      getNativeBalance({ getChainId, getBlockNumber, getBalance }, { address: '0x1234' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(getChainId).not.toHaveBeenCalled();
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('отклоняет неправильный номер блока до RPC-вызовов', async () => {
    const getChainId = vi.fn<NativeBalanceClient['getChainId']>();
    const getBlockNumber = vi.fn<NativeBalanceClient['getBlockNumber']>();
    const getBalance = vi.fn<NativeBalanceClient['getBalance']>();

    await expect(
      getNativeBalance(
        { getChainId, getBlockNumber, getBalance },
        { address: checksummedAddress, blockNumber: -1 },
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(getChainId).not.toHaveBeenCalled();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('не читает баланс при подключении к другой сети', async () => {
    const getChainId = vi.fn<NativeBalanceClient['getChainId']>().mockResolvedValue(1);
    const getBlockNumber = vi.fn<NativeBalanceClient['getBlockNumber']>();
    const getBalance = vi.fn<NativeBalanceClient['getBalance']>();

    await expect(
      getNativeBalance({ getChainId, getBlockNumber, getBalance }, { address: checksummedAddress }),
    ).rejects.toBeInstanceOf(SepoliaChainMismatchError);
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('сохраняет причину ошибки определения latest-блока', async () => {
    const cause = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    const getChainId = vi.fn<NativeBalanceClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<NativeBalanceClient['getBlockNumber']>().mockRejectedValue(cause);
    const getBalance = vi.fn<NativeBalanceClient['getBalance']>();

    try {
      await getNativeBalance(
        { getChainId, getBlockNumber, getBalance },
        { address: checksummedAddress },
      );
      expect.unreachable('Ожидалась ошибка чтения latest-блока.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetNativeBalanceError);

      if (!(error instanceof GetNativeBalanceError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to resolve the latest Sepolia block number.');
      expect(error.cause).toBe(cause);
    }

    expect(getBalance).not.toHaveBeenCalled();
  });

  it('сохраняет причину RPC-ошибки чтения баланса', async () => {
    const cause = Object.assign(new Error('rate limited'), { status: 429 });
    const getChainId = vi.fn<NativeBalanceClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<NativeBalanceClient['getBlockNumber']>();
    const getBalance = vi.fn<NativeBalanceClient['getBalance']>().mockRejectedValue(cause);

    try {
      await getNativeBalance(
        { getChainId, getBlockNumber, getBalance },
        { address: checksummedAddress, blockNumber: 100 },
      );
      expect.unreachable('Ожидалась ошибка чтения баланса.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetNativeBalanceError);

      if (!(error instanceof GetNativeBalanceError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to read the native balance from Sepolia.');
      expect(error.cause).toBe(cause);
    }
  });

  it('отклоняет отрицательный баланс из RPC-ответа', async () => {
    const getChainId = vi.fn<NativeBalanceClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<NativeBalanceClient['getBlockNumber']>();
    const getBalance = vi.fn<NativeBalanceClient['getBalance']>().mockResolvedValue(-1n);

    try {
      await getNativeBalance(
        { getChainId, getBlockNumber, getBalance },
        { address: checksummedAddress, blockNumber: 100 },
      );
      expect.unreachable('Ожидалась ошибка проверки баланса.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetNativeBalanceError);

      if (!(error instanceof GetNativeBalanceError)) {
        throw error;
      }

      expect(error.cause).toBeInstanceOf(ZodError);
    }
  });
});
