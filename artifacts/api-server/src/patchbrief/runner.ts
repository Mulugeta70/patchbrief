import { performance } from "node:perf_hooks";
import {
  createRunningStep,
  finishStep,
  markRunDegraded,
  setRunStatus,
} from "./db";
import { createStepAttemptRecorder } from "./attempts";
import {
  NeedsInputError,
  type PipelineContext,
  type PipelineOutput,
  type StepName,
} from "./pipelineTypes";
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
  const fallbackSteps: string[] = [];
  let degraded = false;

  for (const [index, step] of pipelineSteps.entries()) {
    const startedAt = new Date();
    const stepRow = await createRunningStep(runId, index + 1, step.name, startedAt);
    const started = performance.now();
    const attempts = createStepAttemptRecorder(runId, stepRow.id, step.name);

    try {
      const context: PipelineContext = {
        input,
        priorOutputs,
        attempts,
        degraded,
        fallbackSteps: [...fallbackSteps],
      };
      const output = await step.run(context);
      const outputSummary = oneLine(output.output_summary);
      const fallbackUsed = output.fallback_used === true;
      const fallbackReason =
        typeof output.fallback_reason === "string"
          ? output.fallback_reason
          : undefined;
      if (fallbackUsed) {
        degraded = true;
        fallbackSteps.push(step.name);
        await markRunDegraded(runId);
      }
      await finishStep(stepRow.id, {
        status: "completed",
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        output,
        outputSummary,
        error: fallbackReason,
        fallbackUsed,
      });
      priorOutputs[step.name] = output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      await attempts.ensureFailureAttempt(message, durationMs);

      if (error instanceof NeedsInputError && step.name === "fetch") {
        await finishStep(stepRow.id, {
          status: "needs_input",
          durationMs,
          outputSummary: oneLine(`Needs input: ${message}`),
          error: message,
        });
        await setRunStatus(runId, "needs_input", null);
        return;
      }

      await finishStep(stepRow.id, {
        status: "failed",
        durationMs,
        outputSummary: oneLine(`Failed: ${message}`),
        error: message,
      });
      await setRunStatus(runId, "failed", new Date());
      return;
    }
  }

  await setRunStatus(runId, "completed", new Date());
}
