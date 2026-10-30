import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  runsTable,
  stackItemsTable,
  stepAttemptsTable,
  stepsTable,
  type Run,
  type Step,
  type StepOutput,
} from "@workspace/db";
import { publishAttempt, publishRunUpdate, publishStep } from "./events";

const placeholderStack = [
  { name: "node", version: "18" },
  { name: "express", version: "4.17.1" },
  { name: "lodash", version: "4.17.20" },
  { name: "postgres", version: "15" },
] as const;

export async function seedStackItems(): Promise<void> {
  await db
    .insert(stackItemsTable)
    .values([...placeholderStack])
    .onConflictDoNothing({ target: stackItemsTable.name });
}

export async function getStackItems(): Promise<
  Array<{ name: string; version: string }>
> {
  return db
    .select({ name: stackItemsTable.name, version: stackItemsTable.version })
    .from(stackItemsTable)
    .orderBy(asc(stackItemsTable.name));
}

export async function createRun(
  input: string,
  idempotencyKey: string,
  maximumRunsPerDay = configuredDailyRunLimit(),
): Promise<{ run: Run; created: boolean }> {
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(runsTable)
      .where(eq(runsTable.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing) return { run: existing, created: false };

    // Serialize new-run creation so concurrent requests cannot exceed the daily cap.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(284719053)`);

    const [afterLock] = await tx
      .select()
      .from(runsTable)
      .where(eq(runsTable.idempotencyKey, idempotencyKey))
      .limit(1);
    if (afterLock) return { run: afterLock, created: false };

    const now = new Date();
    const utcDayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const [dailyCount] = await tx
      .select({ total: count() })
      .from(runsTable)
      .where(gte(runsTable.createdAt, utcDayStart));

    if ((dailyCount?.total ?? 0) >= maximumRunsPerDay) {
      throw new DailyRunLimitError(maximumRunsPerDay);
    }

    const [inserted] = await tx
      .insert(runsTable)
      .values({ input, idempotencyKey, status: "queued" })
      .onConflictDoNothing({ target: runsTable.idempotencyKey })
      .returning();

    if (inserted) return { run: inserted, created: true };

    const [conflict] = await tx
      .select()
      .from(runsTable)
      .where(eq(runsTable.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!conflict) {
      throw new Error("Run insert conflicted, but the existing run was not found.");
    }
    return { run: conflict, created: false };
  });

  return result;
}

export class DailyRunLimitError extends Error {
  constructor(readonly maximumRunsPerDay: number) {
    super(
      `The daily run limit of ${maximumRunsPerDay} has been reached. Try again after UTC midnight.`,
    );
    this.name = "DailyRunLimitError";
  }
}

function configuredDailyRunLimit(): number {
  const raw = process.env.PATCHBRIEF_MAX_RUNS_PER_DAY;
  if (raw === undefined || raw.trim() === "") return 100;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("PATCHBRIEF_MAX_RUNS_PER_DAY must be a positive integer.");
  }
  return value;
}

export async function setRunStatus(
  runId: string,
  status: string,
  finishedAt?: Date | null,
): Promise<void> {
  const [updatedRun] = await db
    .update(runsTable)
    .set({ status, ...(finishedAt !== undefined ? { finishedAt } : {}) })
    .where(eq(runsTable.id, runId))
    .returning();

  if (updatedRun) publishRunUpdate(updatedRun);
}

export async function markRunDegraded(runId: string): Promise<void> {
  const [updatedRun] = await db
    .update(runsTable)
    .set({ degraded: true })
    .where(eq(runsTable.id, runId))
    .returning();

  if (updatedRun) publishRunUpdate(updatedRun);
}

export async function createRunningStep(
  runId: string,
  seq: number,
  name: string,
  startedAt: Date,
): Promise<Step> {
  const [existing] = await db
    .select()
    .from(stepsTable)
    .where(and(eq(stepsTable.runId, runId), eq(stepsTable.seq, seq)))
    .limit(1);

  if (existing) {
    if (existing.name !== name || existing.status !== "running") {
      throw new Error(`Cannot resume pipeline step ${name} from ${existing.status}.`);
    }
    return existing;
  }

  const [step] = await db
    .insert(stepsTable)
    .values({ runId, seq, name, status: "running", attempt: 0, startedAt })
    .returning();

  if (!step) throw new Error(`Could not create running step: ${name}`);
  publishStep(step);
  return step;
}

