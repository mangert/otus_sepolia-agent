import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { SepoliaChainMismatchError } from '../blockchain/index.js';
import {
  AbiArgumentsValidationError,
  AbiFunctionMutabilityError,
  AbiFunctionNotFoundError,
  AbiFunctionSelectorError,
  AbiParsingError,
} from '../contracts/index.js';
import { JsonSerializationError } from '../serialization/index.js';
import { ReadContractError, readContract, type ReadContractClient } from './read-contract.js';

const lowercaseContractAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
const contractAddress = '0x52908400098527886E0F7030069857D2E4169EE7';
const lowercaseAccountAddress = '0xde709f2102306220921060314715629080e2fb77';
const accountAddress = '0xde709f2102306220921060314715629080e2fb77';

/** Создаёт mock-клиент для детерминированного контрактного чтения. */
const createMockClient = (rawResult: unknown) => {
  const getChainId = vi.fn<ReadContractClient['getChainId']>().mockResolvedValue(11_155_111);
  const getBlockNumber = vi
    .fn<ReadContractClient['getBlockNumber']>()
    .mockResolvedValue(12_345_678n);
  const readContractRpc = vi.fn<ReadContractClient['readContract']>().mockResolvedValue(rawResult);
  const client: ReadContractClient = {
    getChainId,
    getBlockNumber,
    readContract: readContractRpc,
  };

  return { client, getChainId, getBlockNumber, readContractRpc };
};

