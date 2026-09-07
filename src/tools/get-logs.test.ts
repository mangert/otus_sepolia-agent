import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { SepoliaChainMismatchError } from '../blockchain/index.js';
import { GetLogsError, getLogs, type LogsClient } from './get-logs.js';

const address = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummedAddress = '0x52908400098527886E0F7030069857D2E4169EE7';
const blockHash = `0x${'a'.repeat(64)}`;
const transactionHash = `0x${'b'.repeat(64)}`;
const firstTopic = `0x${'c'.repeat(64)}`;
const secondTopic = `0x${'d'.repeat(64)}`;
const thirdTopic = `0x${'e'.repeat(64)}`;

const rawLog = {
  address,
  blockHash,
  blockNumber: '0x64',
  transactionHash,
  transactionIndex: '0x2',
  logIndex: '0x3',
  data: '0x11223344',
  topics: [firstTopic, secondTopic],
};

describe('getLogs', () => {
  it('передаёт адрес, диапазон и topics в eth_getLogs', async () => {
    const topics = [firstTopic, null, [secondTopic, thirdTopic]];
    const getChainId = vi.fn<LogsClient['getChainId']>().mockResolvedValue(11_155_111);
    const request = vi.fn<LogsClient['request']>().mockResolvedValue([rawLog]);

    await expect(
      getLogs(
        { getChainId, request },
        { address, fromBlock: 100, toBlock: '101', topics },
        { maxDataPreviewBytes: 2 },
      ),
    ).resolves.toEqual({
      address: checksummedAddress,
      fromBlock: '100',
      toBlock: '101',
      blockCount: '2',
      matchedLogCount: 1,
      logs: [
        {
          address: checksummedAddress,
          blockHash,
          blockNumber: '100',
          transactionHash,
          transactionIndex: '2',
          logIndex: '3',
          topics: [firstTopic, secondTopic],
          removed: false,
          dataSizeBytes: 4,
          dataPreview: '0x1122',
          dataTruncated: true,
        },
      ],
      logsTruncated: false,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getLogs',
      params: [
        {
          address: checksummedAddress,
          fromBlock: '0x64',
          toBlock: '0x65',
          topics,
        },
      ],
    });
  });

  it('возвращает пустой результат и пустой topics-фильтр', async () => {
    const getChainId = vi.fn<LogsClient['getChainId']>().mockResolvedValue(11_155_111);
    const request = vi.fn<LogsClient['request']>().mockResolvedValue([]);

    await expect(
      getLogs({ getChainId, request }, { address, fromBlock: 0, toBlock: 0 }),
    ).resolves.toMatchObject({
      blockCount: '1',
      matchedLogCount: 0,
      logs: [],
      logsTruncated: false,
    });
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getLogs',
      params: [expect.objectContaining({ fromBlock: '0x0', toBlock: '0x0', topics: [] })],
    });
  });

  it('принимает диапазон на точной границе лимита', async () => {
    const getChainId = vi.fn<LogsClient['getChainId']>().mockResolvedValue(11_155_111);
    const request = vi.fn<LogsClient['request']>().mockResolvedValue([]);

    await expect(
      getLogs({ getChainId, request }, { address, fromBlock: 1, toBlock: 2_000 }),
    ).resolves.toMatchObject({ blockCount: '2000' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('отклоняет превышение диапазона до RPC-вызовов', async () => {
    const getChainId = vi.fn<LogsClient['getChainId']>();
    const request = vi.fn<LogsClient['request']>();

    await expect(
      getLogs({ getChainId, request }, { address, fromBlock: 0, toBlock: 2_000 }),
    ).rejects.toThrow('Block range must contain at most 2000 blocks.');
    expect(getChainId).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['короткий hash', ['0x1234']],
    ['больше четырёх позиций', Array(5).fill(firstTopic)],
    ['пустой OR-массив', [[]]],
    ['больше двадцати OR-значений', [Array(21).fill(firstTopic)]],
  ])('отклоняет некорректные topics: %s', async (_caseName, topics) => {
    const getChainId = vi.fn<LogsClient['getChainId']>();
    const request = vi.fn<LogsClient['request']>();

    await expect(
      getLogs({ getChainId, request }, { address, fromBlock: 100, toBlock: 100, topics }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(getChainId).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('не запрашивает логи при подключении к другой сети', async () => {
    const getChainId = vi.fn<LogsClient['getChainId']>().mockResolvedValue(1);
    const request = vi.fn<LogsClient['request']>();

    await expect(
      getLogs({ getChainId, request }, { address, fromBlock: 100, toBlock: 100 }),
    ).rejects.toBeInstanceOf(SepoliaChainMismatchError);
    expect(request).not.toHaveBeenCalled();
  });

  it('сохраняет причину rate limit от RPC', async () => {
    const cause = Object.assign(new Error('rate limited'), { status: 429 });
    const getChainId = vi.fn<LogsClient['getChainId']>().mockResolvedValue(11_155_111);
    const request = vi.fn<LogsClient['request']>().mockRejectedValue(cause);

    try {
      await getLogs({ getChainId, request }, { address, fromBlock: 100, toBlock: 100 });
      expect.unreachable('Ожидалась RPC-ошибка получения логов.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetLogsError);

      if (!(error instanceof GetLogsError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to read logs from Sepolia.');
      expect(error.cause).toBe(cause);
    }
  });

  it('ограничивает количество возвращаемых логов', async () => {
    const getChainId = vi.fn<LogsClient['getChainId']>().mockResolvedValue(11_155_111);
    const request = vi
      .fn<LogsClient['request']>()
      .mockResolvedValue([rawLog, { ...rawLog, logIndex: '0x4', removed: true }]);

    const result = await getLogs(
      { getChainId, request },
      { address, fromBlock: 100, toBlock: 100 },
      { maxResults: 1 },
    );

    expect(result.matchedLogCount).toBe(2);
    expect(result.logs).toHaveLength(1);
    expect(result.logsTruncated).toBe(true);
  });

  it.each([
    { maxBlockRange: 0 },
    { maxBlockRange: 10_001 },
    { maxResults: 101 },
    { maxDataPreviewBytes: 4_097 },
  ])('отклоняет некорректные ограничения до RPC-вызовов: %#', async (options) => {
    const getChainId = vi.fn<LogsClient['getChainId']>();
    const request = vi.fn<LogsClient['request']>();

    await expect(
      getLogs({ getChainId, request }, { address, fromBlock: 100, toBlock: 100 }, options),
    ).rejects.toBeInstanceOf(ZodError);
    expect(getChainId).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['не массив', { ...rawLog }],
    ['quantity с ведущим нулём', [{ ...rawLog, blockNumber: '0x064' }]],
    ['data с неполным байтом', [{ ...rawLog, data: '0x1' }]],
    ['больше четырёх topics в логе', [{ ...rawLog, topics: Array(5).fill(firstTopic) }]],
  ])('оборачивает malformed RPC-ответ: %s', async (_caseName, response) => {
    const getChainId = vi.fn<LogsClient['getChainId']>().mockResolvedValue(11_155_111);
    const request = vi.fn<LogsClient['request']>().mockResolvedValue(response);

    try {
      await getLogs({ getChainId, request }, { address, fromBlock: 100, toBlock: 100 });
      expect.unreachable('Ожидалась ошибка проверки RPC-ответа.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetLogsError);

      if (!(error instanceof GetLogsError)) {
        throw error;
      }

      expect(error.cause).toBeInstanceOf(ZodError);
    }
  });
});
