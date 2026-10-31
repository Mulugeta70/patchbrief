import test from "node:test";
import assert from "node:assert/strict";
import { readCvssScores, formatCvssScore } from "./clients/cvss";
import { createAdvisoryClient } from "./clients/advisoryClient";
import { createExtractStep } from "./steps/extract";
import { createAssessStep } from "./steps/assess";
import { createPlanStep } from "./steps/plan";
import { briefStep } from "./steps/brief";
import type { PipelineContext } from "./pipelineTypes";

const metrics = {
  cvssMetricV31: [
    { source: "vendor.example", type: "Secondary", cvssData: { version: "3.1", baseScore: 9.8 } },
    { source: "nvd@nist.gov", type: "Primary", cvssData: { version: "3.1", baseScore: 8.1 } },
  ],
  cvssMetricV40: [
    { source: "vendor.example", type: "Primary", cvssData: { version: "4.0", baseScore: 9.2 } },
  ],
};
const references = Array.from({ length: 8 }, (_, i) => ({ url: `https://vendor.example/advisory/${i}` }));
const configuration = [{ nodes: [{ cpeMatch: [{
  vulnerable: true, criteria: "cpe:2.3:a:vendor:lodash:*:*:*:*:*:*:*:*",
  versionStartIncluding: "4.0.0", versionEndExcluding: "4.17.21",
}] }] }];

test("CVSS priority preserves every score, version and provider without choosing the biggest number", () => {
  const scores = readCvssScores(metrics, "vendor.example");
  assert.deepEqual(scores.map(formatCvssScore), [
    "CVSS v4.0 9.2 (CNA)", "CVSS v3.1 8.1 (NVD)", "CVSS v3.1 9.8 (CNA)",
  ]);
  assert.equal(scores[0]?.source_identifier, "vendor.example");
  assert.equal(readCvssScores({ cvssMetricV31: [{ cvssData: { baseScore: 11 } }] }).length, 0);
  assert.equal(readCvssScores({ cvssMetricV31: [{ cvssData: { baseScore: 0 } }] })[0]?.source, "source not provided");
  const external = readCvssScores({ cvssMetricV40: [
    { source: "assessment.example", cvssData: { version: "4.0", baseScore: 7 } },
  ] }, "vendor.example");
  assert.equal(external[0]?.source, "assessment.example", "Unknown assessors must not be mislabeled CNA");
});

async function makeBrief(configurations: unknown, stack = [{ name: "postgres", version: "15" }]) {
  const client = createAdvisoryClient(async () => Response.json({ vulnerabilities: [{ cve: {
    id: "CVE-2026-12345", sourceIdentifier: "vendor.example", metrics, references,
    descriptions: [{ lang: "en", value: "A vendor advisory." }], configurations,
  } }] }));
  const advisory = await client("CVE-2026-12345");
  const context: PipelineContext = { input: "CVE-2026-12345", priorOutputs: {
    fetch: { output_summary: "Fetched", advisory },
  }, attempts: { runLocal: (op) => op(), runExternal: (op) => op(), async markLastAttemptFailed() {} },
    degraded: false, fallbackSteps: [] };
  context.priorOutputs.extract = await createExtractStep(async () => { throw new Error("No LLM"); }).run(context);
  context.priorOutputs.assess = await createAssessStep(async () => stack).run(context);
  context.priorOutputs.plan = await createPlanStep(async () => { throw new Error("No LLM expected"); }).run(context);
  return { advisory, context, brief: await briefStep.run(context) };
}

