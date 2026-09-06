export type JsonPrimitive = boolean | number | string | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export class JsonSerializationError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JsonSerializationError';
  }
}

/** Формирует путь к свойству для сообщения об ошибке. */
const appendPropertyPath = (path: string, property: string): string =>
  `${path}[${JSON.stringify(property)}]`;

/** Проверяет, что объект можно безопасно представить обычным JSON-объектом. */
const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value) as unknown;

  return prototype === Object.prototype || prototype === null;
};

/** Рекурсивно преобразует значение в JSON-совместимую структуру. */
const convertToJsonValue = (
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString(10);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JsonSerializationError(`Non-finite number at ${path} cannot be serialized.`);
    }

    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new JsonSerializationError(
        `Unsafe integer at ${path} cannot be serialized without precision loss; use bigint.`,
      );
    }

    return value;
  }

  if (value === undefined) {
    return null;
  }

  if (typeof value !== 'object') {
    throw new JsonSerializationError(`Unsupported ${typeof value} value at ${path}.`);
  }

  if (ancestors.has(value)) {
    throw new JsonSerializationError(`Circular reference detected at ${path}.`);
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item, index) =>
        convertToJsonValue(item, `${path}[${index}]`, ancestors),
      );
    }

    if (!isPlainObject(value)) {
      throw new JsonSerializationError(
        `Unsupported object type at ${path}; only plain objects and arrays are allowed.`,
      );
    }

    return Object.fromEntries(
      Object.entries(value).map(([property, propertyValue]) => [
        property,
        convertToJsonValue(propertyValue, appendPropertyPath(path, property), ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
};

/** Преобразует результат blockchain-вызова в JSON-совместимое значение. */
export const toJsonValue = (value: unknown): JsonValue =>
  convertToJsonValue(value, '$', new WeakSet());

/** Сериализует результат blockchain-вызова без потери точности bigint. */
export const serializeJson = (value: unknown): string => JSON.stringify(toJsonValue(value));
