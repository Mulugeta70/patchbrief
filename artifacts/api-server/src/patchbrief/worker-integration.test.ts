import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, pool, runsTable, stepsTable, stackItemsTable } from "@workspace/db";
import { createRun, getRunWithSteps, seedStackItems } from "./db";
import { claimExpiredRuns, withRunLock } from "./leases";
import { runPipeline } from "./runner";
import { LeaseLostError, WorkerCrashError } from "./workerErrors";
import { pipelineSteps } from "./steps";
import { fetchStep } from "./steps/fetch";
import { createExtractStep } from "./steps/extract";
import type { PipelineContext, PipelineOutput } from "./pipelineTypes";
import app from "../app";

// Fault-boundary tests simulate configuration without using a real credential.
// Their malformed-JSON faults intercept before any external LLM request.
process.env.OPENAI_API_KEY ??= "test-only-not-a-credential";
process.env.STACK_EDIT_KEY = "test-only-stack-owner-key";
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

test("daily budget uses normal no-LLM mode and skips every LLM boundary", async () => {
  const { run, created } = await createRun(input, `budget-${randomUUID()}`, {
    faults: [
      { step: "extract", type: "malformed_json", times: "always" },
      { step: "plan", type: "malformed_json", times: "always" },
    ],
  }, 0);
  try {
    assert.equal(created, true);
    assert.equal(run.degraded, false);
    assert.match(run.llmDisabledReason!, /budget/);
    const [claimed] = await claimExpiredRuns(run.id);
    await runPipeline(claimed!);
    const saved = (await getRunWithSteps(run.id))!;
    assert.equal(saved.run.status, "completed");
    assert.equal(saved.steps.length, 5);
    assert.equal(saved.faults.every((fault) => fault.injectedCount === 0), true);
    assert.equal(saved.run.degraded, false);
    assert.equal(saved.steps.filter((s) => s.fallbackUsed).length, 0);
    assert.match(String(saved.steps[4]?.output?.markdown), /Rule-based \(no LLM\)/);
  } finally { await cleanup(run.id); }
});

