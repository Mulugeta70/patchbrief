import type { PipelineStep } from "./pipelineTypes";
import { assessStep } from "./steps/assess";
import { briefStep } from "./steps/brief";
import { extractStep } from "./steps/extract";
import { fetchStep } from "./steps/fetch";
import { planStep } from "./steps/plan";

export const pipelineSteps: PipelineStep[] = [
  fetchStep,
  extractStep,
  assessStep,
  planStep,
  briefStep,
];
