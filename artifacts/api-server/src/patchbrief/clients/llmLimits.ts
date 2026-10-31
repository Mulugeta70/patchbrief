// Fixed ceilings apply to initial, corrective, and remediation prompts alike.
export const ADVISORY_TEXT_MAX_CHARS = 8_000;
export const LLM_PROMPT_MAX_CHARS = 16_000;
export const LLM_MAX_TOKENS = 1_024;
export const DEFAULT_LLM_MODEL = "gpt-4.1-nano";

export function advisoryTextForLlm(value: unknown): string {
  return JSON.stringify(value).slice(0, ADVISORY_TEXT_MAX_CHARS);
}
