import { formatUnits, type Address } from 'viem';
import { z } from 'zod';

import { verifySepoliaNetwork, type ChainIdReader } from '../blockchain/index.js';
import { validateBlockNumber, validateEthereumAddress } from '../validation/index.js';
import type { ReadContractRequest } from './read-contract.js';

const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;
const ERC20_DECIMALS_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;
const ERC20_SYMBOL_ABI = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const;
const balanceSchema = z.bigint().nonnegative();
const decimalsSchema = z.number().int().min(0).max(255);
const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[\p{L}\p{N}._-]+$/u);

export interface Erc20BalanceClient extends ChainIdReader {
  getBlockNumber(): Promise<bigint>;
  readContract(parameters: ReadContractRequest): Promise<unknown>;
}

export interface Erc20BalanceInput {
  tokenAddress: string;
  ownerAddress: string;
  blockNumber?: bigint | number | string;
}

export interface Erc20BalanceResult {
  tokenAddress: Address;
  ownerAddress: Address;
  blockNumber: string;
  balanceRaw: string;
  balanceFormatted?: string;
  decimals?: number;
  symbol?: string;
  metadataWarnings?: string[];
}

export class GetErc20BalanceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GetErc20BalanceError';
  }
}

/** Читает ERC-20 баланс и доступные метаданные на одном блоке Sepolia. */
export const getErc20Balance = async (
  client: Erc20BalanceClient,
  input: Erc20BalanceInput,
): Promise<Erc20BalanceResult> => {
  const tokenAddress = validateEthereumAddress(input.tokenAddress);
  const ownerAddress = validateEthereumAddress(input.ownerAddress);
  const requestedBlockNumber =
    input.blockNumber === undefined ? undefined : validateBlockNumber(input.blockNumber);

  await verifySepoliaNetwork(client);

  let blockNumber = requestedBlockNumber;

  if (blockNumber === undefined) {
    try {
      blockNumber = validateBlockNumber(await client.getBlockNumber());
    } catch (error: unknown) {
      throw new GetErc20BalanceError('Unable to resolve the latest Sepolia block number.', {
        cause: error,
      });
    }
  }

  let balanceRaw: bigint;

  try {
    balanceRaw = balanceSchema.parse(
      await client.readContract({
        address: tokenAddress,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: 'balanceOf',
        args: [ownerAddress],
        blockNumber,
      }),
    );
  } catch (error: unknown) {
    throw new GetErc20BalanceError(
      'Unable to read the ERC-20 balance from Sepolia contract ' + tokenAddress + '.',
      { cause: error },
    );
  }

  const [decimalsResult, symbolResult] = await Promise.allSettled([
    client.readContract({
      address: tokenAddress,
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
      args: [],
      blockNumber,
    }),
    client.readContract({
      address: tokenAddress,
      abi: ERC20_SYMBOL_ABI,
      functionName: 'symbol',
      args: [],
      blockNumber,
    }),
  ]);
  const metadataWarnings: string[] = [];
  let decimals: number | undefined;
  let symbol: string | undefined;

  if (decimalsResult.status === 'fulfilled') {
    const parsedDecimals = decimalsSchema.safeParse(decimalsResult.value);
    if (parsedDecimals.success) {
      decimals = parsedDecimals.data;
    } else {
      metadataWarnings.push('The token returned invalid decimals metadata.');
    }
  } else {
    metadataWarnings.push('The token decimals() call failed.');
  }

  if (symbolResult.status === 'fulfilled') {
    const parsedSymbol = symbolSchema.safeParse(symbolResult.value);
    if (parsedSymbol.success) {
      symbol = parsedSymbol.data;
    } else {
      metadataWarnings.push('The token returned invalid symbol metadata.');
    }
  } else {
    metadataWarnings.push('The token symbol() call failed.');
  }

  return {
    tokenAddress,
    ownerAddress,
    blockNumber: blockNumber.toString(10),
    balanceRaw: balanceRaw.toString(10),
    ...(decimals === undefined
      ? {}
      : { decimals, balanceFormatted: formatUnits(balanceRaw, decimals) }),
    ...(symbol === undefined ? {} : { symbol }),
    ...(metadataWarnings.length === 0 ? {} : { metadataWarnings }),
  };
};
