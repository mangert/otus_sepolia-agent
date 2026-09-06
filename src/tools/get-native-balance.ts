import { formatEther, type Address } from 'viem';
import { z } from 'zod';

import { verifySepoliaNetwork, type ChainIdReader } from '../blockchain/index.js';
import { validateBlockNumber, validateEthereumAddress } from '../validation/index.js';

const nativeBalanceSchema = z.bigint().nonnegative();

export interface NativeBalanceClient extends ChainIdReader {
  getBlockNumber(): Promise<bigint>;
  getBalance(parameters: { address: Address; blockNumber: bigint }): Promise<bigint>;
}

export interface NativeBalanceInput {
  address: string;
  blockNumber?: bigint | number | string;
}

export interface NativeBalanceResult {
  address: Address;
  blockNumber: string;
  balanceWei: string;
  balanceEth: string;
}

export class GetNativeBalanceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GetNativeBalanceError';
  }
}

/** Возвращает нативный баланс адреса на зафиксированном блоке Sepolia. */
export const getNativeBalance = async (
  client: NativeBalanceClient,
  input: NativeBalanceInput,
): Promise<NativeBalanceResult> => {
  const address = validateEthereumAddress(input.address);
  const requestedBlockNumber =
    input.blockNumber === undefined ? undefined : validateBlockNumber(input.blockNumber);

  await verifySepoliaNetwork(client);

  let blockNumber = requestedBlockNumber;

  if (blockNumber === undefined) {
    try {
      blockNumber = validateBlockNumber(await client.getBlockNumber());
    } catch (error: unknown) {
      throw new GetNativeBalanceError('Unable to resolve the latest Sepolia block number.', {
        cause: error,
      });
    }
  }

  let balanceWei: bigint;

  try {
    balanceWei = nativeBalanceSchema.parse(await client.getBalance({ address, blockNumber }));
  } catch (error: unknown) {
    throw new GetNativeBalanceError('Unable to read the native balance from Sepolia.', {
      cause: error,
    });
  }

  return {
    address,
    blockNumber: blockNumber.toString(10),
    balanceWei: balanceWei.toString(10),
    balanceEth: formatEther(balanceWei),
  };
};
