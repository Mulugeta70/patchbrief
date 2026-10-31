import type { Advisory } from "../clients/advisoryClient";
import type { CvssScore } from "../clients/cvss";

export const INCONCLUSIVE_CHECKLIST = "Could not determine whether your stack is affected: the advisory did not state affected versions.";
export const NO_MATCH_CHECKLIST = "Nothing to patch from your current list. Add other software you run to My stack and rerun.";

export function comparisonIsInconclusive(
  extracted: { affected?: unknown },
  assessment: { undetermined_items?: unknown },
  advisory?: { affected?: unknown },
) {
  if (Array.isArray(assessment.undetermined_items) && assessment.undetermined_items.length > 0) return true;
  const products = extracted.affected !== undefined ? extracted.affected : advisory?.affected;
  return !Array.isArray(products) || !products.some((product) =>
    Array.isArray(product?.versions) && product.versions.some((version: unknown) => typeof version === "string" && version.trim()));
}

export function scoresForAdvisory(advisory: Advisory, fallbackScore = advisory.cvss): CvssScore[] {
  if (advisory.cvss_scores?.length) return advisory.cvss_scores;
  return fallbackScore === null ? [] : [{
    version: null, score: fallbackScore,
    source: advisory.source === "nvd" ? "NVD; provider not recorded" : "pasted advisory",
    source_identifier: null, type: null,
  }];
}

export function versionEvidence(advisory: Advisory, extracted: Record<string, unknown>) {
  const vendorLink = advisory.references?.[0]
    ? ` Vendor advisory: ${advisory.references[0]}` : "";
  if (advisory.source === "nvd") {
    const products = advisory.affected ?? [];
    const hasRanges = products.some((p) => p.versions.length > 0);
    const boundaries = new Map<string, Set<string>>();
    for (const { product, version } of advisory.excluded_upper_bounds ?? []) {
      if (!boundaries.has(product)) boundaries.set(product, new Set());
      boundaries.get(product)!.add(version);
    }
    return {
      affected: hasRanges
        ? products.map((p) => `- ${p.product}: ${p.versions.join(" OR ") || "versions not specified"} (NVD configuration)`).join("\n")
        : `NVD has no affected-version data yet. Check the vendor advisory.${vendorLink}`,
      fixed: boundaries.size
        ? [...boundaries].map(([product, versions]) =>
          `- ${product}: ${[...versions].join(", ")} ${versions.size === 1 ? "is the first version" : "are the first versions"} outside NVD's affected range. This does not confirm a fix, so check the vendor advisory.`).join("\n")
        : `NVD configuration data does not confirm a fixed release. Check the vendor advisory.${vendorLink}`,
    };
  }
  const affected = extracted.affected as Array<{ product: string; versions: string[] }> | undefined;
  return {
    affected: affected?.length
      ? affected.map((p) => `- ${p.product}: ${p.versions.join(" OR ") || "versions not specified"} (pasted advisory)`).join("\n")
      : `Affected versions were not stated in the pasted advisory.${vendorLink}`,
    fixed: typeof extracted.fixed_in === "string"
      ? `${extracted.fixed_in} (pasted advisory)`
      : `A fixed release was not stated in the pasted advisory.${vendorLink}`,
  };
}
