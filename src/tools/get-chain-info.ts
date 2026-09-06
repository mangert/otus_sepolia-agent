import { sepolia } from 'viem/chains';

import { verifySepoliaNetwork, type ChainIdReader } from '../blockchain/index.js';
import { validateBlockNumber } from '../validation/index.js';

export interface ChainInfoClient extends ChainIdReader {
  getBlockNumber(): Promise<bigint>;
}

export interface ChainInfoResult {
  network: {
    name: string;
    chainId: number;
    testnet: boolean;
  };
  latestBlockNumber: string;
  connection: {
    status: 'connected';
    readOnly: true;
  };
}

export class GetChainInfoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GetChainInfoError';
  }
}

/** Возвращает проверенную информацию о сети Sepolia и актуальном блоке. */
export const getChainInfo = async (client: ChainInfoClient): Promise<ChainInfoResult> => {
  const chainId = await verifySepoliaNetwork(client);
  let latestBlockNumber: bigint;

  try {
    latestBlockNumber = validateBlockNumber(await client.getBlockNumber());
  } catch (error: unknown) {
    throw new GetChainInfoError('Unable to read the latest Sepolia block number.', {
      cause: error,
    });
  }

  return {
    network: {
      name: sepolia.name,
      chainId,
      testnet: sepolia.testnet === true,
    },
    latestBlockNumber: latestBlockNumber.toString(10),
    connection: {
      status: 'connected',
      readOnly: true,
    },
  };
};
