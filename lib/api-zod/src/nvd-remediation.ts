import semver from 'semver';

export interface BoundaryStackItem {
  name: string;
  version: string;
  matchedProduct?: string | null;
  affectedRanges: string[];
}

export interface NvdBoundaryEvidence {
  source?: string;
  affected?: Array<{ product: string; versions: string[] }> | null;
  excluded_upper_bounds?: Array<{ product: string; version: string }>;
}

const productKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const numericVersion = (version: string) => semver.valid(version)
  ?? (/^\d+(?:\.\d+){0,2}$/.test(version) ? semver.coerce(version)?.version : null);

// An excluded upper bound is not a vendor-confirmed fix. Select it only from
// the range branch containing this installed version, not another release line.
export function nvdUpgradeLines(items: BoundaryStackItem[], advisory?: NvdBoundaryEvidence): string[] {
  if (advisory?.source !== 'nvd') return [];
  return items.flatMap(item => {
    const installed = numericVersion(item.version);
    if (!installed || !item.affectedRanges?.length) return [];
    const product = productKey(item.matchedProduct || item.name);
    const allRanges = advisory.affected?.filter(p => productKey(p.product) === product)
      .flatMap(p => p.versions) ?? item.affectedRanges;
    if (!allRanges.length || allRanges.some(range => !semver.validRange(range))) return [];
    const candidates = (advisory.excluded_upper_bounds ?? []).flatMap(boundary => {
      const target = numericVersion(boundary.version);
      if (productKey(boundary.product) !== product || !target || !semver.gt(target, installed)) return [];
      const matchesBranch = item.affectedRanges.some(range => {
        if (!semver.validRange(range)) return false;
        return new semver.Range(range).set.some(branch =>
          branch.every(comparator => comparator.test(installed)) &&
          branch.some(comparator => comparator.operator === '<' && semver.eq(comparator.semver.version, target)));
      });
      if (!matchesBranch || allRanges.some(range => semver.satisfies(target, range))) return [];
      return [{ version: boundary.version, parsed: target }];
    }).sort((a, b) => semver.compare(a.parsed, b.parsed));
    const target = candidates[0]?.version;
    return target ? [`Upgrade ${item.name} ${item.version} to ${target} or later. ${target} is the first version outside NVD's affected range, so confirm the fix with the vendor advisory.`] : [];
  });
}

export function withNvdUpgradeLines(checklist: string[], items: BoundaryStackItem[], advisory?: NvdBoundaryEvidence) {
  const lines = nvdUpgradeLines(items, advisory);
  return lines.length ? [...lines, ...checklist.filter(line => !lines.includes(line))] : checklist;
}
