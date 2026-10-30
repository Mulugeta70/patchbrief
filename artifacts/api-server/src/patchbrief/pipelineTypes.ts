export type StepName = "fetch" | "extract" | "assess" | "plan" | "brief";

export interface PipelineOutput extends Record<string, unknown> {
  output_summary: string;
}

export interface PipelineContext {
  input: string;
  priorOutputs: Partial<Record<StepName, PipelineOutput>>;
}

export interface PipelineStep {
  name: StepName;
  run: (context: PipelineContext) => Promise<PipelineOutput>;
}

export function requirePriorOutput<T extends object>(
  context: PipelineContext,
  name: StepName,
): T {
  const output = context.priorOutputs[name];
  if (!output) throw new Error(`Required prior step output is missing: ${name}`);
  return output as unknown as T;
}
