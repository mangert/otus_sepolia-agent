import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

export interface RateLimitRetryOptions {
  maxRetries: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Проверяет, является ли значение объектом с доступными полями. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Читает HTTP-заголовок из ошибки провайдера без привязки к конкретному SDK. */
const readErrorHeader = (error: unknown, name: string): string | undefined => {
  if (!isRecord(error) || !isRecord(error['headers'])) {
    return undefined;
  }

  const headers = error['headers'];

  if (typeof headers['get'] === 'function') {
    const value = headers['get'](name);
    return typeof value === 'string' ? value : undefined;
  }

  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
};

/** Определяет ошибку исчерпания rate limit по статусу или имени. */
export const isRateLimitError = (error: unknown): boolean => {
  if (!isRecord(error)) {
    return false;
  }

  return (
    error['status'] === 429 ||
    (typeof error['name'] === 'string' && error['name'].toLowerCase().includes('ratelimit'))
  );
};

/** Извлекает безопасную задержку повтора из заголовков или сообщения провайдера. */
export const getRateLimitRetryDelayMs = (error: unknown, attempt: number): number => {
  const retryAfter = readErrorHeader(error, 'retry-after');

  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.ceil(seconds * 1_000), MAX_RETRY_DELAY_MS);
    }

    const retryAt = Date.parse(retryAfter);

    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(retryAt - Date.now(), 0), MAX_RETRY_DELAY_MS);
    }
  }

  if (isRecord(error) && typeof error['message'] === 'string') {
    const match = /try again in\s+(\d+(?:\.\d+)?)s/iu.exec(error['message']);

    if (match?.[1] !== undefined) {
      return Math.min(Math.ceil(Number(match[1]) * 1_000), MAX_RETRY_DELAY_MS);
    }
  }

  return Math.min(DEFAULT_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
};

/** Повторяет только вызовы модели, отклонённые из-за rate limit. */
export const retryRateLimitedOperation = async <Result>(
  operation: () => Promise<Result> | Result,
  options: RateLimitRetryOptions,
): Promise<Result> => {
  const wait = options.sleep ?? (async (milliseconds: number) => sleep(milliseconds));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (!isRateLimitError(error) || attempt >= options.maxRetries) {
        throw error;
      }

      await wait(getRateLimitRetryDelayMs(error, attempt));
    }
  }
};
