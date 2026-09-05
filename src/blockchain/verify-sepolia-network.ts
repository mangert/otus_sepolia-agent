import { sepolia } from 'viem/chains';

export interface ChainIdReader {
  getChainId(): Promise<number>;
}

export class SepoliaNetworkVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SepoliaNetworkVerificationError';
  }
}

export class SepoliaChainMismatchError extends SepoliaNetworkVerificationError {
  readonly actualChainId: number;
  readonly expectedChainId = sepolia.id;

  constructor(actualChainId: number) {
    super(`RPC endpoint returned chain ID ${actualChainId}; expected Sepolia (${sepolia.id}).`);
    this.name = 'SepoliaChainMismatchError';
    this.actualChainId = actualChainId;
  }
}

/** Проверяет, что RPC endpoint подключён к сети Sepolia. */
export const verifySepoliaNetwork = async (client: ChainIdReader): Promise<number> => {
  let chainId: number;

  try {
    chainId = await client.getChainId();
  } catch (error: unknown) {
    throw new SepoliaNetworkVerificationError('Unable to read chain ID from the RPC endpoint.', {
      cause: error,
    });
  }

  if (chainId !== sepolia.id) {
    throw new SepoliaChainMismatchError(chainId);
  }

  return chainId;
};