test("NVD affected versions and excluded boundaries reach the brief without inventing a fixed release", async () => {
  const { advisory, context, brief } = await makeBrief(configuration);
  assert.equal(advisory.cvss, 9.2);
  assert.deepEqual(advisory.excluded_upper_bounds, [{ product: "lodash", version: "4.17.21" }]);
  assert.equal(context.priorOutputs.extract?.fixed_in, null);
  const markdown = String(brief.markdown);
  assert.match(markdown, /## Affected versions\n- lodash: >=4.0.0 <4.17.21 \(NVD configuration\)/);
  assert.match(markdown, /## Fixed in\n- lodash: 4.17.21 is the first version outside NVD's affected range. This does not confirm a fix/);
  assert.match(markdown, /CVSS v4.0 9.2 \(CNA\)/);
  assert.match(markdown, /Other CVSS scores: CVSS v3.1 8.1 \(NVD\); CVSS v3.1 9.8 \(CNA\)/);
  assert.match(String(brief.team_message), /CVSS v4.0 9.2 \(CNA\)/);
  assert.equal((context.priorOutputs.assess?.cvss_scores as unknown[]).length, 3);
});

test("missing NVD version data always has an explicit warning, first-reference link and Fixed in section", async () => {
  for (const data of [undefined, [{ nodes: [{ cpeMatch: [{
    vulnerable: true, criteria: "cpe:2.3:a:vendor:lodash:*:*:*:*:*:*:*:*",
  }] }] }]]) {
    const { brief } = await makeBrief(data);
    assert.match(String(brief.markdown), /## Affected versions\nNVD has no affected-version data yet. Check the vendor advisory/);
    assert.match(String(brief.markdown), /Vendor advisory: https:\/\/vendor.example\/advisory\/0/);
    assert.match(String(brief.markdown), /## Fixed in\nNVD configuration data does not confirm a fixed release/);
  }
});

test("no-match wording states the exact saved stack count, including an empty stack", async () => {
  for (const count of [0, 1, 3]) {
    const stack = Array.from({ length: count }, (_, i) => ({ name: `my-software-${i}`, version: "1.0.0" }));
    const { context, brief } = await makeBrief(configuration, stack);
    const note = `None of the ${count} items in My stack matched. This only covers software you have listed.`;
    const checklist = "Nothing to patch from your current list. Add other software you run to My stack and rerun.";
    assert.deepEqual(context.priorOutputs.plan?.checklist, [checklist]);
    assert.ok(String(brief.markdown).includes(note));
    assert.equal(String(brief.markdown).split(note).length - 1, 1);
    assert.match(String(brief.markdown), /## Remediation checklist\n- Nothing to patch from your current list/);
    assert.equal(String(brief.team_message).split("\n")[2], checklist);
    assert.equal(String(brief.markdown).includes("# PatchBrief"), false);
    assert.match(String(brief.markdown), /Extraction: NVD fields, no LLM. Checklist: No-match note/);
    assert.equal(String(brief.markdown).includes("No action needed for the tracked stack items"), false);
  }
});

test("Fixed in groups every excluded boundary by product without repeating the qualification", async () => {
  const versions = ["8.2.35", "8.3.36", "8.4.27", "8.5.12", "8.2.35"];
  const { brief } = await makeBrief([{ nodes: [{ cpeMatch: [
    ...versions.map((version) => ({
      vulnerable: true, criteria: "cpe:2.3:a:php:php:*:*:*:*:*:*:*:*",
      versionEndExcluding: version,
    })),
    { vulnerable: true, criteria: "cpe:2.3:a:vendor:other:*:*:*:*:*:*:*:*", versionEndExcluding: "2.0.0" },
  ] }] }]);
  const fixed = String(brief.markdown).split("## Fixed in\n")[1]!.split("\n\n##")[0]!;
  assert.match(fixed, /php: 8.2.35, 8.3.36, 8.4.27, 8.5.12 are the first versions outside NVD's affected range/);
  assert.equal(fixed.match(/- php:/g)?.length, 1);
  assert.equal(fixed.match(/This does not confirm a fix/g)?.length, 2);
  assert.match(fixed, /other: 2.0.0 is the first version/);
});

test("pasted CVSS scores retain explicit versions and label missing versions honestly", async () => {
  const client = createAdvisoryClient(async () => { throw new Error("No network for pasted text"); });
  const explicit = await client("Advisory. CVSS v3.1 score: 8.2.");
  assert.equal(formatCvssScore(explicit.cvss_scores![0]!), "CVSS v3.1 8.2 (pasted advisory)");
  const missing = await client("Advisory. CVSS score: 8.2.");
  assert.equal(formatCvssScore(missing.cvss_scores![0]!), "CVSS (version not provided) 8.2 (pasted advisory)");
});

