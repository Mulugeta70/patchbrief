import { performance } from "node:perf_hooks";
import {
  createRunningStep,
  finishStep,
  setRunStatus,
} from "./db";
import { pipelineSteps } from "./steps";

function summarize(output: Record<string, unknown>): string {
  const result = output["result"];
  return typeof result === "string" ? result : JSON.stringify(output);
}

export async function runPipeline(
  runId: string,
  input: string,
): Promise<void> {
  await setRunStatus(runId, "running");

  for (const [index, step] of pipelineSteps.entries()) {
    const startedAt = new Date();
    const stepRow = await createRunningStep(runId, index + 1, step.name, startedAt);
    const started = performance.now();

    try {
      const output = await step.run({ input });
      await finishStep(stepRow.id, {
        status: "completed",
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        output,
        outputSummary: summarize(output),
      });
    } catch (error) {
      await finishStep(stepRow.id, {
        status: "failed",
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        error: error instanceof Error ? error.message : String(error),
      });
      await setRunStatus(runId, "failed", new Date());
      return;
    }
  }

  await setRunStatus(runId, "completed", new Date());
}
