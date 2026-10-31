export interface CvssScore {
  version: string | null;
  score: number;
  source: string;
  source_identifier: string | null;
  type: string | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Version wins over provider/type. Never select by score magnitude.
export function readCvssScores(metrics: unknown, cnaIdentifier?: unknown): CvssScore[] {
  if (!record(metrics)) return [];
  const scores: CvssScore[] = [];
  for (const [key, version] of [
    ["cvssMetricV40", "4.0"], ["cvssMetricV31", "3.1"],
    ["cvssMetricV30", "3.0"], ["cvssMetricV2", "2.0"],
  ]) {
    const entries = metrics[key!];
    if (!Array.isArray(entries)) continue;
    const withinVersion: CvssScore[] = [];
    for (const metric of entries) {
      if (!record(metric) || !record(metric.cvssData)) continue;
      const score = metric.cvssData.baseScore;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 10) continue;
      const identifier = typeof metric.source === "string" && metric.source.trim() ? metric.source.trim() : null;
      withinVersion.push({
        version: typeof metric.cvssData.version === "string" ? metric.cvssData.version : version!,
        score,
        source: identifier?.toLowerCase() === "nvd@nist.gov" ? "NVD"
          : identifier && identifier === cnaIdentifier ? "CNA" : identifier || "source not provided",
        source_identifier: identifier,
        type: typeof metric.type === "string" ? metric.type : null,
      });
    }
    const typeRank = (s: CvssScore) => s.type?.toLowerCase() === "primary" ? 0 : s.type?.toLowerCase() === "secondary" ? 1 : 2;
    const sourceRank = (s: CvssScore) => s.source === "NVD" ? 0 : s.source === "CNA" ? 1 : 2;
    withinVersion.sort((a, b) => typeRank(a) - typeRank(b) || sourceRank(a) - sourceRank(b));
    scores.push(...withinVersion);
  }
  return scores;
}

export function formatCvssScore(score: CvssScore): string {
  const source = score.source === "pasted advisory" ? "from pasted text" : score.source;
  return score.version ? `CVSS v${score.version} ${score.score} (${source})`
    : `CVSS ${score.score} (version not given, ${source})`;
}
