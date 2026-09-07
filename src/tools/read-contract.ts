import type { Address } from 'viem';

import { verifySepoliaNetwork, type ChainIdReader } from '../blockchain/index.js';
import {
  AbiFunctionSelectorError,
  findAbiFunction,
  getAbiFunctionSignature,
  validateAbiFunctionArguments,
  validateReadOnlyAbiFunction,
  type ReadOnlyAbiFunction,
  type ReadOnlyStateMutability,
} from '../contracts/index.js';
import { toJsonValue, type JsonValue } from '../serialization/index.js';
import { validateBlockNumber, validateEthereumAddress } from '../validation/index.js';

export interface ReadContractRequest {
  address: Address;
  abi: readonly [ReadOnlyAbiFunction];
  functionName: string;
  args: readonly unknown[];
  blockNumber: bigint;
}

export interface ReadContractClient extends ChainIdReader {
  getBlockNumber(): Promise<bigint>;
  readContract(parameters: ReadContractRequest): Promise<unknown>;
}

export interface ReadContractInput {
  address: string;
  abi: unknown;
  functionSignature: string;
  args?: unknown;
  blockNumber?: bigint | number | string;
}

export interface ReadContractResult {
  address: Address;
  blockNumber: string;
  functionSignature: string;
  stateMutability: ReadOnlyStateMutability;
  result: JsonValue;
}

export class ReadContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReadContractError';
  }
}

/** Проверяет, что передана каноническая полная сигнатура функции. */
const validateFullFunctionSignature = (input: unknown): string => {
  if (typeof input !== 'string') {
    throw new AbiFunctionSelectorError(
      'read_contract requires a canonical full ABI function signature.',
    );
  }

  const signature = input.trim();

  if (!signature.includes('(') || !signature.endsWith(')')) {
    throw new AbiFunctionSelectorError(
      'read_contract requires a canonical full ABI function signature.',
    );
  }

  return signature;
};

/** Вызывает только view или pure функцию контракта на зафиксированном блоке Sepolia. */
export const readContract = async (
  client: ReadContractClient,
  input: ReadContractInput,
): Promise<ReadContractResult> => {
  const address = validateEthereumAddress(input.address);
  const requestedBlockNumber =
    input.blockNumber === undefined ? undefined : validateBlockNumber(input.blockNumber);
  const requestedFunctionSignature = validateFullFunctionSignature(input.functionSignature);
  const abiFunction = findAbiFunction(input.abi, requestedFunctionSignature);
  const canonicalFunctionSignature = getAbiFunctionSignature(abiFunction);

  if (requestedFunctionSignature !== canonicalFunctionSignature) {
    throw new AbiFunctionSelectorError(
      'Function signature must be canonical. Use "' + canonicalFunctionSignature + '".',
    );
  }

  const readOnlyAbiFunction = validateReadOnlyAbiFunction(abiFunction);
  const args = validateAbiFunctionArguments(readOnlyAbiFunction, input.args);

  await verifySepoliaNetwork(client);

  let blockNumber = requestedBlockNumber;

  if (blockNumber === undefined) {
    try {
      blockNumber = validateBlockNumber(await client.getBlockNumber());
    } catch (error: unknown) {
      throw new ReadContractError('Unable to resolve the latest Sepolia block number.', {
        cause: error,
      });
    }
  }

  let rawResult: unknown;

  try {
    rawResult = await client.readContract({
      address,
      abi: [readOnlyAbiFunction],
      functionName: readOnlyAbiFunction.name,
      args,
      blockNumber,
    });
  } catch (error: unknown) {
    throw new ReadContractError(
      'Unable to call ' + canonicalFunctionSignature + ' on Sepolia contract ' + address + '.',
      { cause: error },
    );
  }

  let result: JsonValue;

  try {
    result = toJsonValue(rawResult);
  } catch (error: unknown) {
    throw new ReadContractError(
      'Unable to serialize the result of ' + canonicalFunctionSignature + '.',
      { cause: error },
    );
  }

  return {
    address,
    blockNumber: blockNumber.toString(10),
    functionSignature: canonicalFunctionSignature,
    stateMutability: readOnlyAbiFunction.stateMutability,
    result,
  };
};
