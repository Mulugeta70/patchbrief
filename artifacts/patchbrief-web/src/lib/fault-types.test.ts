import test from 'node:test';
import assert from 'node:assert/strict';
import { faultTypesFor } from './fault-types';

test('Break it hides malformed JSON in no-LLM mode without changing the other controls', () => {
  for (const step of ['fetch', 'extract', 'plan'] as const) {
    assert.deepEqual(faultTypesFor(step, false), ['timeout', 'http_500', 'worker_crash']);
    assert.ok(faultTypesFor(step, true).includes('malformed_json'));
  }
  assert.deepEqual(faultTypesFor('assess', false), ['worker_crash']);
});
