import { asc, eq } from "drizzle-orm";
import {
  db,
  runsTable,
  stackItemsTable,
  stepsTable,
  type Run,
  type Step,
  type StepOutput,
} from "@workspace/db";

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

export async function createRun(
  input: string,
  idempotencyKey: string,
): Promise<{ run: Run; created: boolean }> {
  const [inserted] = await db
    .insert(runsTable)
    .values({ input, idempotencyKey, status: "queued" })
    .onConflictDoNothing({ target: runsTable.idempotencyKey })
    .returning();

  if (inserted) return { run: inserted, created: true };

  const [existing] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.idempotencyKey, idempotencyKey))
    .limit(1);

  if (!existing) {
    throw new Error("Run insert conflicted, but the existing run was not found.");
  }

  return { run: existing, created: false };
}

export async function setRunStatus(
  runId: string,
  status: string,
  finishedAt?: Date,
): Promise<void> {
  await db
    .update(runsTable)
    .set({ status, ...(finishedAt ? { finishedAt } : {}) })
    .where(eq(runsTable.id, runId));
}

export async function createRunningStep(
  runId: string,
  seq: number,
  name: string,
  startedAt: Date,
): Promise<Step> {
  const [step] = await db
    .insert(stepsTable)
    .values({
      runId,
      seq,
      name,
      status: "running",
      attempt: 1,
      startedAt,
    })
    .returning();

  if (!step) throw new Error(`Could not create running step: ${name}`);
  return step;
}

export async function finishStep(
  stepId: string,
  values: {
    status: "completed" | "failed";
    durationMs: number;
    output?: StepOutput;
    outputSummary?: string;
    error?: string;
    fallbackUsed?: boolean;
  },
): Promise<void> {
  await db
    .update(stepsTable)
    .set({
      ...values,
      fallbackUsed: values.fallbackUsed ?? false,
    })
    .where(eq(stepsTable.id, stepId));
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
