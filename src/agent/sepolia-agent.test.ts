import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../config/index.js';
import type { SepoliaToolsClient } from '../tools/index.js';
import {
  DEFAULT_AGENT_MAX_ITERATIONS,
  SepoliaAgentExecutionError,
  createSepoliaChatModel,
  createSepoliaAgent,
} from './sepolia-agent.js';

const lowercaseAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummedAddress = '0x52908400098527886E0F7030069857D2E4169EE7';
const usdcContractAddress = '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8';
const balanceWei = 1_000_000_000_000_000_000n;
const llmConfig: AppConfig['llm'] = {
  provider: 'opencode-llm-proxy',
  protocol: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:4010/v1',
  model: 'test-model',
  timeoutMs: 60_000,
  maxRetries: 0,
};

/** Создаёт полностью локальный mock blockchain-клиент. */
const createMockClient = () => {
  const getChainId = vi.fn<SepoliaToolsClient['getChainId']>().mockResolvedValue(11_155_111);
  const getBlockNumber = vi.fn<SepoliaToolsClient['getBlockNumber']>().mockResolvedValue(100n);
  const getBalance = vi.fn<SepoliaToolsClient['getBalance']>().mockResolvedValue(balanceWei);
  const getBlock = vi.fn<SepoliaToolsClient['getBlock']>();
  const getTransaction = vi.fn<SepoliaToolsClient['getTransaction']>();
  const getTransactionReceipt = vi.fn<SepoliaToolsClient['getTransactionReceipt']>();
  const getCode = vi.fn<SepoliaToolsClient['getCode']>();
  const request = vi.fn<SepoliaToolsClient['request']>();
  const readContract = vi.fn<SepoliaToolsClient['readContract']>();
  const client: SepoliaToolsClient = {
    getChainId,
    getBlockNumber,
    getBalance,
    getBlock,
    getTransaction,
    getTransactionReceipt,
    getCode,
    request,
    readContract,
  };

  return {
    client,
    getChainId,
    getBlockNumber,
    getBalance,
    getBlock,
    getTransaction,
    getTransactionReceipt,
    getCode,
    request,
    readContract,
  };
};

