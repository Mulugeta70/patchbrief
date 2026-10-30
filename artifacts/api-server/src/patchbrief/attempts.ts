import { performance } from "node:perf_hooks";
import { finishStepAttempt, startStepAttempt } from "./db";
import { publishAttempt } from "./events";
import { errorMessage, retryTransient } from "./retry";
import type { StepAttemptReporter } from "./pipelineTypes";

export interface StepAttemptRecorder extends StepAttemptReporter {
  ensureFailureAttempt(error: string, durationMs: number): Promise<void>;
}

export function createStepAttemptRecorder(
  runId: string,
  stepId: string,
  stepName: string,
): StepAttemptRecorder {
  let lastAttempt: number | null = null;
  let lastDurationMs = 0;

  const hooks = {
    async start(): Promise<number> {
      const attempt = await startStepAttempt(runId, stepId, stepName);
      lastAttempt = attempt;
      lastDurationMs = 0;
      return attempt;
    },
    async succeed(attempt: number, durationMs: number): Promise<void> {
      lastDurationMs = durationMs;
      await finishStepAttempt(runId, stepName, attempt, {
        durationMs,
        error: null,
        retryInMs: null,
      });
    },
    async fail(
      attempt: number,
      durationMs: number,
      error: string,
      retryInMs: number | null,
    ): Promise<void> {
      lastDurationMs = durationMs;
      await finishStepAttempt(runId, stepName, attempt, {
        durationMs,
        error,
        retryInMs,
      });
      publishAttempt({
        runId,
        stepId,
        stepName,
        attempt,
        phase: "failed",
        timestamp: new Date().toISOString(),
        durationMs,
        ...(retryInMs !== null ? { retryInMs } : {}),
        error,
      });
    },
    async schedule(attempt: number, retryInMs: number): Promise<void> {
      publishAttempt({
        runId,
        stepId,
        stepName,
        attempt,
        phase: "retry_scheduled",
        timestamp: new Date().toISOString(),
        retryInMs,
      });
    },
  };

  async function runLocal<T>(operation: () => Promise<T>): Promise<T> {
    const attempt = await hooks.start();
    const startedAt = performance.now();
    try {
      const result = await operation();
      await hooks.succeed(
        attempt,
        Math.max(0, Math.round(performance.now() - startedAt)),
      );
      return result;
    } catch (error) {
      await hooks.fail(
        attempt,
        Math.max(0, Math.round(performance.now() - startedAt)),
        errorMessage(error),
        null,
      );
      throw error;
    }
  }

  return {
    runLocal,
    runExternal<T>(operation: () => Promise<T>): Promise<T> {
      return retryTransient(operation, hooks);
    },
    async markLastAttemptFailed(
      error: string,
      retryInMs: number | null,
    ): Promise<void> {
      if (lastAttempt === null) return;
      await hooks.fail(lastAttempt, lastDurationMs, error, retryInMs);
      if (retryInMs !== null) {
        await hooks.schedule(lastAttempt, retryInMs);
      }
    },
    async ensureFailureAttempt(error: string, durationMs: number): Promise<void> {
      if (lastAttempt !== null) return;
      const attempt = await hooks.start();
      await hooks.fail(attempt, durationMs, error, null);
    },
  };
}
