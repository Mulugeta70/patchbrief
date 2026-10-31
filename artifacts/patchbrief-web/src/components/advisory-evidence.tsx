import { useState, type ReactNode } from 'react';
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
export function CvssScores({ steps }: { steps: Step[] }) {
  const scores = savedScores(steps);
  if (!scores.length) return null;
  return <div className="cvss-evidence" data-testid="text-trace-cvss">
    <strong>{scoreLabel(scores[0])}</strong>
    {scores.length > 1 && <small data-testid="text-other-cvss">Other scores: {scores.slice(1).map(scoreLabel).join('; ')}</small>}
    <small>Priority: v4.0 → v3.1 → v3.0 → v2.0; Primary metrics, then NVD/CNA sources.</small>
  </div>;
}

export function LinkedText({ text }: { text: string }) {
  const pattern = /https?:\/\/[^\s<>"']+/g;
  const parts: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    parts.push(text.slice(end, index));
    const raw = match[0];
    const url = raw.replace(/[.,;]+$/, '');
    parts.push(<a key={index} href={url} target="_blank" rel="noreferrer">{url}</a>);
    parts.push(raw.slice(url.length));
    end = index + raw.length;
  }
  parts.push(text.slice(end));
  return <>{parts}</>;
}

export function ReferenceList({ references }: { references: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const extra = Math.max(0, references.length - 5);
  return <div data-testid="list-brief-references">
    <ul>{references.slice(0, expanded ? undefined : 5).map((reference, index) =>
      <li key={index}><LinkedText text={reference} /></li>)}</ul>
    {extra > 0 && <button type="button" className="nav-link references-toggle" aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)} data-testid="button-more-references">
      {expanded ? 'Show fewer' : `+${extra} more`}
    </button>}
  </div>;
}
