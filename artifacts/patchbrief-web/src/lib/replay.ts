import type { RunWithSteps, Step, StepAttempt } from '@workspace/api-client-react';

// Derives ordered playback frames purely from a saved run. No network access.
export type ReplayFrame = {
  data: RunWithSteps;
  label: string;
  stepName: string | null;
  at: number; // recorded timestamp (ms)
  recordedGapMs: number | null; // real gap to previous frame
};

type Ev = { at: number; order: number; stepName: string; kind: 'start' | 'completed' | 'failed' | 'interrupted' | 'retry' | 'final'; attempt?: StepAttempt };

const ORDER = ['fetch', 'extract', 'assess', 'plan', 'brief'];
const t = (v: string | null | undefined) => { const n = Date.parse(v || ''); return Number.isFinite(n) ? n : NaN; };

export function buildReplayFrames(saved: RunWithSteps): ReplayFrame[] {
  const events: Ev[] = [];
  let seq = 0;
  const attempts = [...(saved.attempts || [])].sort((a, b) => t(a.startedAt) - t(b.startedAt) || a.attempt - b.attempt);
  for (const a of attempts) {
    const start = t(a.startedAt);
    if (!Number.isFinite(start)) continue;
    events.push({ at: start, order: seq++, stepName: a.stepName, kind: 'start', attempt: a });
    const next = attempts.find((b) => b.stepName === a.stepName && b.attempt > a.attempt);
    const end = a.durationMs != null ? start + a.durationMs : next ? t(next.startedAt) - 1 : start + 1;
    if (a.status === 'completed' || a.status === 'failed' || a.status === 'interrupted') {
      events.push({ at: end, order: seq++, stepName: a.stepName, kind: a.status, attempt: a });
    }
    if (a.retryInMs != null) events.push({ at: end, order: seq++, stepName: a.stepName, kind: 'retry', attempt: a });
  }
  for (const s of saved.steps) {
    if (s.status === 'pending') continue;
    const hasAttempts = attempts.some((a) => a.stepName === s.name);
    const start = t(s.startedAt);
    const base = Number.isFinite(start) ? start : t(s.updatedAt);
    if (!hasAttempts && Number.isFinite(base)) events.push({ at: base, order: seq++, stepName: s.name, kind: 'start' });
    const lastAttemptEnd = Math.max(-Infinity, ...events.filter((e) => e.stepName === s.name).map((e) => e.at));
    // updatedAt is the durable save time; startedAt + rounded duration may
    // incorrectly sort a previous step after the next step's start.
    const end = t(s.updatedAt);
    events.push({ at: Math.max(Number.isFinite(end) ? end : 0, lastAttemptEnd), order: seq++, stepName: s.name, kind: 'final' });
  }
  events.sort((a, b) => a.at - b.at || ORDER.indexOf(a.stepName) - ORDER.indexOf(b.stepName) || a.order - b.order);

  const stepState = new Map<string, Step>();
  const attemptState = new Map<string, StepAttempt>();
  const blank = (s: Step): Step => ({ ...s, status: 'pending', attempt: 0, output: null, error: null, fallbackUsed: false, interrupted: false });
  saved.steps.forEach((s) => stepState.set(s.name, blank(s)));
  const snapshot = (): RunWithSteps => ({
    run: { ...saved.run, status: 'running', finishedAt: null },
    steps: saved.steps.map((s) => stepState.get(s.name) || blank(s)),
    attempts: [...attemptState.values()],
    faults: saved.faults,
  });

  const frames: ReplayFrame[] = [{ data: snapshot(), label: 'Run queued', stepName: null, at: t(saved.run.createdAt), recordedGapMs: null }];
  let prevAt = t(saved.run.createdAt);
  for (const e of events) {
    const original = saved.steps.find((s) => s.name === e.stepName);
    const cur = stepState.get(e.stepName) || (original ? blank(original) : undefined);
    if (!cur || !original) continue;
    const key = e.attempt ? `${e.attempt.stepName}#${e.attempt.attempt}` : '';
    let label = '';
    if (e.kind === 'start') {
      if (e.attempt) attemptState.set(key, { ...e.attempt, status: 'running', durationMs: null, error: null, retryInMs: null });
      const n = e.attempt?.attempt ?? original.attempt ?? 1;
      const resumed = cur.interrupted;
      stepState.set(e.stepName, { ...cur, status: 'running', attempt: n, error: null });
      label = `${e.stepName}: attempt ${n} started${resumed ? ' (resumed after crash)' : ''}${e.attempt?.faultType ? `, injected ${e.attempt.faultType}` : ''}`;
    } else if (e.kind === 'failed' && e.attempt) {
      attemptState.set(key, { ...e.attempt, retryInMs: null });
      stepState.set(e.stepName, { ...cur, error: e.attempt.error });
      label = `${e.stepName}: attempt ${e.attempt.attempt} failed${e.attempt.error ? ` (${e.attempt.error})` : ''}`;
    } else if (e.kind === 'interrupted' && e.attempt) {
      attemptState.set(key, { ...e.attempt, retryInMs: null });
      stepState.set(e.stepName, { ...cur, interrupted: true });
      label = `${e.stepName}: ${e.attempt.faultType === 'worker_crash' ? 'worker crashed' : 'worker interrupted'}, attempt ${e.attempt.attempt} interrupted`;
    } else if (e.kind === 'retry' && e.attempt) {
      attemptState.set(key, { ...e.attempt });
      label = `${e.stepName}: retry scheduled in ${e.attempt.retryInMs} ms`;
    } else if (e.kind === 'completed' && e.attempt) {
      attemptState.set(key, { ...e.attempt });
      label = `${e.stepName}: attempt ${e.attempt.attempt} completed`;
    } else if (e.kind === 'final') {
      stepState.set(e.stepName, { ...original });
      label = `${e.stepName}: ${original.fallbackUsed ? 'finished using fallback' : original.status === 'completed' ? 'completed' : original.status}${original.interrupted ? ', recovered after interruption' : ''}`;
    }
    frames.push({ data: snapshot(), label, stepName: e.stepName, at: e.at, recordedGapMs: Number.isFinite(prevAt) ? Math.max(0, e.at - prevAt) : null });
    prevAt = e.at;
  }
  const finalAt = Math.max(t(saved.run.finishedAt) || prevAt, prevAt);
  frames.push({ data: { ...saved, attempts: [...saved.attempts] }, label: `Run ${saved.run.status}${saved.run.resumeCount > 1 ? `, ${saved.run.resumeCount - 1} additional worker claims recorded` : ''}`, stepName: null, at: finalAt, recordedGapMs: Number.isFinite(finalAt) && Number.isFinite(prevAt) ? Math.max(0, finalAt - prevAt) : null });
  return frames;
}
