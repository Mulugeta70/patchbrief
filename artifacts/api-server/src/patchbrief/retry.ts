import { performance } from "node:perf_hooks";
import { isWorkerStop } from "./workerErrors";

export interface RetryAttemptHooks {
  start(): Promise<number>;
  succeed(attempt: number, durationMs: number): Promise<void>;
  fail(
    attempt: number,
    durationMs: number,
    error: string,
    retryInMs: number | null,
  ): Promise<void>;
  schedule(attempt: number, retryInMs: number): Promise<void>;
}

export class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export class RetryExhaustedError extends Error {
  constructor(
    readonly maxAttempts: number,
    readonly lastError: unknown,
  ) {
    super(
      `Transient external request failed after ${maxAttempts} attempts: ${errorMessage(lastError)}`,
    );
    this.name = "RetryExhaustedError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isTransientFailure(error: unknown): boolean {
  if (error instanceof HttpRequestError) {
    return error.statusCode === 429 || (error.statusCode >= 500 && error.statusCode < 600);
  }

  if (error instanceof TypeError) return true;

  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }

  return false;
}

export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!header) return null;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 2_147_483_647);
  }

  const dateMs = Date.parse(header);
  if (!Number.isFinite(dateMs)) return null;
  return Math.min(Math.max(0, dateMs - nowMs), 2_147_483_647);
}

export function computeRetryDelayMs(
  retryNumber: number,
  retryAfterMs: number | null = null,
  random = Math.random(),
): number {
  if (retryAfterMs !== null) return retryAfterMs;

  const exponentialBase = Math.min(30_000, 300 * 2 ** (retryNumber - 1));
  const jittered = exponentialBase * (0.5 + Math.min(Math.max(random, 0), 1));
  return Math.round(jittered);
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  hooks: RetryAttemptHooks,
  options: {
    maxAttempts?: number;
    sleep?: (durationMs: number) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const sleep = options.sleep ?? sleepWithLongDelay;
  const random = options.random ?? Math.random;
  let retryNumber = 0;

  while (retryNumber < maxAttempts) {
    retryNumber += 1;
    const attempt = await hooks.start();
    const startedAt = performance.now();

    try {
      const result = await operation();
      await hooks.succeed(attempt, Math.max(0, Math.round(performance.now() - startedAt)));
      return result;
    } catch (error) {
      if (isWorkerStop(error)) throw error;
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      const transient = isTransientFailure(error);
      const shouldRetry = transient && retryNumber < maxAttempts;
      const retryInMs = shouldRetry
        ? computeRetryDelayMs(
            retryNumber,
            error instanceof HttpRequestError ? error.retryAfterMs : null,
            random(),
          )
        : null;

      await hooks.fail(attempt, durationMs, errorMessage(error), retryInMs);

      if (retryInMs !== null) {
        await hooks.schedule(attempt, retryInMs);
        await sleep(retryInMs);
        continue;
      }

      if (transient) throw new RetryExhaustedError(maxAttempts, error);
      throw error;
    }
  }

  throw new Error("Retry loop exited unexpectedly.");
}

async function sleepWithLongDelay(durationMs: number): Promise<void> {
  let remaining = durationMs;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 2_147_483_647);
    await new Promise<void>((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}
