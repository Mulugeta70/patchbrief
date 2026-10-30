import { EventEmitter } from "node:events";
import type { Run, Step } from "@workspace/db";

export type RunStreamEvent =
  | { type: "step"; runId: string; step: Step }
  | { type: "attempt"; runId: string; attempt: AttemptStreamEvent }
  | {
      type: "run";
      runId: string;
      run: Pick<Run, "id" | "status" | "degraded" | "input">;
    };

export interface AttemptStreamEvent {
  runId: string;
  stepId: string;
  stepName: string;
  attempt: number;
  phase: "started" | "failed" | "retry_scheduled";
  timestamp: string;
  durationMs?: number;
  retryInMs?: number;
  error?: string;
}

const events = new EventEmitter();

export function publishStep(step: Step): void {
  events.emit(step.runId, { type: "step", runId: step.runId, step } satisfies RunStreamEvent);
}

export function publishRunUpdate(
  run: Pick<Run, "id" | "status" | "degraded" | "input">,
): void {
  events.emit(run.id, { type: "run", runId: run.id, run } satisfies RunStreamEvent);
}

export function publishAttempt(attempt: AttemptStreamEvent): void {
  events.emit(attempt.runId, {
    type: "attempt",
    runId: attempt.runId,
    attempt,
  } satisfies RunStreamEvent);
}

export function subscribeToRun(
  runId: string,
  listener: (event: RunStreamEvent) => void,
): () => void {
  events.on(runId, listener);
  return () => events.off(runId, listener);
}
