import { parseAbi, type Abi, type AbiFunction, type AbiParameter } from 'viem';
import { formatAbiItem } from 'viem/utils';
import { z } from 'zod';

export const MAX_ABI_ITEMS = 1_000;
export const MAX_ABI_PARAMETERS = 100;
export const MAX_ABI_TEXT_LENGTH = 1_000_000;

const solidityIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const abiTypeAndArraysPattern = /^([A-Za-z][A-Za-z0-9]*)(\[(?:[1-9][0-9]*)?\])*$/;

interface FunctionSelector {
  kind: 'name' | 'signature';
  name: string;
  value: string;
}

export class AbiParsingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AbiParsingError';
  }
}

export class AbiFunctionSelectorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AbiFunctionSelectorError';
  }
}

export class AbiFunctionNotFoundError extends Error {
  readonly selector: string;

  constructor(selector: string) {
    super('ABI function "' + selector + '" was not found.');
    this.name = 'AbiFunctionNotFoundError';
    this.selector = selector;
  }
}

export class AbiFunctionAmbiguityError extends Error {
  readonly selector: string;
  readonly candidates: readonly string[];

  constructor(selector: string, candidates: readonly string[]) {
    super(
      'ABI function "' +
        selector +
        '" is ambiguous. Use a full signature: ' +
        candidates.join(', ') +
        '.',
    );
    this.name = 'AbiFunctionAmbiguityError';
    this.selector = selector;
    this.candidates = candidates;
  }
}

/** Проверяет поддерживаемый канонический тип ABI или допустимый целочисленный псевдоним. */
const isSupportedAbiType = (value: string): boolean => {
  const match = abiTypeAndArraysPattern.exec(value);

  if (match === null) {
    return false;
  }

  const baseType = match[1];

  if (
    baseType === 'address' ||
    baseType === 'bool' ||
    baseType === 'string' ||
    baseType === 'function' ||
    baseType === 'bytes' ||
    baseType === 'tuple'
  ) {
    return true;
  }

  const bytesMatch = /^bytes([0-9]+)$/.exec(baseType ?? '');

  if (bytesMatch !== null) {
    const size = Number(bytesMatch[1]);
    return size >= 1 && size <= 32;
  }

  const integerMatch = /^(?:u?int)([0-9]*)$/.exec(baseType ?? '');

  if (integerMatch === null) {
    return false;
  }

  if (integerMatch[1] === '') {
    return true;
  }

  const bitSize = Number(integerMatch[1]);
  return bitSize >= 8 && bitSize <= 256 && bitSize % 8 === 0;
};

const abiNameSchema = z.string().regex(solidityIdentifierPattern, 'Invalid Solidity identifier.');
const abiTypeSchema = z.string().refine(isSupportedAbiType, 'Invalid or unsupported ABI type.');

const abiParameterSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .strictObject({
      name: z.string().optional(),
      type: abiTypeSchema,
      internalType: z.string().min(1).optional(),
      components: z.array(abiParameterSchema).max(MAX_ABI_PARAMETERS).optional(),
      indexed: z.boolean().optional(),
    })
    .superRefine((parameter, context) => {
      const isTuple = parameter.type === 'tuple' || parameter.type.startsWith('tuple[');

      if (isTuple && parameter.components === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Tuple ABI parameters must define components.',
          path: ['components'],
        });
      }

      if (!isTuple && parameter.components !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Only tuple ABI parameters may define components.',
          path: ['components'],
        });
      }
    }),
);

const abiParametersSchema = z.array(abiParameterSchema).max(MAX_ABI_PARAMETERS);
const stateMutabilitySchema = z.enum(['pure', 'view', 'nonpayable', 'payable']);
const legacyAbiFields = {
  constant: z.boolean().optional(),
  gas: z.number().nonnegative().optional(),
  payable: z.boolean().optional(),
};

const jsonAbiSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('function'),
        name: abiNameSchema,
        inputs: abiParametersSchema,
        outputs: abiParametersSchema,
        stateMutability: stateMutabilitySchema,
        ...legacyAbiFields,
      }),
      z.strictObject({
        type: z.literal('constructor'),
        inputs: abiParametersSchema,
        stateMutability: z.enum(['nonpayable', 'payable']),
        payable: z.boolean().optional(),
      }),
      z.strictObject({
        type: z.literal('event'),
        name: abiNameSchema,
        inputs: abiParametersSchema,
        anonymous: z.boolean().optional(),
      }),
      z.strictObject({
        type: z.literal('error'),
        name: abiNameSchema,
        inputs: abiParametersSchema,
      }),
      z.strictObject({
        type: z.literal('fallback'),
        stateMutability: z.enum(['nonpayable', 'payable']),
        payable: z.boolean().optional(),
      }),
      z.strictObject({
        type: z.literal('receive'),
        stateMutability: z.literal('payable'),
      }),
    ]),
  )
  .max(MAX_ABI_ITEMS);

const humanReadableAbiSchema = z.array(z.string().trim().min(1)).min(1).max(MAX_ABI_ITEMS);

/** Приводит псевдонимы целых типов ABI к канонической форме. */
const canonicalizeAbiType = (type: string): string => {
  const arraySuffixIndex = type.indexOf('[');
  const baseType = arraySuffixIndex === -1 ? type : type.slice(0, arraySuffixIndex);
  const arraySuffix = arraySuffixIndex === -1 ? '' : type.slice(arraySuffixIndex);

  if (baseType === 'uint') {
    return 'uint256' + arraySuffix;
  }

  if (baseType === 'int') {
    return 'int256' + arraySuffix;
  }

  return type;
};

/** Канонизирует типы ABI-параметра, включая компоненты кортежа. */
const canonicalizeAbiParameter = <Parameter extends AbiParameter>(
  parameter: Parameter,
): Parameter => {
  const components =
    'components' in parameter
      ? parameter.components.map((component) => canonicalizeAbiParameter(component))
      : undefined;

  return {
    ...parameter,
    type: canonicalizeAbiType(parameter.type),
    ...(components === undefined ? {} : { components }),
  } as Parameter;
};

/** Канонизирует типы параметров во всех элементах ABI. */
const canonicalizeAbi = (abi: Abi): Abi =>
  abi.map((item) => {
    switch (item.type) {
      case 'function':
        return {
          ...item,
          inputs: item.inputs.map((parameter) => canonicalizeAbiParameter(parameter)),
          outputs: item.outputs.map((parameter) => canonicalizeAbiParameter(parameter)),
        };
      case 'constructor':
      case 'event':
      case 'error':
        return {
          ...item,
          inputs: item.inputs.map((parameter) => canonicalizeAbiParameter(parameter)),
        };
      case 'fallback':
      case 'receive':
        return item;
    }
  });

/** Разбирает и проверяет JSON ABI. */
const parseJsonAbi = (input: unknown): Abi => {
  try {
    return canonicalizeAbi(jsonAbiSchema.parse(input) as unknown as Abi);
  } catch (error: unknown) {
    throw new AbiParsingError('Invalid JSON ABI.', { cause: error });
  }
};

/** Разбирает безопасный список human-readable ABI-объявлений. */
const parseHumanReadableAbi = (input: unknown): Abi => {
  try {
    const signatures = humanReadableAbiSchema.parse(input);
    return canonicalizeAbi(parseAbi(signatures));
  } catch (error: unknown) {
    throw new AbiParsingError('Invalid human-readable ABI.', { cause: error });
  }
};

/** Проверяет сбалансированность скобок в полной сигнатуре. */
const hasBalancedParentheses = (value: string): boolean => {
  let depth = 0;

  for (const character of value) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;

      if (depth < 0) {
        return false;
      }
    }
  }

  return depth === 0;
};

