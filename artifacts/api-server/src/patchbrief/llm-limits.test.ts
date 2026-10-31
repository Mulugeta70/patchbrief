import test from "node:test";
import assert from "node:assert/strict";
import { createLlmClient } from "./clients/llmClient";
import { createExtractStep } from "./steps/extract";
import { createPlanStep } from "./steps/plan";
import { advisoryTextForLlm, ADVISORY_TEXT_MAX_CHARS, DEFAULT_LLM_MODEL, LLM_MAX_TOKENS, LLM_PROMPT_MAX_CHARS } from "./clients/llmLimits";
import type { PipelineContext, StepAttemptReporter } from "./pipelineTypes";

const attempts: StepAttemptReporter = {
  runLocal: (operation) => operation(),
  runExternal: (operation) => operation(),
  async markLastAttemptFailed() {},
};

test("LLM client applies configurable model, max_tokens, and fixed prompt ceiling", async () => {
  const oldModel = process.env.LLM_MODEL;
  // Injection at the HTTP boundary supplies credentials without reading secrets.
  // A synthetic key is scoped to this test process and restored immediately.
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only-not-a-credential";
  const bodies: Array<{ model: string; max_tokens: number; messages: Array<{ content: string }> }> = [];
  try {
    const client = createLlmClient(async (_url, options) => {
      bodies.push(JSON.parse(String(options?.body)));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    delete process.env.LLM_MODEL;
    await client("x".repeat(30_000));
    process.env.LLM_MODEL = "custom-test-model";
    await client("short prompt");
    assert.equal(bodies[0]?.model, DEFAULT_LLM_MODEL);
    assert.equal(bodies[1]?.model, "custom-test-model");
    assert.ok(bodies.every((b) => b.max_tokens === LLM_MAX_TOKENS));
    assert.equal(bodies[0]?.messages[0]?.content.length, LLM_PROMPT_MAX_CHARS);
  } finally {
    if (oldModel === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = oldModel;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});

test("extract, corrective retry, and plan truncate advisory text before the LLM call", async () => {
  const description = "x".repeat(20_000) + "SECRET_TAIL_MARKER";
  assert.equal(advisoryTextForLlm({ description }).length, ADVISORY_TEXT_MAX_CHARS);
  const prompts: string[] = [];
  const fake = async (prompt: string) => { prompts.push(prompt); return "invalid JSON"; };
  const context: PipelineContext = {
    input: description, attempts, degraded: false, fallbackSteps: [],
    priorOutputs: {
      fetch: { output_summary: "advisory", advisory: { source: "pasted", description,
        cve_id: null, cvss: null, published: null, references: null, affected: null } },
    },
  };
  await createExtractStep(fake).run(context);
  context.priorOutputs.extract = { output_summary: "facts", cve_id: null, summary: description,
    affected: [{ product: "lodash", versions: ["<=4.17.20"] }], fixed_in: null, cvss: null };
  context.priorOutputs.assess = { output_summary: "assessment",
    affected_items: [{ name: "lodash", version: "4.17.20", status: "affected" }] };
  await createPlanStep(fake).run(context);
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every((prompt) => !prompt.includes("SECRET_TAIL_MARKER")));
  assert.ok(prompts.every((prompt) => prompt.length < LLM_PROMPT_MAX_CHARS));
});
