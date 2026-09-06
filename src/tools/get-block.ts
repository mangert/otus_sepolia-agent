import type { Address, Hash } from 'viem';
import { z } from 'zod';

import { verifySepoliaNetwork, type ChainIdReader } from '../blockchain/index.js';
import {
  blockNumberSchema,
  ethereumAddressSchema,
  ethereumHashSchema,
  validateBlockNumber,
  validateEthereumHash,
} from '../validation/index.js';

export const DEFAULT_BLOCK_TRANSACTION_HASH_LIMIT = 20;
export const MAX_BLOCK_TRANSACTION_HASH_LIMIT = 100;

const blockResponseSchema = z.object({
  number: blockNumberSchema,
  hash: ethereumHashSchema,
  parentHash: ethereumHashSchema,
  timestamp: z.bigint().nonnegative(),
  miner: ethereumAddressSchema,
  gasLimit: z.bigint().nonnegative(),
  gasUsed: z.bigint().nonnegative(),
  baseFeePerGas: z.bigint().nonnegative().nullable(),
  transactions: z.array(ethereumHashSchema),
});

const getBlockOptionsSchema = z.object({
  maxTransactionHashes: z
    .number()
    .int()
    .min(0)
    .max(MAX_BLOCK_TRANSACTION_HASH_LIMIT)
    .default(DEFAULT_BLOCK_TRANSACTION_HASH_LIMIT),
});

export type BlockIdentifier = 'latest' | bigint | number | string;

export type BlockRequest =
  | { blockHash: Hash; includeTransactions: false }
  | { blockNumber: bigint; includeTransactions: false }
  | { blockTag: 'latest'; includeTransactions: false };

export interface BlockClient extends ChainIdReader {
  getBlock(parameters: BlockRequest): Promise<unknown>;
}

export interface GetBlockInput {
  identifier: BlockIdentifier;
}

export interface GetBlockOptions {
  maxTransactionHashes?: number;
}

export interface BlockResult {
  number: string;
  hash: Hash;
  parentHash: Hash;
  timestamp: string;
  miner: Address;
  gasLimit: string;
  gasUsed: string;
  baseFeePerGas: string | null;
  transactionCount: number;
  transactionHashes: Hash[];
  transactionsTruncated: boolean;
}

export class GetBlockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GetBlockError';
  }
}

/** Преобразует идентификатор блока в параметры viem. */
const createBlockRequest = (identifier: BlockIdentifier): BlockRequest => {
  if (identifier === 'latest') {
    return { blockTag: 'latest', includeTransactions: false };
  }

  if (typeof identifier === 'string' && identifier.startsWith('0x')) {
    return { blockHash: validateEthereumHash(identifier), includeTransactions: false };
  }

  return {
    blockNumber: validateBlockNumber(identifier),
    includeTransactions: false,
  };
};

/** Возвращает ограниченную сводку блока Sepolia. */
export const getBlock = async (
  client: BlockClient,
  input: GetBlockInput,
  options: GetBlockOptions = {},
): Promise<BlockResult> => {
  const request = createBlockRequest(input.identifier);
  const { maxTransactionHashes } = getBlockOptionsSchema.parse(options);

  await verifySepoliaNetwork(client);

  let block: z.infer<typeof blockResponseSchema>;

  try {
    block = blockResponseSchema.parse(await client.getBlock(request));
  } catch (error: unknown) {
    throw new GetBlockError('Unable to read the requested Sepolia block.', {
      cause: error,
    });
  }

  return {
    number: block.number.toString(10),
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp.toString(10),
    miner: block.miner,
    gasLimit: block.gasLimit.toString(10),
    gasUsed: block.gasUsed.toString(10),
    baseFeePerGas: block.baseFeePerGas?.toString(10) ?? null,
    transactionCount: block.transactions.length,
    transactionHashes: block.transactions.slice(0, maxTransactionHashes),
    transactionsTruncated: block.transactions.length > maxTransactionHashes,
  };
};
