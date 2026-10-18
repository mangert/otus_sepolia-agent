import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { fakeModel, type FakeBuiltModel } from '@langchain/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { createSepoliaTools, type SepoliaToolsClient } from '../tools/index.js';
import { createSepoliaAgentSystemPrompt, SEPOLIA_AGENT_SYSTEM_PROMPT } from './system-prompt.js';

const address = '0x52908400098527886E0F7030069857D2E4169EE7';
const transactionHash = '0x' + 'a'.repeat(64);
const topic = '0x' + 'c'.repeat(64);

/** Создаёт неиспользуемый RPC-клиент для регистрации реальных тулов. */
const createUnusedClient = (): SepoliaToolsClient => ({
  getChainId: vi.fn<SepoliaToolsClient['getChainId']>(),
  getBlockNumber: vi.fn<SepoliaToolsClient['getBlockNumber']>(),
  getBalance: vi.fn<SepoliaToolsClient['getBalance']>(),
  getBlock: vi.fn<SepoliaToolsClient['getBlock']>(),
  getTransaction: vi.fn<SepoliaToolsClient['getTransaction']>(),
  getTransactionReceipt: vi.fn<SepoliaToolsClient['getTransactionReceipt']>(),
  getCode: vi.fn<SepoliaToolsClient['getCode']>(),
  request: vi.fn<SepoliaToolsClient['request']>(),
  readContract: vi.fn<SepoliaToolsClient['readContract']>(),
});

/** Передаёт системный промпт и пользовательский запрос mock-модели с реальными тулами. */
const invokeMockModel = (model: FakeBuiltModel, question: string) => {
  const tools = createSepoliaTools(createUnusedClient());

  return model
    .bindTools([...tools])
    .invoke([new SystemMessage(SEPOLIA_AGENT_SYSTEM_PROMPT), new HumanMessage(question)]);
};

describe('SEPOLIA_AGENT_SYSTEM_PROMPT', () => {
  it('фиксирует сеть и жёсткую read-only границу', () => {
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('Ethereum Sepolia');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('chain ID 11155111');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('Never switch to another network');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('Never sign or send a transaction');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('Never call payable or nonpayable functions');
  });

  it('требует прозрачной обработки RPC-ошибок и неполных результатов', () => {
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('Never hide');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('RPC error');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('rate limit');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('wrong-network errors');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('result is truncated');
  });

  it('фиксирует правила блоков, единиц и точности', () => {
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('observed block number');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('same explicit block number');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('One ETH equals 10^18 wei');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('wei per gas');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain('Never round');
    expect(SEPOLIA_AGENT_SYSTEM_PROMPT).toContain(
      'This restriction applies only to blockchain timestamps',
    );
  });

  it('добавляет текущую дату, день недели и часовой пояс', () => {
    const prompt = createSepoliaAgentSystemPrompt(
      new Date('2026-10-18T12:34:56.000Z'),
      'Europe/Amsterdam',
    );

    expect(prompt).toContain('2026-10-18 14:34:56 (Sunday)');
    expect(prompt).toContain('Host time zone: Europe/Amsterdam');
    expect(prompt).toContain('Current UTC instant: 2026-10-18T12:34:56.000Z');
    expect(prompt).toContain('without calling a blockchain tool');
  });
});

describe('mock LLM tool selection', () => {
  it.each([
    {
      question: 'What is the current Sepolia chain ID and latest block?',
      toolName: 'get_chain_info',
      args: {},
    },
    {
      question: `What was the Sepolia ETH balance of ${address} at block 42?`,
      toolName: 'get_native_balance',
      args: { address, blockNumber: '42' },
    },
    {
      question: 'Show Sepolia block 42 with at most five transaction hashes.',
      toolName: 'get_block',
      args: { identifier: '42', maxTransactionHashes: 5 },
    },
    {
      question: `Show transaction ${transactionHash}.`,
      toolName: 'get_transaction',
      args: { hash: transactionHash },
    },
    {
      question: `Did transaction ${transactionHash} succeed?`,
      toolName: 'get_transaction_receipt',
      args: { hash: transactionHash },
    },
    {
      question: `Does ${address} have contract bytecode at block 42?`,
      toolName: 'get_contract_code',
      args: { address, blockNumber: '42' },
    },
    {
      question: `Read logs from ${address} for blocks 42 to 43 with topic ${topic}.`,
      toolName: 'get_logs',
      args: { address, fromBlock: '42', toBlock: '43', topics: [topic] },
    },
    {
      question: `Call owner() on contract ${address} at block 42 using function owner() view returns (address).`,
      toolName: 'read_contract',
      args: {
        address,
        abi: 'function owner() view returns (address)',
        functionSignature: 'owner()',
        args: [],
        blockNumber: '42',
      },
    },
  ])('направляет типовой read-запрос в $toolName', async ({ question, toolName, args }) => {
    const model = fakeModel().respondWithTools([{ name: toolName, args, id: 'tool-call-1' }]);

    const response = await invokeMockModel(model, question);

    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls?.[0]).toMatchObject({ name: toolName, args });
    expect(model.callCount).toBe(1);
    expect(SystemMessage.isInstance(model.calls[0]?.messages[0])).toBe(true);
    expect(model.calls[0]?.messages[0]?.content).toBe(SEPOLIA_AGENT_SYSTEM_PROMPT);
    expect(HumanMessage.isInstance(model.calls[0]?.messages[1])).toBe(true);
    expect(model.calls[0]?.messages[1]?.content).toBe(question);
  });
});

describe('mock LLM write-request refusal', () => {
  it.each([
    'Send 1 Sepolia ETH to another address.',
    'Deploy this smart contract to Sepolia.',
    'Call the payable deposit() function through eth_call.',
    'Load my private key and sign an approval transaction.',
  ])('отклоняет write-запрос без вызова тула: %s', async (question) => {
    const refusal =
      'I cannot perform that request because this Sepolia agent is strictly read-only.';
    const model = fakeModel().respond(new AIMessage(refusal));

    const response = await invokeMockModel(model, question);

    expect(response.content).toBe(refusal);
    expect(response.tool_calls ?? []).toHaveLength(0);
    expect(model.callCount).toBe(1);
    expect(model.calls[0]?.messages[0]?.content).toBe(SEPOLIA_AGENT_SYSTEM_PROMPT);
  });
});
