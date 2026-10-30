import { injectBoundaryFault } from "../faults";
import type { StepAttemptReporter } from "../pipelineTypes";
import {
  HttpRequestError,
  RetryExhaustedError,
  parseRetryAfterMs,
  retryTransient,
} from "../retry";

export interface AdvisoryAffectedProduct {
  product: string;
  versions: string[];
}

export interface Advisory {
  source: "nvd" | "pasted";
  cve_id: string | null;
  description: string | null;
  cvss: number | null;
  references: string[] | null;
  published: string | null;
  affected: AdvisoryAffectedProduct[] | null;
}

interface NvdCve {
  id?: unknown;
  descriptions?: unknown;
  metrics?: unknown;
  references?: unknown;
  published?: unknown;
  configurations?: unknown;
}

const CVE_ID_PATTERN = /^CVE-\d{4}-\d{4,}$/i;
const NVD_CVE_ENDPOINT = "https://services.nvd.nist.gov/rest/json/cves/2.0";

export class AdvisoryInputRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisoryInputRequiredError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDescription(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entries = value.filter(isRecord);
  const english = entries.find((entry) => entry["lang"] === "en");
  const selected = english ?? entries[0];
  return typeof selected?.["value"] === "string" ? selected["value"] : null;
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

function readExplicitCvss(description: string): number | null {
  const patterns = [
    /\bCVSS(?:\s+v?\d+\.\d+)?\s+(?:base\s+)?score\s*[:=]?\s*(10(?:\.0)?|[0-9](?:\.\d+)?)\b/i,
    /\bCVSS(?:\s+v?\d+\.\d+)?\s*[:=]\s*(10(?:\.0)?|[0-9](?:\.\d+)?)\b/i,
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    const score = match?.[1] ? Number(match[1]) : NaN;
    if (Number.isFinite(score) && score >= 0 && score <= 10) return score;
  }
  return null;
}

function readReferences(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(isRecord)
    .map((reference) => reference["url"])
    .filter((url): url is string => typeof url === "string");
}

function readCve(value: unknown): NvdCve | null {
  if (!isRecord(value) || !Array.isArray(value["vulnerabilities"])) return null;
  const first = value["vulnerabilities"][0];
  if (!isRecord(first) || !isRecord(first["cve"])) return null;
  return first["cve"] as NvdCve;
}

function rangeFromCpe(match: Record<string, unknown>, cpeVersion: string): string[] {
  const lowerInclusive = match["versionStartIncluding"];
  const lowerExclusive = match["versionStartExcluding"];
  const upperInclusive = match["versionEndIncluding"];
  const upperExclusive = match["versionEndExcluding"];
  const range: string[] = [];

  if (typeof lowerInclusive === "string") range.push(`>=${lowerInclusive}`);
  if (typeof lowerExclusive === "string") range.push(`>${lowerExclusive}`);
  if (typeof upperInclusive === "string") range.push(`<=${upperInclusive}`);
  if (typeof upperExclusive === "string") range.push(`<${upperExclusive}`);
  if (range.length) return [range.join(" ")];
  if (cpeVersion !== "*" && cpeVersion !== "-") return [`=${cpeVersion}`];
  return [];
}

function readAffectedProducts(value: unknown): AdvisoryAffectedProduct[] | null {
  const products = new Map<string, Set<string>>();

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isRecord(node)) return;

    const cpeMatches = node["cpeMatch"];
    if (Array.isArray(cpeMatches)) {
      for (const candidate of cpeMatches) {
        if (!isRecord(candidate) || candidate["vulnerable"] !== true) continue;
        const criteria = candidate["criteria"];
        if (typeof criteria !== "string") continue;
        const parts = criteria.split(":");
        if (parts.length < 6 || parts[0] !== "cpe" || parts[1] !== "2.3") continue;

        const product = parts[4]?.replace(/_/g, "-");
        if (!product) continue;
        const ranges = rangeFromCpe(candidate, parts[5] ?? "*");
        if (!products.has(product)) products.set(product, new Set());
        for (const range of ranges) products.get(product)?.add(range);
      }
    }

    visit(node["nodes"]);
    visit(node["children"]);
  }

  visit(value);
  if (products.size === 0) return null;

  return [...products.entries()].map(([product, versions]) => ({
    product,
    versions: [...versions],
  }));
}

async function retryWithoutReporter<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  return retryTransient(operation, {
    async start() {
      attempt += 1;
      return attempt;
    },
    async succeed() {},
    async fail() {},
    async schedule() {},
  });
}

export function createAdvisoryClient(fetcher: typeof fetch = fetch) {
  return async function advisoryClient(
    input: string,
    attempts?: StepAttemptReporter,
  ): Promise<Advisory> {
    const trimmed = input.trim();
    if (!CVE_ID_PATTERN.test(trimmed)) {
      const advisory: Advisory = {
        source: "pasted",
        cve_id: null,
        description: trimmed || null,
        cvss: readExplicitCvss(trimmed),
        references: null,
        published: null,
        affected: null,
      };
      return attempts ? attempts.runLocal(async () => advisory) : advisory;
    }

    const cveId = trimmed.toUpperCase();
    const url = new URL(NVD_CVE_ENDPOINT);
    url.searchParams.set("cveIds", cveId);

    const operation = async (): Promise<Advisory> => {
      const fault = await injectBoundaryFault(attempts);
      if (fault === "malformed_json") {
        await new Response("{ injected malformed JSON").json();
      }
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new HttpRequestError(
          response.status,
          `NVD CVE API request failed with HTTP ${response.status}.`,
          parseRetryAfterMs(response.headers.get("Retry-After")),
        );
      }

      const cve = readCve(await response.json());
      if (!cve) {
        throw new AdvisoryInputRequiredError(
          `NVD returned no record for ${cveId}. Paste the advisory text to continue.`,
        );
      }

      return {
        source: "nvd",
        cve_id: typeof cve.id === "string" ? cve.id : cveId,
        description: readDescription(cve.descriptions),
        cvss: readCvss(cve.metrics),
        references: readReferences(cve.references),
        published: typeof cve.published === "string" ? cve.published : null,
        affected: readAffectedProducts(cve.configurations),
      };
    };

    try {
      return attempts
        ? await attempts.runExternal(operation)
        : await retryWithoutReporter(operation);
    } catch (error) {
      if (error instanceof HttpRequestError && error.statusCode === 404) {
        throw new AdvisoryInputRequiredError(
          `NVD could not find ${cveId}. Paste the advisory text to continue.`,
        );
      }
      if (error instanceof RetryExhaustedError) {
        throw new AdvisoryInputRequiredError(
          `NVD was unavailable after three attempts. Paste the advisory text to continue.`,
        );
      }
      throw error;
    }
  };
}

export const advisoryClient = createAdvisoryClient();
