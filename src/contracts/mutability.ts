import type { AbiFunction, AbiStateMutability } from 'viem';

import { getAbiFunctionSignature } from './abi.js';

export type ReadOnlyStateMutability = Extract<AbiStateMutability, 'view' | 'pure'>;
export type ReadOnlyAbiFunction = AbiFunction & {
  readonly stateMutability: ReadOnlyStateMutability;
};

export class AbiFunctionMutabilityError extends Error {
  readonly functionSignature: string;
  readonly stateMutability: unknown;

  constructor(functionSignature: string, stateMutability: unknown) {
    const mutabilityDescription =
      stateMutability === undefined
        ? 'missing stateMutability'
        : 'stateMutability "' + String(stateMutability) + '"';

    super(
      'ABI function "' +
        functionSignature +
        '" has ' +
        mutabilityDescription +
        '. Only view and pure functions are allowed.',
    );
    this.name = 'AbiFunctionMutabilityError';
    this.functionSignature = functionSignature;
    this.stateMutability = stateMutability;
  }
}

/** Разрешает только ABI-функции с mutability view или pure. */
export const validateReadOnlyAbiFunction = (abiFunction: AbiFunction): ReadOnlyAbiFunction => {
  const stateMutability: unknown = (abiFunction as Partial<AbiFunction>).stateMutability;

  if (stateMutability === 'view' || stateMutability === 'pure') {
    return abiFunction as ReadOnlyAbiFunction;
  }

  throw new AbiFunctionMutabilityError(getAbiFunctionSignature(abiFunction), stateMutability);
};
