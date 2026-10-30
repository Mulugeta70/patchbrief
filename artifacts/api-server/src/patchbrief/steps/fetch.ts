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
      const summary = advisory.cve_id
        ? `Fetched advisory data for ${advisory.cve_id}.`
        : `Received pasted advisory text (${context.input.trim().length} characters).`;

      return { output_summary: summary, advisory };
    },
  };
}

export const fetchStep = createFetchStep();
