import { describe, expect, it, vi } from 'vitest';

import {
  createGetBlockTool,
  createGetChainInfoTool,
  createGetContractCodeTool,
  createGetErc20BalanceTool,
  createGetLogsTool,
  createGetNativeBalanceTool,
  createGetTransactionReceiptTool,
  createGetTransactionTool,
  createReadContractTool,
  createSepoliaTools,
  getBlockToolSchema,
  getChainInfoToolSchema,
  getContractCodeToolSchema,
  getErc20BalanceToolSchema,
  getLogsToolSchema,
  getNativeBalanceToolSchema,
  getTransactionReceiptToolSchema,
  getTransactionToolSchema,
  readContractToolSchema,
  type SepoliaToolsClient,
} from './langchain-tools.js';

const lowercaseAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummedAddress = '0x52908400098527886E0F7030069857D2E4169EE7';
const recipientAddress = '0xde709f2102306220921060314715629080e2fb77';
const transactionHash = '0x' + 'a'.repeat(64);
const blockHash = '0x' + 'b'.repeat(64);
const parentHash = '0x' + 'c'.repeat(64);
const topic = '0x' + 'd'.repeat(64);

const blockFixture = {
  number: 100n,
  hash: blockHash,
  parentHash,
  timestamp: 1_700_000_000n,
  miner: lowercaseAddress,
  gasLimit: 30_000_000n,
  gasUsed: 21_000n,
  baseFeePerGas: 1n,
  transactions: [transactionHash],
};

const transactionFixture = {
  hash: transactionHash,
  blockHash,
  blockNumber: 100n,
  transactionIndex: 0,
  from: lowercaseAddress,
  to: recipientAddress,
  value: 1n,
  nonce: 2,
  gas: 21_000n,
  gasPrice: 3n,
  maxFeePerGas: null,
  maxPriorityFeePerGas: null,
  input: '0x',
  type: 'legacy',
};

const receiptFixture = {
  transactionHash,
  transactionIndex: 0,
  blockHash,
  blockNumber: 100n,
  from: lowercaseAddress,
  to: recipientAddress,
  contractAddress: null,
  status: 'success',
  gasUsed: 21_000n,
  cumulativeGasUsed: 21_000n,
  effectiveGasPrice: 3n,
  type: 'legacy',
  logs: [{ logIndex: 0, address: lowercaseAddress, topics: [topic] }],
};

const logFixture = {
  address: lowercaseAddress,
  blockHash,
  blockNumber: '0x64',
  transactionHash,
  transactionIndex: '0x0',
  logIndex: '0x0',
  data: '0x1234',
  topics: [topic],
};

/** Создаёт единый mock-клиент для всех LangChain-обёрток. */
const createMockClient = () => {
  const getChainId = vi.fn<SepoliaToolsClient['getChainId']>().mockResolvedValue(11_155_111);
  const getBlockNumber = vi.fn<SepoliaToolsClient['getBlockNumber']>().mockResolvedValue(100n);
  const getBalance = vi.fn<SepoliaToolsClient['getBalance']>().mockResolvedValue(10n);
  const getBlockRpc = vi.fn<SepoliaToolsClient['getBlock']>().mockResolvedValue(blockFixture);
  const getTransactionRpc = vi
    .fn<SepoliaToolsClient['getTransaction']>()
    .mockResolvedValue(transactionFixture);
  const getTransactionReceiptRpc = vi
    .fn<SepoliaToolsClient['getTransactionReceipt']>()
    .mockResolvedValue(receiptFixture);
  const getCode = vi.fn<SepoliaToolsClient['getCode']>().mockResolvedValue('0x6000');
  const request = vi.fn<SepoliaToolsClient['request']>().mockResolvedValue([logFixture]);
  const readContractRpc = vi.fn<SepoliaToolsClient['readContract']>().mockResolvedValue(5n);
  const client: SepoliaToolsClient = {
    getChainId,
    getBlockNumber,
    getBalance,
    getBlock: getBlockRpc,
    getTransaction: getTransactionRpc,
    getTransactionReceipt: getTransactionReceiptRpc,
    getCode,
    request,
    readContract: readContractRpc,
  };

  return {
    client,
    getChainId,
    getBlockNumber,
    getBalance,
    getBlockRpc,
    getTransactionRpc,
    getTransactionReceiptRpc,
    getCode,
    request,
    readContractRpc,
  };
};

