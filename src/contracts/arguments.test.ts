import type { AbiFunction, AbiParameter } from 'viem';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  AbiArgumentsValidationError,
  MAX_ABI_ARGUMENT_ARRAY_LENGTH,
  validateAbiFunctionArguments,
} from './arguments.js';

const lowercaseAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummedAddress = '0x52908400098527886E0F7030069857D2E4169EE7';

/** Создаёт ABI-функцию с заданными входными параметрами. */
const createAbiFunction = (inputs: readonly AbiParameter[], name = 'check'): AbiFunction => ({
  type: 'function',
  name,
  inputs,
  outputs: [],
  stateMutability: 'view',
});

/** Перехватывает ожидаемую ошибку проверки ABI-аргументов. */
const captureValidationError = (callback: () => unknown): AbiArgumentsValidationError => {
  try {
    callback();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AbiArgumentsValidationError);

    if (error instanceof AbiArgumentsValidationError) {
      return error;
    }

    throw error;
  }

  throw new Error('Ожидалась ошибка проверки ABI-аргументов.');
};

describe('validateAbiFunctionArguments: количество аргументов', () => {
  it('подставляет пустой массив для функции без аргументов', () => {
    expect(validateAbiFunctionArguments(createAbiFunction([]))).toEqual([]);
  });

  it('отклоняет значение аргументов, которое не является массивом', () => {
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([]), { value: 1 }),
    );

    expect(error.argumentPath).toBe('args');
    expect(error.message).toContain('Expected an array');
  });

  it.each([
    ['недостаточно', []],
    ['слишком много', [1, 2]],
  ])('отклоняет неверное количество аргументов: %s', (_caseName, args) => {
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([{ type: 'uint256' }]), args),
    );

    expect(error.functionSignature).toBe('check(uint256)');
    expect(error.argumentPath).toBe('args');
    expect(error.message).toContain('Expected 1 arguments');
  });
});

describe('validateAbiFunctionArguments: простые типы', () => {
  it('нормализует адрес и сохраняет строку и boolean', () => {
    const abiFunction = createAbiFunction([
      { type: 'address' },
      { type: 'string' },
      { type: 'bool' },
    ]);

    expect(validateAbiFunctionArguments(abiFunction, [lowercaseAddress, 'Sepolia', true])).toEqual([
      checksummedAddress,
      'Sepolia',
      true,
    ]);
  });

  it('отклоняет неправильный адрес и сохраняет исходную причину', () => {
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([{ type: 'address' }]), ['0x1234']),
    );

    expect(error.argumentPath).toBe('args[0]');
    expect(error.cause).toBeInstanceOf(ZodError);
  });

  it.each([
    [{ type: 'string' } as const, 42, 'Expected a string'],
    [{ type: 'bool' } as const, 'true', 'Expected a boolean'],
  ])('отклоняет неверное значение простого типа %#', (parameter, value, message) => {
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([parameter]), [value]),
    );

    expect(error.argumentPath).toBe('args[0]');
    expect(error.message).toContain(message);
  });
});

describe('validateAbiFunctionArguments: целые числа', () => {
  it('преобразует bigint, безопасное number и десятичную строку в bigint', () => {
    const abiFunction = createAbiFunction([
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'int16' },
    ]);
    const largeInteger = '90071992547409931234567890';

    expect(validateAbiFunctionArguments(abiFunction, [1n, 2, largeInteger, '-123'])).toEqual([
      1n,
      2n,
      BigInt(largeInteger),
      -123n,
    ]);
  });

  it('принимает точные границы uint8 и int8', () => {
    const abiFunction = createAbiFunction([
      { type: 'uint8' },
      { type: 'uint8' },
      { type: 'int8' },
      { type: 'int8' },
    ]);

    expect(validateAbiFunctionArguments(abiFunction, [0, '255', '-128', 127])).toEqual([
      0n,
      255n,
      -128n,
      127n,
    ]);
  });

  it('принимает максимальное значение uint256 без потери точности', () => {
    const maximumUint256 = 2n ** 256n - 1n;

    expect(
      validateAbiFunctionArguments(createAbiFunction([{ type: 'uint256' }]), [
        maximumUint256.toString(10),
      ]),
    ).toEqual([maximumUint256]);
  });

  it.each([
    ['uint8 overflow', { type: 'uint8' } as const, '256'],
    ['отрицательный uint8', { type: 'uint8' } as const, -1],
    ['int8 overflow', { type: 'int8' } as const, 128],
    ['int8 underflow', { type: 'int8' } as const, '-129'],
    ['небезопасный number', { type: 'uint256' } as const, Number.MAX_SAFE_INTEGER + 1],
    ['дробное число', { type: 'uint256' } as const, 1.5],
    ['hex-строка', { type: 'uint256' } as const, '0x10'],
    ['строка с ведущим нулём', { type: 'uint256' } as const, '01'],
  ])('отклоняет неправильное целое: %s', (_caseName, parameter, value) => {
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([parameter]), [value]),
    );

    expect(error.argumentPath).toBe('args[0]');
  });
});

