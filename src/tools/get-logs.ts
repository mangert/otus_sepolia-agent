import { numberToHex, type Address, type Hash, type Hex } from 'viem';
import { z } from 'zod';

import { verifySepoliaNetwork, type ChainIdReader } from '../blockchain/index.js';
import {
  ethereumAddressSchema,
  ethereumHashSchema,
  hexDataSchema,
  validateBlockRange,
  validateEthereumAddress,
} from '../validation/index.js';

export const DEFAULT_LOG_BLOCK_RANGE = 2_000;
export const MAX_LOG_BLOCK_RANGE = 10_000;
export const DEFAULT_LOG_RESULT_LIMIT = 20;
export const MAX_LOG_RESULT_LIMIT = 100;
export const DEFAULT_LOG_DATA_PREVIEW_BYTES = 256;
export const MAX_LOG_DATA_PREVIEW_BYTES = 4_096;
export const MAX_TOPIC_OR_VALUES = 20;
export const MAX_RPC_LOG_RESULTS = 10_000;

const rpcQuantitySchema = z
  .string()
  .regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/, 'Invalid JSON-RPC quantity.')
  .transform((value): bigint => BigInt(value));

const topicFilterSchema = z.union([
  ethereumHashSchema,
  z.array(ethereumHashSchema).min(1).max(MAX_TOPIC_OR_VALUES),
  z.null(),
]);

const topicsSchema = z.array(topicFilterSchema).max(4).default([]);

const rawLogSchema = z.object({
  address: ethereumAddressSchema,
  blockHash: ethereumHashSchema,
  blockNumber: rpcQuantitySchema,
  transactionHash: ethereumHashSchema,
  transactionIndex: rpcQuantitySchema,
  logIndex: rpcQuantitySchema,
  data: hexDataSchema,
  topics: z.array(ethereumHashSchema).max(4),
  removed: z.boolean().optional().default(false),
});

const rawLogsSchema = z.array(rawLogSchema).max(MAX_RPC_LOG_RESULTS);

const getLogsOptionsSchema = z.object({
  maxBlockRange: z.number().int().min(1).max(MAX_LOG_BLOCK_RANGE).default(DEFAULT_LOG_BLOCK_RANGE),
  maxResults: z.number().int().min(0).max(MAX_LOG_RESULT_LIMIT).default(DEFAULT_LOG_RESULT_LIMIT),
  maxDataPreviewBytes: z
    .number()
    .int()
    .min(0)
    .max(MAX_LOG_DATA_PREVIEW_BYTES)
    .default(DEFAULT_LOG_DATA_PREVIEW_BYTES),
});

export type TopicFilter = Hash | Hash[] | null;

export interface LogsRpcFilter {
  address: Address;
  fromBlock: Hex;
  toBlock: Hex;
  topics: TopicFilter[];
}

export interface LogsRpcRequest {
  method: 'eth_getLogs';
  params: [LogsRpcFilter];
}

export interface LogsClient extends ChainIdReader {
  request(request: LogsRpcRequest): Promise<unknown>;
}

export interface GetLogsInput {
  address: string;
  fromBlock: bigint | number | string;
  toBlock: bigint | number | string;
  topics?: (string | string[] | null)[];
}

export interface GetLogsOptions {
  maxBlockRange?: number;
  maxResults?: number;
  maxDataPreviewBytes?: number;
}

export interface LogResult {
  address: Address;
  blockHash: Hash;
  blockNumber: string;
  transactionHash: Hash;
  transactionIndex: string;
  logIndex: string;
  topics: Hash[];
  removed: boolean;
  dataSizeBytes: number;
  dataPreview: Hex;
  dataTruncated: boolean;
}

export interface GetLogsResult {
  address: Address;
  fromBlock: string;
  toBlock: string;
  blockCount: string;
  matchedLogCount: number;
  logs: LogResult[];
  logsTruncated: boolean;
}

export class GetLogsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GetLogsError';
  }
}

/** Преобразует RPC-лог в компактный JSON-совместимый результат. */
const formatLog = (log: z.infer<typeof rawLogSchema>, maxDataPreviewBytes: number): LogResult => {
  const dataSizeBytes = (log.data.length - 2) / 2;
  const previewEnd = 2 + maxDataPreviewBytes * 2;

  return {
    address: log.address,
    blockHash: log.blockHash,
    blockNumber: log.blockNumber.toString(10),
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex.toString(10),
    logIndex: log.logIndex.toString(10),
    topics: log.topics,
    removed: log.removed,
    dataSizeBytes,
    dataPreview: log.data.slice(0, previewEnd) as Hex,
    dataTruncated: dataSizeBytes > maxDataPreviewBytes,
  };
};

/** Возвращает ограниченный список логов контракта из диапазона блоков Sepolia. */
export const getLogs = async (
  client: LogsClient,
  input: GetLogsInput,
  options: GetLogsOptions = {},
): Promise<GetLogsResult> => {
  const address = validateEthereumAddress(input.address);
  const { maxBlockRange, maxResults, maxDataPreviewBytes } = getLogsOptionsSchema.parse(options);
  const range = validateBlockRange(
    { fromBlock: input.fromBlock, toBlock: input.toBlock },
    maxBlockRange,
  );
  const topics = topicsSchema.parse(input.topics ?? []);

  await verifySepoliaNetwork(client);

  let rawLogs: z.infer<typeof rawLogsSchema>;

  try {
    rawLogs = rawLogsSchema.parse(
      await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address,
            fromBlock: numberToHex(range.fromBlock),
            toBlock: numberToHex(range.toBlock),
            topics,
          },
        ],
      }),
    );
  } catch (error: unknown) {
    throw new GetLogsError('Unable to read logs from Sepolia.', {
      cause: error,
    });
  }

  return {
    address,
    fromBlock: range.fromBlock.toString(10),
    toBlock: range.toBlock.toString(10),
    blockCount: range.size.toString(10),
    matchedLogCount: rawLogs.length,
    logs: rawLogs.slice(0, maxResults).map((log) => formatLog(log, maxDataPreviewBytes)),
    logsTruncated: rawLogs.length > maxResults,
  };
};
