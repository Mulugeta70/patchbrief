import type { StepAttemptReporter } from "../pipelineTypes";
import { injectBoundaryFault } from "../faults";
import {
  HttpRequestError,
  parseRetryAfterMs,
  retryTransient,
} from "../retry";

export type LlmClient = (
  prompt: string,
  attempts?: StepAttemptReporter,
) => Promise<string>;

const OPENAI_CHAT_COMPLETIONS_URL =
  "https://api.openai.com/v1/chat/completions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

export function createLlmClient(fetcher: typeof fetch = fetch): LlmClient {
  return async function llmClient(
    prompt: string,
    attempts?: StepAttemptReporter,
  ): Promise<string> {
    const operation = async (): Promise<string> => {
      const fault = await injectBoundaryFault(attempts);
      if (fault === "malformed_json") return "{ injected malformed JSON";
      const apiKey = process.env["OPENAI_API_KEY"];
      if (!apiKey) {
        throw new Error(
          "OPENAI_API_KEY is missing. Add it in Replit Tools > Secrets, then restart the API Server.",
        );
      }

      const response = await fetcher(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new HttpRequestError(
          response.status,
          `OpenAI request failed with HTTP ${response.status}.`,
          parseRetryAfterMs(response.headers.get("Retry-After")),
        );
      }

      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload["choices"])) {
        throw new Error("OpenAI returned an unexpected response shape.");
      }

      const firstChoice = payload["choices"][0];
      if (!isRecord(firstChoice) || !isRecord(firstChoice["message"])) {
        throw new Error("OpenAI returned no message content.");
      }

      const content = firstChoice["message"]["content"];
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("OpenAI returned empty text.");
      }

      return content.trim();
    };

    return attempts
      ? attempts.runExternal(operation)
      : retryWithoutReporter(operation);
  };
}

export const llmClient = createLlmClient();
