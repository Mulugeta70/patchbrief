import { useState, type ReactNode } from 'react';
import type { Step } from '@workspace/api-client-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { savedScores, scoreLabel } from '../lib/cvss-presentation';
export function CvssScores({ steps }: { steps: Step[] }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const scores = savedScores(steps);
  if (!scores.length) return null;
  return <div className="cvss-evidence" data-testid="text-trace-cvss">
    <strong>{scoreLabel(scores[0])}</strong>
    {scores.length > 1 && <small data-testid="text-other-cvss">Other scores: {scores.slice(1).map(scoreLabel).join('; ')}</small>}
    <Tooltip open={helpOpen} onOpenChange={setHelpOpen}>
      <TooltipTrigger asChild><button type="button" className="nav-link score-help" aria-expanded={helpOpen}
        onClick={(event) => { event.preventDefault(); setHelpOpen((open) => !open); }}>
        How the score is chosen
      </button></TooltipTrigger>
      <TooltipContent className="score-help-tooltip" side="bottom">
        Priority: v4.0 → v3.1 → v3.0 → v2.0; Primary metrics, then NVD/CNA sources.
      </TooltipContent>
    </Tooltip>
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
