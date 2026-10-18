import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { SepoliaChainMismatchError } from '../blockchain/index.js';
import {
  GetErc20BalanceError,
  getErc20Balance,
  type Erc20BalanceClient,
} from './get-erc20-balance.js';

const ownerAddress = '0x52908400098527886E0F7030069857D2E4169EE7';
const tokenAddress = '0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8';
const checksummedTokenAddress = '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8';

/** Создаёт mock-клиент стандартных ERC-20 чтений. */
const createMockClient = () => {
  const getChainId = vi.fn<Erc20BalanceClient['getChainId']>().mockResolvedValue(11_155_111);
  const getBlockNumber = vi
    .fn<Erc20BalanceClient['getBlockNumber']>()
    .mockResolvedValue(12_345_678n);
  const readContract = vi
    .fn<Erc20BalanceClient['readContract']>()
    .mockResolvedValueOnce(12_345_678n)
    .mockResolvedValueOnce(6)
    .mockResolvedValueOnce('USDC');

  return {
    client: { getChainId, getBlockNumber, readContract },
    getChainId,
    getBlockNumber,
    readContract,
  };
};

describe('getErc20Balance', () => {
  it('читает баланс и метаданные на одном зафиксированном блоке', async () => {
    const mocks = createMockClient();

    await expect(getErc20Balance(mocks.client, { tokenAddress, ownerAddress })).resolves.toEqual({
      tokenAddress: checksummedTokenAddress,
      ownerAddress,
      blockNumber: '12345678',
      balanceRaw: '12345678',
      balanceFormatted: '12.345678',
      decimals: 6,
      symbol: 'USDC',
    });
    expect(mocks.getChainId).toHaveBeenCalledOnce();
    expect(mocks.getBlockNumber).toHaveBeenCalledOnce();
    expect(mocks.readContract).toHaveBeenCalledTimes(3);
    expect(mocks.readContract.mock.calls.map(([request]) => request.blockNumber)).toEqual([
      12_345_678n,
      12_345_678n,
      12_345_678n,
    ]);
    expect(mocks.readContract.mock.calls[0]?.[0]).toMatchObject({
      address: checksummedTokenAddress,
      functionName: 'balanceOf',
      args: [ownerAddress],
    });
  });

  it('использует явный блок без запроса latest', async () => {
    const mocks = createMockClient();

    await expect(
      getErc20Balance(mocks.client, { tokenAddress, ownerAddress, blockNumber: '42' }),
    ).resolves.toMatchObject({ blockNumber: '42' });
    expect(mocks.getBlockNumber).not.toHaveBeenCalled();
    expect(mocks.readContract.mock.calls.every(([request]) => request.blockNumber === 42n)).toBe(
      true,
    );
  });

  it('возвращает сырой баланс, если метаданные недоступны', async () => {
    const mocks = createMockClient();
    mocks.readContract.mockReset();
    mocks.readContract
      .mockResolvedValueOnce(7n)
      .mockRejectedValueOnce(new Error('decimals reverted'))
      .mockResolvedValueOnce('unsafe symbol with spaces');

    await expect(getErc20Balance(mocks.client, { tokenAddress, ownerAddress })).resolves.toEqual({
      tokenAddress: checksummedTokenAddress,
      ownerAddress,
      blockNumber: '12345678',
      balanceRaw: '7',
      metadataWarnings: [
        'The token decimals() call failed.',
        'The token returned invalid symbol metadata.',
      ],
    });
  });

  it('отклоняет неправильные адреса до RPC-вызовов', async () => {
    const mocks = createMockClient();

    await expect(
      getErc20Balance(mocks.client, { tokenAddress: '0x1234', ownerAddress }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mocks.getChainId).not.toHaveBeenCalled();
    expect(mocks.getBlockNumber).not.toHaveBeenCalled();
    expect(mocks.readContract).not.toHaveBeenCalled();
  });

  it('не читает контракт при подключении к другой сети', async () => {
    const mocks = createMockClient();
    mocks.getChainId.mockResolvedValue(1);

    await expect(
      getErc20Balance(mocks.client, { tokenAddress, ownerAddress }),
    ).rejects.toBeInstanceOf(SepoliaChainMismatchError);
    expect(mocks.getBlockNumber).not.toHaveBeenCalled();
    expect(mocks.readContract).not.toHaveBeenCalled();
  });

  it('сохраняет причину ошибки balanceOf', async () => {
    const mocks = createMockClient();
    const cause = new Error('execution reverted');
    mocks.readContract.mockReset();
    mocks.readContract.mockRejectedValueOnce(cause);

    try {
      await getErc20Balance(mocks.client, { tokenAddress, ownerAddress });
      expect.unreachable('Ожидалась ошибка чтения ERC-20 баланса.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetErc20BalanceError);
      expect(error).toMatchObject({ cause });
    }
  });
});
