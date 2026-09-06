import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { SepoliaChainMismatchError } from '../blockchain/index.js';
import { GetBlockError, getBlock, type BlockClient } from './get-block.js';

const blockHash = `0x${'a'.repeat(64)}`;
const parentHash = `0x${'b'.repeat(64)}`;
const miner = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummedMiner = '0x52908400098527886E0F7030069857D2E4169EE7';
const transactionHashes = [`0x${'1'.repeat(64)}`, `0x${'2'.repeat(64)}`];

const blockFixture = {
  number: 12_345_678n,
  hash: blockHash,
  parentHash,
  timestamp: 1_700_000_000n,
  miner,
  gasLimit: 30_000_000n,
  gasUsed: 21_000n,
  baseFeePerGas: 1_000_000_000n,
  transactions: transactionHashes,
};

describe('getBlock', () => {
  it('получает существующий блок по номеру', async () => {
    const getChainId = vi.fn<BlockClient['getChainId']>().mockResolvedValue(11_155_111);
    const readBlock = vi.fn<BlockClient['getBlock']>().mockResolvedValue(blockFixture);

    await expect(
      getBlock({ getChainId, getBlock: readBlock }, { identifier: 12_345_678 }),
    ).resolves.toEqual({
      number: '12345678',
      hash: blockHash,
      parentHash,
      timestamp: '1700000000',
      miner: checksummedMiner,
      gasLimit: '30000000',
      gasUsed: '21000',
      baseFeePerGas: '1000000000',
      transactionCount: 2,
      transactionHashes,
      transactionsTruncated: false,
    });
    expect(readBlock).toHaveBeenCalledOnce();
    expect(readBlock).toHaveBeenCalledWith({
      blockNumber: 12_345_678n,
      includeTransactions: false,
    });
  });

  it('получает блок по тегу latest', async () => {
    const getChainId = vi.fn<BlockClient['getChainId']>().mockResolvedValue(11_155_111);
    const readBlock = vi.fn<BlockClient['getBlock']>().mockResolvedValue(blockFixture);

    await getBlock({ getChainId, getBlock: readBlock }, { identifier: 'latest' });

    expect(readBlock).toHaveBeenCalledWith({
      blockTag: 'latest',
      includeTransactions: false,
    });
  });

  it('получает блок по hash без изменения значения', async () => {
    const mixedCaseHash = `0x${'aB'.repeat(32)}`;
    const getChainId = vi.fn<BlockClient['getChainId']>().mockResolvedValue(11_155_111);
    const readBlock = vi.fn<BlockClient['getBlock']>().mockResolvedValue(blockFixture);

    await getBlock({ getChainId, getBlock: readBlock }, { identifier: mixedCaseHash });

    expect(readBlock).toHaveBeenCalledWith({
      blockHash: mixedCaseHash,
      includeTransactions: false,
    });
  });

  it('принимает большой номер блока как десятичную строку', async () => {
    const getChainId = vi.fn<BlockClient['getChainId']>().mockResolvedValue(11_155_111);
    const readBlock = vi.fn<BlockClient['getBlock']>().mockResolvedValue(blockFixture);

    await getBlock(
      { getChainId, getBlock: readBlock },
      { identifier: '90071992547409931234567890' },
    );

    expect(readBlock).toHaveBeenCalledWith({
      blockNumber: 90_071_992_547_409_931_234_567_890n,
      includeTransactions: false,
    });
  });

  it('ограничивает количество возвращаемых хэшей транзакций', async () => {
    const hashes = Array.from(
      { length: 22 },
      (_, index) => `0x${index.toString(16).padStart(64, '0')}`,
    );
    const getChainId = vi.fn<BlockClient['getChainId']>().mockResolvedValue(11_155_111);
    const readBlock = vi
      .fn<BlockClient['getBlock']>()
      .mockResolvedValue({ ...blockFixture, transactions: hashes });

    const result = await getBlock({ getChainId, getBlock: readBlock }, { identifier: 'latest' });

    expect(result.transactionCount).toBe(22);
    expect(result.transactionHashes).toEqual(hashes.slice(0, 20));
    expect(result.transactionsTruncated).toBe(true);
  });

  it('поддерживает пользовательский лимит и null base fee', async () => {
    const getChainId = vi.fn<BlockClient['getChainId']>().mockResolvedValue(11_155_111);
    const readBlock = vi
      .fn<BlockClient['getBlock']>()
      .mockResolvedValue({ ...blockFixture, baseFeePerGas: null });

    const result = await getBlock(
      { getChainId, getBlock: readBlock },
      { identifier: 'latest' },
      { maxTransactionHashes: 1 },
    );

    expect(result.baseFeePerGas).toBeNull();
    expect(result.transactionHashes).toEqual(transactionHashes.slice(0, 1));
    expect(result.transactionsTruncated).toBe(true);
  });

  it.each([-1, 'pending', '01', '0x1234'])(
    'отклоняет некорректный идентификатор до RPC-вызовов: %s',
    async (identifier) => {
      const getChainId = vi.fn<BlockClient['getChainId']>();
      const readBlock = vi.fn<BlockClient['getBlock']>();

      await expect(
        getBlock({ getChainId, getBlock: readBlock }, { identifier }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(getChainId).not.toHaveBeenCalled();
      expect(readBlock).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 101, 1.5])(
    'отклоняет некорректный лимит до RPC-вызовов: %s',
    async (maxTransactionHashes) => {
      const getChainId = vi.fn<BlockClient['getChainId']>();
      const readBlock = vi.fn<BlockClient['getBlock']>();

      await expect(
        getBlock(
          { getChainId, getBlock: readBlock },
          { identifier: 'latest' },
          { maxTransactionHashes },
        ),
      ).rejects.toBeInstanceOf(ZodError);
      expect(getChainId).not.toHaveBeenCalled();
      expect(readBlock).not.toHaveBeenCalled();
    },
  );

  it('не запрашивает блок при подключении к другой сети', async () => {
    const getChainId = vi.fn<BlockClient['getChainId']>().mockResolvedValue(1);
    const readBlock = vi.fn<BlockClient['getBlock']>();

    await expect(
      getBlock({ getChainId, getBlock: readBlock }, { identifier: 'latest' }),
    ).rejects.toBeInstanceOf(SepoliaChainMismatchError);
    expect(readBlock).not.toHaveBeenCalled();
  });

  it('сохраняет причину ошибки отсутствующего блока', async () => {
    const cause = Object.assign(new Error('Block not found'), { code: -32_001 });
    const getChainId = vi.fn<BlockClient['getChainId']>().mockResolvedValue(11_155_111);
    const readBlock = vi.fn<BlockClient['getBlock']>().mockRejectedValue(cause);

    try {
      await getBlock({ getChainId, getBlock: readBlock }, { identifier: 999_999_999 });
      expect.unreachable('Ожидалась ошибка отсутствующего блока.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetBlockError);

      if (!(error instanceof GetBlockError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to read the requested Sepolia block.');
      expect(error.cause).toBe(cause);
    }
  });

  it('оборачивает ошибку некорректного RPC-ответа', async () => {
    const getChainId = vi.fn<BlockClient['getChainId']>().mockResolvedValue(11_155_111);
    const readBlock = vi
      .fn<BlockClient['getBlock']>()
      .mockResolvedValue({ ...blockFixture, hash: null });

    try {
      await getBlock({ getChainId, getBlock: readBlock }, { identifier: 'latest' });
      expect.unreachable('Ожидалась ошибка проверки RPC-ответа.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetBlockError);

      if (!(error instanceof GetBlockError)) {
        throw error;
      }

      expect(error.cause).toBeInstanceOf(ZodError);
    }
  });
});
