import { advisoryClient } from "../clients/advisoryClient";
import type { PipelineStep } from "../pipelineTypes";

export function createFetchStep(
  lookup: typeof advisoryClient = advisoryClient,
): PipelineStep {
  return {
    name: "fetch",
    async run({ input }) {
      const advisory = await lookup(input);
      const summary = advisory.cve_id
        ? `Fetched advisory data for ${advisory.cve_id}.`
        : `Received pasted advisory text (${input.trim().length} characters).`;

      return { output_summary: summary, advisory };
    },
  };
}

export const fetchStep = createFetchStep();
