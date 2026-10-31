import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunWithSteps } from '@workspace/api-client-react';
import { TraceGraph } from './App';

afterEach(cleanup);

test('node details show summary and attempts before raw output, collapsed by default and reset for another node', async () => {
  const user = userEvent.setup();
  const data = {
    run: { id: 'test-run' },
    steps: ['fetch', 'extract'].map((name, index) => ({
      id: name, seq: index + 1, name, status: 'completed', attempt: 1,
      outputSummary: `${name} summary`, output: { raw: `${name} evidence` },
    })),
    attempts: [{ id: 'attempt', stepName: 'fetch', attempt: 1, status: 'completed',
      startedAt: '2026-10-30T12:00:00Z', durationMs: 20 }],
  } as unknown as RunWithSteps;
  const props = { data, onSelect() {}, selectedSeq: 1, connection: 'replay',
    retrying: null, retryRemainingMs: 0, localInterrupted: [] };
  const view = render(<TraceGraph {...props} />);
  const panel = screen.getByTestId('detail-selected-step');
  const summary = panel.querySelector('p')!;
  expect(summary.textContent).toBe('fetch summary');
  const history = screen.getByTestId('list-attempts');
  const toggle = screen.getByText('Show raw output');
  const details = toggle.closest('details')!;
  expect(summary.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(history.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(details.open).toBe(false);
  await user.click(toggle);
  expect(details.open).toBe(true);
  expect(details.textContent).toContain('fetch evidence');
  await user.click(toggle);
  expect(details.open).toBe(false);
  await user.click(toggle);
  view.rerender(<TraceGraph {...props} selectedSeq={2} />);
  expect(screen.getByText('Show raw output').closest('details')!.open).toBe(false);
});
