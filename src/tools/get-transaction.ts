import type { Address, Hash, Hex } from 'viem';
import { z } from 'zod';

import { verifySepoliaNetwork, type ChainIdReader } from '../blockchain/index.js';
import {
  blockNumberSchema,
  ethereumAddressSchema,
  ethereumHashSchema,
  hexDataSchema,
  validateTransactionHash,
} from '../validation/index.js';

const safeRpcIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const transactionResponseSchema = z
  .object({
    hash: ethereumHashSchema,
    blockHash: ethereumHashSchema.nullable(),
    blockNumber: blockNumberSchema.nullable(),
    transactionIndex: safeRpcIntegerSchema.nullable(),
    from: ethereumAddressSchema,
    to: ethereumAddressSchema.nullable(),
    value: z.bigint().nonnegative(),
    nonce: safeRpcIntegerSchema,
    gas: z.bigint().nonnegative(),
    gasPrice: z.bigint().nonnegative().nullish(),
    maxFeePerGas: z.bigint().nonnegative().nullish(),
    maxPriorityFeePerGas: z.bigint().nonnegative().nullish(),
    input: hexDataSchema,
    type: z.string().min(1),
  })
  .superRefine((transaction, context) => {
    const blockFields = [
      transaction.blockHash,
      transaction.blockNumber,
      transaction.transactionIndex,
    ];
    const nullBlockFieldCount = blockFields.filter((value) => value === null).length;

    if (nullBlockFieldCount !== 0 && nullBlockFieldCount !== blockFields.length) {
      context.addIssue({
        code: 'custom',
        message: 'Transaction block fields must be either all null or all populated.',
      });
    }
  });

export interface TransactionClient extends ChainIdReader {
  getTransaction(parameters: { hash: Hash }): Promise<unknown>;
}

export interface GetTransactionInput {
  hash: string;
}

export interface TransactionResult {
  hash: Hash;
  status: 'confirmed' | 'pending';
  blockHash: Hash | null;
  blockNumber: string | null;
  transactionIndex: string | null;
  from: Address;
  to: Address | null;
  valueWei: string;
  nonce: string;
  gasLimit: string;
  gasPriceWei: string | null;
  maxFeePerGasWei: string | null;
  maxPriorityFeePerGasWei: string | null;
  input: Hex;
  type: string;
}

export class GetTransactionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GetTransactionError';
  }
}

/** Возвращает основные поля транзакции Sepolia без потери числовой точности. */
export const getTransaction = async (
  client: TransactionClient,
  input: GetTransactionInput,
): Promise<TransactionResult> => {
  const requestedHash = validateTransactionHash(input.hash);

  await verifySepoliaNetwork(client);

  let transaction: z.infer<typeof transactionResponseSchema>;

  try {
    transaction = transactionResponseSchema.parse(
      await client.getTransaction({ hash: requestedHash }),
    );
  } catch (error: unknown) {
    throw new GetTransactionError('Unable to read the requested Sepolia transaction.', {
      cause: error,
    });
  }

  if (transaction.hash.toLowerCase() !== requestedHash.toLowerCase()) {
    throw new GetTransactionError(
      'RPC response transaction hash does not match the requested hash.',
    );
  }

  return {
    hash: transaction.hash,
    status: transaction.blockNumber === null ? 'pending' : 'confirmed',
    blockHash: transaction.blockHash,
    blockNumber: transaction.blockNumber?.toString(10) ?? null,
    transactionIndex: transaction.transactionIndex?.toString(10) ?? null,
    from: transaction.from,
    to: transaction.to,
    valueWei: transaction.value.toString(10),
    nonce: transaction.nonce.toString(10),
    gasLimit: transaction.gas.toString(10),
    gasPriceWei: transaction.gasPrice?.toString(10) ?? null,
    maxFeePerGasWei: transaction.maxFeePerGas?.toString(10) ?? null,
    maxPriorityFeePerGasWei: transaction.maxPriorityFeePerGas?.toString(10) ?? null,
    input: transaction.input,
    type: transaction.type,
  };
};
