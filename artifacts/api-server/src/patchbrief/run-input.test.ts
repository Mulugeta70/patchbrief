import test from "node:test";
import assert from "node:assert/strict";
import { isValidRunInput, RUN_INPUT_ERROR } from "@workspace/api-zod";

test("new-run input accepts only complete CVE identifiers or meaningful advisory-shaped text", () => {
  for (const value of ["CVE-2024-3094", " cve-2026-123456789 ", "CVE-2024-0000"]) {
    assert.equal(isValidRunInput(value), true, value);
  }
  for (const value of [
    "Lodash has a security issue; check the vendor advisory for affected releases.",
    "An issue affects AcmeWidget and permits unauthorized access to private files.",
    "The foobar library is affected; consult the vendor advisory for more details.",
    "A vulnerability in Foobar permits unauthorized access to private files.",
    "The advisory describes a flaw in version v1.2.3 and recommends updating.",
    "A security advisory affects release v1.2.3; verify your installed software.",
  ]) assert.equal(isValidRunInput(value), true, value);
});

test("new-run input rejects short text, malformed CVEs and long text without product or version clues", () => {
  for (const value of [null, 123, "", "   ", "hello", "lodash 4.17.20", "CVE-2024-123", "CVE-24-3094",
    "x".repeat(100), "1234567890".repeat(10), "This is just a long sentence without any useful information."]) {
    assert.equal(isValidRunInput(value), false, String(value));
  }
  assert.equal(RUN_INPUT_ERROR, "That doesn't look like a CVE ID (like CVE-2024-3094) or advisory text. Paste a CVE ID or the full advisory.");
});

test("the advisory minimum is forty trimmed characters, while CVEs bypass that minimum", () => {
  assert.equal(isValidRunInput(`lodash ${"x".repeat(32)}`), false);
  assert.equal(isValidRunInput(`lodash ${"x".repeat(33)}`), true);
  assert.equal(isValidRunInput(`  lodash ${"x".repeat(32)}  `), false);
  assert.equal(isValidRunInput("CVE-2024-3094"), true);
});