describe('LangChain tool schemas', () => {
  it.each([
    {
      name: 'get_chain_info',
      schema: getChainInfoToolSchema,
      valid: {},
      invalid: { unexpected: true },
    },
    {
      name: 'get_native_balance',
      schema: getNativeBalanceToolSchema,
      valid: { address: lowercaseAddress, blockNumber: '42' },
      invalid: { address: '0x1234' },
    },
    {
      name: 'get_erc20_balance',
      schema: getErc20BalanceToolSchema,
      valid: {
        tokenAddress: lowercaseAddress,
        ownerAddress: recipientAddress,
        blockNumber: '42',
      },
      invalid: { tokenAddress: lowercaseAddress, ownerAddress: '0x1234' },
    },
    {
      name: 'get_block',
      schema: getBlockToolSchema,
      valid: { identifier: 'latest', maxTransactionHashes: 0 },
      invalid: { identifier: 'pending' },
    },
    {
      name: 'get_transaction',
      schema: getTransactionToolSchema,
      valid: { hash: transactionHash },
      invalid: { hash: '0x1234' },
    },
    {
      name: 'get_transaction_receipt',
      schema: getTransactionReceiptToolSchema,
      valid: { hash: transactionHash, maxLogSummaries: 0 },
      invalid: { hash: transactionHash, maxLogSummaries: 101 },
    },
    {
      name: 'get_contract_code',
      schema: getContractCodeToolSchema,
      valid: { address: lowercaseAddress, blockNumber: 42, maxPreviewBytes: 1 },
      invalid: { address: lowercaseAddress, maxPreviewBytes: 4_097 },
    },
    {
      name: 'get_logs',
      schema: getLogsToolSchema,
      valid: {
        address: lowercaseAddress,
        fromBlock: '100',
        toBlock: 101,
        topics: [topic],
      },
      invalid: {
        address: lowercaseAddress,
        fromBlock: 100,
        toBlock: 101,
        topics: [topic, topic, topic, topic, topic],
      },
    },
    {
      name: 'read_contract',
      schema: readContractToolSchema,
      valid: {
        address: lowercaseAddress,
        abi: 'function value(uint256 id) view returns (uint256)',
        functionSignature: 'value(uint256)',
        args: ['7'],
      },
      invalid: {
        address: lowercaseAddress,
        abi: 'function value() view returns (uint256)',
        functionSignature: 'value',
      },
    },
  ])('валидирует отдельную схему $name', ({ schema, valid, invalid }) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse(invalid).success).toBe(false);
  });

  it('добавляет пустой список аргументов read_contract по умолчанию', () => {
    expect(
      readContractToolSchema.parse({
        address: lowercaseAddress,
        abi: 'function owner() view returns (address)',
        functionSignature: 'owner()',
      }).args,
    ).toEqual([]);
  });
});

describe('LangChain tool registry', () => {
  it('регистрирует полный read-only набор с отдельными именами и схемами', () => {
    const { client } = createMockClient();
    const tools = createSepoliaTools(client);

    expect(tools.map(({ name }) => name)).toEqual([
      'get_chain_info',
      'get_native_balance',
      'get_erc20_balance',
      'get_block',
      'get_transaction',
      'get_transaction_receipt',
      'get_contract_code',
      'get_logs',
      'read_contract',
    ]);
    expect(tools.every(({ metadata }) => metadata?.readOnly === true)).toBe(true);
    expect(tools.every(({ description }) => description.length > 0)).toBe(true);
  });
});

