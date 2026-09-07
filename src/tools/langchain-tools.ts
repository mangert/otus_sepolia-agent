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
  .describe('A 20-byte Ethereum address with a 0x prefix.');
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
    NativeBalanceClient,
    ReadContractClient,
    TransactionClient,
    TransactionReceiptClient {}

/** Создаёт LangChain-тул чтения метаданных сети Sepolia. */
export const createGetChainInfoTool = (client: ChainInfoClient) =>
  new DynamicStructuredTool({
    name: 'get_chain_info',
    description:
      'Verify the RPC network and return the Sepolia chain ID, latest block number, and read-only connection status.',
    schema: getChainInfoToolSchema,
    metadata: readOnlyToolMetadata,
    func: async () => getChainInfo(client),
  });

/** Создаёт LangChain-тул чтения нативного баланса. */
export const createGetNativeBalanceTool = (client: NativeBalanceClient) =>
  new DynamicStructuredTool({
    name: 'get_native_balance',
    description:
      'Read the native Sepolia ETH balance of an address at an optional block. Returns both wei and ETH with the observed block number.',
    schema: getNativeBalanceToolSchema,
    metadata: readOnlyToolMetadata,
    func: async ({ address, blockNumber }) =>
      getNativeBalance(client, {
        address,
        ...(blockNumber === undefined ? {} : { blockNumber }),
      }),
  });

/** Создаёт LangChain-тул чтения блока. */
export const createGetBlockTool = (client: BlockClient) =>
  new DynamicStructuredTool({
    name: 'get_block',
    description:
      'Read a Sepolia block by number, hash, or latest and return a bounded summary with transaction hashes.',
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
    description:
      'Read a Sepolia transaction by hash and return confirmation status, participants, value, gas fields, and input data.',
    schema: getTransactionToolSchema,
    metadata: readOnlyToolMetadata,
    func: async ({ hash }) => getTransaction(client, { hash }),
  });

/** Создаёт LangChain-тул чтения receipt транзакции. */
export const createGetTransactionReceiptTool = (client: TransactionReceiptClient) =>
  new DynamicStructuredTool({
    name: 'get_transaction_receipt',
    description:
      'Read a Sepolia transaction receipt with execution status, gas usage, created contract address, and bounded log summaries.',
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
    description:
      'Check whether a Sepolia address has contract bytecode at an optional block and return a bounded bytecode preview and hash.',
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
    description:
      'Read Sepolia contract logs for an explicit inclusive block range and optional topic filters. Range and output sizes are bounded.',
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
      'Call one view or pure function on a Sepolia contract. Requires the ABI and canonical full signature; payable and nonpayable functions are rejected.',
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
    createGetBlockTool(client),
    createGetTransactionTool(client),
    createGetTransactionReceiptTool(client),
    createGetContractCodeTool(client),
    createGetLogsTool(client),
    createReadContractTool(client),
  ] as const;
