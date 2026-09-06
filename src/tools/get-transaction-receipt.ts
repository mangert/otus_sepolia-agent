import type { Address, Hash } from 'viem';
import { z } from 'zod';

import { verifySepoliaNetwork, type ChainIdReader } from '../blockchain/index.js';
import {
  blockNumberSchema,
  ethereumAddressSchema,
  ethereumHashSchema,
  validateTransactionHash,
} from '../validation/index.js';

export const DEFAULT_RECEIPT_LOG_SUMMARY_LIMIT = 20;
export const MAX_RECEIPT_LOG_SUMMARY_LIMIT = 100;

const safeRpcIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const receiptLogSchema = z.object({
  logIndex: safeRpcIntegerSchema,
  address: ethereumAddressSchema,
  topics: z.array(ethereumHashSchema).max(4),
});

const receiptResponseSchema = z.object({
  transactionHash: ethereumHashSchema,
  transactionIndex: safeRpcIntegerSchema,
  blockHash: ethereumHashSchema,
  blockNumber: blockNumberSchema,
  from: ethereumAddressSchema,
  to: ethereumAddressSchema.nullable(),
  contractAddress: ethereumAddressSchema.nullable(),
  status: z.enum(['success', 'reverted']),
  gasUsed: z.bigint().nonnegative(),
  cumulativeGasUsed: z.bigint().nonnegative(),
  effectiveGasPrice: z.bigint().nonnegative(),
  type: z.string().min(1),
  logs: z.array(receiptLogSchema),
});

const receiptOptionsSchema = z.object({
  maxLogSummaries: z
    .number()
    .int()
    .min(0)
    .max(MAX_RECEIPT_LOG_SUMMARY_LIMIT)
    .default(DEFAULT_RECEIPT_LOG_SUMMARY_LIMIT),
});

export interface TransactionReceiptClient extends ChainIdReader {
  getTransactionReceipt(parameters: { hash: Hash }): Promise<unknown>;
}

export interface GetTransactionReceiptInput {
  hash: string;
}

export interface GetTransactionReceiptOptions {
  maxLogSummaries?: number;
}

export interface ReceiptLogSummary {
  logIndex: string;
  address: Address;
  topicCount: number;
  eventSignature: Hash | null;
}

export interface TransactionReceiptResult {
  transactionHash: Hash;
  status: 'success' | 'reverted';
  blockHash: Hash;
  blockNumber: string;
  transactionIndex: string;
  from: Address;
  to: Address | null;
  contractAddress: Address | null;
  gasUsed: string;
  cumulativeGasUsed: string;
  effectiveGasPriceWei: string;
  type: string;
  logs: {
    count: number;
    summaries: ReceiptLogSummary[];
    truncated: boolean;
  };
}

export class GetTransactionReceiptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GetTransactionReceiptError';
  }
}

/** Возвращает статус и краткую сводку receipt транзакции Sepolia. */
export const getTransactionReceipt = async (
  client: TransactionReceiptClient,
  input: GetTransactionReceiptInput,
  options: GetTransactionReceiptOptions = {},
): Promise<TransactionReceiptResult> => {
  const requestedHash = validateTransactionHash(input.hash);
  const { maxLogSummaries } = receiptOptionsSchema.parse(options);

  await verifySepoliaNetwork(client);

  let receipt: z.infer<typeof receiptResponseSchema>;

  try {
    receipt = receiptResponseSchema.parse(
      await client.getTransactionReceipt({ hash: requestedHash }),
    );
  } catch (error: unknown) {
    throw new GetTransactionReceiptError(
      'Unable to read the requested Sepolia transaction receipt.',
      { cause: error },
    );
  }

  if (receipt.transactionHash.toLowerCase() !== requestedHash.toLowerCase()) {
    throw new GetTransactionReceiptError(
      'RPC response transaction hash does not match the requested hash.',
    );
  }

  const logSummaries = receipt.logs.slice(0, maxLogSummaries).map((log) => ({
    logIndex: log.logIndex.toString(10),
    address: log.address,
    topicCount: log.topics.length,
    eventSignature: log.topics[0] ?? null,
  }));

  return {
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(10),
    transactionIndex: receipt.transactionIndex.toString(10),
    from: receipt.from,
    to: receipt.to,
    contractAddress: receipt.contractAddress,
    gasUsed: receipt.gasUsed.toString(10),
    cumulativeGasUsed: receipt.cumulativeGasUsed.toString(10),
    effectiveGasPriceWei: receipt.effectiveGasPrice.toString(10),
    type: receipt.type,
    logs: {
      count: receipt.logs.length,
      summaries: logSummaries,
      truncated: receipt.logs.length > maxLogSummaries,
    },
  };
};
