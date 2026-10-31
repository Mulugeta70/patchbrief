import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, pool, runsTable, stepsTable } from "@workspace/db";
import { createRun, getRunWithSteps, seedStackItems } from "./db";
import { claimExpiredRuns, withRunLock } from "./leases";
import { runPipeline } from "./runner";
import { LeaseLostError, WorkerCrashError } from "./workerErrors";
import { pipelineSteps } from "./steps";
import { fetchStep } from "./steps/fetch";
import { createExtractStep } from "./steps/extract";
import type { PipelineContext, PipelineOutput } from "./pipelineTypes";
import app from "../app";

before(seedStackItems);
after(async () => { await pool.end(); });
const input = "Lodash versions <= 4.17.20 are affected. Fixed in version 4.17.21. CVSS score: 8.2.";
const cleanup = (id: string) => db.delete(runsTable).where(eq(runsTable.id, id));

test("crashed run recovers once, preserves completed steps, and fences the old worker", async () => {
  const { run } = await createRun(input, `integration-${randomUUID()}`, {
    faults: [
      { step: "extract", type: "worker_crash", times: 1 },
      { step: "extract", type: "malformed_json", times: "always" },
      { step: "plan", type: "malformed_json", times: "always" },
    ],
  }, 1_000_000);
  try {
    const claims = await Promise.all([claimExpiredRuns(run.id), claimExpiredRuns(run.id)]);
    assert.equal(claims.flat().length, 1, "Only one concurrent worker can claim the run");
    const original = claims.flat()[0]!;
    await runPipeline(original);
    const crashed = (await getRunWithSteps(run.id))!;
    assert.equal(crashed.run.status, "running");
    assert.equal(crashed.run.resumeCount, 1);
    assert.equal(crashed.steps[0]?.status, "completed");
    assert.equal(crashed.steps[1]?.status, "running");
    assert.equal(crashed.attempts.find((a) => a.stepName === "extract")?.status, "running");
    assert.equal(crashed.attempts.find((a) => a.stepName === "extract")?.error, null);
    assert.equal(crashed.faults[0]?.injectedCount, 1);
    const fetchSavedAt = crashed.steps[0]!.updatedAt.toISOString();
    await db.update(runsTable).set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(runsTable.id, run.id));
    const [replacement] = await claimExpiredRuns(run.id);
    assert.ok(replacement);
    await assert.rejects(withRunLock(run.id, original.workerId!, async () => {}),
      LeaseLostError, "Old worker cannot write after another claims its lease");
    await runPipeline(replacement);
    const finished = (await getRunWithSteps(run.id))!;
    assert.equal(finished.run.status, "completed");
    assert.equal(finished.run.resumeCount, 2);
    assert.equal(finished.steps.length, 5);
    assert.deepEqual(finished.steps.map((s) => s.seq), [1, 2, 3, 4, 5]);
    assert.equal(finished.steps[0]!.updatedAt.toISOString(), fetchSavedAt);
    assert.equal(finished.steps[0]!.attempt, 1);
    assert.equal(finished.steps[1]!.interrupted, true);
    assert.deepEqual(finished.attempts.filter((a) => a.stepName === "extract").map((a) => a.status),
      ["interrupted", "failed", "failed"]);
    assert.equal(finished.faults[0]?.remaining, 0);
    assert.equal(finished.faults[1]?.injectedCount, 2);
    assert.equal(finished.run.workerId, null);
    assert.equal(finished.run.leaseExpiresAt, null);
  } finally { await cleanup(run.id); }
});

test("daily budget accepts a degraded run and skips every LLM boundary", async () => {
  const { run, created } = await createRun(input, `budget-${randomUUID()}`, {
    faults: [
      { step: "extract", type: "malformed_json", times: "always" },
      { step: "plan", type: "malformed_json", times: "always" },
    ],
  }, 0);
  try {
    assert.equal(created, true);
    assert.equal(run.degraded, true);
    assert.match(run.llmDisabledReason!, /budget/);
    const [claimed] = await claimExpiredRuns(run.id);
    await runPipeline(claimed!);
    const saved = (await getRunWithSteps(run.id))!;
    assert.equal(saved.run.status, "completed");
    assert.equal(saved.steps.length, 5);
    assert.equal(saved.faults.every((fault) => fault.injectedCount === 0), true);
    assert.equal(saved.steps.filter((s) => s.fallbackUsed).length, 2);
    assert.match(String(saved.steps[4]?.output?.markdown), /extract, plan/);
  } finally { await cleanup(run.id); }
});

test("invalid LLM JSON gets one corrective retry, then fallback and saved degraded flag", async () => {
  const { run } = await createRun(input, `json-${randomUUID()}`, {
    faults: [
      { step: "extract", type: "malformed_json", times: "always" },
      { step: "plan", type: "malformed_json", times: "always" },
    ],
  }, 1_000_000);
  try {
    const [claimed] = await claimExpiredRuns(run.id);
    await runPipeline(claimed!);
    const saved = (await getRunWithSteps(run.id))!;
    const attempts = saved.attempts.filter((a) => a.stepName === "extract");
    assert.equal(saved.run.status, "completed");
    assert.equal(saved.run.degraded, true);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((a) => a.status), ["failed", "failed"]);
    assert.deepEqual(attempts.map((a) => a.retryInMs), [0, null]);
    assert.equal(saved.steps[1]?.fallbackUsed, true);
    assert.equal(saved.faults[0]?.injectedCount, 2);
  } finally { await cleanup(run.id); }
});

