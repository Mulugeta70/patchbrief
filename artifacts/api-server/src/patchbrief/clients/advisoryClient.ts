export interface Advisory {
  source: "nvd" | "pasted";
  cve_id: string | null;
  description: string | null;
  cvss: number | null;
  references: string[] | null;
  published: string | null;
}

interface NvdCve {
  id?: unknown;
  descriptions?: unknown;
  metrics?: unknown;
  references?: unknown;
  published?: unknown;
}

const CVE_ID_PATTERN = /^CVE-\d{4}-\d{4,}$/i;
const NVD_CVE_ENDPOINT =
  "https://services.nvd.nist.gov/rest/json/cves/2.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDescription(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entries = value.filter(isRecord);
  const english = entries.find((entry) => entry["lang"] === "en");
  const selected = english ?? entries[0];
  return typeof selected?.["value"] === "string"
    ? selected["value"]
    : null;
}

function readCvss(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const metricOrder = [
    "cvssMetricV40",
    "cvssMetricV31",
    "cvssMetricV30",
    "cvssMetricV2",
  ];

  for (const key of metricOrder) {
    const metricList = value[key];
    if (!Array.isArray(metricList)) continue;
    for (const metric of metricList) {
      if (!isRecord(metric)) continue;
      const data = metric["cvssData"];
      if (!isRecord(data)) continue;
      const score = data["baseScore"];
      if (typeof score === "number" && Number.isFinite(score)) return score;
    }
  }

  return null;
}

function readReferences(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const urls = value
    .filter(isRecord)
    .map((reference) => reference["url"])
    .filter((url): url is string => typeof url === "string");
  return urls;
}

function readCve(value: unknown): NvdCve | null {
  if (!isRecord(value) || !Array.isArray(value["vulnerabilities"])) {
    return null;
  }
  const first = value["vulnerabilities"][0];
  if (!isRecord(first) || !isRecord(first["cve"])) return null;
  return first["cve"] as NvdCve;
}

export function createAdvisoryClient(fetcher: typeof fetch = fetch) {
  return async function advisoryClient(input: string): Promise<Advisory> {
    const trimmed = input.trim();
    if (!CVE_ID_PATTERN.test(trimmed)) {
      return {
        source: "pasted",
        cve_id: null,
        description: trimmed || null,
        cvss: null,
        references: null,
        published: null,
      };
    }

    const cveId = trimmed.toUpperCase();
    const url = new URL(NVD_CVE_ENDPOINT);
    url.searchParams.set("cveIds", cveId);
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`NVD CVE API request failed with HTTP ${response.status}.`);
    }

    const cve = readCve(await response.json());
    if (!cve) {
      return {
        source: "nvd",
        cve_id: cveId,
        description: null,
        cvss: null,
        references: null,
        published: null,
      };
    }

    return {
      source: "nvd",
      cve_id: typeof cve.id === "string" ? cve.id : cveId,
      description: readDescription(cve.descriptions),
      cvss: readCvss(cve.metrics),
      references: readReferences(cve.references),
      published: typeof cve.published === "string" ? cve.published : null,
    };
  };
}

export const advisoryClient = createAdvisoryClient();
