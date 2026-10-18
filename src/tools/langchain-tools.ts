import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { MAX_ABI_ITEMS, MAX_ABI_PARAMETERS } from '../contracts/index.js';
import { getBlock, MAX_BLOCK_TRANSACTION_HASH_LIMIT, type BlockClient } from './get-block.js';
import { getChainInfo, type ChainInfoClient } from './get-chain-info.js';
import {
  getContractCode,
  MAX_BYTECODE_PREVIEW_BYTES,
  type ContractCodeClient,
} from './get-contract-code.js';
import {
  getLogs,
  MAX_LOG_BLOCK_RANGE,
  MAX_LOG_DATA_PREVIEW_BYTES,
  MAX_LOG_RESULT_LIMIT,
  MAX_TOPIC_OR_VALUES,
  type LogsClient,
} from './get-logs.js';
import { getErc20Balance, type Erc20BalanceClient } from './get-erc20-balance.js';
import { getNativeBalance, type NativeBalanceClient } from './get-native-balance.js';
import {
  getTransactionReceipt,
  MAX_RECEIPT_LOG_SUMMARY_LIMIT,
  type TransactionReceiptClient,
} from './get-transaction-receipt.js';
import { getTransaction, type TransactionClient } from './get-transaction.js';
import { readContract, type ReadContractClient } from './read-contract.js';

const ethereumAddressInputSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe('Exact 0x-prefixed 20-byte address; copy only the address, with no extra characters.');
const ethereumHashInputSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .describe('A 32-byte Ethereum hash with a 0x prefix.');
const blockNumberInputSchema = z
  .union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  ])
  .describe('A non-negative block number as a safe integer or decimal string.');
const blockIdentifierInputSchema = z
  .union([z.literal('latest'), ethereumHashInputSchema, blockNumberInputSchema])
  .describe('The literal latest, a block hash, or a non-negative block number.');
const topicInputSchema = z.union([
  ethereumHashInputSchema,
  z.array(ethereumHashInputSchema).min(1).max(MAX_TOPIC_OR_VALUES),
  z.null(),
]);
const readOnlyToolMetadata = {
  network: 'ethereum-sepolia',
  chainId: 11_155_111,
  readOnly: true,
} as const;

export const getChainInfoToolSchema = z.strictObject({});

export const getNativeBalanceToolSchema = z.strictObject({
  address: ethereumAddressInputSchema,
  blockNumber: blockNumberInputSchema.optional(),
});

export const getErc20BalanceToolSchema = z.strictObject({
  tokenAddress: ethereumAddressInputSchema.describe(
    'Exact Sepolia ERC-20 contract address; do not use the holder address here.',
  ),
  ownerAddress: ethereumAddressInputSchema.describe(
    'Exact wallet or account address whose token balance should be read.',
  ),
  blockNumber: blockNumberInputSchema.optional(),
});

export const getBlockToolSchema = z.strictObject({
  identifier: blockIdentifierInputSchema,
  maxTransactionHashes: z.number().int().min(0).max(MAX_BLOCK_TRANSACTION_HASH_LIMIT).optional(),
});

export const getTransactionToolSchema = z.strictObject({
  hash: ethereumHashInputSchema,
});

export const getTransactionReceiptToolSchema = z.strictObject({
  hash: ethereumHashInputSchema,
  maxLogSummaries: z.number().int().min(0).max(MAX_RECEIPT_LOG_SUMMARY_LIMIT).optional(),
});

export const getContractCodeToolSchema = z.strictObject({
  address: ethereumAddressInputSchema,
  blockNumber: blockNumberInputSchema.optional(),
  maxPreviewBytes: z.number().int().min(0).max(MAX_BYTECODE_PREVIEW_BYTES).optional(),
});

export const getLogsToolSchema = z.strictObject({
  address: ethereumAddressInputSchema,
  fromBlock: blockNumberInputSchema,
  toBlock: blockNumberInputSchema,
  topics: z.array(topicInputSchema).max(4).optional(),
  maxBlockRange: z.number().int().min(1).max(MAX_LOG_BLOCK_RANGE).optional(),
  maxResults: z.number().int().min(0).max(MAX_LOG_RESULT_LIMIT).optional(),
  maxDataPreviewBytes: z.number().int().min(0).max(MAX_LOG_DATA_PREVIEW_BYTES).optional(),
});

export const readContractToolSchema = z.strictObject({
  address: ethereumAddressInputSchema,
  abi: z
    .json()
    .refine(
      (value) =>
        typeof value === 'string' || (Array.isArray(value) && value.length <= MAX_ABI_ITEMS),
      'ABI must be a human-readable string or a JSON array within the item limit.',
    ),
  functionSignature: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*\([^\s]*\)$/)
    .describe('The canonical full function signature, for example balanceOf(address).'),
  args: z.array(z.json()).max(MAX_ABI_PARAMETERS).default([]),
  blockNumber: blockNumberInputSchema.optional(),
});

export interface SepoliaToolsClient
  extends
    BlockClient,
    ChainInfoClient,
    ContractCodeClient,
    LogsClient,
    Erc20BalanceClient,
    NativeBalanceClient,
    ReadContractClient,
    TransactionClient,
    TransactionReceiptClient {}

/** Создаёт LangChain-тул чтения метаданных сети Sepolia. */
export const createGetChainInfoTool = (client: ChainInfoClient) =>
  new DynamicStructuredTool({
    name: 'get_chain_info',
    description: 'Return Sepolia chain ID, latest block, and connection status.',
    schema: getChainInfoToolSchema,
    metadata: readOnlyToolMetadata,
    func: async () => getChainInfo(client),
  });