export async function startStepAttempt(
  runId: string,
  stepId: string,
  stepName: string,
): Promise<number> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [step] = await tx
      .select()
      .from(stepsTable)
      .where(and(eq(stepsTable.id, stepId), eq(stepsTable.runId, runId)))
      .for("update")
      .limit(1);

    if (!step || step.status !== "running" || step.name !== stepName) {
      throw new Error(`Cannot start an attempt for step ${stepName}.`);
    }

    const attempt = step.attempt + 1;
    await tx.insert(stepAttemptsTable).values({
      runId,
      stepName,
      attempt,
      startedAt: now,
    });

    const [updatedStep] = await tx
      .update(stepsTable)
      .set({
        attempt,
        startedAt: step.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(stepsTable.id, stepId))
      .returning();

    if (!updatedStep) throw new Error(`Could not update step attempt: ${stepId}`);
    return { attempt, step: updatedStep };
  });

  publishStep(result.step);
  publishAttempt({
    runId,
    stepId,
    stepName,
    attempt: result.attempt,
    phase: "started",
    timestamp: now.toISOString(),
  });
  return result.attempt;
}

export async function finishStepAttempt(
  runId: string,
  stepName: string,
  attempt: number,
  values: {
    durationMs: number;
    error: string | null;
    retryInMs: number | null;
  },
): Promise<void> {
  const [updatedAttempt] = await db
    .update(stepAttemptsTable)
    .set(values)
    .where(
      and(
        eq(stepAttemptsTable.runId, runId),
        eq(stepAttemptsTable.stepName, stepName),
        eq(stepAttemptsTable.attempt, attempt),
      ),
    )
    .returning();

  if (!updatedAttempt) {
    throw new Error(`Could not finish ${stepName} attempt ${attempt}.`);
  }
}

export async function finishStep(
  stepId: string,
  values: {
    status: "completed" | "needs_input" | "failed";
    durationMs: number;
    output?: StepOutput;
    outputSummary?: string;
    error?: string;
    fallbackUsed?: boolean;
  },
): Promise<void> {
  const [updatedStep] = await db
    .update(stepsTable)
    .set({
      status: values.status,
      durationMs: values.durationMs,
      output: values.output ?? null,
      outputSummary: values.outputSummary ?? null,
      error: values.error ?? null,
      fallbackUsed: values.fallbackUsed ?? false,
      updatedAt: new Date(),
    })
    .where(eq(stepsTable.id, stepId))
    .returning();

  if (!updatedStep) throw new Error(`Could not finish step: ${stepId}`);
  publishStep(updatedStep);
}

export async function resumeRunWithInput(
  runId: string,
  input: string,
): Promise<
  | { kind: "resumed"; run: Run; fetchStep: Step }
  | { kind: "not_found" }
  | { kind: "not_waiting" }
> {
  const result = await db.transaction(async (tx) => {
    const [existingRun] = await tx
      .select()
      .from(runsTable)
      .where(eq(runsTable.id, runId))
      .limit(1);

    if (!existingRun) return { kind: "not_found" as const };
    if (existingRun.status !== "needs_input") {
      return { kind: "not_waiting" as const };
    }

    const [run] = await tx
      .update(runsTable)
      .set({ input, status: "running", finishedAt: null })
      .where(and(eq(runsTable.id, runId), eq(runsTable.status, "needs_input")))
      .returning();
    if (!run) return { kind: "not_waiting" as const };

    const [fetchStep] = await tx
      .update(stepsTable)
      .set({
        status: "running",
        startedAt: null,
        durationMs: null,
        output: null,
        outputSummary: null,
        error: null,
        fallbackUsed: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stepsTable.runId, runId),
          eq(stepsTable.seq, 1),
          eq(stepsTable.name, "fetch"),
          eq(stepsTable.status, "needs_input"),
        ),
      )
      .returning();

    if (!fetchStep) throw new Error("The waiting run does not have a fetch step.");
    return { kind: "resumed" as const, run, fetchStep };
  });

  if (result.kind === "resumed") {
    publishStep(result.fetchStep);
    publishRunUpdate(result.run);
  }
  return result;
}

export async function getRunWithSteps(
  runId: string,
): Promise<{ run: Run; steps: Step[] } | null> {
  const [run] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);

  if (!run) return null;

  const steps = await db
    .select()
    .from(stepsTable)
    .where(eq(stepsTable.runId, runId))
    .orderBy(asc(stepsTable.seq));

  return { run, steps };
}

export async function getLatestRunWithSteps(): Promise<{
  run: Run;
  steps: Step[];
} | null> {
  const [run] = await db
    .select()
    .from(runsTable)
    .orderBy(desc(runsTable.createdAt))
    .limit(1);

  if (!run) return null;
  return getRunWithSteps(run.id);
}
