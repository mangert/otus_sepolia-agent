import { encodeAbiParameters, type AbiFunction, type AbiParameter, type Hex } from 'viem';

import { validateEthereumAddress, validateHexData } from '../validation/index.js';
import { getAbiFunctionSignature } from './abi.js';

export const MAX_ABI_ARGUMENT_ARRAY_LENGTH = 1_000;
export const MAX_ABI_ARGUMENT_NESTING_DEPTH = 16;

interface AbiArrayType {
  itemType: string;
  fixedLength: bigint | null;
}

type UnknownRecord = Record<string, unknown>;

export class AbiArgumentsValidationError extends Error {
  readonly functionSignature: string;
  readonly argumentPath: string;

  constructor(
    functionSignature: string,
    argumentPath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      'Invalid arguments for ABI function "' +
        functionSignature +
        '" at ' +
        argumentPath +
        ': ' +
        message,
      options,
    );
    this.name = 'AbiArgumentsValidationError';
    this.functionSignature = functionSignature;
    this.argumentPath = argumentPath;
  }
}

/** Создаёт ошибку проверки с точным путём к аргументу. */
const failValidation = (
  functionSignature: string,
  argumentPath: string,
  message: string,
  options?: ErrorOptions,
): never => {
  throw new AbiArgumentsValidationError(functionSignature, argumentPath, message, options);
};

/** Определяет внешний размер массива и тип его элемента. */
const parseAbiArrayType = (type: string): AbiArrayType | null => {
  const match = /^(.*)\[([0-9]*)\]$/.exec(type);

  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }

  return {
    itemType: match[1],
    fixedLength: match[2] === '' ? null : BigInt(match[2]),
  };
};

/** Проверяет, что значение является объектом с именованными полями. */
const isUnknownRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Проверяет целое ABI-значение и преобразует его в bigint. */
const validateIntegerValue = (
  type: string,
  value: unknown,
  functionSignature: string,
  argumentPath: string,
): bigint => {
  const integerType = /^(u?int)([0-9]*)$/.exec(type);

  if (integerType === null) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Unsupported integer type "' + type + '".',
    );
  }

  const bitSize = integerType[2] === '' ? 256 : Number(integerType[2]);

  if (bitSize < 8 || bitSize > 256 || bitSize % 8 !== 0) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Unsupported integer type "' + type + '".',
    );
  }

  let normalizedValue: bigint;

  if (typeof value === 'bigint') {
    normalizedValue = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    normalizedValue = BigInt(value);
  } else if (typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value)) {
    normalizedValue = BigInt(value);
  } else {
    return failValidation(
      functionSignature,
      argumentPath,
      'Expected ' + type + ' as bigint, a safe integer, or a decimal integer string.',
    );
  }

  const isUnsigned = integerType[1] === 'uint';
  const minimum = isUnsigned ? 0n : -(2n ** BigInt(bitSize - 1));
  const maximum = isUnsigned ? 2n ** BigInt(bitSize) - 1n : 2n ** BigInt(bitSize - 1) - 1n;

  if (normalizedValue < minimum || normalizedValue > maximum) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Integer is outside the ' +
        type +
        ' range [' +
        minimum.toString(10) +
        ', ' +
        maximum.toString(10) +
        '].',
    );
  }

  return normalizedValue;
};

/** Проверяет hex-значение и необязательную фиксированную длину. */
const validateBytesValue = (
  type: string,
  value: unknown,
  expectedBytes: number | undefined,
  functionSignature: string,
  argumentPath: string,
): Hex => {
  let normalizedValue: Hex;

  try {
    normalizedValue = validateHexData(value);
  } catch (error: unknown) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Expected ' + type + ' as a complete 0x-prefixed hex byte string.',
      { cause: error },
    );
  }

  const byteLength = (normalizedValue.length - 2) / 2;

  if (expectedBytes !== undefined && byteLength !== expectedBytes) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Expected exactly ' +
        expectedBytes.toString(10) +
        ' bytes for ' +
        type +
        ', received ' +
        byteLength.toString(10) +
        '.',
    );
  }

  return normalizedValue;
};

/** Проверяет tuple в позиционной или именованной форме. */
const validateTupleValue = (
  parameter: AbiParameter,
  value: unknown,
  functionSignature: string,
  argumentPath: string,
  depth: number,
): unknown => {
  if (!('components' in parameter) || !Array.isArray(parameter.components)) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Tuple ABI parameter must define components.',
    );
  }

  const components = parameter.components;

  if (Array.isArray(value)) {
    if (value.length !== components.length) {
      return failValidation(
        functionSignature,
        argumentPath,
        'Expected tuple with ' +
          components.length.toString(10) +
          ' values, received ' +
          value.length.toString(10) +
          '.',
      );
    }

    return components.map((component, index) =>
      validateAbiParameterValue(
        component,
        value[index],
        functionSignature,
        argumentPath + '[' + index.toString(10) + ']',
        depth + 1,
      ),
    );
  }

  if (!isUnknownRecord(value)) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Expected tuple as an array or an object with named component fields.',
    );
  }

  const componentNames = components.map((component) => component.name);
  const hasUsableNames =
    componentNames.every((name): name is string => typeof name === 'string' && name.length > 0) &&
    new Set(componentNames).size === componentNames.length;

  if (!hasUsableNames) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Tuple object form requires unique, non-empty component names; use an array instead.',
    );
  }

  const extraKeys = Object.keys(value).filter((key) => !componentNames.includes(key));

  if (extraKeys.length > 0) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Tuple contains unsupported fields: ' + extraKeys.join(', ') + '.',
    );
  }

  const normalizedEntries = components.map((component, index) => {
    const componentName = componentNames[index] as string;

    if (!Object.hasOwn(value, componentName)) {
      return failValidation(
        functionSignature,
        argumentPath + '.' + componentName,
        'Tuple component is required.',
      );
    }

    return [
      componentName,
      validateAbiParameterValue(
        component,
        value[componentName],
        functionSignature,
        argumentPath + '.' + componentName,
        depth + 1,
      ),
    ] as const;
  });

  return Object.fromEntries(normalizedEntries);
};

