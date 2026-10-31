import { injectBoundaryFault } from "../faults";
import { readCvssScores, type CvssScore } from "./cvss";
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
  cvss_scores?: CvssScore[];
  excluded_upper_bounds?: Array<{ product: string; version: string }>;
  references: string[] | null;
  published: string | null;
  affected: AdvisoryAffectedProduct[] | null;
}

interface NvdCve {
  sourceIdentifier?: unknown;
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

function readExcludedUpperBounds(value: unknown): Array<{ product: string; version: string }> {
  const bounds = new Map<string, { product: string; version: string }>();
  function visit(node: unknown): void {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isRecord(node)) return;
    if (Array.isArray(node.cpeMatch)) for (const match of node.cpeMatch) {
      if (!isRecord(match) || match.vulnerable !== true ||
        typeof match.criteria !== "string" || typeof match.versionEndExcluding !== "string") continue;
      const parts = match.criteria.split(":");
      const product = parts[4]?.replace(/_/g, "-");
      if (parts[0] !== "cpe" || parts[1] !== "2.3" || !product || !match.versionEndExcluding.trim()) continue;
      const version = match.versionEndExcluding;
      bounds.set(`${product}\0${version}`, { product, version });
    }
    visit(node.nodes); visit(node.children);
  }
  visit(value);
  return [...bounds.values()];
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
      const score = readExplicitCvss(trimmed);
      const version = trimmed.match(/\bCVSS\s+v?([234]\.\d)\b/i)?.[1] ?? null;
      const advisory: Advisory = {
        source: "pasted",
        cve_id: null,
        description: trimmed || null,
        cvss: score,
        cvss_scores: score === null ? [] : [{
          score, version, source: "pasted advisory", source_identifier: null, type: null,
        }],
        excluded_upper_bounds: [],
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

      const scores = readCvssScores(cve.metrics, cve.sourceIdentifier);
      return {
        source: "nvd",
        cve_id: typeof cve.id === "string" ? cve.id : cveId,
        description: readDescription(cve.descriptions),
        cvss: scores[0]?.score ?? null,
        cvss_scores: scores,
        excluded_upper_bounds: readExcludedUpperBounds(cve.configurations),
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
