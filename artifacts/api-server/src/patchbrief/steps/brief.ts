import type { Advisory } from "../clients/advisoryClient";
import {
  requirePriorOutput,
  type PipelineStep,
} from "../pipelineTypes";

interface FetchOutput extends Record<string, unknown> {
  output_summary: string;
  advisory: Advisory;
}

interface AssessItem {
  name: string;
  version: string;
  affectedRanges: string[];
}

interface AssessOutput extends Record<string, unknown> {
  output_summary: string;
  severity: string;
  cvss: number | null;
  affected_items: AssessItem[];
  not_affected_items: AssessItem[];
  undetermined_items: AssessItem[];
}

interface PlanOutput extends Record<string, unknown> {
  output_summary: string;
  checklist: string[];
}

function renderAffectedItems(items: AssessItem[]): string {
  if (items.length === 0) return "No tracked stack items were confirmed affected.";
  return items
    .map(
      (item) =>
        `- ${item.name} ${item.version} (affected range: ${item.affectedRanges.join(", ")})`,
    )
    .join("\n");
}

export const briefStep: PipelineStep = {
  name: "brief",
  async run(context) {
    return context.attempts.runLocal(async () => {
      const fetched = requirePriorOutput<FetchOutput>(context, "fetch");
      const assessment = requirePriorOutput<AssessOutput>(context, "assess");
      const plan = requirePriorOutput<PlanOutput>(context, "plan");
      const extracted = requirePriorOutput<Record<string, unknown>>(context, "extract");
      const extractionPath = extracted.extraction_path === "nvd_structured"
        ? "NVD structured fields (no LLM)"
        : extracted.extraction_path === "llm_pasted"
          ? "Pasted advisory text (LLM)"
          : extracted.extraction_path === "rule_based_pasted"
            ? "Pasted advisory text (rule-based fallback)"
            : "Not recorded in this saved run";
      const checklistPath = plan.wording_path === "llm" ? "LLM wording"
        : plan.wording_path === "rule_based" ? "Rule-based fallback"
          : plan.wording_path === "no_action" ? "No-action note (no LLM)" : "Not recorded in this saved run";
      const advisory = fetched.advisory;
      const summary = advisory.description?.trim() || "No advisory description provided.";
      const cvssLabel =
        assessment.cvss === null ? "CVSS unavailable" : `CVSS ${assessment.cvss}`;

      const uncertainty =
        assessment.undetermined_items.length > 0
          ? `\n\nVersion comparison was inconclusive for: ${assessment.undetermined_items
              .map((item) => `${item.name} ${item.version}`)
              .join(", ")}.`
          : "";
      const checklist = plan.checklist.map((item) => `- ${item}`).join("\n");
      const references =
        advisory.references && advisory.references.length > 0
          ? advisory.references.map((reference) => `- ${reference}`).join("\n")
          : "No references were provided by the advisory source.";
      const published = advisory.published
        ? `\n\nPublished: ${advisory.published}`
        : "";
      const degradedSection = context.degraded
        ? `Yes. Fallback used for: ${context.fallbackSteps.join(", ")}.`
        : "No.";

      const markdown = [
        "# PatchBrief",
        "",
        "## Summary",
        summary,
        published,
        "",
        "## Processing path",
        `Extraction: ${extractionPath}. Checklist: ${checklistPath}.`,
        "",
        "## Degraded processing",
        degradedSection,
        "",
        "## Severity",
        `${assessment.severity} (${cvssLabel})`,
        "",
        "## Affected stack items",
        renderAffectedItems(assessment.affected_items),
        uncertainty,
        "",
        "## Remediation checklist",
        checklist,
        "",
        "## References",
        references,
      ].join("\n");

      const affectedLabel =
        assessment.affected_items.length > 0
          ? assessment.affected_items
              .map((item) => `${item.name} ${item.version}`)
              .join(", ")
          : assessment.undetermined_items.length > 0
            ? `none confirmed; comparison inconclusive for ${assessment.undetermined_items
                .map((item) => item.name)
                .join(", ")}`
            : "none";
      const teamMessage = [
        `${advisory.cve_id ?? "Advisory"}: ${assessment.severity} (${cvssLabel}).`,
        `Affected tracked stack items: ${affectedLabel}.`,
        `Remediation: ${plan.checklist[0] ?? "No action needed."}`,
      ].join("\n");

      return {
        output_summary: `Brief: ${markdown.trim().split(/\s+/).length} words.`,
        extraction_path: extracted.extraction_path ?? null,
        wording_path: plan.wording_path ?? null,
        markdown,
        team_message: teamMessage,
      };
    });
  },
};