describe('readContract', () => {
  it('вызывает функцию без аргументов на зафиксированном latest-блоке', async () => {
    const { client, getChainId, getBlockNumber, readContractRpc } =
      createMockClient(123_456_789_012_345_678_901n);

    await expect(
      readContract(client, {
        address: lowercaseContractAddress,
        abi: 'function totalSupply() view returns (uint256)',
        functionSignature: 'totalSupply()',
      }),
    ).resolves.toEqual({
      address: contractAddress,
      blockNumber: '12345678',
      functionSignature: 'totalSupply()',
      stateMutability: 'view',
      result: '123456789012345678901',
    });

    expect(getChainId).toHaveBeenCalledOnce();
    expect(getBlockNumber).toHaveBeenCalledOnce();
    expect(readContractRpc).toHaveBeenCalledOnce();
    expect(readContractRpc).toHaveBeenCalledWith({
      address: contractAddress,
      abi: [
        {
          type: 'function',
          name: 'totalSupply',
          inputs: [],
          outputs: [{ type: 'uint256' }],
          stateMutability: 'view',
        },
      ],
      functionName: 'totalSupply',
      args: [],
      blockNumber: 12_345_678n,
    });
  });

  it('нормализует аргументы и использует явный номер блока', async () => {
    const { client, getBlockNumber, readContractRpc } = createMockClient(42n);
    const abi = [
      {
        type: 'function',
        name: 'balanceOf',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
      },
    ];

    await expect(
      readContract(client, {
        address: contractAddress,
        abi: JSON.stringify(abi),
        functionSignature: 'balanceOf(address)',
        args: [lowercaseAccountAddress],
        blockNumber: '42',
      }),
    ).resolves.toEqual({
      address: contractAddress,
      blockNumber: '42',
      functionSignature: 'balanceOf(address)',
      stateMutability: 'view',
      result: '42',
    });

    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(readContractRpc).toHaveBeenCalledWith({
      address: contractAddress,
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ type: 'uint256' }],
          stateMutability: 'view',
        },
      ],
      functionName: 'balanceOf',
      args: [accountAddress],
      blockNumber: 42n,
    });
  });

  it('передаёт viem только выбранную перегрузку', async () => {
    const { client, readContractRpc } = createMockClient('selected');
    const abi = [
      'function value(address account) view returns (string)',
      'function value(uint256 id) view returns (string)',
    ];

    await expect(
      readContract(client, {
        address: contractAddress,
        abi,
        functionSignature: 'value(uint256)',
        args: ['7'],
        blockNumber: 100,
      }),
    ).resolves.toMatchObject({
      functionSignature: 'value(uint256)',
      result: 'selected',
    });

    expect(readContractRpc).toHaveBeenCalledWith({
      address: contractAddress,
      abi: [
        {
          type: 'function',
          name: 'value',
          inputs: [{ name: 'id', type: 'uint256' }],
          outputs: [{ type: 'string' }],
          stateMutability: 'view',
        },
      ],
      functionName: 'value',
      args: [7n],
      blockNumber: 100n,
    });
  });

  it('сериализует несколько возвращаемых значений без потери точности', async () => {
    const { client } = createMockClient([
      'Sepolia Token',
      90_071_992_547_409_931_234_567_890n,
      false,
    ]);

    await expect(
      readContract(client, {
        address: contractAddress,
        abi: 'function metadata() view returns (string name, uint256 supply, bool paused)',
        functionSignature: 'metadata()',
        blockNumber: 1,
      }),
    ).resolves.toMatchObject({
      result: ['Sepolia Token', '90071992547409931234567890', false],
    });
  });

  it('разрешает pure-функцию', async () => {
    const { client } = createMockClient(9n);

    await expect(
      readContract(client, {
        address: contractAddress,
        abi: 'function square(uint256 value) pure returns (uint256)',
        functionSignature: 'square(uint256)',
        args: [3],
        blockNumber: 1,
      }),
    ).resolves.toMatchObject({
      stateMutability: 'pure',
      result: '9',
    });
  });

  it('преобразует пустой результат функции в null', async () => {
    const { client } = createMockClient(undefined);
    const abi = [
      {
        type: 'function',
        name: 'ping',
        inputs: [],
        outputs: [],
        stateMutability: 'view',
      },
    ];

    await expect(
      readContract(client, {
        address: contractAddress,
        abi,
        functionSignature: 'ping()',
        blockNumber: 1,
      }),
    ).resolves.toMatchObject({ result: null });
  });

  it('сохраняет причину revert из eth_call', async () => {
    const cause = Object.assign(new Error('execution reverted'), {
      data: '0x08c379a0',
    });
    const { client, readContractRpc } = createMockClient(null);
    readContractRpc.mockRejectedValue(cause);

    try {
      await readContract(client, {
        address: contractAddress,
        abi: 'function owner() view returns (address)',
        functionSignature: 'owner()',
        blockNumber: 100,
      });
      expect.unreachable('Ожидалась ошибка выполнения контрактной функции.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ReadContractError);

      if (!(error instanceof ReadContractError)) {
        throw error;
      }

      expect(error.message).toBe(
        'Unable to call owner() on Sepolia contract ' + contractAddress + '.',
      );
      expect(error.cause).toBe(cause);
    }
  });

  it('сохраняет причину ошибки определения latest-блока', async () => {
    const cause = new Error('request timed out');
    const { client, getBlockNumber, readContractRpc } = createMockClient(null);
    getBlockNumber.mockRejectedValue(cause);

    try {
      await readContract(client, {
        address: contractAddress,
        abi: 'function owner() view returns (address)',
        functionSignature: 'owner()',
      });
      expect.unreachable('Ожидалась ошибка определения latest-блока.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ReadContractError);

      if (!(error instanceof ReadContractError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to resolve the latest Sepolia block number.');
      expect(error.cause).toBe(cause);
    }

    expect(readContractRpc).not.toHaveBeenCalled();
  });

  it('оборачивает ошибку сериализации malformed результата', async () => {
    const { client } = createMockClient(Symbol('malformed'));

    try {
      await readContract(client, {
        address: contractAddress,
        abi: 'function name() view returns (string)',
        functionSignature: 'name()',
        blockNumber: 100,
      });
      expect.unreachable('Ожидалась ошибка сериализации результата.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ReadContractError);

      if (!(error instanceof ReadContractError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to serialize the result of name().');
      expect(error.cause).toBeInstanceOf(JsonSerializationError);
    }
  });

  it('останавливается до чтения контракта при подключении не к Sepolia', async () => {
    const { client, getChainId, getBlockNumber, readContractRpc } = createMockClient(null);
    getChainId.mockResolvedValue(1);

    await expect(
      readContract(client, {
        address: contractAddress,
        abi: 'function owner() view returns (address)',
        functionSignature: 'owner()',
      }),
    ).rejects.toBeInstanceOf(SepoliaChainMismatchError);

    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(readContractRpc).not.toHaveBeenCalled();
  });

  it('отклоняет неправильный ABI до RPC-вызовов', async () => {
    const { client, getChainId, getBlockNumber, readContractRpc } = createMockClient(null);
    const malformedAbi = [
      {
        type: 'function',
        name: 'broken',
        inputs: [],
        stateMutability: 'view',
      },
    ];

    await expect(
      readContract(client, {
        address: contractAddress,
        abi: malformedAbi,
        functionSignature: 'broken()',
      }),
    ).rejects.toBeInstanceOf(AbiParsingError);

    expect(getChainId).not.toHaveBeenCalled();
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(readContractRpc).not.toHaveBeenCalled();
  });

  it('отклоняет отсутствующую перегрузку до RPC-вызовов', async () => {
    const { client, getChainId, readContractRpc } = createMockClient(null);

    await expect(
      readContract(client, {
        address: contractAddress,
        abi: 'function value(address account) view returns (uint256)',
        functionSignature: 'value(uint256)',
        args: [1],
      }),
    ).rejects.toBeInstanceOf(AbiFunctionNotFoundError);

    expect(getChainId).not.toHaveBeenCalled();
    expect(readContractRpc).not.toHaveBeenCalled();
  });

  it('требует полную сигнатуру даже для неперегруженной функции', async () => {
    const { client, getChainId, readContractRpc } = createMockClient(null);

    await expect(
      readContract(client, {
        address: contractAddress,
        abi: 'function owner() view returns (address)',
        functionSignature: 'owner',
      }),
    ).rejects.toBeInstanceOf(AbiFunctionSelectorError);

    expect(getChainId).not.toHaveBeenCalled();
    expect(readContractRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['nonpayable', 'function setValue(uint256 value)', 'setValue(uint256)', [1]],
    ['payable', 'function deposit() payable', 'deposit()', []],
  ])('запрещает %s функцию до RPC-вызовов', async (_mutability, abi, functionSignature, args) => {
    const { client, getChainId, getBlockNumber, readContractRpc } = createMockClient(null);

    await expect(
      readContract(client, {
        address: contractAddress,
        abi,
        functionSignature,
        args,
      }),
    ).rejects.toBeInstanceOf(AbiFunctionMutabilityError);

    expect(getChainId).not.toHaveBeenCalled();
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(readContractRpc).not.toHaveBeenCalled();
  });

  it('отклоняет неправильные аргументы до RPC-вызовов', async () => {
    const { client, getChainId, readContractRpc } = createMockClient(null);

    await expect(
      readContract(client, {
        address: contractAddress,
        abi: 'function balanceOf(address account) view returns (uint256)',
        functionSignature: 'balanceOf(address)',
        args: ['0x1234'],
      }),
    ).rejects.toBeInstanceOf(AbiArgumentsValidationError);

    expect(getChainId).not.toHaveBeenCalled();
    expect(readContractRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['неправильный адрес', { address: '0x1234', blockNumber: 1 }],
    ['неправильный блок', { address: contractAddress, blockNumber: -1 }],
  ])('отклоняет %s до RPC-вызовов', async (_caseName, overrides) => {
    const { client, getChainId, readContractRpc } = createMockClient(null);

    await expect(
      readContract(client, {
        address: overrides.address,
        abi: 'function owner() view returns (address)',
        functionSignature: 'owner()',
        blockNumber: overrides.blockNumber,
      }),
    ).rejects.toBeInstanceOf(ZodError);

    expect(getChainId).not.toHaveBeenCalled();
    expect(readContractRpc).not.toHaveBeenCalled();
  });
});
