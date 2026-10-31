export const NO_MATCH_CHECKLIST = 'Nothing to patch from your current list. Add other software you run to My stack and rerun.';
export const INCONCLUSIVE_CHECKLIST = 'Could not determine whether your stack is affected: the advisory did not state affected versions.';

export function processingPathLabel(value: string) {
  const labels: Record<string, string> = {
    nvd_structured: 'NVD fields, no LLM', no_action: 'No-match note',
    inconclusive: 'Inconclusive comparison',
    llm_pasted: 'Pasted text, LLM', rule_based_pasted: 'Pasted text, rule-based fallback',
    llm: 'LLM wording', rule_based: 'Rule-based fallback',
    rule_based_no_llm: 'Rule-based (no LLM)',
  };
  return labels[value] ?? value.replaceAll('_', ' ');
}

export function fixedBoundaryLines(bounds: Array<{ product: string; version: string }>) {
  const groups = new Map<string, Set<string>>();
  for (const { product, version } of bounds) {
    if (!groups.has(product)) groups.set(product, new Set());
    groups.get(product)!.add(version);
  }
  return [...groups].map(([product, versions]) =>
    `- ${product}: ${[...versions].join(', ')} ${versions.size === 1 ? 'is the first version' : 'are the first versions'} outside NVD's affected range. This does not confirm a fix, so check the vendor advisory.`).join('\n');
}

export function parseAffectedRanges(lines: string[]) {
  const groups = new Map<string, { product: string; ranges: string[]; source: string }>();
  for (const line of lines) {
    const match = line.trim().match(/^[-*]\s+(.+?):\s+(.*?)\s+\((NVD configuration|pasted advisory)\)$/);
    if (!match) return null;
    const [, product, value, source] = match;
    const key = `${product}:${source}`;
    const entry = groups.get(key) ?? { product, ranges: [], source };
    entry.ranges = [...new Set([...entry.ranges, ...value.split(' OR ')])];
    groups.set(key, entry);
  }
  return [...groups.values()];
}

export function visibleRanges(ranges: string[], expanded: boolean) {
  return ranges.slice(0, expanded ? undefined : 3);
}
