import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../config/index.js';
import type { SepoliaToolsClient } from '../tools/index.js';
import {
  DEFAULT_AGENT_MAX_ITERATIONS,
  SepoliaAgentExecutionError,
  createSepoliaAgent,
} from './sepolia-agent.js';

const lowercaseAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummedAddress = '0x52908400098527886E0F7030069857D2E4169EE7';
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
    expect(agent.toolNames).toHaveLength(8);
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
