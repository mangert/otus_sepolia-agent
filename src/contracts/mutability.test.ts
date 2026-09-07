import type { AbiFunction, AbiStateMutability } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  AbiFunctionMutabilityError,
  validateReadOnlyAbiFunction,
  type ReadOnlyStateMutability,
} from './mutability.js';

const createAbiFunction = (stateMutability: AbiStateMutability): AbiFunction => ({
  type: 'function',
  name: 'readValue',
  inputs: [{ name: 'id', type: 'uint256' }],
  outputs: [{ type: 'bytes32' }],
  stateMutability,
});

describe('validateReadOnlyAbiFunction', () => {
  it.each(['view', 'pure'] as const)('разрешает функцию с mutability %s', (stateMutability) => {
    const abiFunction = createAbiFunction(stateMutability);
    const result = validateReadOnlyAbiFunction(abiFunction);
    const narrowedMutability: ReadOnlyStateMutability = result.stateMutability;

    expect(result).toBe(abiFunction);
    expect(narrowedMutability).toBe(stateMutability);
  });

  it.each(['nonpayable', 'payable'] as const)(
    'отклоняет state-changing функцию с mutability %s',
    (stateMutability) => {
      const abiFunction = createAbiFunction(stateMutability);

      try {
        validateReadOnlyAbiFunction(abiFunction);
        expect.unreachable('Ожидался запрет state-changing функции.');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AbiFunctionMutabilityError);

        if (!(error instanceof AbiFunctionMutabilityError)) {
          throw error;
        }

        expect(error.functionSignature).toBe('readValue(uint256)');
        expect(error.stateMutability).toBe(stateMutability);
        expect(error.message).toBe(
          'ABI function "readValue(uint256)" has stateMutability "' +
            stateMutability +
            '". Only view and pure functions are allowed.',
        );
      }
    },
  );

  it('отклоняет ABI-функцию без stateMutability', () => {
    const abiFunctionWithoutMutability = {
      type: 'function',
      name: 'readValue',
      inputs: [{ name: 'id', type: 'uint256' }],
      outputs: [{ type: 'bytes32' }],
    } as unknown as AbiFunction;

    try {
      validateReadOnlyAbiFunction(abiFunctionWithoutMutability);
      expect.unreachable('Ожидалась ошибка отсутствующего stateMutability.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AbiFunctionMutabilityError);

      if (!(error instanceof AbiFunctionMutabilityError)) {
        throw error;
      }

      expect(error.functionSignature).toBe('readValue(uint256)');
      expect(error.stateMutability).toBeUndefined();
      expect(error.message).toBe(
        'ABI function "readValue(uint256)" has missing stateMutability. ' +
          'Only view and pure functions are allowed.',
      );
    }
  });

  it('отклоняет неизвестное значение stateMutability', () => {
    const abiFunctionWithInvalidMutability = {
      ...createAbiFunction('view'),
      stateMutability: 'constant',
    } as unknown as AbiFunction;

    expect(() => validateReadOnlyAbiFunction(abiFunctionWithInvalidMutability)).toThrow(
      AbiFunctionMutabilityError,
    );
  });
});
