import test from "node:test";
import assert from "node:assert/strict";
import { retryTransient, type RetryAttemptHooks } from "./retry";
import { WorkerCrashError } from "./workerErrors";
import { createAdvisoryClient } from "./clients/advisoryClient";
import { createLlmClient } from "./clients/llmClient";
import { createExtractStep } from "./steps/extract";
import type { PipelineContext, StepAttemptReporter } from "./pipelineTypes";
import type { FaultType } from "./faults";

function reporter(faults: FaultType[]) {
  const state = { starts: 0, failures: 0, successes: 0, delays: [] as number[] };
  const hooks: RetryAttemptHooks = {
    async start() { return ++state.starts; },
    async fail() { state.failures++; },
    async succeed() { state.successes++; },
    async schedule(_attempt, delay) { state.delays.push(delay); },
  };
  const attempts: StepAttemptReporter = {
    runLocal: (operation) => operation(),
    runExternal: (operation) => retryTransient(operation, hooks, { sleep: async () => {} }),
    async markLastAttemptFailed() {},
    async injectFault() { return faults.shift() ?? null; },
  };
  return { state, attempts };
}

test("worker crash bypasses retry failure writes", async () => {
  const { state } = reporter([]);
  const hooks: RetryAttemptHooks = {
    async start() { return ++state.starts; },
    async fail() { state.failures++; },
    async succeed() { state.successes++; },
    async schedule() { throw new Error("Must not schedule a crash retry"); },
  };
  await assert.rejects(retryTransient(async () => { throw new WorkerCrashError(); }, hooks), WorkerCrashError);
  assert.equal(state.starts, 1);
  assert.equal(state.failures, 0);
});

test("NVD boundary faults use the real retry policy", async () => {
  let networkCalls = 0;
  const client = createAdvisoryClient(async () => {
    networkCalls++;
    return new Response(JSON.stringify({ vulnerabilities: [{ cve: {
      id: "CVE-2026-12345", descriptions: [{lang: "en", value: "Example advisory"}],
    }}] }), { status: 200 });
  });
  const { attempts, state } = reporter(["timeout", "http_500"]);
  const advisory = await client("CVE-2026-12345", attempts);
  assert.equal(advisory.cve_id, "CVE-2026-12345");
  assert.equal(state.starts, 3);
  assert.equal(state.failures, 2);
  assert.equal(state.delays.length, 2);
  assert.equal(networkCalls, 1);
});

test("malformed NVD JSON fails immediately without a network request", async () => {
  const client = createAdvisoryClient(async () => { throw new Error("No network expected"); });
  const { attempts, state } = reporter(["malformed_json"]);
  await assert.rejects(client("CVE-2026-12345", attempts), SyntaxError);
  assert.equal(state.starts, 1);
});

test("LLM boundary injects before credentials and returns malformed text for schema validation", async () => {
  const client = createLlmClient(async () => { throw new Error("No network expected"); });
  const { attempts, state } = reporter(["timeout", "http_500", "malformed_json"]);
  const text = await client("prompt", attempts);
  assert.throws(() => JSON.parse(text), SyntaxError);
  assert.equal(state.starts, 3);
  assert.equal(state.failures, 2);
});

test("extract never turns a worker crash into a fallback", async () => {
  const { attempts } = reporter([]);
  const context: PipelineContext = {
    input: "Advisory text", attempts, degraded: false, fallbackSteps: [],
    priorOutputs: { fetch: { output_summary: "Pasted", advisory: {
      source: "pasted", cve_id: null, description: "Advisory text",
      cvss: null, references: null, published: null, affected: null,
    }}},
  };
  const extract = createExtractStep(async () => { throw new WorkerCrashError(); });
  await assert.rejects(extract.run(context), WorkerCrashError);
  let called = false;
  const budgetExtract = createExtractStep(async () => { called = true; throw new Error("Not allowed"); });
  const output = await budgetExtract.run({ ...context, llmDisabledReason: "Daily LLM budget reached" });
  assert.equal(called, false);
  assert.equal(output.fallback_used, false);
  assert.equal(output.no_llm_reason, "Daily LLM budget reached");
});
