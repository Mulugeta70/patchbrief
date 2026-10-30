import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HttpRequestError,
  RetryExhaustedError,
  parseRetryAfterMs,
  retryTransient,
} from "./retry";
import {
  AdvisoryInputRequiredError,
  createAdvisoryClient,
} from "./clients/advisoryClient";
import { createExtractStep } from "./steps/extract";
import type { PipelineContext, StepAttemptReporter } from "./pipelineTypes";

function createHooks() {
  const events: Array<{ type: string; attempt: number; retryInMs?: number }> = [];
  let nextAttempt = 0;
  return {
    events,
    hooks: {
      async start() {
        nextAttempt += 1;
        events.push({ type: "started", attempt: nextAttempt });
        return nextAttempt;
      },
      async succeed(attempt: number) {
        events.push({ type: "succeeded", attempt });
      },
      async fail(
        attempt: number,
        _durationMs: number,
        _error: string,
        retryInMs: number | null,
      ) {
        events.push({
          type: "failed",
          attempt,
          ...(retryInMs !== null ? { retryInMs } : {}),
        });
      },
      async schedule(attempt: number, retryInMs: number) {
        events.push({ type: "retry_scheduled", attempt, retryInMs });
      },
    },
  };
}

test("transient 429 retries and honors Retry-After", async () => {
  const { hooks, events } = createHooks();
  const sleeps: number[] = [];
  let calls = 0;

  const result = await retryTransient(
    async () => {
      calls += 1;
      if (calls === 1) throw new HttpRequestError(429, "rate limited", 1250);
      return "ok";
    },
    hooks,
    { sleep: async (delay) => { sleeps.push(delay); } },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1250]);
  assert.deepEqual(events.map((event) => event.type), [
    "started",
    "failed",
    "retry_scheduled",
    "started",
    "succeeded",
  ]);
});

test("permanent HTTP errors fail without retrying", async () => {
  const { hooks, events } = createHooks();
  const missing = new HttpRequestError(404, "not found");
  let calls = 0;

  await assert.rejects(
    retryTransient(
      async () => {
        calls += 1;
        throw missing;
      },
      hooks,
      { sleep: async () => assert.fail("permanent error must not sleep") },
    ),
    (error) => error === missing,
  );
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ["started", "failed"]);
});

test("transient failures stop after three attempts", async () => {
  const { hooks, events } = createHooks();
  let calls = 0;

  await assert.rejects(
    retryTransient(
      async () => {
        calls += 1;
        throw new TypeError("network unavailable");
      },
      hooks,
      { sleep: async () => {}, random: () => 0 },
    ),
    RetryExhaustedError,
  );
  assert.equal(calls, 3);
  assert.equal(events.filter((event) => event.type === "started").length, 3);
  assert.equal(events.filter((event) => event.type === "retry_scheduled").length, 2);
});

test("Retry-After parses seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(
    parseRetryAfterMs("Thu, 01 Jan 1970 00:00:02 GMT", 0),
    2000,
  );
  assert.equal(parseRetryAfterMs("not-a-date", 0), null);
});

test("NVD 404 switches to advisory input without retrying", async () => {
  let calls = 0;
  const lookup = createAdvisoryClient(async () => {
    calls += 1;
    return new Response("", { status: 404 });
  });

  await assert.rejects(
    lookup("CVE-2026-12345"),
    AdvisoryInputRequiredError,
  );
  assert.equal(calls, 1);
});

function testAttempts(markedFailures: Array<{ error: string; retryInMs: number | null }>): StepAttemptReporter {
  return {
    async runLocal<T>(operation: () => Promise<T>) {
      return operation();
    },
    async runExternal<T>(operation: () => Promise<T>) {
      return operation();
    },
    async markLastAttemptFailed(error, retryInMs) {
      markedFailures.push({ error, retryInMs });
    },
  };
}

function extractContext(description: string): PipelineContext {
  return {
    input: "pasted advisory",
    priorOutputs: {
      fetch: {
        output_summary: "pasted advisory",
        advisory: {
          source: "pasted",
          cve_id: "CVE-2026-12345",
          description,
          cvss: null,
          references: null,
          published: null,
          affected: null,
        },
      },
    },
    attempts: testAttempts([]),
    degraded: false,
    fallbackSteps: [],
  };
}

test("extract retries invalid JSON once with the validation error", async () => {
  const prompts: string[] = [];
  const markedFailures: Array<{ error: string; retryInMs: number | null }> = [];
  const context = extractContext("Lodash versions <= 4.17.20 are affected.");
  context.attempts = testAttempts(markedFailures);
  const step = createExtractStep(async (prompt) => {
    prompts.push(prompt);
    if (prompts.length === 1) return "not json";
    return JSON.stringify({
      cve_id: "CVE-2026-12345",
      summary: "Lodash versions are affected.",
      affected: [{ product: "lodash", versions: ["<=4.17.20"] }],
      fixed_in: null,
      cvss: null,
    });
  });

  const output = await step.run(context);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /Validation error: LLM extraction output was not valid JSON/);
  assert.equal(markedFailures.length, 1);
  assert.equal(markedFailures[0]?.retryInMs, 0);
  assert.notEqual(output.fallback_used, true);
});

test("extract falls back to advisory ranges after two invalid outputs", async () => {
  const markedFailures: Array<{ error: string; retryInMs: number | null }> = [];
  const context = extractContext(
    "Lodash versions <= 4.17.20 are affected. Fixed in version 4.17.21.",
  );
  context.attempts = testAttempts(markedFailures);
  let calls = 0;
  const step = createExtractStep(async () => {
    calls += 1;
    return "invalid";
  });

  const output = await step.run(context);
  assert.equal(calls, 2);
  assert.equal(output.fallback_used, true);
  assert.equal(output.fixed_in, "4.17.21");
  assert.deepEqual(output.affected, [
    { product: "lodash", versions: ["<=4.17.20"] },
  ]);
  assert.equal(markedFailures.length, 2);
  assert.equal(markedFailures[1]?.retryInMs, null);
});

test("fallback keeps compound range bounds together", async () => {
  const context = extractContext("Lodash versions >= 1.0.0 < 2.0.0 are affected.");
  const step = createExtractStep(async () => { throw new Error("LLM unavailable"); });
  const output = await step.run(context);
  assert.deepEqual(output.affected, [
    { product: "lodash", versions: [">=1.0.0 <2.0.0"] },
  ]);
});

test("extract never accepts a CVSS score absent from the advisory", async () => {
  const context = extractContext("No affected products or score were provided.");
  const step = createExtractStep(async () => JSON.stringify({
    cve_id: "CVE-2026-12345",
    summary: "No affected products were provided.",
    affected: [],
    fixed_in: null,
    cvss: 9.8,
  }));
  const output = await step.run(context);
  assert.equal(output.fallback_used, true);
  assert.equal(output.cvss, null);
});