async function waitUntilFinished(id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const saved = await getRunWithSteps(id);
    if (saved && ["completed", "failed"].includes(saved.run.status)) return saved;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Test run did not finish within 10 seconds.");
}

test("sequential and simultaneous POSTs with one idempotency key create exactly one run", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs`;
  const ids = new Set<string>();
  try {
    for (const concurrent of [false, true]) {
      const key = `post-${randomUUID()}`;
      const post = () => fetch(url, { method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ input, faults: [
          { step: "extract", type: "malformed_json", times: "always" },
          { step: "plan", type: "malformed_json", times: "always" },
        ] }),
      });
      const responses = concurrent ? await Promise.all([post(), post()]) : [await post(), await post()];
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
      const bodies = await Promise.all(responses.map((r) => r.json())) as Array<{ run: { id: string } }>;
      for (const body of bodies) ids.add(body.run.id);
      assert.equal(bodies[0]!.run.id, bodies[1]!.run.id);
      const rows = await db.select().from(runsTable).where(eq(runsTable.idempotencyKey, key));
      assert.equal(rows.length, 1);
      const saved = await waitUntilFinished(bodies[0]!.run.id);
      assert.equal(saved.steps.length, 5);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const id of ids) await cleanup(id);
  }
});

async function seedFirstTwo(id: string) {
  const context: PipelineContext = { input, priorOutputs: {}, degraded: true, fallbackSteps: [],
    llmDisabledReason: "Test: no LLM calls", attempts: {
      runLocal: (operation) => operation(), runExternal: (operation) => operation(),
      async markLastAttemptFailed() {},
    } };
  const first = await fetchStep.run(context);
  context.priorOutputs.fetch = first;
  const second = await createExtractStep(async () => { throw new Error("No LLM expected"); }).run(context);
  return db.insert(stepsTable).values([first, second].map((output, i) => ({
    runId: id, seq: i + 1, name: ["fetch", "extract"][i]!, status: "completed",
    attempt: 1, startedAt: new Date(), durationMs: 1, output,
    outputSummary: output.output_summary, fallbackUsed: output.fallback_used === true,
  }))).returning();
}

test("recovery with steps 1 and 2 saved executes only steps 3 to 5", async () => {
  const { run } = await createRun(input, `seeded-${randomUUID()}`, {}, 0);
  const originals = pipelineSteps.map((step) => step.run);
  const executed: string[] = [];
  try {
    const seeded = await seedFirstTwo(run.id);
    pipelineSteps.forEach((step, index) => {
      step.run = async (context) => { executed.push(step.name); return originals[index]!(context); };
    });
    const [claimed] = await claimExpiredRuns(run.id);
    await runPipeline(claimed!);
    const saved = (await getRunWithSteps(run.id))!;
    assert.equal(saved.run.status, "completed");
    assert.deepEqual(executed, ["assess", "plan", "brief"]);
    assert.deepEqual(saved.steps.slice(0, 2), seeded);
    assert.deepEqual(saved.attempts.map((a) => a.stepName), ["assess", "plan", "brief"]);
  } finally {
    pipelineSteps.forEach((step, index) => { step.run = originals[index]!; });
    await cleanup(run.id);
  }
});

test("a finished but unsaved step reruns with identical output and no duplicate rows", async () => {
  const { run } = await createRun(input, `unsaved-${randomUUID()}`, {}, 0);
  const assess = pipelineSteps[2]!;
  const original = assess.run;
  const outputs: PipelineOutput[] = [];
  try {
    await seedFirstTwo(run.id);
    assess.run = async (context) => {
      const output = await original(context);
      outputs.push(output);
      if (outputs.length === 1) throw new WorkerCrashError();
      return output;
    };
    const [claimed] = await claimExpiredRuns(run.id);
    await runPipeline(claimed!);
    const interrupted = (await getRunWithSteps(run.id))!;
    const unsavedStep = interrupted.steps[2]!;
    assert.equal(outputs.length, 1, "Computation finished before the simulated unsaved-result crash");
    assert.equal(unsavedStep.status, "running");
    assert.equal(unsavedStep.output, null);
    await db.update(runsTable).set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(runsTable.id, run.id));
    const [replacement] = await claimExpiredRuns(run.id);
    await runPipeline(replacement!);
    const saved = (await getRunWithSteps(run.id))!;
    assert.equal(saved.run.status, "completed");
    assert.equal(outputs.length, 2);
    assert.deepEqual(outputs[0], outputs[1]);
    assert.deepEqual(saved.steps[2]?.output, outputs[0]);
    assert.equal(saved.steps[2]?.id, unsavedStep.id, "Recovery reuses the original step row");
    assert.equal(saved.steps.length, 5);
    assert.equal(new Set(saved.steps.map((step) => step.seq)).size, 5);
    assert.deepEqual(saved.attempts.filter((a) => a.stepName === "assess").map((a) => a.status),
      ["interrupted", "completed"]);
  } finally { assess.run = original; await cleanup(run.id); }
});