describe('Sepolia agent loop', () => {
  it('читает очевидный нативный баланс без обращения к LLM', async () => {
    const mocks = createMockClient();
    const model = fakeModel();
    const agent = createSepoliaAgent({ llm: llmConfig, client: mocks.client, model });

    const result = await agent.invoke(`Проверь баланс кошелька ${checksummedAddress}`);

    expect(result.answer).toBe(
      `Баланс адреса ${checksummedAddress} в Sepolia: 1 ETH (1000000000000000000 wei). Данные получены на блоке 100.`,
    );
    expect(result.intermediateSteps).toEqual([
      expect.objectContaining({
        toolName: 'get_native_balance',
        input: { address: checksummedAddress },
        status: 'success',
      }),
    ]);
    expect(model.callCount).toBe(0);
    expect(mocks.getBalance).toHaveBeenCalledWith({
      address: checksummedAddress,
      blockNumber: 100n,
    });
  });

  it('не подменяет баланс токена нативным ETH-балансом', async () => {
    const mocks = createMockClient();
    const model = fakeModel();
    const agent = createSepoliaAgent({ llm: llmConfig, client: mocks.client, model });

    const result = await agent.invoke(
      `Спасибо! А какой баланс USDС на адресе ${checksummedAddress}?`,
    );

    expect(result.answer).toContain('адрес контракта ERC-20 токена в сети Sepolia');
    expect(result.answer).toContain('balanceOf(address)');
    expect(result.answer).toContain('уже встроен');
    expect(result.answer).not.toContain('ETH (');
    expect(result.intermediateSteps).toEqual([]);
    expect(model.callCount).toBe(0);
    expect(mocks.getBalance).not.toHaveBeenCalled();
  });

  it('читает ERC-20 баланс по контракту и кошельку из истории', async () => {
    const mocks = createMockClient();
    mocks.readContract.mockImplementation(async ({ functionName }) => {
      if (functionName === 'balanceOf') return 12_345_678n;
      if (functionName === 'decimals') return 6;
      return 'USDC';
    });
    const model = fakeModel();
    const agent = createSepoliaAgent({ llm: llmConfig, client: mocks.client, model });

    const result = await agent.invoke(
      `Так, а какой баланс токена USDС с адресом контракта ${usdcContractAddress} на том же кошельке?`,
      {
        history: [
          {
            role: 'user',
            content: `Какой нативный баланс на адресе ${checksummedAddress}?`,
          },
          {
            role: 'assistant',
            content: `Баланс адреса ${checksummedAddress}: 1 ETH.`,
          },
        ],
      },
    );

    expect(result.answer).toContain(`Баланс адреса ${checksummedAddress}: 12.345678 USDC`);
    expect(result.answer).toContain(`Контракт токена: ${usdcContractAddress}`);
    expect(result.answer).toContain('12345678 минимальных единиц');
    expect(result.intermediateSteps).toEqual([
      expect.objectContaining({
        toolName: 'get_erc20_balance',
        input: {
          tokenAddress: usdcContractAddress,
          ownerAddress: checksummedAddress,
        },
        status: 'success',
      }),
    ]);
    expect(model.callCount).toBe(0);
    expect(mocks.getBalance).not.toHaveBeenCalled();
    expect(mocks.readContract).toHaveBeenCalledTimes(3);
  });

  it('исправляет лишние символы вокруг адреса в tool call', async () => {
    const mocks = createMockClient();
    const model = fakeModel()
      .respondWithTools([
        {
          name: 'get_native_balance',
          args: { address: `\\)\n${lowercaseAddress}` },
          id: 'repaired-balance-call',
        },
      ])
      .respond(new AIMessage('The balance is 1 Sepolia ETH at block 100.'));
    const agent = createSepoliaAgent({ llm: llmConfig, client: mocks.client, model });

    const result = await agent.invoke('Read the requested wallet funds.');

    expect(result.answer).toContain('1 Sepolia ETH');
    expect(mocks.getBalance).toHaveBeenCalledWith({
      address: checksummedAddress,
      blockNumber: 100n,
    });
    expect(model.callCount).toBe(2);
  });

  it('выполняет один тул и возвращает финальный ответ с промежуточным результатом', async () => {
    const mocks = createMockClient();
    const model = fakeModel()
      .respondWithTools([
        {
          name: 'get_native_balance',
          args: { address: lowercaseAddress, blockNumber: '42' },
          id: 'balance-call',
        },
      ])
      .respond(new AIMessage('The balance is 1 Sepolia ETH at block 42.'));
    const agent = createSepoliaAgent({ llm: llmConfig, client: mocks.client, model });

    const result = await agent.invoke('Check the balance.');

    expect(result.answer).toBe('The balance is 1 Sepolia ETH at block 42.');
    expect(result.intermediateSteps).toHaveLength(1);
    expect(result.intermediateSteps[0]).toMatchObject({
      toolCallId: 'balance-call',
      toolName: 'get_native_balance',
      input: { address: lowercaseAddress, blockNumber: '42' },
      status: 'success',
    });
    expect(JSON.parse(result.intermediateSteps[0]?.output ?? '')).toEqual({
      address: checksummedAddress,
      blockNumber: '42',
      balanceWei: '1000000000000000000',
      balanceEth: '1',
    });
    expect(mocks.getBalance).toHaveBeenCalledWith({
      address: checksummedAddress,
      blockNumber: 42n,
    });
    expect(model.callCount).toBe(2);
    expect(agent.maxIterations).toBe(DEFAULT_AGENT_MAX_ITERATIONS);
    expect(agent.recursionLimit).toBe(17);
    expect(agent.toolNames).toHaveLength(9);
  });

  it('выполняет несколько тулов в последовательных ReAct-итерациях', async () => {
    const mocks = createMockClient();
    const model = fakeModel()
      .respondWithTools([{ name: 'get_chain_info', args: {}, id: 'chain-call' }])
      .respondWithTools([
        {
          name: 'get_native_balance',
          args: { address: lowercaseAddress, blockNumber: '100' },
          id: 'balance-call',
        },
      ])
      .respond(new AIMessage('Sepolia is at block 100 and the balance is 1 ETH.'));
    const agent = createSepoliaAgent({ llm: llmConfig, client: mocks.client, model });

    const result = await agent.invoke('Check the network, then read the balance.');

    expect(result.answer).toBe('Sepolia is at block 100 and the balance is 1 ETH.');
    expect(result.intermediateSteps).toHaveLength(2);
    expect(result.intermediateSteps.map(({ toolName, status }) => ({ toolName, status }))).toEqual([
      { toolName: 'get_chain_info', status: 'success' },
      { toolName: 'get_native_balance', status: 'success' },
    ]);
    expect(model.callCount).toBe(3);
    expect(
      model.calls[1]?.messages.some(
        (message) => ToolMessage.isInstance(message) && message.tool_call_id === 'chain-call',
      ),
    ).toBe(true);
    expect(
      model.calls[2]?.messages.some(
        (message) => ToolMessage.isInstance(message) && message.tool_call_id === 'balance-call',
      ),
    ).toBe(true);
    expect(mocks.getChainId).toHaveBeenCalledTimes(2);
    expect(mocks.getBlockNumber).toHaveBeenCalledOnce();
    expect(mocks.getBalance).toHaveBeenCalledOnce();
  });

  it('возвращает ответ без tool calls, когда подходящего тула нет', async () => {
    const mocks = createMockClient();
    const refusal = 'No available read-only Sepolia tool can perform that request.';
    const model = fakeModel().respond(new AIMessage(refusal));
    const agent = createSepoliaAgent({ llm: llmConfig, client: mocks.client, model });

    await expect(agent.invoke('Predict tomorrow’s ETH price.')).resolves.toEqual({
      answer: refusal,
      intermediateSteps: [],
    });
    expect(model.callCount).toBe(1);
    expect(mocks.getChainId).not.toHaveBeenCalled();
    expect(mocks.getBlockNumber).not.toHaveBeenCalled();
    expect(mocks.getBalance).not.toHaveBeenCalled();
  });

  it('удаляет просочившееся рассуждение Qwen из финального ответа', async () => {
    const mocks = createMockClient();
    const model = fakeModel().respond(
      new AIMessage('Internal reasoning that must stay hidden.\n</think>\nКраткий ответ.'),
    );
    const agent = createSepoliaAgent({ llm: llmConfig, client: mocks.client, model });

    await expect(agent.invoke('Представься кратко.')).resolves.toEqual({
      answer: 'Краткий ответ.',
      intermediateSteps: [],
    });
    expect(model.calls[0]?.messages[0]?.text).toContain('## Runtime date context');
    expect(model.calls[0]?.messages[0]?.text).toContain('Current host-local date and time:');
  });

  it('передаёт RPC-ошибку модели и помечает промежуточный шаг как error', async () => {
    const mocks = createMockClient();
    const cause = new Error(
      'RPC timeout at https://rpc.example.test/path?apiKey=secret token=secret-value',
    );
    mocks.getBlock.mockRejectedValue(cause);
    const model = fakeModel()
      .respondWithTools([{ name: 'get_block', args: { identifier: '42' }, id: 'block-error-call' }])
      .respond(new AIMessage('The RPC request failed, so block 42 cannot be reported.'));
    const agent = createSepoliaAgent({ llm: llmConfig, client: mocks.client, model });

    const result = await agent.invoke('Show block 42.');

    expect(result.answer).toContain('RPC request failed');
    expect(result.intermediateSteps).toHaveLength(1);
    expect(result.intermediateSteps[0]).toMatchObject({
      toolCallId: 'block-error-call',
      toolName: 'get_block',
      status: 'error',
    });
    expect(result.intermediateSteps[0]?.output).toContain(
      'GetBlockError: Unable to read the requested Sepolia block.',
    );
    expect(result.intermediateSteps[0]?.output).toContain('Cause: Error: RPC timeout');
    expect(result.intermediateSteps[0]?.output).toContain('[redacted-url]');
    expect(result.intermediateSteps[0]?.output).toContain('token [redacted]');
    expect(result.intermediateSteps[0]?.output).not.toContain('secret');
    const errorToolMessage = model.calls[1]?.messages.find(
      (message) => ToolMessage.isInstance(message) && message.tool_call_id === 'block-error-call',
    );
    expect(errorToolMessage).toBeInstanceOf(ToolMessage);
    expect(errorToolMessage).toMatchObject({ status: 'error' });
  });

  it('останавливает зацикленный вызов тулов по лимиту итераций', async () => {
    const mocks = createMockClient();
    const model = fakeModel();

    for (let index = 0; index < 5; index += 1) {
      model.respondWithTools([
        { name: 'get_chain_info', args: {}, id: 'loop-call-' + index.toString(10) },
      ]);
    }

    const agent = createSepoliaAgent({
      llm: llmConfig,
      client: mocks.client,
      model,
      maxIterations: 1,
    });

    try {
      await agent.invoke('Keep checking the chain forever.');
      expect.unreachable('Ожидалось превышение лимита итераций.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SepoliaAgentExecutionError);

      if (!(error instanceof SepoliaAgentExecutionError)) {
        throw error;
      }

      expect(error.cause).toMatchObject({
        name: 'GraphRecursionError',
        lc_error_code: 'GRAPH_RECURSION_LIMIT',
      });
    }

    expect(agent.maxIterations).toBe(1);
    expect(agent.recursionLimit).toBe(3);
    expect(mocks.getBlockNumber).toHaveBeenCalledOnce();
    expect(model.callCount).toBe(2);
  });
});

describe('Sepolia chat model', () => {
  it('отключает серверную проверку tool calls Groq для локального восстановления', () => {
    const model = createSepoliaChatModel(
      {
        ...llmConfig,
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: 'test-key',
      },
      { disableToolValidation: true },
    );

    expect(model.modelKwargs).toMatchObject({
      disable_tool_validation: true,
      reasoning_format: 'hidden',
      reasoning_effort: 'none',
    });
  });

  it('не добавляет Groq reasoning-параметры локальному прокси', () => {
    const model = createSepoliaChatModel(llmConfig);

    expect(model.modelKwargs).toEqual({});
  });
});
