import type { Advisory } from "../clients/advisoryClient";
import type { CvssScore } from "../clients/cvss";

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
    ? ` Vendor advisory: ${advisory.references[0]}` : " No reference was provided by the source.";
  if (advisory.source === "nvd") {
    const products = advisory.affected ?? [];
    const hasRanges = products.some((p) => p.versions.length > 0);
    return {
      affected: hasRanges
        ? products.map((p) => `- ${p.product}: ${p.versions.join(" OR ") || "versions not specified"} (NVD configuration)`).join("\n")
        : `NVD has no affected-version data yet. Check the vendor advisory.${vendorLink}`,
      fixed: advisory.excluded_upper_bounds?.length
        ? advisory.excluded_upper_bounds.map((b) =>
          `- ${b.product}: fixed release not confirmed. NVD's affected range excludes ${b.version} at its upper boundary; verify the vendor's fixed release.`).join("\n")
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
