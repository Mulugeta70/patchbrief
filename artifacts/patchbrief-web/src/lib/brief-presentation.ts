import type { Step } from '@workspace/api-client-react';
import { savedScores, scoreLabel } from './cvss-presentation';
import { fixedBoundaryLines, NO_MATCH_CHECKLIST } from './version-presentation';

function hasNoMatches(steps: Step[]) {
  const assessment = steps.find((s) => s.name === 'assess')?.output;
  if (Array.isArray(assessment?.affected_items)) return assessment.affected_items.length === 0;
  if (Array.isArray(assessment?.items)) return assessment.items.every((item) =>
    item.status === 'not_affected' || item.status === 'undetermined' || item.affected === false);
  return false;
}

export function presentTeamMessage(content: string, steps: Step[]) {
  const lines = labelSavedText(content, steps).split('\n');
  if (content && hasNoMatches(steps)) {
    lines[1] = /inconclusive/.test(lines[1] ?? '') ? lines[1]
      : 'Affected tracked stack items: none matched.';
    lines[2] = NO_MATCH_CHECKLIST;
  }
  return lines.join('\n');
}

function replaceSection(text: string, heading: string, body: string) {
  return text.replace(new RegExp(`(^## ${heading}\\s*\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'm'),
    (_match, title: string) => `${title}${body}\n\n`);
}

export function labelSavedText(content: string, steps: Step[]) {
  const assessment = steps.find((s) => s.name === 'assess')?.output;
  const count = Array.isArray(assessment?.items) ? assessment.items.length
    : ['affected_items', 'not_affected_items', 'undetermined_items'].reduce((n, key) =>
      n + (Array.isArray(assessment?.[key]) ? assessment[key].length : 0), 0);
  const note = `None of the ${count} items in My stack matched. This only covers software you have listed.`;
  const scores = savedScores(steps);
  return content.replace(/No action needed for the tracked stack items\./g, note)
    .replace(/No tracked stack items were confirmed affected\./g, note)
    .replace(/\bCVSS (\d+(?:\.\d+)?)(?!\d|\.\d)/g, (original, number: string) => {
      const score = scores.find((entry) => entry.score === Number(number));
      return score ? scoreLabel(score) : original;
    });
}

// Older saved runs retain their original evidence. Fill presentation gaps from
// that saved evidence only, without looking up NVD or rewriting database rows.
export function presentSavedBrief(content: string, steps: Step[]) {
  if (!content) return content;
  const advisory = steps.find((s) => s.name === 'fetch')?.output?.advisory as {
    source?: string; affected?: Array<{ product: string; versions: string[] }>; references?: string[];
    excluded_upper_bounds?: Array<{ product: string; version: string }>;
  } | undefined;
  const extracted = steps.find((s) => s.name === 'extract')?.output;
  let text = labelSavedText(content, steps).replace(/^# PatchBrief\s*\n/m, '')
    .replaceAll('NVD structured fields (no LLM)', 'NVD fields, no LLM')
    .replaceAll('No-action note (no LLM)', 'No-match note');
  const sourceLabel = advisory?.source === 'nvd' ? 'NVD configuration' : 'pasted advisory';
  const affected = advisory?.source === 'nvd' ? advisory.affected
    : extracted?.affected as Array<{ product: string; versions: string[] }> | undefined;
  const vendor = advisory?.references?.[0] ? ` Vendor advisory: ${advisory.references[0]}` : '';
  const additions: string[] = [];
  if (!/^## Affected versions$/m.test(text)) additions.push('## Affected versions', affected?.some((p) => p.versions?.length)
    ? affected.map((p) => `- ${p.product}: ${p.versions.join(' OR ') || 'versions not specified'} (${sourceLabel})`).join('\n')
    : advisory?.source === 'nvd'
      ? `NVD has no affected-version data yet. Check the vendor advisory.${vendor}`
      : `Affected versions were not stated in the pasted advisory.${vendor}`, '');
  if (!/^## Fixed in$/m.test(text)) additions.push('## Fixed in', advisory?.source !== 'nvd' && typeof extracted?.fixed_in === 'string'
    ? `${extracted.fixed_in} (pasted advisory)`
    : `A fixed release was not confirmed by the saved ${sourceLabel} data.${vendor}`, '');
  if (additions.length) {
    const insert = additions.join('\n');
    text = /^## Affected stack items$/m.test(text)
      ? text.replace(/^## Affected stack items$/m, `${insert}\n## Affected stack items`)
      : `${text}\n\n${insert}`;
  }
  if (advisory?.source === 'nvd' && advisory.excluded_upper_bounds?.length) {
    text = replaceSection(text, 'Fixed in', fixedBoundaryLines(advisory.excluded_upper_bounds));
  }
  // Match legacy wording too, without changing the immutable saved record.
  if (hasNoMatches(steps) || /None of the \d+ items in My stack matched/.test(text)) {
    text = replaceSection(text, 'Remediation checklist', `- ${NO_MATCH_CHECKLIST}`);
  }
  return text;
}
