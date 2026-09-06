import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { SepoliaChainMismatchError } from '../blockchain/index.js';
import {
  GetTransactionReceiptError,
  getTransactionReceipt,
  type TransactionReceiptClient,
} from './get-transaction-receipt.js';

const transactionHash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;
const eventSignature = `0x${'c'.repeat(64)}`;
const from = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummedFrom = '0x52908400098527886E0F7030069857D2E4169EE7';
const to = '0x0000000000000000000000000000000000000000';

const successfulReceipt = {
  transactionHash,
  transactionIndex: Number.MAX_SAFE_INTEGER,
  blockHash,
  blockNumber: 9_007_199_254_740_993n,
  from,
  to,
  contractAddress: from,
  status: 'success',
  gasUsed: 123_456_789_012_345_678_901n,
  cumulativeGasUsed: 223_456_789_012_345_678_901n,
  effectiveGasPrice: 1_000_000_000n,
  type: 'eip1559',
  logs: [
    { logIndex: 0, address: from, topics: [eventSignature] },
    { logIndex: 1, address: to, topics: [] },
  ],
};

describe('getTransactionReceipt', () => {
  it('возвращает успешный receipt без потери точности', async () => {
    const getChainId = vi
      .fn<TransactionReceiptClient['getChainId']>()
      .mockResolvedValue(11_155_111);
    const readReceipt = vi
      .fn<TransactionReceiptClient['getTransactionReceipt']>()
      .mockResolvedValue(successfulReceipt);

    await expect(
      getTransactionReceipt(
        { getChainId, getTransactionReceipt: readReceipt },
        { hash: transactionHash },
      ),
    ).resolves.toEqual({
      transactionHash,
      status: 'success',
      blockHash,
      blockNumber: '9007199254740993',
      transactionIndex: '9007199254740991',
      from: checksummedFrom,
      to,
      contractAddress: checksummedFrom,
      gasUsed: '123456789012345678901',
      cumulativeGasUsed: '223456789012345678901',
      effectiveGasPriceWei: '1000000000',
      type: 'eip1559',
      logs: {
        count: 2,
        summaries: [
          {
            logIndex: '0',
            address: checksummedFrom,
            topicCount: 1,
            eventSignature,
          },
          {
            logIndex: '1',
            address: to,
            topicCount: 0,
            eventSignature: null,
          },
        ],
        truncated: false,
      },
    });
    expect(readReceipt).toHaveBeenCalledOnce();
    expect(readReceipt).toHaveBeenCalledWith({ hash: transactionHash });
  });

  it('возвращает reverted receipt без адреса созданного контракта', async () => {
    const revertedReceipt = {
      ...successfulReceipt,
      status: 'reverted',
      contractAddress: null,
      logs: [],
    };
    const getChainId = vi
      .fn<TransactionReceiptClient['getChainId']>()
      .mockResolvedValue(11_155_111);
    const readReceipt = vi
      .fn<TransactionReceiptClient['getTransactionReceipt']>()
      .mockResolvedValue(revertedReceipt);

    await expect(
      getTransactionReceipt(
        { getChainId, getTransactionReceipt: readReceipt },
        { hash: transactionHash },
      ),
    ).resolves.toMatchObject({
      status: 'reverted',
      contractAddress: null,
      logs: {
        count: 0,
        summaries: [],
        truncated: false,
      },
    });
  });

  it('сохраняет причину ошибки отсутствующего receipt', async () => {
    const cause = Object.assign(new Error('Transaction receipt not found'), { code: -32_001 });
    const getChainId = vi
      .fn<TransactionReceiptClient['getChainId']>()
      .mockResolvedValue(11_155_111);
    const readReceipt = vi
      .fn<TransactionReceiptClient['getTransactionReceipt']>()
      .mockRejectedValue(cause);

    try {
      await getTransactionReceipt(
        { getChainId, getTransactionReceipt: readReceipt },
        { hash: transactionHash },
      );
      expect.unreachable('Ожидалась ошибка отсутствующего receipt.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetTransactionReceiptError);

      if (!(error instanceof GetTransactionReceiptError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to read the requested Sepolia transaction receipt.');
      expect(error.cause).toBe(cause);
    }
  });

  it.each(['0x1234', `0x${'a'.repeat(63)}`, `0x${'g'.repeat(64)}`])(
    'отклоняет неправильный hash до RPC-вызовов: %s',
    async (hash) => {
      const getChainId = vi.fn<TransactionReceiptClient['getChainId']>();
      const readReceipt = vi.fn<TransactionReceiptClient['getTransactionReceipt']>();

      await expect(
        getTransactionReceipt({ getChainId, getTransactionReceipt: readReceipt }, { hash }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(getChainId).not.toHaveBeenCalled();
      expect(readReceipt).not.toHaveBeenCalled();
    },
  );

  it('не запрашивает receipt при подключении к другой сети', async () => {
    const getChainId = vi.fn<TransactionReceiptClient['getChainId']>().mockResolvedValue(1);
    const readReceipt = vi.fn<TransactionReceiptClient['getTransactionReceipt']>();

    await expect(
      getTransactionReceipt(
        { getChainId, getTransactionReceipt: readReceipt },
        { hash: transactionHash },
      ),
    ).rejects.toBeInstanceOf(SepoliaChainMismatchError);
    expect(readReceipt).not.toHaveBeenCalled();
  });

  it('ограничивает summaries логов по умолчанию', async () => {
    const logs = Array.from({ length: 21 }, (_, logIndex) => ({
      logIndex,
      address: from,
      topics: [eventSignature],
    }));
    const getChainId = vi
      .fn<TransactionReceiptClient['getChainId']>()
      .mockResolvedValue(11_155_111);
    const readReceipt = vi
      .fn<TransactionReceiptClient['getTransactionReceipt']>()
      .mockResolvedValue({ ...successfulReceipt, logs });

    const result = await getTransactionReceipt(
      { getChainId, getTransactionReceipt: readReceipt },
      { hash: transactionHash },
    );

    expect(result.logs.count).toBe(21);
    expect(result.logs.summaries).toHaveLength(20);
    expect(result.logs.truncated).toBe(true);
  });

  it('поддерживает нулевой пользовательский лимит summaries', async () => {
    const getChainId = vi
      .fn<TransactionReceiptClient['getChainId']>()
      .mockResolvedValue(11_155_111);
    const readReceipt = vi
      .fn<TransactionReceiptClient['getTransactionReceipt']>()
      .mockResolvedValue(successfulReceipt);

    const result = await getTransactionReceipt(
      { getChainId, getTransactionReceipt: readReceipt },
      { hash: transactionHash },
      { maxLogSummaries: 0 },
    );

    expect(result.logs).toEqual({ count: 2, summaries: [], truncated: true });
  });

  it.each([-1, 101, 1.5])(
    'отклоняет некорректный лимит до RPC-вызовов: %s',
    async (maxLogSummaries) => {
      const getChainId = vi.fn<TransactionReceiptClient['getChainId']>();
      const readReceipt = vi.fn<TransactionReceiptClient['getTransactionReceipt']>();

      await expect(
        getTransactionReceipt(
          { getChainId, getTransactionReceipt: readReceipt },
          { hash: transactionHash },
          { maxLogSummaries },
        ),
      ).rejects.toBeInstanceOf(ZodError);
      expect(getChainId).not.toHaveBeenCalled();
      expect(readReceipt).not.toHaveBeenCalled();
    },
  );

  it('отклоняет RPC-ответ с другим transaction hash', async () => {
    const getChainId = vi
      .fn<TransactionReceiptClient['getChainId']>()
      .mockResolvedValue(11_155_111);
    const readReceipt = vi
      .fn<TransactionReceiptClient['getTransactionReceipt']>()
      .mockResolvedValue({ ...successfulReceipt, transactionHash: `0x${'d'.repeat(64)}` });

    await expect(
      getTransactionReceipt(
        { getChainId, getTransactionReceipt: readReceipt },
        { hash: transactionHash },
      ),
    ).rejects.toThrow('RPC response transaction hash does not match the requested hash.');
  });

  it.each([
    { status: '0x1' },
    { gasUsed: '0x5208' },
    { logs: [{ logIndex: 0, address: from, topics: Array(5).fill(eventSignature) }] },
  ])('оборачивает malformed RPC-ответ %#', async (malformedFields) => {
    const getChainId = vi
      .fn<TransactionReceiptClient['getChainId']>()
      .mockResolvedValue(11_155_111);
    const readReceipt = vi
      .fn<TransactionReceiptClient['getTransactionReceipt']>()
      .mockResolvedValue({ ...successfulReceipt, ...malformedFields });

    try {
      await getTransactionReceipt(
        { getChainId, getTransactionReceipt: readReceipt },
        { hash: transactionHash },
      );
      expect.unreachable('Ожидалась ошибка проверки RPC-ответа.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetTransactionReceiptError);

      if (!(error instanceof GetTransactionReceiptError)) {
        throw error;
      }

      expect(error.cause).toBeInstanceOf(ZodError);
    }
  });
});
