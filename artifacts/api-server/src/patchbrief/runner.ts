import { performance } from "node:perf_hooks";
import type { Run } from "@workspace/db";
import { createRunningStep, finishStep, getRunWithSteps, markRunDegraded, setRunStatus } from "./db";
import { createStepAttemptRecorder } from "./attempts";
import { NeedsInputError, type PipelineContext, type PipelineOutput, type StepName } from "./pipelineTypes";
import { pipelineSteps } from "./steps";
import { HEARTBEAT_MS, prepareClaimedRun, renewLease } from "./leases";
import { isWorkerStop, LeaseLostError } from "./workerErrors";
import { logger } from "../lib/logger";

function oneLine(value: string): string { return value.replace(/\s+/g, " ").trim(); }

// A worker only runs after a database claim. Every write is fenced by that lease.
export async function runPipeline(run: Run): Promise<void> {
  const runId = run.id;
  const workerId = run.workerId;
  if (!workerId) throw new Error("A worker must claim the run before executing it.");
  let leaseLost = false;
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing || leaseLost) return;
    renewing = true;
    void renewLease(runId, workerId).then((renewed) => {
      if (!renewed) leaseLost = true;
    }).catch((error: unknown) => {
      leaseLost = true;
      logger.error({ err: error, runId }, "Worker heartbeat failed");
    }).finally(() => { renewing = false; });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    await prepareClaimedRun(runId, workerId);
    const saved = await getRunWithSteps(runId);
    if (!saved) throw new Error("Claimed run disappeared.");
    const priorOutputs: Partial<Record<StepName, PipelineOutput>> = {};
    const fallbackSteps: string[] = [];
    let degraded = saved.run.degraded;
    for (const [index, step] of pipelineSteps.entries()) {
      if (leaseLost) throw new LeaseLostError();
      const completed = saved.steps.find((row) => row.seq === index + 1 && row.status === "completed");
      if (completed) {
        if (!completed.output) throw new Error(`Saved output missing for completed ${step.name}.`);
        priorOutputs[step.name] = completed.output as PipelineOutput;
        if (completed.fallbackUsed) fallbackSteps.push(step.name);
        continue;
      }
      const stepRow = await createRunningStep(runId, index + 1, step.name, new Date(), workerId);
      const started = performance.now();
      const attempts = createStepAttemptRecorder(runId, stepRow.id, step.name, workerId);
      try {
        const context: PipelineContext = {
          input: saved.run.input, priorOutputs, attempts, degraded,
          fallbackSteps: [...fallbackSteps], llmDisabledReason: saved.run.llmDisabledReason,
        };
        const output = await step.run(context);
        if (leaseLost) throw new LeaseLostError();
        const fallbackUsed = output.fallback_used === true;
        const fallbackReason = typeof output.fallback_reason === "string" ? output.fallback_reason : undefined;
        if (fallbackUsed) {
          degraded = true;
          fallbackSteps.push(step.name);
          await markRunDegraded(runId, workerId);
        }
        await finishStep(stepRow.id, {
          status: "completed", durationMs: Math.max(0, Math.round(performance.now() - started)),
          output, outputSummary: oneLine(output.output_summary), error: fallbackReason, fallbackUsed,
        }, runId, workerId);
        priorOutputs[step.name] = output;
      } catch (error) {
        // A simulated crash deliberately leaves BOTH step and attempt running.
        // Recovery, not this worker, records the interruption after lease expiry.
        if (isWorkerStop(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const durationMs = Math.max(0, Math.round(performance.now() - started));
        await attempts.ensureFailureAttempt(message, durationMs);
        const needsInput = error instanceof NeedsInputError && step.name === "fetch";
        await finishStep(stepRow.id, {
          status: needsInput ? "needs_input" : "failed", durationMs,
          outputSummary: oneLine(`${needsInput ? "Needs input" : "Failed"}: ${message}`), error: message,
        }, runId, workerId);
        await setRunStatus(runId, needsInput ? "needs_input" : "failed",
          needsInput ? null : new Date(), workerId);
        return;
      }
      if (saved.run.slowMode && index < pipelineSteps.length - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      }
    }
    await setRunStatus(runId, "completed", new Date(), workerId);
  } catch (error) {
    if (!isWorkerStop(error)) throw error;
    logger.info({ runId, reason: (error as Error).message }, "Run worker stopped; lease recovery will continue");
  } finally {
    clearInterval(heartbeat);
  }
}