test("missing LLM key uses rule-based extraction and checklist without failed calls or degradation", async () => {
  const { run } = await createRun(input, `no-key-${randomUUID()}`, {}, 1_000_000, false);
  try {
    assert.equal(run.degraded, false);
    assert.match(run.llmDisabledReason!, /No LLM key/);
    const [claimed] = await claimExpiredRuns(run.id);
    await runPipeline(claimed!);
    const saved = (await getRunWithSteps(run.id))!;
    assert.equal(saved.run.status, "completed");
    assert.equal(saved.run.degraded, false);
    assert.equal(saved.steps.length, 5);
    assert.equal(saved.steps.some((step) => step.fallbackUsed), false);
    assert.equal(saved.attempts.some((attempt) => attempt.status === "failed"), false);
    assert.equal(saved.steps[1]?.output?.extraction_path, "rule_based_no_llm");
    assert.equal(saved.steps[3]?.output?.wording_path, "rule_based_no_llm");
    assert.match(String(saved.steps[4]?.output?.markdown), /High, CVSS 8.2 \(version not given, from pasted text\)/);
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

test("rejected input creates no runs or daily-cap usage and the same key can submit corrected text", async () => {
  const { request } = await import("node:http");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs`;
  const key = `validation-${randomUUID()}`;
  const post = (input: string) => new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const req = request(url, { method: "POST", localAddress: "127.0.0.2",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => { resolve({ status: res.statusCode!, body: JSON.parse(text) }); });
    });
    req.on("error", reject);
    req.end(JSON.stringify({ input }));
  });
  let createdId: string | undefined;
  try {
    const before = await db.select({ id: runsTable.id }).from(runsTable);
    for (const value of ["hello", "This is just a long sentence without any useful information."]) {
      const response = await post(value);
      assert.equal(response.status, 400);
      assert.equal(response.body.error, "That doesn't look like a CVE ID (like CVE-2024-3094) or advisory text. Paste a CVE ID or the full advisory.");
    }
    const after = await db.select({ id: runsTable.id }).from(runsTable);
    assert.deepEqual(after.map((row) => row.id).sort(), before.map((row) => row.id).sort(),
      "Rejected input must not create records counted by the daily cap");
    const accepted = await post("Lodash versions before 4.17.21 are affected by the advisory.");
    assert.equal(accepted.status, 201);
    createdId = accepted.body.run.id;
    assert.equal((await db.select().from(runsTable).where(eq(runsTable.idempotencyKey, key))).length, 1);
  } finally {
    if (createdId) await db.delete(runsTable).where(eq(runsTable.id, createdId));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

test("shared stack API persists across clients, validates input, and enforces the 30-item cap atomically", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stack`;
  const createdIds: string[] = [];
  const prefix = `stack-test-${randomUUID().slice(0, 8)}`;
  const post = (name: string, version: string) => fetch(url, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-only-stack-owner-key" }, body: JSON.stringify({ name, version }) });
  try {
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "unauthorized", version: "1.2.3" }) })).status, 401);
    assert.equal((await fetch(`${url}/${randomUUID()}`, { method: "DELETE" })).status, 401);
    assert.equal((await fetch(`${url}/unlock`, { method: "POST", headers: { Authorization: "Bearer test-only-stack-owner-key" } })).status, 204);
    assert.equal((await post("", "1.2.3")).status, 400);
    assert.equal((await post("bad-range", ">=1.2.3")).status, 400);
    for (const version of ["18", "15", "1.2-beta", ""]) {
      const rejected = await post(`${prefix}-invalid`, version);
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json() as { error: string }).error, "Use a full version, like 18.19.1");
    }
    const twoPart = await post(`${prefix}-two-part`, "18.19");
    assert.equal(twoPart.status, 201);
    createdIds.push((await twoPart.json() as { id: string }).id);
    const first = await post(`${prefix}-item`, "1.2.3");
    assert.equal(first.status, 201);
    const item = await first.json() as { id: string; name: string; version: string };
    createdIds.push(item.id);
    const otherClient = await fetch(url, { headers: { "User-Agent": "another-device", Cookie: "" } });
    const persisted = await otherClient.json() as Array<{ id: string; name: string; version: string }>;
    assert.ok(persisted.some((row) => row.id === item.id && row.version === "1.2.3"));
    assert.equal((await post(item.name.toUpperCase(), "2.0.0")).status, 409);
    for (let i = persisted.length; i < 29; i++) {
      const response = await post(`${prefix}-${i}`, "1.0.0");
      assert.equal(response.status, 201);
      createdIds.push((await response.json() as { id: string }).id);
    }
    const competing = await Promise.all([post(`${prefix}-a`, "1.0.0"), post(`${prefix}-b`, "1.0.0")]);
    assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
    for (const response of competing) {
      if (response.status === 201) createdIds.push((await response.json() as { id: string }).id);
    }
    const capped = await (await fetch(url)).json() as unknown[];
    assert.equal(capped.length, 30);
    assert.equal((await fetch(`${url}/${item.id}`, { method: "DELETE", headers: { Authorization: "Bearer test-only-stack-owner-key" } })).status, 204);
    assert.equal((await fetch(`${url}/${item.id}`, { method: "DELETE", headers: { Authorization: "Bearer test-only-stack-owner-key" } })).status, 404);
    await seedStackItems();
    const afterSeed = await (await fetch(url)).json() as Array<{ id: string }>;
    assert.equal(afterSeed.length, 29, "Seeding must not repopulate removed items");
  } finally {
    for (const id of createdIds) await db.delete(stackItemsTable).where(eq(stackItemsTable.id, id));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("ten most recent runs remain saved across clients and input is stored before step one", async () => {
  const ids: string[] = [];
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs`;
  try {
    for (let i = 0; i < 12; i++) {
      const originalInput = `Saved advisory ${i}: ${"Evidence. ".repeat(50)}`;
      const { run } = await createRun(originalInput, `recent-${randomUUID()}`, {}, 0);
      ids.push(run.id);
      const beforeStart = (await getRunWithSteps(run.id))!;
      assert.equal(beforeStart.run.input, originalInput);
      assert.equal(beforeStart.steps.length, 0);
      // These history fixtures must not be picked up by the HTTP worker wake-up.
      await db.update(runsTable).set({ status: "completed", finishedAt: new Date() }).where(eq(runsTable.id, run.id));
    }
    const first = await (await fetch(url)).json() as Array<{ id: string; input: string; status: string }>;
    const refreshed = await (await fetch(url, { headers: { "User-Agent": "fresh-device", Cookie: "" } })).json();
    assert.deepEqual(refreshed, first);
    assert.equal(first.length, 10);
    assert.equal(first[0]?.id, ids[11]);
    assert.equal(first[9]?.id, ids[2]);
    assert.equal(first.every((r) => r.status === "completed" && r.input.length > 400), true);
  } finally {
    for (const id of ids) await cleanup(id);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
