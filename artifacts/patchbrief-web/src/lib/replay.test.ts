import test from "node:test";
import assert from "node:assert/strict";
import type { RunWithSteps } from "@workspace/api-client-react";
import { buildReplayFrames } from "./replay";
import { describeApiError } from "./api-errors";

const at = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();
function savedRun(): RunWithSteps {
  const names = ["fetch", "extract", "assess", "plan", "brief"];
  const starts = [10, 1_000, 3_000, 16_000, 17_000];
  const ends = [900, 2_000, 15_100, 16_100, 17_100];
  return {
    run: { id: "saved-run", input: "advisory", status: "completed", degraded: true,
      createdAt: at(0), finishedAt: at(18_000), resumeCount: 2 },
    steps: names.map((name, i) => ({ id: name, runId: "saved-run", seq: i + 1, name,
      status: "completed", attempt: i < 3 ? 2 : 1, startedAt: at(starts[i]!),
      updatedAt: at(ends[i]!), durationMs: ends[i]! - starts[i]!, output: {},
      outputSummary: `${i + 1} measured items`, error: null, fallbackUsed: name === "extract",
      interrupted: name === "assess" })),
    attempts: [
      { stepName: "fetch", attempt: 1, startedAt: at(10), durationMs: 100, status: "failed", error: "HTTP 503", retryInMs: 300 },
      { stepName: "fetch", attempt: 2, startedAt: at(500), durationMs: 50, status: "completed", error: null, retryInMs: null },
      { stepName: "extract", attempt: 1, startedAt: at(1_000), durationMs: 50, status: "failed", error: "Invalid JSON", retryInMs: 0 },
      { stepName: "extract", attempt: 2, startedAt: at(1_100), durationMs: 70, status: "failed", error: "Invalid JSON", retryInMs: null },
      { stepName: "assess", attempt: 1, startedAt: at(3_000), durationMs: 1_000, status: "interrupted", error: "Worker lease expired", retryInMs: null, faultType: "worker_crash" },
      { stepName: "assess", attempt: 2, startedAt: at(15_000), durationMs: 20, status: "completed", error: null, retryInMs: null },
      { stepName: "plan", attempt: 1, startedAt: at(16_000), durationMs: 20, status: "completed", error: null, retryInMs: null },
      { stepName: "brief", attempt: 1, startedAt: at(17_000), durationMs: 20, status: "completed", error: null, retryInMs: null },
    ].map((a) => ({ ...a, runId: "saved-run", faultType: a.faultType ?? null })),
    faults: [],
  } as RunWithSteps;
}

test("offline replay orders retries, fallback, crash and resume without fetching or mutating saved data", () => {
  const saved = savedRun();
  const before = JSON.stringify(saved);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Replay must never fetch"); };
  try {
    const frames = buildReplayFrames(saved);
    const labels = frames.map((f) => f.label);
    assert.ok(labels.some((label) => /retry scheduled in 300 ms/.test(label)));
    assert.ok(labels.some((label) => /extract: finished using fallback/.test(label)));
    assert.ok(labels.some((label) => /assess: worker crashed/.test(label)));
    assert.ok(labels.some((label) => /assess: attempt 2 started \(resumed after crash\)/.test(label)));
    assert.ok(labels.findIndex((label) => label === "fetch: completed") <
      labels.findIndex((label) => label === "extract: attempt 1 started"));
    assert.ok(frames.every((frame, index) => index === 0 || frame.at >= frames[index - 1]!.at));
    assert.deepEqual(frames.at(-1)?.data, saved);
    assert.equal(JSON.stringify(saved), before);
    for (const frame of frames) {
      assert.deepEqual(frame.data.steps.map((s) => s.durationMs), saved.steps.map((s) => s.durationMs));
      assert.deepEqual(frame.data.steps.map((s) => s.outputSummary), saved.steps.map((s) => s.outputSummary));
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("replay does not describe the first worker claim as a resume", () => {
  const saved = savedRun();
  saved.run.resumeCount = 1;
  const final = buildReplayFrames(saved).at(-1)!;
  assert.equal(final.label, "Run completed");
});

test("rejected input errors explain 413, 429, validation and network recovery", () => {
  assert.match(describeApiError({ status: 413 }, ""), /Shorten.*20,000.*text has been kept/);
  assert.match(describeApiError({ status: 429 }, ""), /Wait a minute.*text has been kept/);
  assert.match(describeApiError({ status: 400, data: { error: "Invalid input." } }, ""), /Fix the input/);
  assert.match(describeApiError(new TypeError("Failed to fetch"), ""), /Check your connection.*text has been kept/);
});
