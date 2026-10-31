export const RUN_INPUT_ERROR = "That doesn't look like a CVE ID (like CVE-2024-3094) or advisory text. Paste a CVE ID or the full advisory.";

const cveId = /^CVE-\d{4}-\d{4,}$/i;
const letterAndVersion = /\b(?:[a-z][a-z0-9_-]*[ \t-]+v?\d+(?:\.\d+)+|v\d+(?:\.\d+)+|[a-z][a-z0-9_-]*\d+(?:\.\d+)+)\b/i;
const softwareName = /\b(?:node(?:\.?js)?|express|lodash|postgres(?:ql)?|apache|nginx|openssl|openssh|linux|windows|microsoft|chrome|firefox|safari|php|python|java|ruby|rails|django|flask|wordpress|drupal|mysql|sqlite|mongodb|redis|kubernetes|docker|curl|gitlab|github|debian|ubuntu|lib[a-z0-9]{2,})\b/i;
const packageLikeName = /\b(?:[A-Za-z][a-z]+[A-Z][A-Za-z0-9]*|[a-z]{2,}[-_.][a-z]{2,})\b/;
const genericWords = new Set([
  "a", "an", "the", "this", "that", "it", "is", "are", "all", "any", "some", "our", "your",
  "affected", "advisory", "text", "software", "product", "component", "version", "versions",
  "users", "systems", "installations", "unknown", "unspecified", "security", "sample", "example", "test", "testing", "vulnerability", "issue",
]);

// A lightweight shape check, not a claim that the advisory is authentic or complete.
// Named software, package-style names and software-context names cover products
// outside the common-name examples without accepting arbitrary long prose.
export function isValidRunInput(input: unknown): boolean {
  if (typeof input !== "string") return false;
  const value = input.trim();
  if (cveId.test(value)) return true;
  if (Array.from(value).length < 40) return false;
  if (letterAndVersion.test(value) || softwareName.test(value) || packageLikeName.test(value)) return true;
  const names = [
    ...value.matchAll(/\b(?:affects?|package|product|library|software|component)\s+([a-z][a-z0-9_.+-]{1,})\b/gi),
    ...value.matchAll(/\b([a-z][a-z0-9_.+-]{1,})\s+(?:versions?|releases?|server|client|library|package|framework|is (?:vulnerable|affected))\b/gi),
    ...value.matchAll(/\bin\s+([A-Z][a-zA-Z0-9_.+-]{1,})\b/g),
  ];
  return names.some((match) => !genericWords.has(match[1]!.toLowerCase()));
}
