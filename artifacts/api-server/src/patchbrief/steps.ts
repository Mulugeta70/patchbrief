export interface PipelineInput {
  input: string;
}

export interface PipelineOutput extends Record<string, unknown> {
  result: string;
}

export interface PipelineStep {
  name: string;
  run: (input: PipelineInput) => Promise<PipelineOutput>;
}

const pauseBriefly = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 120));

function makePlaceholderStep(name: string): PipelineStep {
  return {
    name,
    async run({ input }) {
      await pauseBriefly();
      return { result: `${name} placeholder completed for: ${input}` };
    },
  };
}

export const pipelineSteps: PipelineStep[] = [
  makePlaceholderStep("fetch"),
  makePlaceholderStep("extract"),
  makePlaceholderStep("assess"),
  makePlaceholderStep("plan"),
  makePlaceholderStep("brief"),
];
