import { asc, desc, eq } from "drizzle-orm";
import {
  db,
  runsTable,
  stackItemsTable,
  stepsTable,
  type Run,
  type Step,
  type StepOutput,
} from "@workspace/db";
import { publishFinishedRun, publishStep } from "./events";

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
  const [updatedRun] = await db
    .update(runsTable)
    .set({ status, ...(finishedAt ? { finishedAt } : {}) })
    .where(eq(runsTable.id, runId))
    .returning();

  if (finishedAt && updatedRun) publishFinishedRun(updatedRun);
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
  publishStep(step);
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
  const [updatedStep] = await db
    .update(stepsTable)
    .set({
      ...values,
      fallbackUsed: values.fallbackUsed ?? false,
      updatedAt: new Date(),
    })
    .where(eq(stepsTable.id, stepId))
    .returning();

  if (!updatedStep) throw new Error(`Could not finish step: ${stepId}`);
  publishStep(updatedStep);
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
