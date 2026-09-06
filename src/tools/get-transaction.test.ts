import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { SepoliaChainMismatchError } from '../blockchain/index.js';
import { GetTransactionError, getTransaction, type TransactionClient } from './get-transaction.js';

const transactionHash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;
const from = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummedFrom = '0x52908400098527886E0F7030069857D2E4169EE7';
const to = '0x0000000000000000000000000000000000000000';

const confirmedTransaction = {
  hash: transactionHash,
  blockHash,
  blockNumber: 9_007_199_254_740_993n,
  transactionIndex: Number.MAX_SAFE_INTEGER,
  from,
  to,
  value: 123_456_789_012_345_678_901_234_567_890n,
  nonce: Number.MAX_SAFE_INTEGER,
  gas: 30_000_000n,
  gasPrice: 1_000_000_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
  input: '0xAa00fF',
  type: 'eip1559',
};

describe('getTransaction', () => {
  it('возвращает найденную подтверждённую транзакцию без потери точности', async () => {
    const getChainId = vi.fn<TransactionClient['getChainId']>().mockResolvedValue(11_155_111);
    const readTransaction = vi
      .fn<TransactionClient['getTransaction']>()
      .mockResolvedValue(confirmedTransaction);

    await expect(
      getTransaction({ getChainId, getTransaction: readTransaction }, { hash: transactionHash }),
    ).resolves.toEqual({
      hash: transactionHash,
      status: 'confirmed',
      blockHash,
      blockNumber: '9007199254740993',
      transactionIndex: '9007199254740991',
      from: checksummedFrom,
      to,
      valueWei: '123456789012345678901234567890',
      nonce: '9007199254740991',
      gasLimit: '30000000',
      gasPriceWei: '1000000000',
      maxFeePerGasWei: '2000000000',
      maxPriorityFeePerGasWei: '100000000',
      input: '0xAa00fF',
      type: 'eip1559',
    });
    expect(readTransaction).toHaveBeenCalledOnce();
    expect(readTransaction).toHaveBeenCalledWith({ hash: transactionHash });
  });

  it('возвращает неподтверждённую транзакцию с пустыми блоковыми полями', async () => {
    const pendingTransaction = {
      ...confirmedTransaction,
      blockHash: null,
      blockNumber: null,
      transactionIndex: null,
      gasPrice: undefined,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    };
    const getChainId = vi.fn<TransactionClient['getChainId']>().mockResolvedValue(11_155_111);
    const readTransaction = vi
      .fn<TransactionClient['getTransaction']>()
      .mockResolvedValue(pendingTransaction);

    await expect(
      getTransaction({ getChainId, getTransaction: readTransaction }, { hash: transactionHash }),
    ).resolves.toMatchObject({
      status: 'pending',
      blockHash: null,
      blockNumber: null,
      transactionIndex: null,
      gasPriceWei: null,
      maxFeePerGasWei: null,
      maxPriorityFeePerGasWei: null,
    });
  });

  it('сохраняет причину ошибки отсутствующей транзакции', async () => {
    const cause = Object.assign(new Error('Transaction not found'), { code: -32_001 });
    const getChainId = vi.fn<TransactionClient['getChainId']>().mockResolvedValue(11_155_111);
    const readTransaction = vi.fn<TransactionClient['getTransaction']>().mockRejectedValue(cause);

    try {
      await getTransaction(
        { getChainId, getTransaction: readTransaction },
        { hash: transactionHash },
      );
      expect.unreachable('Ожидалась ошибка отсутствующей транзакции.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetTransactionError);

      if (!(error instanceof GetTransactionError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to read the requested Sepolia transaction.');
      expect(error.cause).toBe(cause);
    }
  });

  it.each(['0x1234', `0x${'a'.repeat(63)}`, `0x${'g'.repeat(64)}`, `${'a'.repeat(64)}`])(
    'отклоняет неправильный hash до RPC-вызовов: %s',
    async (hash) => {
      const getChainId = vi.fn<TransactionClient['getChainId']>();
      const readTransaction = vi.fn<TransactionClient['getTransaction']>();

      await expect(
        getTransaction({ getChainId, getTransaction: readTransaction }, { hash }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(getChainId).not.toHaveBeenCalled();
      expect(readTransaction).not.toHaveBeenCalled();
    },
  );

  it('не запрашивает транзакцию при подключении к другой сети', async () => {
    const getChainId = vi.fn<TransactionClient['getChainId']>().mockResolvedValue(1);
    const readTransaction = vi.fn<TransactionClient['getTransaction']>();

    await expect(
      getTransaction({ getChainId, getTransaction: readTransaction }, { hash: transactionHash }),
    ).rejects.toBeInstanceOf(SepoliaChainMismatchError);
    expect(readTransaction).not.toHaveBeenCalled();
  });

  it('отклоняет RPC-ответ с другим hash', async () => {
    const getChainId = vi.fn<TransactionClient['getChainId']>().mockResolvedValue(11_155_111);
    const readTransaction = vi
      .fn<TransactionClient['getTransaction']>()
      .mockResolvedValue({ ...confirmedTransaction, hash: `0x${'c'.repeat(64)}` });

    await expect(
      getTransaction({ getChainId, getTransaction: readTransaction }, { hash: transactionHash }),
    ).rejects.toThrow('RPC response transaction hash does not match the requested hash.');
  });

  it('принимает различающийся регистр одного hash', async () => {
    const mixedCaseHash = `0x${'aA'.repeat(32)}`;
    const lowercaseHash = mixedCaseHash.toLowerCase();
    const getChainId = vi.fn<TransactionClient['getChainId']>().mockResolvedValue(11_155_111);
    const readTransaction = vi
      .fn<TransactionClient['getTransaction']>()
      .mockResolvedValue({ ...confirmedTransaction, hash: lowercaseHash });

    await expect(
      getTransaction({ getChainId, getTransaction: readTransaction }, { hash: mixedCaseHash }),
    ).resolves.toMatchObject({ hash: lowercaseHash });
    expect(readTransaction).toHaveBeenCalledWith({ hash: mixedCaseHash });
  });

  it('отклоняет несогласованные блоковые поля RPC-ответа', async () => {
    const getChainId = vi.fn<TransactionClient['getChainId']>().mockResolvedValue(11_155_111);
    const readTransaction = vi
      .fn<TransactionClient['getTransaction']>()
      .mockResolvedValue({ ...confirmedTransaction, blockHash: null });

    try {
      await getTransaction(
        { getChainId, getTransaction: readTransaction },
        { hash: transactionHash },
      );
      expect.unreachable('Ожидалась ошибка проверки блоковых полей.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetTransactionError);

      if (!(error instanceof GetTransactionError)) {
        throw error;
      }

      expect(error.cause).toBeInstanceOf(ZodError);
    }
  });

  it('отклоняет calldata с неполным байтом', async () => {
    const getChainId = vi.fn<TransactionClient['getChainId']>().mockResolvedValue(11_155_111);
    const readTransaction = vi
      .fn<TransactionClient['getTransaction']>()
      .mockResolvedValue({ ...confirmedTransaction, input: '0x1' });

    try {
      await getTransaction(
        { getChainId, getTransaction: readTransaction },
        { hash: transactionHash },
      );
      expect.unreachable('Ожидалась ошибка проверки calldata.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetTransactionError);

      if (!(error instanceof GetTransactionError)) {
        throw error;
      }

      expect(error.cause).toBeInstanceOf(ZodError);
    }
  });
});