/** Создаёт LangChain-тул чтения нативного баланса. */
export const createGetNativeBalanceTool = (client: NativeBalanceClient) =>
  new DynamicStructuredTool({
    name: 'get_native_balance',
    description: 'Read native Sepolia ETH balance in wei and ETH at an optional block.',
    schema: getNativeBalanceToolSchema,
    metadata: readOnlyToolMetadata,
    func: async ({ address, blockNumber }) =>
      getNativeBalance(client, {
        address,
        ...(blockNumber === undefined ? {} : { blockNumber }),
      }),
  });

/** Создаёт LangChain-тул чтения стандартного ERC-20 баланса. */
export const createGetErc20BalanceTool = (client: Erc20BalanceClient) =>
  new DynamicStructuredTool({
    name: 'get_erc20_balance',
    description:
      'Read an ERC-20 token balance on Sepolia using a token contract address and a holder address. The standard balanceOf, decimals, and symbol ABI is built in.',
    schema: getErc20BalanceToolSchema,
    metadata: readOnlyToolMetadata,
    func: async ({ tokenAddress, ownerAddress, blockNumber }) =>
      getErc20Balance(client, {
        tokenAddress,
        ownerAddress,
        ...(blockNumber === undefined ? {} : { blockNumber }),
      }),
  });

/** Создаёт LangChain-тул чтения блока. */
export const createGetBlockTool = (client: BlockClient) =>
  new DynamicStructuredTool({
    name: 'get_block',
    description: 'Read a Sepolia block by number, hash, or latest.',
    schema: getBlockToolSchema,
    metadata: readOnlyToolMetadata,
    func: async ({ identifier, maxTransactionHashes }) =>
      getBlock(
        client,
        { identifier },
        maxTransactionHashes === undefined ? {} : { maxTransactionHashes },
      ),
  });

/** Создаёт LangChain-тул чтения транзакции. */
export const createGetTransactionTool = (client: TransactionClient) =>
  new DynamicStructuredTool({
    name: 'get_transaction',
    description: 'Read a Sepolia transaction by hash.',
    schema: getTransactionToolSchema,
    metadata: readOnlyToolMetadata,
    func: async ({ hash }) => getTransaction(client, { hash }),
  });

/** Создаёт LangChain-тул чтения receipt транзакции. */
export const createGetTransactionReceiptTool = (client: TransactionReceiptClient) =>
  new DynamicStructuredTool({
    name: 'get_transaction_receipt',
    description: 'Read a Sepolia transaction receipt and execution status.',
    schema: getTransactionReceiptToolSchema,
    metadata: readOnlyToolMetadata,
    func: async ({ hash, maxLogSummaries }) =>
      getTransactionReceipt(
        client,
        { hash },
        maxLogSummaries === undefined ? {} : { maxLogSummaries },
      ),
  });

/** Создаёт LangChain-тул чтения bytecode контракта. */
export const createGetContractCodeTool = (client: ContractCodeClient) =>
  new DynamicStructuredTool({
    name: 'get_contract_code',
    description: 'Read contract bytecode at an optional Sepolia block.',
    schema: getContractCodeToolSchema,
    metadata: readOnlyToolMetadata,
    func: async ({ address, blockNumber, maxPreviewBytes }) =>
      getContractCode(
        client,
        {
          address,
          ...(blockNumber === undefined ? {} : { blockNumber }),
        },
        maxPreviewBytes === undefined ? {} : { maxPreviewBytes },
      ),
  });

/** Создаёт LangChain-тул чтения логов контракта. */
export const createGetLogsTool = (client: LogsClient) =>
  new DynamicStructuredTool({
    name: 'get_logs',
    description: 'Read bounded Sepolia logs for an explicit block range and optional topics.',
    schema: getLogsToolSchema,
    metadata: readOnlyToolMetadata,
    func: async ({
      address,
      fromBlock,
      toBlock,
      topics,
      maxBlockRange,
      maxResults,
      maxDataPreviewBytes,
    }) =>
      getLogs(
        client,
        {
          address,
          fromBlock,
          toBlock,
          ...(topics === undefined ? {} : { topics }),
        },
        {
          ...(maxBlockRange === undefined ? {} : { maxBlockRange }),
          ...(maxResults === undefined ? {} : { maxResults }),
          ...(maxDataPreviewBytes === undefined ? {} : { maxDataPreviewBytes }),
        },
      ),
  });

/** Создаёт LangChain-тул безопасного чтения функции контракта. */
export const createReadContractTool = (client: ReadContractClient) =>
  new DynamicStructuredTool({
    name: 'read_contract',
    description:
      'Call one view or pure Sepolia contract function using its ABI and full signature.',
    schema: readContractToolSchema,
    metadata: readOnlyToolMetadata,
    func: async ({ address, abi, functionSignature, args, blockNumber }) =>
      readContract(client, {
        address,
        abi,
        functionSignature,
        args,
        ...(blockNumber === undefined ? {} : { blockNumber }),
      }),
  });

/** Создаёт полный read-only набор LangChain-тулов Sepolia. */
export const createSepoliaTools = (client: SepoliaToolsClient) =>
  [
    createGetChainInfoTool(client),
    createGetNativeBalanceTool(client),
    createGetErc20BalanceTool(client),
    createGetBlockTool(client),
    createGetTransactionTool(client),
    createGetTransactionReceiptTool(client),
    createGetContractCodeTool(client),
    createGetLogsTool(client),
    createReadContractTool(client),
  ] as const;
