import { describe, expect, it, vi } from 'vitest';

import {
  getRateLimitRetryDelayMs,
  isRateLimitError,
  retryRateLimitedOperation,
} from './rate-limit-retry.js';

describe('rate limit retry', () => {
  it('читает Retry-After в секундах', () => {
    const error = Object.assign(new Error('limited'), {
      status: 429,
      headers: new Headers({ 'retry-after': '3' }),
    });

    expect(isRateLimitError(error)).toBe(true);
    expect(getRateLimitRetryDelayMs(error, 0)).toBe(3_000);
  });

  it('читает задержку из сообщения Groq', () => {
    const error = Object.assign(new Error('Please try again in 2.5s.'), { status: 429 });

    expect(getRateLimitRetryDelayMs(error, 0)).toBe(2_500);
  });

  it('повторяет только ограниченный вызов и сохраняет результат', async () => {
    const error = Object.assign(new Error('Please try again in 3s.'), { status: 429 });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('ok');
    const wait = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue();

    await expect(
      retryRateLimitedOperation(operation, { maxRetries: 2, sleep: wait }),
    ).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(3_000);
  });

  it('не повторяет прочие ошибки', async () => {
    const error = new Error('bad request');
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);
    const wait = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue();

    await expect(retryRateLimitedOperation(operation, { maxRetries: 2, sleep: wait })).rejects.toBe(
      error,
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
});