/** Проверяет синтаксис имени или полной сигнатуры функции. */
const parseFunctionSelector = (input: unknown): FunctionSelector => {
  if (typeof input !== 'string') {
    throw new AbiFunctionSelectorError('ABI function selector must be a string.');
  }

  const selector = input.trim();

  if (solidityIdentifierPattern.test(selector)) {
    return { kind: 'name', name: selector, value: selector };
  }

  const openingParenthesis = selector.indexOf('(');
  const name = selector.slice(0, openingParenthesis);
  const isSignature =
    openingParenthesis > 0 &&
    selector.endsWith(')') &&
    solidityIdentifierPattern.test(name) &&
    !/\s/.test(selector) &&
    /^[A-Za-z0-9_(),[\]]+$/.test(selector) &&
    hasBalancedParentheses(selector);

  if (!isSignature) {
    throw new AbiFunctionSelectorError(
      'ABI function selector must be a function name or canonical full signature.',
    );
  }

  return { kind: 'signature', name, value: selector };
};

/** Возвращает каноническую полную сигнатуру ABI-функции. */
export const getAbiFunctionSignature = (abiFunction: AbiFunction): string =>
  formatAbiItem(abiFunction);

/** Разбирает JSON или human-readable представление ABI. */
export const parseContractAbi = (input: unknown): Abi => {
  if (typeof input === 'string') {
    const trimmedInput = input.trim();

    if (trimmedInput.length === 0) {
      throw new AbiParsingError('ABI must not be empty.');
    }

    if (trimmedInput.length > MAX_ABI_TEXT_LENGTH) {
      throw new AbiParsingError(
        'ABI text must not exceed ' + MAX_ABI_TEXT_LENGTH.toString(10) + ' characters.',
      );
    }

    if (trimmedInput.startsWith('[') || trimmedInput.startsWith('{')) {
      let decodedInput: unknown;

      try {
        decodedInput = JSON.parse(trimmedInput) as unknown;
      } catch (error: unknown) {
        throw new AbiParsingError('ABI contains invalid JSON.', { cause: error });
      }

      return parseContractAbi(decodedInput);
    }

    return parseHumanReadableAbi(
      trimmedInput
        .split(/\r?\n/)
        .map((signature) => signature.trim())
        .filter((signature) => signature.length > 0),
    );
  }

  if (Array.isArray(input)) {
    if (input.length > 0 && input.every((item) => typeof item === 'string')) {
      return parseHumanReadableAbi(input);
    }

    return parseJsonAbi(input);
  }

  throw new AbiParsingError('ABI must be a JSON array or human-readable ABI string.');
};

/** Находит функцию ABI и требует полную сигнатуру для перегруженного имени. */
export const findAbiFunction = (abiInput: unknown, selectorInput: unknown): AbiFunction => {
  const abi = parseContractAbi(abiInput);
  const selector = parseFunctionSelector(selectorInput);
  const namedFunctions = abi.filter(
    (item): item is AbiFunction => item.type === 'function' && item.name === selector.name,
  );

  if (selector.kind === 'name') {
    if (namedFunctions.length === 0) {
      throw new AbiFunctionNotFoundError(selector.value);
    }

    if (namedFunctions.length > 1) {
      throw new AbiFunctionAmbiguityError(
        selector.value,
        namedFunctions.map((abiFunction) => getAbiFunctionSignature(abiFunction)),
      );
    }

    return namedFunctions[0] as AbiFunction;
  }

  const exactMatches = namedFunctions.filter(
    (abiFunction) => getAbiFunctionSignature(abiFunction) === selector.value,
  );

  if (exactMatches.length === 0) {
    throw new AbiFunctionNotFoundError(selector.value);
  }

  if (exactMatches.length > 1) {
    throw new AbiFunctionAmbiguityError(
      selector.value,
      exactMatches.map((abiFunction) => getAbiFunctionSignature(abiFunction)),
    );
  }

  return exactMatches[0] as AbiFunction;
};
