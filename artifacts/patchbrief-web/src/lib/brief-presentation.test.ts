import test from "node:test";
import assert from "node:assert/strict";
import type { Step } from "@workspace/api-client-react";
import { presentSavedBrief, labelSavedText } from "./brief-presentation";

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
