import type { FaultInput } from '@workspace/api-client-react';

export function faultTypesFor(step: FaultInput['step'], llmEnabled: boolean): FaultInput['type'][] {
  return ['fetch', 'extract', 'plan'].includes(step)
    ? (['timeout', 'http_500', 'malformed_json', 'worker_crash'] as FaultInput['type'][])
      .filter((type) => llmEnabled || type !== 'malformed_json')
    : ['worker_crash'];
}
