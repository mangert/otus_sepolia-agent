import { getAddress, isAddress, type Address, type Hash } from 'viem';
import { z } from 'zod';

const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/;
const decimalBlockNumberPattern = /^(0|[1-9][0-9]*)$/;

const collectionLimitSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const ethereumAddressSchema = z
  .string()
  .refine((value) => isAddress(value), 'Invalid Ethereum address.')
  .transform((value): Address => getAddress(value));

export const transactionHashSchema = z
  .string()
  .regex(transactionHashPattern, 'Transaction hash must be a 32-byte hex value.')
  .transform((value): Hash => value as Hash);

export const blockNumberSchema = z
  .union([
    z.bigint().nonnegative(),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(decimalBlockNumberPattern, 'Block number must be a non-negative integer.'),
  ])
  .transform((value): bigint => BigInt(value));

export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
  size: bigint;
}

/** Создаёт схему допустимого включительного диапазона блоков. */
export const createBlockRangeSchema = (maxRangeSize: number) => {
  const validatedMaxRangeSize = collectionLimitSchema.parse(maxRangeSize);
  const bigintMaxRangeSize = BigInt(validatedMaxRangeSize);

  return z
    .strictObject({
      fromBlock: blockNumberSchema,
      toBlock: blockNumberSchema,
    })
    .superRefine((range, context) => {
      if (range.toBlock < range.fromBlock) {
        context.addIssue({
          code: 'custom',
          message: 'toBlock must be greater than or equal to fromBlock.',
          path: ['toBlock'],
        });
        return;
      }

      const rangeSize = range.toBlock - range.fromBlock + 1n;

      if (rangeSize > bigintMaxRangeSize) {
        context.addIssue({
          code: 'custom',
          message: `Block range must contain at most ${validatedMaxRangeSize} blocks.`,
          path: ['toBlock'],
        });
      }
    })
    .transform((range): BlockRange => ({
      ...range,
      size: range.toBlock - range.fromBlock + 1n,
    }));
};

/** Создаёт схему массива с явным верхним пределом элементов. */
export const createLimitedArraySchema = <ItemSchema extends z.ZodType>(
  itemSchema: ItemSchema,
  maxItems: number,
) => {
  const validatedMaxItems = collectionLimitSchema.parse(maxItems);

  return z
    .array(itemSchema)
    .max(validatedMaxItems, `Array must contain at most ${validatedMaxItems} items.`);
};

/** Проверяет и нормализует Ethereum-адрес. */
export const validateEthereumAddress = (value: unknown): Address =>
  ethereumAddressSchema.parse(value);

/** Проверяет хэш Ethereum-транзакции без изменения значения. */
export const validateTransactionHash = (value: unknown): Hash => transactionHashSchema.parse(value);

/** Проверяет номер блока и преобразует его в bigint. */
export const validateBlockNumber = (value: unknown): bigint => blockNumberSchema.parse(value);

/** Проверяет порядок и включительный размер диапазона блоков. */
export const validateBlockRange = (value: unknown, maxRangeSize: number): BlockRange =>
  createBlockRangeSchema(maxRangeSize).parse(value);

/** Проверяет элементы массива и ограничивает их количество. */
export const validateLimitedArray = <Output>(
  value: unknown,
  itemSchema: z.ZodType<Output>,
  maxItems: number,
): Output[] => createLimitedArraySchema(itemSchema, maxItems).parse(value);
