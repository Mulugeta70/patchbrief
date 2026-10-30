import { EventEmitter } from "node:events";
import type { Run, Step } from "@workspace/db";

export type RunStreamEvent =
  | { type: "step"; runId: string; step: Step }
  | {
      type: "run";
      runId: string;
      run: Pick<Run, "id" | "status" | "degraded">;
    };

const events = new EventEmitter();

export function publishStep(step: Step): void {
  events.emit(step.runId, { type: "step", runId: step.runId, step } satisfies RunStreamEvent);
}

export function publishFinishedRun(
  run: Pick<Run, "id" | "status" | "degraded">,
): void {
  events.emit(run.id, { type: "run", runId: run.id, run } satisfies RunStreamEvent);
}

export function subscribeToRun(
  runId: string,
  listener: (event: RunStreamEvent) => void,
): () => void {
  events.on(runId, listener);
  return () => events.off(runId, listener);
}
