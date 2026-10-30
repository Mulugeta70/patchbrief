import { performance } from "node:perf_hooks";
import {
  createRunningStep,
  finishStep,
  setRunStatus,
} from "./db";
import type { PipelineContext, PipelineOutput, StepName } from "./pipelineTypes";
import { pipelineSteps } from "./steps";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export async function runPipeline(
  runId: string,
  input: string,
): Promise<void> {
  await setRunStatus(runId, "running");
  const priorOutputs: Partial<Record<StepName, PipelineOutput>> = {};

  for (const [index, step] of pipelineSteps.entries()) {
    const startedAt = new Date();
    const stepRow = await createRunningStep(runId, index + 1, step.name, startedAt);
    const started = performance.now();

    try {
      const context: PipelineContext = {
        input,
        priorOutputs,
      };
      const output = await step.run(context);
      const outputSummary = oneLine(output.output_summary);
      await finishStep(stepRow.id, {
        status: "completed",
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        output,
        outputSummary,
      });
      priorOutputs[step.name] = output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finishStep(stepRow.id, {
        status: "failed",
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        outputSummary: oneLine(`Failed: ${message}`),
        error: message,
      });
      await setRunStatus(runId, "failed", new Date());
      return;
    }
  }

  await setRunStatus(runId, "completed", new Date());
}
