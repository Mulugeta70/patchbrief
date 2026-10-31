import semver from "semver";
import { getStackItems } from "../db";
import type { ExtractedAdvisory } from "./extract";
import { requirePriorOutput, type PipelineStep } from "../pipelineTypes";

type AssessmentStatus = "affected" | "not_affected" | "undetermined";

interface StackAssessment {
  name: string;
  version: string;
  status: AssessmentStatus;
  matchedProduct: string | null;
  affectedRanges: string[];
  reason: string;
}

interface ExtractOutput extends ExtractedAdvisory {
  output_summary: string;
}

function normalizeProduct(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const productAliases: Record<string, string[]> = {
  node: ["node", "nodejs"],
  express: ["express", "expressjs"],
  lodash: ["lodash"],
  postgres: ["postgres", "postgresql"],
};

function productKey(value: string): string {
  const normalized = normalizeProduct(value);
  const alias = Object.entries(productAliases).find(([, values]) =>
    values.includes(normalized),
  );
  return alias?.[0] ?? normalized;
}

function severityBand(cvss: number | null): string {
  if (cvss === null) return "Unknown";
  if (cvss >= 9) return "Critical";
  if (cvss >= 7) return "High";
  if (cvss >= 4) return "Medium";
  return "Low";
}

function compareStackItem(
  item: { name: string; version: string },
  affected: ExtractedAdvisory["affected"],
): StackAssessment {
  const matchingProducts = affected.filter(
    (entry) => productKey(entry.product) === productKey(item.name),
  );

  if (matchingProducts.length === 0) {
    if (affected.length === 0) {
      return {
        name: item.name,
        version: item.version,
        status: "undetermined",
        matchedProduct: null,
        affectedRanges: [],
        reason: "The advisory did not identify affected products.",
      };
    }

    return {
      name: item.name,
      version: item.version,
      status: "not_affected",
      matchedProduct: null,
      affectedRanges: [],
      reason: "The product is not listed among the advisory's affected products.",
    };
  }

  const ranges = matchingProducts.flatMap((entry) => entry.versions);
  const parsedVersion = semver.coerce(item.version);
  if (!parsedVersion || ranges.length === 0) {
    return {
      name: item.name,
      version: item.version,
      status: "undetermined",
      matchedProduct: matchingProducts[0]?.product ?? null,
      affectedRanges: ranges,
      reason: "The stack version or advisory version range could not be compared as semver.",
    };
  }

  const rangeChecks = ranges.map((range) => {
    const parsedRange = semver.validRange(range);
    return parsedRange === null
      ? null
      : semver.satisfies(parsedVersion.version, parsedRange, {
          includePrerelease: true,
        });
  });

  if (rangeChecks.some((matches) => matches === true)) {
    return {
      name: item.name,
      version: item.version,
      status: "affected",
      matchedProduct: matchingProducts[0]?.product ?? null,
      affectedRanges: ranges,
      reason: "The installed version satisfies an affected semver range.",
    };
  }

  if (rangeChecks.some((matches) => matches === null)) {
    return {
      name: item.name,
      version: item.version,
      status: "undetermined",
      matchedProduct: matchingProducts[0]?.product ?? null,
      affectedRanges: ranges,
      reason: "At least one advisory version range is not valid semver.",
    };
  }

  return {
    name: item.name,
    version: item.version,
    status: "not_affected",
    matchedProduct: matchingProducts[0]?.product ?? null,
    affectedRanges: ranges,
    reason: "The installed version does not satisfy the advisory's affected semver ranges.",
  };
}

export function createAssessStep(
  readStackItems: typeof getStackItems = getStackItems,
): PipelineStep {
  return {
    name: "assess",
    async run(context) {
      return context.attempts.runLocal(async () => {
        const extracted = requirePriorOutput<ExtractOutput>(context, "extract");
        const stackItems = await readStackItems();

        const items = stackItems.map((item) =>
          compareStackItem(item, extracted.affected),
        );
        const affectedItems = items.filter((item) => item.status === "affected");
        const notAffectedItems = items.filter(
          (item) => item.status === "not_affected",
        );
        const undeterminedItems = items.filter(
          (item) => item.status === "undetermined",
        );
        const severity = severityBand(extracted.cvss);
        const summary = `${affectedItems.length} of ${stackItems.length} stack items affected, severity ${severity}; ${undeterminedItems.length} undetermined.`;

        return {
          output_summary: summary,
          cvss: extracted.cvss,
          severity,
          items,
          affected_items: affectedItems,
          not_affected_items: notAffectedItems,
          undetermined_items: undeterminedItems,
        };
      });
    },
  };
}

export const assessStep = createAssessStep();
