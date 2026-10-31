import { advisoryClient } from "../clients/advisoryClient";
import { AdvisoryInputRequiredError } from "../clients/advisoryClient";
import { NeedsInputError, type PipelineStep } from "../pipelineTypes";

export function createFetchStep(
  lookup: typeof advisoryClient = advisoryClient,
): PipelineStep {
  return {
    name: "fetch",
    async run(context) {
      let advisory;
      try {
        advisory = await lookup(context.input, context.attempts);
      } catch (error) {
        if (error instanceof AdvisoryInputRequiredError) {
          throw new NeedsInputError(error.message);
        }
        throw error;
      }
      const chars = advisory.description?.length ?? 0;
      const summary = advisory.source === "nvd"
        ? `Looked up ${advisory.cve_id}, ${chars.toLocaleString("en-US")} chars (NVD).`
        : `Received pasted advisory, ${chars.toLocaleString("en-US")} chars.`;

      return { output_summary: summary, advisory };
    },
  };
}

export const fetchStep = createFetchStep();
