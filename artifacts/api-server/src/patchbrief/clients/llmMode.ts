export const NO_LLM_REASON = "No LLM key configured.";

export function hasLlmKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}
