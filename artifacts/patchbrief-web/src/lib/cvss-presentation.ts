import type { Step } from '@workspace/api-client-react';

export type DisplayScore = { score: number; version: string | null; source: string };
export function scoreLabel(score: DisplayScore) {
  return `CVSS ${score.version ? `v${score.version}` : '(version not provided)'} ${score.score} (${score.source})`;
}
export function savedScores(steps: Step[]): DisplayScore[] {
  const fetched = steps.find((s) => s.name === 'fetch')?.output?.advisory as Record<string, unknown> | undefined;
  const assessment = steps.find((s) => s.name === 'assess')?.output;
  const values = fetched?.cvss_scores ?? assessment?.cvss_scores;
  if (Array.isArray(values) && values.length) return values.filter((s): s is DisplayScore =>
    typeof s?.score === 'number' && typeof s?.source === 'string' && (s.version === null || typeof s.version === 'string'));
  const score = assessment?.cvss ?? fetched?.cvss;
  return typeof score === 'number' ? [{
    score, version: null, source: fetched?.source === 'nvd' ? 'NVD; provider not recorded' : 'pasted advisory',
  }] : [];
}