/** Проверяет массив ABI и рекурсивно нормализует его элементы. */
const validateArrayValue = (
  parameter: AbiParameter,
  arrayType: AbiArrayType,
  value: unknown,
  functionSignature: string,
  argumentPath: string,
  depth: number,
): readonly unknown[] => {
  if (!Array.isArray(value)) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Expected ' + parameter.type + ' array.',
    );
  }

  if (value.length > MAX_ABI_ARGUMENT_ARRAY_LENGTH) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Array must contain at most ' + MAX_ABI_ARGUMENT_ARRAY_LENGTH.toString(10) + ' items.',
    );
  }

  if (arrayType.fixedLength !== null && BigInt(value.length) !== arrayType.fixedLength) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Expected array length ' +
        arrayType.fixedLength.toString(10) +
        ', received ' +
        value.length.toString(10) +
        '.',
    );
  }

  const itemParameter = { ...parameter, type: arrayType.itemType } as AbiParameter;

  return value.map((item, index) =>
    validateAbiParameterValue(
      itemParameter,
      item,
      functionSignature,
      argumentPath + '[' + index.toString(10) + ']',
      depth + 1,
    ),
  );
};

/** Проверяет одно значение по соответствующему ABI-параметру. */
const validateAbiParameterValue = (
  parameter: AbiParameter,
  value: unknown,
  functionSignature: string,
  argumentPath: string,
  depth: number,
): unknown => {
  if (depth > MAX_ABI_ARGUMENT_NESTING_DEPTH) {
    return failValidation(
      functionSignature,
      argumentPath,
      'Argument nesting must not exceed ' +
        MAX_ABI_ARGUMENT_NESTING_DEPTH.toString(10) +
        ' levels.',
    );
  }

  const arrayType = parseAbiArrayType(parameter.type);

  if (arrayType !== null) {
    return validateArrayValue(parameter, arrayType, value, functionSignature, argumentPath, depth);
  }

  if (/^u?int[0-9]*$/.test(parameter.type)) {
    return validateIntegerValue(parameter.type, value, functionSignature, argumentPath);
  }

  if (parameter.type === 'address') {
    try {
      return validateEthereumAddress(value);
    } catch (error: unknown) {
      return failValidation(functionSignature, argumentPath, 'Expected a valid Ethereum address.', {
        cause: error,
      });
    }
  }

  if (parameter.type === 'bool') {
    return typeof value === 'boolean'
      ? value
      : failValidation(functionSignature, argumentPath, 'Expected a boolean.');
  }

  if (parameter.type === 'string') {
    return typeof value === 'string'
      ? value
      : failValidation(functionSignature, argumentPath, 'Expected a string.');
  }

  if (parameter.type === 'bytes') {
    return validateBytesValue(parameter.type, value, undefined, functionSignature, argumentPath);
  }

  const fixedBytes = /^bytes([0-9]+)$/.exec(parameter.type);

  if (fixedBytes !== null) {
    return validateBytesValue(
      parameter.type,
      value,
      Number(fixedBytes[1]),
      functionSignature,
      argumentPath,
    );
  }

  if (parameter.type === 'function') {
    return validateBytesValue(parameter.type, value, 24, functionSignature, argumentPath);
  }

  if (parameter.type === 'tuple') {
    return validateTupleValue(parameter, value, functionSignature, argumentPath, depth);
  }

  return failValidation(
    functionSignature,
    argumentPath,
    'Unsupported ABI type "' + parameter.type + '".',
  );
};

/** Проверяет и нормализует аргументы выбранной ABI-функции до RPC-вызова. */
export const validateAbiFunctionArguments = (
  abiFunction: AbiFunction,
  argumentsInput: unknown = [],
): readonly unknown[] => {
  const functionSignature = getAbiFunctionSignature(abiFunction);

  if (!Array.isArray(argumentsInput)) {
    return failValidation(functionSignature, 'args', 'Expected an array of function arguments.');
  }

  if (argumentsInput.length !== abiFunction.inputs.length) {
    return failValidation(
      functionSignature,
      'args',
      'Expected ' +
        abiFunction.inputs.length.toString(10) +
        ' arguments, received ' +
        argumentsInput.length.toString(10) +
        '.',
    );
  }

  const normalizedArguments = abiFunction.inputs.map((parameter, index) =>
    validateAbiParameterValue(
      parameter,
      argumentsInput[index],
      functionSignature,
      'args[' + index.toString(10) + ']',
      0,
    ),
  );

  try {
    encodeAbiParameters(abiFunction.inputs, normalizedArguments);
  } catch (error: unknown) {
    return failValidation(
      functionSignature,
      'args',
      'Arguments could not be encoded for this ABI function.',
      { cause: error },
    );
  }

  return normalizedArguments;
};