describe('LangChain tool input conversion and service calls', () => {
  it('get_chain_info вызывает сервис без входных параметров', async () => {
    const { client, getChainId, getBlockNumber } = createMockClient();

    await expect(createGetChainInfoTool(client).invoke({})).resolves.toMatchObject({
      latestBlockNumber: '100',
      connection: { readOnly: true },
    });
    expect(getChainId).toHaveBeenCalledOnce();
    expect(getBlockNumber).toHaveBeenCalledOnce();
  });

  it('get_native_balance преобразует блок и нормализует адрес', async () => {
    const { client, getBalance, getBlockNumber } = createMockClient();

    await expect(
      createGetNativeBalanceTool(client).invoke({
        address: lowercaseAddress,
        blockNumber: '42',
      }),
    ).resolves.toMatchObject({
      address: checksummedAddress,
      blockNumber: '42',
      balanceWei: '10',
    });
    expect(getBalance).toHaveBeenCalledWith({
      address: checksummedAddress,
      blockNumber: 42n,
    });
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it('get_erc20_balance различает контракт токена и владельца', async () => {
    const { client, readContractRpc, getBlockNumber } = createMockClient();
    readContractRpc.mockImplementation(async ({ functionName }) => {
      if (functionName === 'balanceOf') return 12_345_678n;
      if (functionName === 'decimals') return 6;
      return 'USDC';
    });

    await expect(
      createGetErc20BalanceTool(client).invoke({
        tokenAddress: lowercaseAddress,
        ownerAddress: recipientAddress,
        blockNumber: '42',
      }),
    ).resolves.toMatchObject({
      tokenAddress: checksummedAddress,
      ownerAddress: recipientAddress,
      blockNumber: '42',
      balanceRaw: '12345678',
      balanceFormatted: '12.345678',
      decimals: 6,
      symbol: 'USDC',
    });
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(readContractRpc).toHaveBeenCalledTimes(3);
  });

  it('get_block передаёт преобразованный номер и лимит результата', async () => {
    const { client, getBlockRpc } = createMockClient();

    await expect(
      createGetBlockTool(client).invoke({
        identifier: '42',
        maxTransactionHashes: 0,
      }),
    ).resolves.toMatchObject({
      transactionHashes: [],
      transactionsTruncated: true,
    });
    expect(getBlockRpc).toHaveBeenCalledWith({
      blockNumber: 42n,
      includeTransactions: false,
    });
  });

  it('get_transaction передаёт хэш без изменения', async () => {
    const { client, getTransactionRpc } = createMockClient();

    await expect(
      createGetTransactionTool(client).invoke({ hash: transactionHash }),
    ).resolves.toMatchObject({
      hash: transactionHash,
      status: 'confirmed',
      valueWei: '1',
    });
    expect(getTransactionRpc).toHaveBeenCalledWith({ hash: transactionHash });
  });

  it('get_transaction_receipt передаёт хэш и лимит логов', async () => {
    const { client, getTransactionReceiptRpc } = createMockClient();

    await expect(
      createGetTransactionReceiptTool(client).invoke({
        hash: transactionHash,
        maxLogSummaries: 0,
      }),
    ).resolves.toMatchObject({
      logs: { count: 1, summaries: [], truncated: true },
    });
    expect(getTransactionReceiptRpc).toHaveBeenCalledWith({ hash: transactionHash });
  });

  it('get_contract_code преобразует блок и применяет лимит preview', async () => {
    const { client, getCode, getBlockNumber } = createMockClient();

    await expect(
      createGetContractCodeTool(client).invoke({
        address: lowercaseAddress,
        blockNumber: '42',
        maxPreviewBytes: 1,
      }),
    ).resolves.toMatchObject({
      address: checksummedAddress,
      blockNumber: '42',
      bytecodePreview: '0x60',
      bytecodeTruncated: true,
    });
    expect(getCode).toHaveBeenCalledWith({
      address: checksummedAddress,
      blockNumber: 42n,
    });
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it('get_logs преобразует диапазон в JSON-RPC quantities и передаёт topics', async () => {
    const { client, request } = createMockClient();

    await expect(
      createGetLogsTool(client).invoke({
        address: lowercaseAddress,
        fromBlock: '100',
        toBlock: 101,
        topics: [topic],
        maxBlockRange: 2,
        maxResults: 0,
        maxDataPreviewBytes: 0,
      }),
    ).resolves.toMatchObject({
      matchedLogCount: 1,
      logs: [],
      logsTruncated: true,
    });
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getLogs',
      params: [
        {
          address: checksummedAddress,
          fromBlock: '0x64',
          toBlock: '0x65',
          topics: [topic],
        },
      ],
    });
  });

  it('read_contract разбирает ABI и преобразует аргумент и блок', async () => {
    const { client, readContractRpc, getBlockNumber } = createMockClient();

    await expect(
      createReadContractTool(client).invoke({
        address: lowercaseAddress,
        abi: 'function value(uint256 id) view returns (uint256)',
        functionSignature: 'value(uint256)',
        args: ['7'],
        blockNumber: '42',
      }),
    ).resolves.toMatchObject({
      address: checksummedAddress,
      blockNumber: '42',
      functionSignature: 'value(uint256)',
      result: '5',
    });
    expect(readContractRpc).toHaveBeenCalledWith({
      address: checksummedAddress,
      abi: [
        {
          type: 'function',
          name: 'value',
          inputs: [{ name: 'id', type: 'uint256' }],
          outputs: [{ type: 'uint256' }],
          stateMutability: 'view',
        },
      ],
      functionName: 'value',
      args: [7n],
      blockNumber: 42n,
    });
    expect(getBlockNumber).not.toHaveBeenCalled();
  });
});

describe('LangChain tool error handling', () => {
  it.each([
    {
      name: 'get_chain_info',
      errorName: 'GetChainInfoError',
      run: () => {
        const mocks = createMockClient();
        const cause = new Error('latest block unavailable');
        mocks.getBlockNumber.mockRejectedValue(cause);
        return {
          cause,
          operation: createGetChainInfoTool(mocks.client).invoke({}),
        };
      },
    },
    {
      name: 'get_native_balance',
      errorName: 'GetNativeBalanceError',
      run: () => {
        const mocks = createMockClient();
        const cause = new Error('balance unavailable');
        mocks.getBalance.mockRejectedValue(cause);
        return {
          cause,
          operation: createGetNativeBalanceTool(mocks.client).invoke({
            address: lowercaseAddress,
            blockNumber: 42,
          }),
        };
      },
    },
    {
      name: 'get_erc20_balance',
      errorName: 'GetErc20BalanceError',
      run: () => {
        const mocks = createMockClient();
        const cause = new Error('token balance unavailable');
        mocks.readContractRpc.mockRejectedValue(cause);
        return {
          cause,
          operation: createGetErc20BalanceTool(mocks.client).invoke({
            tokenAddress: lowercaseAddress,
            ownerAddress: recipientAddress,
            blockNumber: 42,
          }),
        };
      },
    },
    {
      name: 'get_block',
      errorName: 'GetBlockError',
      run: () => {
        const mocks = createMockClient();
        const cause = new Error('block unavailable');
        mocks.getBlockRpc.mockRejectedValue(cause);
        return {
          cause,
          operation: createGetBlockTool(mocks.client).invoke({ identifier: 42 }),
        };
      },
    },
    {
      name: 'get_transaction',
      errorName: 'GetTransactionError',
      run: () => {
        const mocks = createMockClient();
        const cause = new Error('transaction unavailable');
        mocks.getTransactionRpc.mockRejectedValue(cause);
        return {
          cause,
          operation: createGetTransactionTool(mocks.client).invoke({
            hash: transactionHash,
          }),
        };
      },
    },
    {
      name: 'get_transaction_receipt',
      errorName: 'GetTransactionReceiptError',
      run: () => {
        const mocks = createMockClient();
        const cause = new Error('receipt unavailable');
        mocks.getTransactionReceiptRpc.mockRejectedValue(cause);
        return {
          cause,
          operation: createGetTransactionReceiptTool(mocks.client).invoke({
            hash: transactionHash,
          }),
        };
      },
    },
    {
      name: 'get_contract_code',
      errorName: 'GetContractCodeError',
      run: () => {
        const mocks = createMockClient();
        const cause = new Error('bytecode unavailable');
        mocks.getCode.mockRejectedValue(cause);
        return {
          cause,
          operation: createGetContractCodeTool(mocks.client).invoke({
            address: lowercaseAddress,
            blockNumber: 42,
          }),
        };
      },
    },
    {
      name: 'get_logs',
      errorName: 'GetLogsError',
      run: () => {
        const mocks = createMockClient();
        const cause = new Error('rate limited');
        mocks.request.mockRejectedValue(cause);
        return {
          cause,
          operation: createGetLogsTool(mocks.client).invoke({
            address: lowercaseAddress,
            fromBlock: 100,
            toBlock: 101,
          }),
        };
      },
    },
    {
      name: 'read_contract',
      errorName: 'ReadContractError',
      run: () => {
        const mocks = createMockClient();
        const cause = new Error('execution reverted');
        mocks.readContractRpc.mockRejectedValue(cause);
        return {
          cause,
          operation: createReadContractTool(mocks.client).invoke({
            address: lowercaseAddress,
            abi: 'function value() view returns (uint256)',
            functionSignature: 'value()',
            blockNumber: 42,
          }),
        };
      },
    },
  ])('сохраняет тип и причину ошибки $name', async ({ errorName, run }) => {
    const { cause, operation } = run();

    try {
      await operation;
      expect.unreachable('Ожидалась ошибка blockchain-сервиса.');
    } catch (error: unknown) {
      expect(error).toMatchObject({ name: errorName, cause });
    }
  });
});
