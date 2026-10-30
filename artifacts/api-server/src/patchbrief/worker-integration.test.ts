import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, pool, runsTable } from "@workspace/db";
import { createRun, getRunWithSteps } from "./db";
import { claimExpiredRuns, withRunLock } from "./leases";
import { runPipeline } from "./runner";
import { LeaseLostError } from "./workerErrors";

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
