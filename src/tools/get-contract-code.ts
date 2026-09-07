import { keccak256, type Address, type Hash, type Hex } from 'viem';
import { z } from 'zod';

import { verifySepoliaNetwork, type ChainIdReader } from '../blockchain/index.js';
import {
  hexDataSchema,
  validateBlockNumber,
  validateEthereumAddress,
} from '../validation/index.js';

export const DEFAULT_BYTECODE_PREVIEW_BYTES = 256;
export const MAX_BYTECODE_PREVIEW_BYTES = 4_096;

const contractCodeOptionsSchema = z.object({
  maxPreviewBytes: z
    .number()
    .int()
    .min(0)
    .max(MAX_BYTECODE_PREVIEW_BYTES)
    .default(DEFAULT_BYTECODE_PREVIEW_BYTES),
});

export interface ContractCodeClient extends ChainIdReader {
  getBlockNumber(): Promise<bigint>;
  getCode(parameters: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
}

export interface GetContractCodeInput {
  address: string;
  blockNumber?: bigint | number | string;
}

export interface GetContractCodeOptions {
  maxPreviewBytes?: number;
}

export interface ContractCodeResult {
  address: Address;
  blockNumber: string;
  isContract: boolean;
  bytecodeSizeBytes: number;
  bytecodeHash: Hash | null;
  bytecodePreview: Hex;
  bytecodeTruncated: boolean;
}

export class GetContractCodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GetContractCodeError';
  }
}

/** Возвращает ограниченную сводку bytecode по адресу на выбранном блоке Sepolia. */
export const getContractCode = async (
  client: ContractCodeClient,
  input: GetContractCodeInput,
  options: GetContractCodeOptions = {},
): Promise<ContractCodeResult> => {
  const address = validateEthereumAddress(input.address);
  const requestedBlockNumber =
    input.blockNumber === undefined ? undefined : validateBlockNumber(input.blockNumber);
  const { maxPreviewBytes } = contractCodeOptionsSchema.parse(options);

  await verifySepoliaNetwork(client);

  let blockNumber = requestedBlockNumber;

  if (blockNumber === undefined) {
    try {
      blockNumber = validateBlockNumber(await client.getBlockNumber());
    } catch (error: unknown) {
      throw new GetContractCodeError('Unable to resolve the latest Sepolia block number.', {
        cause: error,
      });
    }
  }

  let bytecode: Hex;

  try {
    bytecode = hexDataSchema.parse((await client.getCode({ address, blockNumber })) ?? '0x');
  } catch (error: unknown) {
    throw new GetContractCodeError('Unable to read bytecode from Sepolia.', {
      cause: error,
    });
  }

  const bytecodeSizeBytes = (bytecode.length - 2) / 2;
  const isContract = bytecodeSizeBytes > 0;
  const bytecodeTruncated = bytecodeSizeBytes > maxPreviewBytes;
  const previewEnd = 2 + maxPreviewBytes * 2;
  const bytecodePreview = bytecode.slice(0, previewEnd) as Hex;

  return {
    address,
    blockNumber: blockNumber.toString(10),
    isContract,
    bytecodeSizeBytes,
    bytecodeHash: isContract ? keccak256(bytecode) : null,
    bytecodePreview,
    bytecodeTruncated,
  };
};
