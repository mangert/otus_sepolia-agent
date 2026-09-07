import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  AbiFunctionAmbiguityError,
  AbiFunctionNotFoundError,
  AbiFunctionSelectorError,
  AbiParsingError,
  findAbiFunction,
  getAbiFunctionSignature,
  parseContractAbi,
} from './abi.js';

const balanceOfJsonAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint' }],
    stateMutability: 'view',
  },
];

const overloadedHumanReadableAbi = [
  'function lookup(address account) view returns (uint256)',
  'function lookup(uint256 id) pure returns (address)',
];

describe('parseContractAbi', () => {
  it('разбирает JSON ABI из массива и канонизирует целочисленные псевдонимы', () => {
    expect(parseContractAbi(balanceOfJsonAbi)).toEqual([
      {
        type: 'function',
        name: 'balanceOf',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
      },
    ]);
  });

  it('разбирает JSON ABI из строки', () => {
    const parsedAbi = parseContractAbi(JSON.stringify(balanceOfJsonAbi));

    expect(parsedAbi).toHaveLength(1);
    expect(parsedAbi[0]).toMatchObject({ type: 'function', name: 'balanceOf' });
  });

  it('принимает пустой JSON ABI', () => {
    expect(parseContractAbi('[]')).toEqual([]);
  });

  it('разбирает одиночную human-readable функцию', () => {
    expect(parseContractAbi('function totalSupply() view returns (uint256)')).toEqual([
      {
        type: 'function',
        name: 'totalSupply',
        inputs: [],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
      },
    ]);
  });

  it('разбирает список human-readable перегрузок', () => {
    const parsedAbi = parseContractAbi(overloadedHumanReadableAbi);

    expect(parsedAbi).toHaveLength(2);
    expect(parsedAbi.map((item) => (item.type === 'function' ? item.name : undefined))).toEqual([
      'lookup',
      'lookup',
    ]);
  });

  it('разбирает несколько human-readable объявлений из многострочной строки', () => {
    const parsedAbi = parseContractAbi(overloadedHumanReadableAbi.join('\n'));

    expect(parsedAbi).toHaveLength(2);
  });

  it('сохраняет компоненты кортежа и формирует каноническую сигнатуру', () => {
    const abi = [
      {
        type: 'function',
        name: 'quote',
        inputs: [
          {
            name: 'requests',
            type: 'tuple[]',
            components: [
              { name: 'account', type: 'address' },
              { name: 'amount', type: 'uint' },
            ],
          },
        ],
        outputs: [{ type: 'uint' }],
        stateMutability: 'view',
      },
    ];

    const abiFunction = findAbiFunction(abi, 'quote((address,uint256)[])');

    expect(getAbiFunctionSignature(abiFunction)).toBe('quote((address,uint256)[])');
    expect(abiFunction.inputs[0]).toMatchObject({
      type: 'tuple[]',
      components: [
        { name: 'account', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    });
  });

  it('сохраняет SyntaxError как причину неправильного JSON', () => {
    try {
      parseContractAbi('[{"type":"function"}');
      expect.unreachable('Ожидалась ошибка синтаксиса JSON ABI.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AbiParsingError);

      if (!(error instanceof AbiParsingError)) {
        throw error;
      }

      expect(error.message).toBe('ABI contains invalid JSON.');
      expect(error.cause).toBeInstanceOf(SyntaxError);
    }
  });

  it('сохраняет ZodError как причину неправильной структуры JSON ABI', () => {
    try {
      parseContractAbi([
        {
          type: 'function',
          name: 'broken',
          inputs: [],
          stateMutability: 'view',
        },
      ]);
      expect.unreachable('Ожидалась ошибка структуры JSON ABI.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AbiParsingError);

      if (!(error instanceof AbiParsingError)) {
        throw error;
      }

      expect(error.message).toBe('Invalid JSON ABI.');
      expect(error.cause).toBeInstanceOf(ZodError);
    }
  });

  it.each([
    ['JSON-объект вместо массива', { type: 'function' }],
    [
      'неподдерживаемый тип',
      [
        {
          type: 'function',
          name: 'broken',
          inputs: [{ type: 'uint7' }],
          outputs: [],
          stateMutability: 'view',
        },
      ],
    ],
    [
      'tuple без components',
      [
        {
          type: 'function',
          name: 'broken',
          inputs: [{ type: 'tuple' }],
          outputs: [],
          stateMutability: 'view',
        },
      ],
    ],
    ['смешанный массив', ['function ok() view returns (bool)', { type: 'event' }]],
    ['неподдерживаемый тип входа', 123],
    ['null', null],
    ['пустая строка', ''],
  ])('отклоняет неправильный ABI: %s', (_caseName, abi) => {
    expect(() => parseContractAbi(abi)).toThrow(AbiParsingError);
  });

  it.each([
    'function broken(',
    'function broken(uint257 value) view returns (bool)',
    'not an ABI declaration',
  ])('отклоняет неправильный human-readable ABI: %s', (abi) => {
    expect(() => parseContractAbi(abi)).toThrow(AbiParsingError);
  });
});

describe('findAbiFunction', () => {
  it('находит единственную функцию по имени', () => {
    const abiFunction = findAbiFunction(balanceOfJsonAbi, 'balanceOf');

    expect(abiFunction.name).toBe('balanceOf');
    expect(getAbiFunctionSignature(abiFunction)).toBe('balanceOf(address)');
  });

  it.each([
    ['lookup(address)', 'view'],
    ['lookup(uint256)', 'pure'],
  ] as const)('выбирает перегрузку %s по полной сигнатуре', (signature, stateMutability) => {
    const abiFunction = findAbiFunction(overloadedHumanReadableAbi, signature);

    expect(getAbiFunctionSignature(abiFunction)).toBe(signature);
    expect(abiFunction.stateMutability).toBe(stateMutability);
  });

  it('отклоняет неоднозначное имя и сообщает полные сигнатуры', () => {
    try {
      findAbiFunction(overloadedHumanReadableAbi, 'lookup');
      expect.unreachable('Ожидалась ошибка неоднозначного имени функции.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AbiFunctionAmbiguityError);

      if (!(error instanceof AbiFunctionAmbiguityError)) {
        throw error;
      }

      expect(error.selector).toBe('lookup');
      expect(error.candidates).toEqual(['lookup(address)', 'lookup(uint256)']);
      expect(error.message).toContain('Use a full signature');
    }
  });

  it('отклоняет дублирующуюся полную сигнатуру как неоднозначную', () => {
    const duplicateAbi = [...balanceOfJsonAbi, ...balanceOfJsonAbi];

    expect(() => findAbiFunction(duplicateAbi, 'balanceOf(address)')).toThrow(
      AbiFunctionAmbiguityError,
    );
  });

  it.each(['allowance', 'balanceOf(uint256)'])(
    'сообщает об отсутствующей функции для селектора %s',
    (selector) => {
      try {
        findAbiFunction(balanceOfJsonAbi, selector);
        expect.unreachable('Ожидалась ошибка отсутствующей функции.');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AbiFunctionNotFoundError);

        if (!(error instanceof AbiFunctionNotFoundError)) {
          throw error;
        }

        expect(error.selector).toBe(selector);
      }
    },
  );

  it('не считает событие функцией с тем же именем', () => {
    const eventOnlyAbi = [
      {
        type: 'event',
        name: 'Transfer',
        inputs: [],
        anonymous: false,
      },
    ];

    expect(() => findAbiFunction(eventOnlyAbi, 'Transfer')).toThrow(AbiFunctionNotFoundError);
  });

  it.each([
    ['function balanceOf(address)', 'декларация вместо селектора'],
    ['balanceOf (address)', 'пробел внутри сигнатуры'],
    ['balanceOf(address', 'незакрытая скобка'],
    ['', 'пустой селектор'],
    [123, 'нестроковый селектор'],
  ])('отклоняет неправильный селектор: %s (%s)', (selector) => {
    expect(() => findAbiFunction(balanceOfJsonAbi, selector)).toThrow(AbiFunctionSelectorError);
  });
});
