import { and, asc, eq, ne, sql } from "drizzle-orm";
import { runFaultsTable, stepAttemptsTable } from "@workspace/db";
import { withRunLock } from "./leases";
import { publishFault } from "./events";
import { HttpRequestError } from "./retry";
import { WorkerCrashError } from "./workerErrors";
import type { StepAttemptReporter, StepName } from "./pipelineTypes";

export type FaultType = "timeout" | "http_500" | "malformed_json" | "worker_crash";
export interface FaultInput { step: StepName; type: FaultType; times: 1 | 2 | 3 | "always" }

export async function consumeFault(
  runId: string, workerId: string, stepName: string, attempt: number, onlyCrash = false,
): Promise<FaultType | null> {
  const fault = await withRunLock(runId, workerId, async (tx) => {
    const [next] = await tx.select().from(runFaultsTable).where(and(
      eq(runFaultsTable.runId, runId), eq(runFaultsTable.stepName, stepName),
      ne(runFaultsTable.remaining, 0),
      onlyCrash ? eq(runFaultsTable.type, "worker_crash") : undefined,
    )).orderBy(asc(runFaultsTable.seq), asc(runFaultsTable.createdAt), asc(runFaultsTable.id)).limit(1).for("update");
    if (!next) return null;
    const [updated] = await tx.update(runFaultsTable).set({
      remaining: next.remaining === -1 ? -1 : next.remaining - 1,
      injectedCount: sql`${runFaultsTable.injectedCount} + 1`,
    }).where(eq(runFaultsTable.id, next.id)).returning();
    await tx.update(stepAttemptsTable).set({ faultType: next.type }).where(and(
      eq(stepAttemptsTable.runId, runId), eq(stepAttemptsTable.stepName, stepName),
      eq(stepAttemptsTable.attempt, attempt),
    ));
    return updated ?? null;
  });
  if (!fault) return null;
  publishFault(fault);
  return fault.type as FaultType;
}

export function applyFault(type: FaultType | null): void {
  if (type === "worker_crash") throw new WorkerCrashError();
  if (type === "timeout") throw new DOMException("Injected request timeout.", "TimeoutError");
  if (type === "http_500") throw new HttpRequestError(500, "Injected HTTP 500.");
}

export async function injectBoundaryFault(attempts?: StepAttemptReporter) {
  const type = await attempts?.injectFault?.() ?? null;
  applyFault(type);
  return type;
}
