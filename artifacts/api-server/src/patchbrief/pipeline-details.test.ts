import test from "node:test";
import assert from "node:assert/strict";
import { createExtractStep } from "./steps/extract";
import { createFetchStep } from "./steps/fetch";
import { createAssessStep } from "./steps/assess";
import { createPlanStep } from "./steps/plan";
import { briefStep } from "./steps/brief";
import type { Advisory } from "./clients/advisoryClient";
import type { PipelineContext } from "./pipelineTypes";

const advisory: Advisory = {
  source: "nvd", cve_id: "CVE-2021-23337",
  description: "Lodash versions < 4.17.21 are affected.",
  cvss: 7.2, published: "2021-02-15", references: ["https://example.com/advisory"],
  affected: [{ product: "lodash", versions: ["<4.17.21"] }],
};
function context(): PipelineContext {
  return { input: advisory.cve_id!, priorOutputs: {}, degraded: false, fallbackSteps: [],
    attempts: { runLocal: (operation) => operation(), runExternal: (operation) => operation(),
      async markLastAttemptFailed() {} } };
}

test("CVE extraction uses NVD structured facts without an LLM or inferred fixed version", async () => {
  const ctx = context();
  ctx.priorOutputs.fetch = { output_summary: "Fetched", advisory };
  let calls = 0;
  const step = createExtractStep(async () => { calls++; throw new Error("LLM must not be used"); });
  const result = await step.run(ctx);
  assert.equal(calls, 0);
  assert.equal(result.extraction_path, "nvd_structured");
  assert.equal(result.fallback_used, undefined);
  assert.deepEqual(result.affected, advisory.affected);
  assert.equal(result.cvss, 7.2);
  assert.equal(result.fixed_in, null);
  assert.equal(result.output_summary, "Extracted 1 affected products (NVD structured fields, no LLM).");
  ctx.priorOutputs.fetch = { output_summary: "Fetched", advisory: {
    ...advisory, cvss: null, affected: null, description: null,
  } };
  const missing = await step.run(ctx);
  assert.equal(missing.cvss, null);
  assert.deepEqual(missing.affected, []);
  assert.equal(missing.fixed_in, null);
});

test("all step summaries report actual counts and the brief records processing paths", async () => {
  const ctx = context();
  const fetched = await createFetchStep(async () => advisory).run(ctx);
  assert.match(fetched.output_summary, new RegExp(`${advisory.description!.length} chars`));
  ctx.priorOutputs.fetch = fetched;
  ctx.priorOutputs.extract = await createExtractStep(async () => { throw new Error("No LLM"); }).run(ctx);
  const assessed = await createAssessStep(async () => [
    { name: "lodash", version: "4.17.20" }, { name: "express", version: "4.17.1" },
  ]).run(ctx);
  assert.equal(assessed.output_summary, "1 of 2 stack items affected, severity High; 0 undetermined.");
  ctx.priorOutputs.assess = assessed;
  const planned = await createPlanStep(async () => JSON.stringify({ checklist: [
    "Review lodash against the vendor advisory.", "Verify the lodash fixed release.",
  ] })).run(ctx);
  assert.equal(planned.output_summary, "Wrote 2 checklist items (LLM wording).");
  ctx.priorOutputs.plan = planned;
  const brief = await briefStep.run(ctx);
  const markdown = String(brief.markdown);
  assert.equal(brief.output_summary, `Brief: ${markdown.trim().split(/\s+/).length} words.`);
  assert.match(markdown, /Extraction: NVD structured fields \(no LLM\)/);
  assert.match(markdown, /Checklist: LLM wording/);
});

test("pasted advisory extraction still uses the LLM and its existing fallback", async () => {
  const ctx = context();
  ctx.priorOutputs.fetch = { output_summary: "Pasted", advisory: { ...advisory, source: "pasted" } };
  let calls = 0;
  const step = createExtractStep(async () => { calls++; return "not JSON"; });
  const output = await step.run(ctx);
  assert.equal(calls, 2);
  assert.equal(output.extraction_path, "rule_based_pasted");
  assert.equal(output.fallback_used, true);
  assert.match(output.output_summary, /Extracted 1 affected products/);
});
