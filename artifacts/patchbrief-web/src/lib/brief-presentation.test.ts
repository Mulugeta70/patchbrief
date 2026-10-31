import test from "node:test";
import assert from "node:assert/strict";
import type { Step } from "@workspace/api-client-react";
import { presentSavedBrief, labelSavedText, presentTeamMessage } from "./brief-presentation";
import { fixedBoundaryLines, parseAffectedRanges, visibleRanges, NO_MATCH_CHECKLIST, processingPathLabel } from "./version-presentation";

test("old saved briefs gain source-only version sections and scoped wording without modifying saved rows", () => {
  const steps = [
    { name: "fetch", output: { advisory: { source: "nvd", cvss: 8.2, affected: null,
      references: ["https://vendor.example/advisory"] } } },
    { name: "assess", output: { cvss: 8.2, items: [{ name: "postgres", version: "15" }] } },
    { name: "extract", output: { fixed_in: null } },
  ] as Step[];
  const before = JSON.stringify(steps);
  const result = presentSavedBrief("## Severity\nHigh (CVSS 8.2)\n\n## Affected stack items\nNo tracked stack items were confirmed affected.\n\n## Remediation checklist\nNo action needed for the tracked stack items.", steps);
  assert.match(result, /CVSS \(version not provided\) 8.2 \(NVD; provider not recorded\)/);
  assert.match(result, /## Affected versions\nNVD has no affected-version data yet/);
  assert.match(result, /## Fixed in/);
  assert.match(result, /None of the 1 items in My stack matched/);
  assert.match(labelSavedText("Team: CVSS 8.2. No action needed for the tracked stack items.", steps),
    /CVSS \(version not provided\) 8.2 \(NVD; provider not recorded\).*None of the 1 items/);
  assert.equal(JSON.stringify(steps), before);
});

test("saved runs group fixed boundaries, show the scoped no-match line once, and match the team checklist", () => {
  const bounds = ["8.2.35", "8.3.36", "8.4.27", "8.5.12"].map((version) => ({ product: "php", version }));
  const steps = [
    { name: "fetch", output: { advisory: { source: "nvd", affected: null, excluded_upper_bounds: bounds } } },
    { name: "assess", output: { affected_items: [], not_affected_items: [{}], undetermined_items: [] } },
  ] as Step[];
  const note = "None of the 1 items in My stack matched. This only covers software you have listed.";
  const before = JSON.stringify(steps);
  const content = `# PatchBrief\n\n## Processing path\nExtraction: NVD structured fields (no LLM). Checklist: No-action note (no LLM).\n\n## Fixed in\nold per-boundary lines\n\n## Affected stack items\n${note}\n\n## Remediation checklist\n- ${note}\n\n## References\n- https://vendor.example/`;
  const result = presentSavedBrief(content, steps);
  assert.equal(result.split(note).length - 1, 1);
  assert.match(result, /## Remediation checklist\n- Nothing to patch from your current list/);
  assert.ok(!result.includes("# PatchBrief"));
  assert.match(result, /NVD fields, no LLM. Checklist: No-match note/);
  assert.ok(result.includes(fixedBoundaryLines(bounds)));
  assert.equal(result.match(/This does not confirm a fix/g)?.length, 1);
  const team = presentTeamMessage(`CVE: High\nAffected tracked stack items: none of 1 listed items matched.\nRemediation: ${note}`, steps);
  assert.equal(team.split("\n").length, 3);
  assert.equal(team.split("\n")[2], NO_MATCH_CHECKLIST);
  assert.ok(!team.includes("None of the"));
  assert.equal(JSON.stringify(steps), before);
});

test("affected-version previews show three ranges per product and expand to all saved ranges", () => {
  const products = parseAffectedRanges([
    "- php: <8.2.35 OR >=8.3.0 <8.3.36 OR >=8.4.0 <8.4.27 OR >=8.5.0 <8.5.12 (NVD configuration)",
    "- php: <8.2.35 OR =8.0.0 (NVD configuration)",
    "- other: <2.0.0 (NVD configuration)",
  ])!;
  assert.equal(products.length, 2);
  assert.equal(products[0].ranges.length, 5);
  assert.equal(visibleRanges(products[0].ranges, false).length, 3);
  assert.deepEqual(visibleRanges(products[0].ranges, true), products[0].ranges);
  assert.equal(visibleRanges(products[1].ranges, false).length, 1);
  assert.equal(parseAffectedRanges(["NVD has no affected-version data yet. Check the vendor advisory."]), null);
});

test("processing paths display plain words without changing stored path values", () => {
  assert.equal(processingPathLabel("nvd_structured"), "NVD fields, no LLM");
  assert.equal(processingPathLabel("no_action"), "No-match note");
});
