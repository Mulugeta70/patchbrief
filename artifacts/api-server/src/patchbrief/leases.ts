import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { db, runsTable, stepsTable, stepAttemptsTable } from "@workspace/db";
import { publishAttempt, publishRunUpdate, publishStep } from "./events";
import { LeaseLostError } from "./workerErrors";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const LEASE_SECONDS = 12;
export const HEARTBEAT_MS = 3000;

// Locking the owning run fences every write against a concurrent lease takeover.
export async function withRunLock<T>(
  runId: string,
  workerId: string | undefined,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(runsTable)
      .where(and(eq(runsTable.id, runId), workerId
        ? and(eq(runsTable.workerId, workerId), sql`${runsTable.leaseExpiresAt} > now()`)
        : undefined))
      .for("update").limit(1);
    if (!run) throw new LeaseLostError();
    return operation(tx);
  });
}

export async function claimExpiredRuns(runId?: string) {
  // PostgreSQL rechecks this WHERE after row-lock contention. One claim wins.
  return db.update(runsTable).set({
    workerId: randomUUID(),
    leaseExpiresAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
    resumeCount: sql`${runsTable.resumeCount} + 1`,
    status: "running",
  }).where(and(
    inArray(runsTable.status, ["queued", "running"]),
    lt(runsTable.leaseExpiresAt, sql`now()`),
    runId ? eq(runsTable.id, runId) : undefined,
  )).returning();
}

export async function renewLease(runId: string, workerId: string): Promise<boolean> {
  const rows = await db.update(runsTable).set({
    leaseExpiresAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
  }).where(and(
    eq(runsTable.id, runId), eq(runsTable.workerId, workerId),
    eq(runsTable.status, "running"),
    sql`${runsTable.leaseExpiresAt} > now()`,
  )).returning({ id: runsTable.id });
  return rows.length === 1;
}

export async function prepareClaimedRun(runId: string, workerId: string) {
  const result = await withRunLock(runId, workerId, async (tx) => {
    const unfinished = await tx.select().from(stepsTable)
      .where(and(eq(stepsTable.runId, runId), ne(stepsTable.status, "completed")));
    const interruptedAttempts = [];
    const resetSteps = [];
    for (const step of unfinished) {
      if (step.status === "running" && step.attempt > 0) {
        const [attempt] = await tx.update(stepAttemptsTable).set({
          status: "interrupted",
          error: sql`concat_ws(' ', ${stepAttemptsTable.error}, 'Worker interrupted: lease expired before the step result was saved.')`,
          durationMs: sql`coalesce(${stepAttemptsTable.durationMs}, least(2147483647, greatest(0, extract(epoch from (now() - ${stepAttemptsTable.startedAt})) * 1000))::int)`,
          retryInMs: null,
        }).where(and(
          eq(stepAttemptsTable.runId, runId),
          eq(stepAttemptsTable.stepName, step.name),
          eq(stepAttemptsTable.attempt, step.attempt),
        )).returning();
        if (attempt) interruptedAttempts.push({ attempt, stepId: step.id });
      }
      const [reset] = await tx.update(stepsTable).set({
        status: "pending", startedAt: null, durationMs: null,
        output: null, outputSummary: null, error: null, fallbackUsed: false,
        interrupted: step.interrupted || step.status === "running",
        updatedAt: new Date(),
      }).where(eq(stepsTable.id, step.id)).returning();
      if (reset) resetSteps.push(reset);
    }
    return { interruptedAttempts, resetSteps };
  });
  for (const { attempt, stepId } of result.interruptedAttempts) {
    publishAttempt({ runId, stepId, stepName: attempt.stepName, attempt: attempt.attempt,
      phase: "interrupted", timestamp: new Date().toISOString(), record: attempt,
      error: attempt.error ?? undefined });
  }
  for (const step of result.resetSteps) publishStep(step);
  const [run] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
  if (run) publishRunUpdate(run);
}
