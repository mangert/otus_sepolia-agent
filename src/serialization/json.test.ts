import { describe, expect, it } from 'vitest';

import { JsonSerializationError, serializeJson, toJsonValue } from './index.js';

describe('toJsonValue', () => {
  it('преобразует большой bigint в точную десятичную строку', () => {
    const uint256Max = (1n << 256n) - 1n;

    expect(toJsonValue(uint256Max)).toBe(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    );
  });

  it('преобразует отрицательный bigint без потери знака', () => {
    expect(toJsonValue(-123n)).toBe('-123');
  });

  it('сохраняет hex-строку без изменения регистра', () => {
    expect(toJsonValue('0xAa00fF')).toBe('0xAa00fF');
  });

  it('рекурсивно преобразует вложенные объекты и массивы', () => {
    expect(
      toJsonValue({
        block: 12_345_678n,
        transaction: {
          hash: '0xAbCd',
          values: [0n, 1n, { gasUsed: 21_000n }],
        },
        success: true,
      }),
    ).toEqual({
      block: '12345678',
      transaction: {
        hash: '0xAbCd',
        values: ['0', '1', { gasUsed: '21000' }],
      },
      success: true,
    });
  });

  it.each([
    [null, null],
    [undefined, null],
    [{}, {}],
    [[], []],
  ])('обрабатывает пустое значение %#', (value, expected) => {
    expect(toJsonValue(value)).toEqual(expected);
  });

  it('заменяет undefined и пропуски массива на null', () => {
    const sparseArray = new Array<bigint | undefined>(4);
    sparseArray[0] = 1n;
    sparseArray[2] = undefined;
    sparseArray[3] = 4n;

    expect(toJsonValue(sparseArray)).toEqual(['1', null, null, '4']);
  });

  it('заменяет undefined в объекте на null', () => {
    expect(toJsonValue({ value: undefined })).toEqual({ value: null });
  });

  it('принимает безопасные числа', () => {
    expect(toJsonValue([0, Number.MAX_SAFE_INTEGER, -1.5])).toEqual([
      0,
      Number.MAX_SAFE_INTEGER,
      -1.5,
    ]);
  });

  it('поддерживает объект без прототипа', () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, {
      balance: 100n,
    });

    expect(toJsonValue(value)).toEqual({ balance: '100' });
  });

  it('не считает повторную ссылку циклом', () => {
    const shared = { value: 1n };

    expect(toJsonValue({ first: shared, second: shared })).toEqual({
      first: { value: '1' },
      second: { value: '1' },
    });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1])(
    'отклоняет небезопасное целое число: %s',
    (value) => {
      expect(() => toJsonValue({ result: [value] })).toThrow(
        'Unsafe integer at $["result"][0] cannot be serialized without precision loss; use bigint.',
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'отклоняет неограниченное число: %s',
    (value) => {
      expect(() => toJsonValue(value)).toThrow('Non-finite number at $ cannot be serialized.');
    },
  );

  it('отклоняет циклическую ссылку с путём к ней', () => {
    const value: { nested?: unknown } = {};
    value.nested = value;

    expect(() => toJsonValue(value)).toThrow('Circular reference detected at $["nested"].');
  });

  it.each([
    [() => undefined, 'function'],
    [Symbol('result'), 'symbol'],
  ])('отклоняет значение типа %s', (value, type) => {
    expect(() => toJsonValue(value)).toThrow(`Unsupported ${type} value at $.`);
  });

  it.each([new Date('2026-01-01T00:00:00Z'), new Map(), new Set()])(
    'отклоняет объект с пользовательским прототипом: %s',
    (value) => {
      expect(() => toJsonValue(value)).toThrow(
        'Unsupported object type at $; only plain objects and arrays are allowed.',
      );
    },
  );
});

describe('serializeJson', () => {
  it('возвращает JSON-строку для результата с bigint', () => {
    expect(serializeJson({ balanceWei: 1_000_000_000_000_000_000n, data: '0x00' })).toBe(
      '{"balanceWei":"1000000000000000000","data":"0x00"}',
    );
  });

  it.each([
    [null, 'null'],
    [undefined, 'null'],
    [{}, '{}'],
    [[], '[]'],
  ])('сериализует пустой ответ %#', (value, expected) => {
    expect(serializeJson(value)).toBe(expected);
  });

  it('возвращает специализированную ошибку', () => {
    expect(() => serializeJson(9_007_199_254_740_992)).toThrow(JsonSerializationError);
  });
});
