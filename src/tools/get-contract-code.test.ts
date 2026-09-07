import type { Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { SepoliaChainMismatchError } from '../blockchain/index.js';
import {
  GetContractCodeError,
  getContractCode,
  type ContractCodeClient,
} from './get-contract-code.js';

const lowercaseAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
const checksummedAddress = '0x52908400098527886E0F7030069857D2E4169EE7';

describe('getContractCode', () => {
  it('возвращает bytecode контракта на зафиксированном latest-блоке', async () => {
    const getChainId = vi.fn<ContractCodeClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi
      .fn<ContractCodeClient['getBlockNumber']>()
      .mockResolvedValue(12_345_678n);
    const getCode = vi.fn<ContractCodeClient['getCode']>().mockResolvedValue('0x60016000');

    await expect(
      getContractCode(
        { getChainId, getBlockNumber, getCode },
        { address: lowercaseAddress },
        { maxPreviewBytes: 2 },
      ),
    ).resolves.toEqual({
      address: checksummedAddress,
      blockNumber: '12345678',
      isContract: true,
      bytecodeSizeBytes: 4,
      bytecodeHash: '0xcf61a6eb3b9b89e75f1dadf3dcd16509616896cb50eac765a68fa27bbbc6de82',
      bytecodePreview: '0x6001',
      bytecodeTruncated: true,
    });
    expect(getBlockNumber).toHaveBeenCalledOnce();
    expect(getCode).toHaveBeenCalledOnce();
    expect(getCode).toHaveBeenCalledWith({
      address: checksummedAddress,
      blockNumber: 12_345_678n,
    });
  });

  it('использует явный номер блока без запроса latest', async () => {
    const getChainId = vi.fn<ContractCodeClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<ContractCodeClient['getBlockNumber']>();
    const getCode = vi.fn<ContractCodeClient['getCode']>().mockResolvedValue('0x00');

    await expect(
      getContractCode(
        { getChainId, getBlockNumber, getCode },
        { address: checksummedAddress, blockNumber: '42' },
      ),
    ).resolves.toMatchObject({
      blockNumber: '42',
      isContract: true,
      bytecodeSizeBytes: 1,
      bytecodePreview: '0x00',
      bytecodeTruncated: false,
    });
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getCode).toHaveBeenCalledWith({
      address: checksummedAddress,
      blockNumber: 42n,
    });
  });

  it.each([
    ['undefined', undefined],
    ['пустой код', '0x' as const],
  ])('распознаёт EOA для ответа %s', async (_caseName, bytecode) => {
    const getChainId = vi.fn<ContractCodeClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<ContractCodeClient['getBlockNumber']>();
    const getCode = vi.fn<ContractCodeClient['getCode']>().mockResolvedValue(bytecode);

    await expect(
      getContractCode(
        { getChainId, getBlockNumber, getCode },
        { address: checksummedAddress, blockNumber: 100 },
      ),
    ).resolves.toEqual({
      address: checksummedAddress,
      blockNumber: '100',
      isContract: false,
      bytecodeSizeBytes: 0,
      bytecodeHash: null,
      bytecodePreview: '0x',
      bytecodeTruncated: false,
    });
  });

  it('поддерживает нулевой лимит preview', async () => {
    const getChainId = vi.fn<ContractCodeClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<ContractCodeClient['getBlockNumber']>();
    const getCode = vi.fn<ContractCodeClient['getCode']>().mockResolvedValue('0x6000');

    await expect(
      getContractCode(
        { getChainId, getBlockNumber, getCode },
        { address: checksummedAddress, blockNumber: 100 },
        { maxPreviewBytes: 0 },
      ),
    ).resolves.toMatchObject({
      isContract: true,
      bytecodeSizeBytes: 2,
      bytecodePreview: '0x',
      bytecodeTruncated: true,
    });
  });

  it('отклоняет неправильный адрес до RPC-вызовов', async () => {
    const getChainId = vi.fn<ContractCodeClient['getChainId']>();
    const getBlockNumber = vi.fn<ContractCodeClient['getBlockNumber']>();
    const getCode = vi.fn<ContractCodeClient['getCode']>();

    await expect(
      getContractCode({ getChainId, getBlockNumber, getCode }, { address: '0x1234' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(getChainId).not.toHaveBeenCalled();
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getCode).not.toHaveBeenCalled();
  });

  it('отклоняет неправильный номер блока до RPC-вызовов', async () => {
    const getChainId = vi.fn<ContractCodeClient['getChainId']>();
    const getBlockNumber = vi.fn<ContractCodeClient['getBlockNumber']>();
    const getCode = vi.fn<ContractCodeClient['getCode']>();

    await expect(
      getContractCode(
        { getChainId, getBlockNumber, getCode },
        { address: checksummedAddress, blockNumber: -1 },
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(getChainId).not.toHaveBeenCalled();
    expect(getCode).not.toHaveBeenCalled();
  });

  it.each([-1, 4_097, 1.5])(
    'отклоняет некорректный лимит preview до RPC-вызовов: %s',
    async (maxPreviewBytes) => {
      const getChainId = vi.fn<ContractCodeClient['getChainId']>();
      const getBlockNumber = vi.fn<ContractCodeClient['getBlockNumber']>();
      const getCode = vi.fn<ContractCodeClient['getCode']>();

      await expect(
        getContractCode(
          { getChainId, getBlockNumber, getCode },
          { address: checksummedAddress },
          { maxPreviewBytes },
        ),
      ).rejects.toBeInstanceOf(ZodError);
      expect(getChainId).not.toHaveBeenCalled();
      expect(getCode).not.toHaveBeenCalled();
    },
  );

  it('не читает bytecode при подключении к другой сети', async () => {
    const getChainId = vi.fn<ContractCodeClient['getChainId']>().mockResolvedValue(1);
    const getBlockNumber = vi.fn<ContractCodeClient['getBlockNumber']>();
    const getCode = vi.fn<ContractCodeClient['getCode']>();

    await expect(
      getContractCode({ getChainId, getBlockNumber, getCode }, { address: checksummedAddress }),
    ).rejects.toBeInstanceOf(SepoliaChainMismatchError);
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getCode).not.toHaveBeenCalled();
  });

  it('сохраняет причину ошибки определения latest-блока', async () => {
    const cause = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    const getChainId = vi.fn<ContractCodeClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<ContractCodeClient['getBlockNumber']>().mockRejectedValue(cause);
    const getCode = vi.fn<ContractCodeClient['getCode']>();

    try {
      await getContractCode(
        { getChainId, getBlockNumber, getCode },
        { address: checksummedAddress },
      );
      expect.unreachable('Ожидалась ошибка чтения latest-блока.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetContractCodeError);

      if (!(error instanceof GetContractCodeError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to resolve the latest Sepolia block number.');
      expect(error.cause).toBe(cause);
    }

    expect(getCode).not.toHaveBeenCalled();
  });

  it('сохраняет причину RPC-ошибки чтения bytecode', async () => {
    const cause = Object.assign(new Error('rate limited'), { status: 429 });
    const getChainId = vi.fn<ContractCodeClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<ContractCodeClient['getBlockNumber']>();
    const getCode = vi.fn<ContractCodeClient['getCode']>().mockRejectedValue(cause);

    try {
      await getContractCode(
        { getChainId, getBlockNumber, getCode },
        { address: checksummedAddress, blockNumber: 100 },
      );
      expect.unreachable('Ожидалась ошибка чтения bytecode.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetContractCodeError);

      if (!(error instanceof GetContractCodeError)) {
        throw error;
      }

      expect(error.message).toBe('Unable to read bytecode from Sepolia.');
      expect(error.cause).toBe(cause);
    }
  });

  it('оборачивает malformed bytecode из RPC-ответа', async () => {
    const getChainId = vi.fn<ContractCodeClient['getChainId']>().mockResolvedValue(11_155_111);
    const getBlockNumber = vi.fn<ContractCodeClient['getBlockNumber']>();
    const getCode = vi.fn<ContractCodeClient['getCode']>().mockResolvedValue('0x1' as Hex);

    try {
      await getContractCode(
        { getChainId, getBlockNumber, getCode },
        { address: checksummedAddress, blockNumber: 100 },
      );
      expect.unreachable('Ожидалась ошибка проверки bytecode.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GetContractCodeError);

      if (!(error instanceof GetContractCodeError)) {
        throw error;
      }

      expect(error.cause).toBeInstanceOf(ZodError);
    }
  });
});
