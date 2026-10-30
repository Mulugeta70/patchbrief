import { z } from "zod/v4";
import { llmClient, type LlmClient } from "../clients/llmClient";
import type { ExtractedAdvisory } from "./extract";
import { requirePriorOutput, type PipelineStep } from "../pipelineTypes";
import { errorMessage } from "../retry";

interface AssessedItem {
  name: string;
  version: string;
  affectedRanges: string[];
}

interface AssessOutput extends Record<string, unknown> {
  output_summary: string;
  affected_items: AssessedItem[];
  undetermined_items: Array<{ name: string; version: string }>;
  severity: string;
  cvss: number | null;
}

interface ExtractOutput extends ExtractedAdvisory {
  output_summary: string;
}

const checklistSchema = z
  .object({ checklist: z.array(z.string().min(1)).min(1).max(6) })
  .strict();

function parseChecklist(raw: string): string[] {
  const text = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("LLM remediation output was not valid JSON.");
  }

  const result = checklistSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`LLM remediation output failed schema validation: ${details}`);
  }

  return result.data.checklist;
}

function createFallbackChecklist(
  affectedItems: AssessedItem[],
  fixedIn: string | null,
): string[] {
  const names = affectedItems.map((item) => `${item.name} ${item.version}`);
  const targets = affectedItems.map((item) => item.name).join(", ");
  const fixedRelease = fixedIn
    ? `the advisory lists ${fixedIn} as fixed`
    : "the advisory does not list a fixed version";

  return [
    `Confirm the vendor-fixed release for ${names.join(", ")}; ${fixedRelease}.`,
    `Upgrade only the affected tracked items (${targets}) to the vendor-confirmed fixed releases.`,
    `Verify the deployed versions of ${targets} and rerun the assessment.`,
  ];
}

export function createPlanStep(
  generateText: LlmClient = llmClient,
): PipelineStep {
  return {
    name: "plan",
    async run(context) {
      const assessment = requirePriorOutput<AssessOutput>(context, "assess");
      const extracted = requirePriorOutput<ExtractOutput>(context, "extract");
      if (assessment.affected_items.length === 0) {
        const note =
          assessment.undetermined_items.length > 0
            ? "No action needed for confirmed affected stack items; some version comparisons are inconclusive."
            : "No action needed for the tracked stack items.";
        return context.attempts.runLocal(async () => ({
          output_summary: note,
          checklist: [note],
        }));
      }

      const prompt = [
        "Write a short remediation checklist only for the affected stack items listed below.",
        "Do not include unaffected or undetermined products.",
        "Do not invent fixed versions. Mention a target version only if it appears in fixed_in; otherwise tell the team to verify the vendor's fixed release.",
        "Return only JSON in this shape: {\"checklist\": [\"...\", \"...\"]}. Use 2 to 4 concise checklist items.",
        `Affected stack items: ${JSON.stringify(assessment.affected_items)}`,
        `Advisory fixed_in: ${JSON.stringify(extracted.fixed_in)}`,
        `Advisory CVE and summary: ${JSON.stringify({ cve_id: extracted.cve_id, summary: extracted.summary })}`,
      ].join("\n");

      try {
        const raw = await generateText(prompt, context.attempts);
        let checklist: string[];
        try {
          checklist = parseChecklist(raw);
          const affectedNames = assessment.affected_items.map((item) =>
            item.name.toLowerCase(),
          );
          if (
            checklist.some(
              (item) =>
                !affectedNames.some((name) => item.toLowerCase().includes(name)),
            )
          ) {
            throw new Error(
              "LLM remediation output mentioned a checklist item without naming an affected stack item.",
            );
          }
          const versionPattern = /\bv?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?\b/g;
          const allowedVersions = new Set(
            [
              ...assessment.affected_items.map((item) => item.version),
              extracted.fixed_in ?? "",
              ...extracted.affected.flatMap((item) => item.versions),
            ].flatMap((value) =>
              [...value.matchAll(versionPattern)].map((match) =>
                match[0].replace(/^v/i, ""),
              ),
            ),
          );
          const mentionedVersions = checklist.flatMap((item) =>
            [...item.matchAll(versionPattern)].map((match) =>
              match[0].replace(/^v/i, ""),
            ),
          );
          if (mentionedVersions.some((version) => !allowedVersions.has(version))) {
            throw new Error(
              "LLM remediation output included a version absent from the advisory and affected stack items.",
            );
          }
        } catch (error) {
          await context.attempts.markLastAttemptFailed(errorMessage(error), null);
          throw error;
        }

        return {
          output_summary: checklist[0] ?? "Remediation checklist generated.",
          checklist,
        };
      } catch (error) {
        const reason = errorMessage(error);
        return {
          output_summary:
            "Created a remediation checklist from the affected stack table (fallback).",
          checklist: createFallbackChecklist(
            assessment.affected_items,
            extracted.fixed_in,
          ),
          fallback_used: true,
          fallback_reason: reason,
        };
      }
    },
  };
}

export const planStep = createPlanStep();