describe('validateAbiFunctionArguments: bytes', () => {
  it('принимает динамические и фиксированные bytes', () => {
    const abiFunction = createAbiFunction([{ type: 'bytes' }, { type: 'bytes4' }]);

    expect(validateAbiFunctionArguments(abiFunction, ['0x', '0xaabbccdd'])).toEqual([
      '0x',
      '0xaabbccdd',
    ]);
  });

  it.each([
    ['неполный байт', { type: 'bytes' } as const, '0x1'],
    ['без 0x', { type: 'bytes' } as const, 'aabb'],
    ['неверная длина bytes4', { type: 'bytes4' } as const, '0xaabb'],
  ])('отклоняет неправильные bytes: %s', (_caseName, parameter, value) => {
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([parameter]), [value]),
    );

    expect(error.argumentPath).toBe('args[0]');
  });

  it('безопасно отклоняет неподдерживаемый кодировщиком тип function', () => {
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([{ type: 'function' }]), [
        '0x' + '11'.repeat(24),
      ]),
    );

    expect(error.argumentPath).toBe('args');
    expect(error.message).toContain('could not be encoded');
  });
});

describe('validateAbiFunctionArguments: массивы', () => {
  it('рекурсивно нормализует динамический массив', () => {
    expect(
      validateAbiFunctionArguments(createAbiFunction([{ type: 'uint16[]' }]), [[1, '2', 3n]]),
    ).toEqual([[1n, 2n, 3n]]);
  });

  it('проверяет длину и элементы фиксированного массива адресов', () => {
    expect(
      validateAbiFunctionArguments(createAbiFunction([{ type: 'address[2]' }]), [
        [lowercaseAddress, checksummedAddress],
      ]),
    ).toEqual([[checksummedAddress, checksummedAddress]]);
  });

  it('поддерживает вложенные динамические и фиксированные массивы', () => {
    expect(
      validateAbiFunctionArguments(createAbiFunction([{ type: 'uint8[2][]' }]), [
        [
          [1, '2'],
          [3n, 4],
        ],
      ]),
    ).toEqual([
      [
        [1n, 2n],
        [3n, 4n],
      ],
    ]);
  });

  it.each([
    ['не-массив', { type: 'uint256[]' } as const, 1, 'args[0]'],
    ['неверная фиксированная длина', { type: 'uint256[2]' } as const, [1], 'args[0]'],
    ['неверный элемент', { type: 'uint8[]' } as const, [1, 256], 'args[0][1]'],
  ])('отклоняет неправильный массив: %s', (_caseName, parameter, value, path) => {
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([parameter]), [value]),
    );

    expect(error.argumentPath).toBe(path);
  });

  it('ограничивает максимальный размер массива', () => {
    const oversizedArray = Array.from({ length: MAX_ABI_ARGUMENT_ARRAY_LENGTH + 1 }, () => 0);
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([{ type: 'uint256[]' }]), [oversizedArray]),
    );

    expect(error.argumentPath).toBe('args[0]');
    expect(error.message).toContain(
      'at most ' + MAX_ABI_ARGUMENT_ARRAY_LENGTH.toString(10) + ' items',
    );
  });
});

describe('validateAbiFunctionArguments: tuple', () => {
  const tupleParameter = {
    type: 'tuple',
    components: [
      { name: 'owner', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  } as const satisfies AbiParameter;

  it('нормализует tuple в позиционной форме', () => {
    expect(
      validateAbiFunctionArguments(createAbiFunction([tupleParameter]), [[lowercaseAddress, '42']]),
    ).toEqual([[checksummedAddress, 42n]]);
  });

  it('нормализует tuple в именованной форме', () => {
    expect(
      validateAbiFunctionArguments(createAbiFunction([tupleParameter]), [
        { owner: lowercaseAddress, amount: '42' },
      ]),
    ).toEqual([{ owner: checksummedAddress, amount: 42n }]);
  });

  it('поддерживает массив tuple', () => {
    const tupleArrayParameter = { ...tupleParameter, type: 'tuple[]' } as const;

    expect(
      validateAbiFunctionArguments(createAbiFunction([tupleArrayParameter]), [
        [{ owner: lowercaseAddress, amount: 1 }],
      ]),
    ).toEqual([[{ owner: checksummedAddress, amount: 1n }]]);
  });

  it.each([
    ['неверное число позиций', [lowercaseAddress], 'args[0]'],
    ['отсутствующее поле', { owner: lowercaseAddress }, 'args[0].amount'],
    ['лишнее поле', { owner: lowercaseAddress, amount: 1, network: 'mainnet' }, 'args[0]'],
    ['неправильное вложенное значение', { owner: lowercaseAddress, amount: -1 }, 'args[0].amount'],
  ])('отклоняет неправильный tuple: %s', (_caseName, value, path) => {
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([tupleParameter]), [value]),
    );

    expect(error.argumentPath).toBe(path);
  });

  it('требует позиционную форму для tuple без имён компонентов', () => {
    const unnamedTuple = {
      type: 'tuple',
      components: [{ type: 'address' }, { type: 'uint256' }],
    } as const satisfies AbiParameter;
    const error = captureValidationError(() =>
      validateAbiFunctionArguments(createAbiFunction([unnamedTuple]), [
        { owner: lowercaseAddress, amount: 1 },
      ]),
    );

    expect(error.argumentPath).toBe('args[0]');
    expect(error.message).toContain('use an array instead');
  });
});
