import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createBlockRangeSchema,
  createLimitedArraySchema,
  validateBlockNumber,
  validateBlockRange,
  validateEthereumAddress,
  validateLimitedArray,
  validateTransactionHash,
} from './blockchain-input.js';

describe('validateEthereumAddress', () => {
  it('принимает и нормализует lowercase-адрес', () => {
    expect(validateEthereumAddress('0x52908400098527886e0f7030069857d2e4169ee7')).toBe(
      '0x52908400098527886E0F7030069857D2E4169EE7',
    );
  });

  it('сохраняет корректный checksummed-адрес', () => {
    const address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

    expect(validateEthereumAddress(address)).toBe(address);
  });

  it.each([
    '0x1234',
    '52908400098527886e0f7030069857d2e4169ee7',
    '0x52908400098527886e0f7030069857d2e4169eez',
    '0x52908400098527886E0F7030069857D2E4169Ee7',
    ' 0x52908400098527886e0f7030069857d2e4169ee7 ',
    123,
  ])('отклоняет некорректный адрес: %s', (value) => {
    expect(() => validateEthereumAddress(value)).toThrow();
  });
});

describe('validateTransactionHash', () => {
  it('принимает 32-байтовый hex-хэш без изменения регистра', () => {
    const hash = `0x${'aB'.repeat(32)}`;

    expect(validateTransactionHash(hash)).toBe(hash);
  });

  it.each([
    `0x${'ab'.repeat(31)}`,
    `0x${'ab'.repeat(33)}`,
    `${'ab'.repeat(32)}`,
    `0x${'ag'.repeat(32)}`,
    ` 0x${'ab'.repeat(32)}`,
    null,
  ])('отклоняет некорректный хэш: %s', (value) => {
    expect(() => validateTransactionHash(value)).toThrow();
  });
});

describe('validateBlockNumber', () => {
  it.each([
    [0n, 0n],
    [0, 0n],
    [Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)],
    ['12345678', 12_345_678n],
    ['90071992547409931234567890', 90_071_992_547_409_931_234_567_890n],
  ])('преобразует допустимый номер %s в bigint', (value, expected) => {
    expect(validateBlockNumber(value)).toBe(expected);
  });

  it.each([
    -1n,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '-1',
    '01',
    '1.5',
    '0x10',
    'latest',
    ' 1 ',
    '',
  ])('отклоняет некорректный номер блока: %s', (value) => {
    expect(() => validateBlockNumber(value)).toThrow();
  });
});

describe('validateBlockRange', () => {
  it('принимает диапазон из одного блока', () => {
    expect(validateBlockRange({ fromBlock: 100, toBlock: 100 }, 1)).toEqual({
      fromBlock: 100n,
      toBlock: 100n,
      size: 1n,
    });
  });

  it('принимает диапазон на точной границе лимита', () => {
    expect(validateBlockRange({ fromBlock: '100', toBlock: 109n }, 10)).toEqual({
      fromBlock: 100n,
      toBlock: 109n,
      size: 10n,
    });
  });

  it('отклоняет обратный диапазон', () => {
    expect(() => validateBlockRange({ fromBlock: 101, toBlock: 100 }, 10)).toThrow(
      'toBlock must be greater than or equal to fromBlock.',
    );
  });

  it('отклоняет диапазон, превышающий лимит на один блок', () => {
    expect(() => validateBlockRange({ fromBlock: 100, toBlock: 110 }, 10)).toThrow(
      'Block range must contain at most 10 blocks.',
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'отклоняет некорректный лимит диапазона: %s',
    (limit) => {
      expect(() => createBlockRangeSchema(limit)).toThrow();
    },
  );

  it('отклоняет дополнительные поля диапазона', () => {
    expect(() =>
      validateBlockRange({ fromBlock: 100, toBlock: 100, network: 'mainnet' }, 10),
    ).toThrow();
  });
});

describe('validateLimitedArray', () => {
  const itemSchema = z.string().min(1);

  it('принимает пустой массив', () => {
    expect(validateLimitedArray([], itemSchema, 2)).toEqual([]);
  });

  it('принимает массив на точной границе лимита', () => {
    expect(validateLimitedArray(['one', 'two'], itemSchema, 2)).toEqual(['one', 'two']);
  });

  it('отклоняет массив сверх лимита', () => {
    expect(() => validateLimitedArray(['one', 'two', 'three'], itemSchema, 2)).toThrow(
      'Array must contain at most 2 items.',
    );
  });

  it('проверяет каждый элемент массива', () => {
    expect(() => validateLimitedArray(['one', ''], itemSchema, 2)).toThrow();
  });

  it('отклоняет значение, которое не является массивом', () => {
    expect(() => validateLimitedArray('one', itemSchema, 2)).toThrow();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'отклоняет некорректный лимит массива: %s',
    (limit) => {
      expect(() => createLimitedArraySchema(itemSchema, limit)).toThrow();
    },
  );
});
