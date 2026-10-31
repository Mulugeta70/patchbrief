import type { Advisory } from "../clients/advisoryClient";
import { formatCvssScore } from "../clients/cvss";
import { scoresForAdvisory, versionEvidence } from "./briefEvidence";
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

function renderAffectedItems(items: AssessItem[], stackCount: number): string {
  if (items.length === 0) return `None of the ${stackCount} items in My stack matched. This only covers software you have listed.`;
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
        ? "NVD fields, no LLM"
        : extracted.extraction_path === "llm_pasted"
          ? "Pasted advisory text (LLM)"
          : extracted.extraction_path === "rule_based_pasted"
            ? "Pasted advisory text (rule-based fallback)"
            : "Not recorded in this saved run";
      const checklistPath = plan.wording_path === "llm" ? "LLM wording"
        : plan.wording_path === "rule_based" ? "Rule-based fallback"
          : plan.wording_path === "no_action" ? "No-match note" : "Not recorded in this saved run";
      const advisory = fetched.advisory;
      const summary = advisory.description?.trim() || "No advisory description provided.";
      const scores = scoresForAdvisory(advisory, assessment.cvss);
      const cvssLabel = scores[0] ? formatCvssScore(scores[0]) : "CVSS unavailable";
      const versions = versionEvidence(advisory, extracted);
      const stackCount = assessment.affected_items.length + assessment.not_affected_items.length + assessment.undetermined_items.length;

      const uncertainty =
        assessment.undetermined_items.length > 0
          ? `\n\nVersion comparison was inconclusive for: ${assessment.undetermined_items
              .map((item) => `${item.name} ${item.version}`)
              .join(", ")}.`
          : "";
      const noMatchNote = "Nothing to patch from your current list. Add other software you run to My stack and rerun.";
      const checklist = (assessment.affected_items.length ? plan.checklist : [noMatchNote])
        .map((item) => `- ${item}`).join("\n");
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
        ...(scores.length > 1 ? [`Other CVSS scores: ${scores.slice(1).map(formatCvssScore).join("; ")}`, ""] : []),
        "## Affected versions",
        versions.affected,
        "",
        "## Fixed in",
        versions.fixed,
        "",
        "## Affected stack items",
        renderAffectedItems(assessment.affected_items, stackCount),
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
            : "none matched";
      const teamMessage = [
        `${advisory.cve_id ?? "Advisory"}: ${assessment.severity} (${cvssLabel}).`,
        `Affected tracked stack items: ${affectedLabel}.`,
        assessment.affected_items.length === 0 ? noMatchNote
          : `Remediation: ${plan.checklist[0] ?? "Check the vendor advisory."}`,
      ].join("\n");

      return {
        output_summary: `Brief: ${markdown.trim().split(/\s+/).length} words.`,
        extraction_path: extracted.extraction_path ?? null,
        wording_path: plan.wording_path ?? null,
        cvss_scores: scores,
        cvss_label: cvssLabel,
        markdown,
        team_message: teamMessage,
      };
    });
  },
};
