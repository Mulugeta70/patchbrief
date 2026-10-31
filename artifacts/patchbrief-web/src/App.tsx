import { type FormEvent, type ReactNode, useEffect, useMemo, useState, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import StackPage from '@/pages/stack';
import { RecentRuns } from '@/components/recent-runs';
import { ArchitectureDiagram } from '@/components/architecture-diagram';
import { BROWSER_RUNS_CHANGED, rememberBrowserRun } from '@/lib/browser-runs';
import { runTitle } from '@/lib/browser-runs';
import { faultTypesFor } from '@/lib/fault-types';
import { isValidRunInput, RUN_INPUT_ERROR } from '@workspace/api-zod/run-input';
import { ReplayControls, useReplay } from '@/components/replay-controls';
import { describeApiError } from '@/lib/api-errors';
import { CvssScores } from '@/components/advisory-evidence';
import { MarkdownBrief } from '@/components/markdown-brief';
import { presentSavedBrief, presentTeamMessage } from '@/lib/brief-presentation';
import { processingPathLabel } from '@/lib/version-presentation';
import { Link, Route, Switch, useLocation, useParams, Router as WouterRouter } from 'wouter';
import {
  getGetLatestRunQueryKey, getGetRunQueryKey, getRun, useCreateRun, useHealthCheck, useGetRun, useSubmitRunInput,
  type FaultInput, type RunFault, type RunWithSteps, type Step, type StepAttempt,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient();
type DisplayStatus = 'completed' | 'running' | 'needs_input' | 'failed' | 'waiting' | 'fallback_used';
type RunData = RunWithSteps;
type AttemptEvent = { runId: string; stepId: string; stepName: string; attempt: number; phase: 'started' | 'failed' | 'retry_scheduled' | 'completed' | 'interrupted'; timestamp: string; retryInMs?: number; durationMs?: number; error?: string; record?: StepAttempt };
const ORDERED_STEPS = ['fetch', 'extract', 'assess', 'plan', 'brief'] as const;
type StepKey = typeof ORDERED_STEPS[number];
const STEP_LABELS: Record<string, string> = { fetch: 'Fetch advisory', extract: 'Extract facts', assess: 'Assess stack', plan: 'Map remediation', brief: 'Write brief' };
const FAULT_LABELS: Record<string, string> = { timeout: 'Timeout', http_500: 'HTTP 500', malformed_json: 'Malformed JSON', worker_crash: 'Worker crash' };
const isTerminal = (status?: string) => status === 'completed' || status === 'failed';

function timesText(value: number) { return value === -1 ? 'always' : `${value}x`; }
function formatTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + `.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function Header() {
  const [location] = useLocation();
  return <header className="topbar">
    <Link href="/" className="brand" data-testid="link-home"><span>PatchBrief</span></Link>
    <nav className="nav-links" aria-label="Primary navigation">
      <Link href="/" className={`nav-link ${location === '/' ? 'active' : ''}`} data-testid="link-new-review">New run</Link>
      <Link href="/how-it-works" className={`nav-link ${location === '/how-it-works' ? 'active' : ''}`} data-testid="link-how-it-works">How it works</Link>
      <Link href="/stack" className={`nav-link ${location === '/stack' ? 'active' : ''}`} data-testid="link-my-stack">My stack</Link>
    </nav>
  </header>;
}

function AppFrame({ children }: { children: ReactNode }) {
  return <div className="app-shell"><Header />{children}</div>;
}

function BreakItPanel({ faults, setFaults, slowMode, setSlowMode, input }: {
  faults: FaultInput[]; setFaults: (next: FaultInput[]) => void; slowMode: boolean; setSlowMode: (v: boolean) => void; input: string;
}) {
  const [step, setStep] = useState<StepKey>('fetch');
  const [type, setType] = useState<FaultInput['type']>('timeout');
  const [times, setTimes] = useState<FaultInput['times']>(1);
  const health = useHealthCheck();
  const llmEnabled = health.data?.llmEnabled === true;
  const allowed = faultTypesFor(step, llmEnabled);
  useEffect(() => {
    if (!faultTypesFor(step, llmEnabled).includes(type)) setType('worker_crash');
  }, [step, llmEnabled, type]);
  const changeStep = (next: StepKey) => {
    setStep(next);
    if (!faultTypesFor(next, llmEnabled).includes(type)) setType('worker_crash');
  };
  const add = () => {
    if (faults.length >= 20) return;
    setFaults([...faults, { step, type, times }]);
  };
  const looksLikeCve = /^\s*CVE-\d{4}-\d{4,}\s*$/i.test(input);
  const fetchNetwork = faults.some((f) => f.step === 'fetch' && f.type !== 'worker_crash');
  return <section className="break-panel" aria-labelledby="break-it-title" data-testid="panel-break-it">
    <div className="break-head">
      <div><h3 id="break-it-title">Break it</h3><p>Optional demo faults, scoped to this run only. Watch retries, fallbacks and worker recovery happen live.</p></div>
    </div>
    <div className="fault-builder">
      <label><span>Step</span>
        <select className="input-control" value={step} onChange={(e) => changeStep(e.target.value as StepKey)} data-testid="select-fault-step">
          {ORDERED_STEPS.map((s) => <option key={s} value={s}>{STEP_LABELS[s]}</option>)}
        </select>
      </label>
      <label><span>Failure</span>
        <select className="input-control" value={type} onChange={(e) => setType(e.target.value as FaultInput['type'])} data-testid="select-fault-type">
          {allowed.map((t) => <option key={t} value={t}>{FAULT_LABELS[t]}</option>)}
        </select>
      </label>
      <label><span>Times</span>
        <div className="times-group" role="radiogroup" aria-label="How many times">
          {([1, 2, 3, 'always'] as FaultInput['times'][]).map((t) => <button key={String(t)} type="button" role="radio" aria-checked={times === t} className={`times-chip ${times === t ? 'on' : ''}`} onClick={() => setTimes(t)} data-testid={`button-fault-times-${t}`}>{t === 'always' ? 'always' : `${t}x`}</button>)}
        </div>
      </label>
      <button type="button" className="add-fault" onClick={add} disabled={faults.length >= 20} data-testid="button-add-fault">Add fault</button>
    </div>
    <p className="field-hint">Timeout, HTTP 500 and malformed JSON apply to fetch, extract and plan. Worker crash applies to every step.</p>
    {faults.length === 0
      ? <div className="fault-empty" data-testid="text-no-faults">No faults queued. The run will behave normally.</div>
      : <ul className="fault-list" data-testid="list-faults">
        {faults.map((f, index) => <li key={`${f.step}-${f.type}-${index}`} className={`fault-item ${f.type === 'worker_crash' ? 'crash' : ''}`} data-testid={`row-fault-${index}`}>
          <span className="fault-step">{f.step}</span><span>{FAULT_LABELS[f.type]}</span><span className="fault-times">{f.times === 'always' ? 'always' : `${f.times}x`}</span>
          <button type="button" className="remove-fault" aria-label={`Remove ${FAULT_LABELS[f.type]} on ${f.step}`} onClick={() => setFaults(faults.filter((_, i) => i !== index))} data-testid={`button-remove-fault-${index}`}>Remove</button>
        </li>)}
      </ul>}
    <div className={`fault-note ${fetchNetwork && !looksLikeCve ? 'warn' : ''}`} data-testid="text-fetch-fault-note">
      Fetch network faults only fire when the input is a CVE identifier, because fetch then calls NVD over HTTP. Pasted advisory text bypasses HTTP, so a fetch timeout, HTTP 500 or malformed JSON fault will never trigger.
      {fetchNetwork && !looksLikeCve && <strong> Your current input is not a bare CVE ID.</strong>}
    </div>
    <label className="slow-toggle" data-testid="toggle-slow-mode">
      <input type="checkbox" checked={slowMode} onChange={(e) => setSlowMode(e.target.checked)} data-testid="input-slow-mode" />
      <span className="slow-track" aria-hidden="true" />
      <span><strong>Slow mode</strong> artificial 1.5s delay between steps for demos</span>
    </label>
  </section>;
}

const MAX_INPUT = 20000;
const DRAFT_KEY = 'patchbrief:draft';
function Home() {
  const [input, setInputState] = useState(() => { try { return sessionStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; } });
  const setInput = (v: string) => { setInputState(v); try { if (v) sessionStorage.setItem(DRAFT_KEY, v); else sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ } };
  const [inputError, setInputError] = useState('');
  const [faults, setFaults] = useState<FaultInput[]>([]);
  const [slowMode, setSlowMode] = useState(false);
  const idempotencyHeaders = useRef(new Headers());
  const createRun = useCreateRun({ request: { headers: idempotencyHeaders.current } });
  const [, setLocation] = useLocation();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = input.trim();
    if (value.length > MAX_INPUT) { setInputError(`Your text is ${value.length.toLocaleString()} characters; the limit is 20,000. Shorten it by ${(value.length - MAX_INPUT).toLocaleString()} characters and submit again. Nothing was sent and your text has been kept.`); return; }
    if (!isValidRunInput(value)) { setInputError(RUN_INPUT_ERROR); return; }
    setInputError('');
    const idempotencyKey = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    idempotencyHeaders.current.set('Idempotency-Key', idempotencyKey);
    createRun.mutate(
      { data: { input: value, ...(faults.length ? { faults } : {}), ...(slowMode ? { slowMode: true } : {}) } },
      {
        onSuccess: (result) => {
          setInput('');
          try {
            rememberBrowserRun(window.localStorage, result.run.id);
            window.dispatchEvent(new Event(BROWSER_RUNS_CHANGED));
          } catch {
            window.alert('The run was created, but this browser could not save it in Recent runs. Keep the replay link to return to it.');
          }
          setLocation(`/run/${encodeURIComponent(result.run.id)}`);
        },
        onError: (failure) => setInputError((failure as { data?: { error?: string } })?.data?.error === RUN_INPUT_ERROR
          ? RUN_INPUT_ERROR : describeApiError(failure, 'The run could not be started. Check the input and try again.')),
      },
    );
  };

  return <AppFrame>
    <main className="page-wrap">
      <div className="home-grid">
        <section className="fade-in">
          <h1 className="hero-title">Paste a CVE. Get a triage brief. See every step.</h1>
          <p className="hero-copy">Checks an advisory against the software I run, and shows how each step went.</p>
        </section>
        <form className="form-panel fade-in" onSubmit={submit} data-testid="form-create-run">
          <div className="panel-head">
            <div><h2 className="panel-title">New run</h2><p className="panel-subtitle">One identifier or the full advisory text.</p></div>
          </div>
          <label className="input-label" htmlFor="advisory-input">CVE ID or advisory</label>
          <textarea id="advisory-input" className="input-control advisory-input" value={input} aria-invalid={!!inputError || input.length > MAX_INPUT} aria-describedby={inputError ? 'run-input-error' : undefined} onChange={(event) => { setInput(event.target.value); if (inputError) setInputError(''); }} placeholder={'CVE-2024-3094\n\nor paste the vendor advisory here'} data-testid="input-advisory" />
          <div className="draft-controls">
            <p className={`field-hint ${input.length > MAX_INPUT ? 'over' : ''}`} data-testid="text-input-count">The supplied text is the source material. {input.length.toLocaleString()} / 20,000 characters.{input.length > MAX_INPUT ? ' Over the limit; shorten before submitting.' : ''} Your draft is kept in this tab.</p>
            <button type="button" className="copy-button" disabled={createRun.isPending}
              onClick={() => { setInput(''); setInputError(''); }} data-testid="button-clear-draft">Clear</button>
          </div>
          <BreakItPanel faults={faults} setFaults={setFaults} slowMode={slowMode} setSlowMode={setSlowMode} input={input} />
          {inputError && <div id="run-input-error" className="error-box" role="alert" data-testid="status-submit-error">{inputError}</div>}
          <button className="submit-button" type="submit" disabled={createRun.isPending} data-testid="button-submit-run">
            <span>{createRun.isPending ? 'Starting review…' : 'Run assessment'}</span>
            <span className="submit-meta">{faults.length ? `${faults.length} fault${faults.length > 1 ? 's' : ''}` : ''}{slowMode ? `${faults.length ? ' / ' : ''}slow` : ''}</span>
          </button>
          {createRun.isPending && <p className="field-hint" aria-live="polite">Creating a fresh run. This may take a moment.</p>}
        </form>
      </div>
      <RecentRuns />
    </main>
  </AppFrame>;
}

function normalizedStatus(step?: Step): DisplayStatus {
  if (!step || step.status === 'pending') return 'waiting';
  if (step.fallbackUsed) return 'fallback_used';
  return step.status;
}
function statusText(status: DisplayStatus) {
  return status === 'completed' ? 'done' : status === 'fallback_used' ? 'fallback used' : status === 'needs_input' ? 'needs input' : status;
}
function formatDuration(ms: number | null | undefined) {
  if (ms == null) return 'not recorded';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function formatSummary(step?: Step) {
  return (step?.outputSummary || step?.error || (step?.status === 'running' ? 'Working through this step.' : 'No summary recorded yet.'))
    .replace(/\b1 affected products\b/g, '1 affected product');
}
const attemptKey = (a: StepAttempt) => `${a.stepName}#${a.attempt}`;
function unionAttempts(base: StepAttempt[] = [], preferred: StepAttempt[] = []) {
  const map = new Map(base.map((a) => [attemptKey(a), a]));
  preferred.forEach((a) => map.set(attemptKey(a), a));
  return [...map.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.attempt - b.attempt);
}
function unionFaults(base: RunFault[] = [], preferred: RunFault[] = []) {
  const map = new Map(base.map((f) => [f.id, f]));
  preferred.forEach((f) => map.set(f.id, f));
  return [...map.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
function mergeRunData(current: RunData | null, incoming: RunData): RunData {
  if (!current || current.run.id !== incoming.run.id) return incoming;
  const newer = new Map(current.steps.map((step) => [step.seq, step]));
  incoming.steps.forEach((next) => {
    const prior = newer.get(next.seq);
    if (!prior || Date.parse(next.updatedAt || '') >= Date.parse(prior.updatedAt || '')) newer.set(next.seq, next);
  });
  return {
    run: isTerminal(current.run.status) && !isTerminal(incoming.run.status) ? current.run : { ...current.run, ...incoming.run },
    steps: [...newer.values()].sort((a, b) => a.seq - b.seq),
    attempts: unionAttempts(current.attempts, incoming.attempts),
    faults: unionFaults(current.faults, incoming.faults),
  };
}
function replaceFromSnapshot(current: RunData | null, snapshot: RunData): RunData {
  if (!current || current.run.id !== snapshot.run.id) return snapshot;
  const steps = snapshot.steps.map((next) => {
    const previous = current.steps.find((step) => step.seq === next.seq);
    if (!previous) return next;
    const previousTime = Date.parse(previous.updatedAt || '');
    const nextTime = Date.parse(next.updatedAt || '');
    return Number.isFinite(previousTime) && (!Number.isFinite(nextTime) || previousTime > nextTime) ? previous : next;
  });
  return {
    run: isTerminal(current.run.status) && !isTerminal(snapshot.run.status) ? current.run : snapshot.run,
    steps: steps.sort((a, b) => a.seq - b.seq),
    attempts: unionAttempts(current.attempts, snapshot.attempts),
    faults: unionFaults(current.faults, snapshot.faults),
  };
}

function AttemptHistory({ attempts }: { attempts: StepAttempt[] }) {
  if (!attempts.length) return <div className="attempt-empty" data-testid="text-no-attempts">No attempts have been recorded for this step yet.</div>;
  return <ol className="attempt-list" data-testid="list-attempts">
    {attempts.map((a) => <li key={attemptKey(a)} className={`attempt-row ${a.status}`} data-testid={`row-attempt-${a.stepName}-${a.attempt}`}>
      <div className="attempt-top">
        <span className="attempt-no">#{a.attempt}</span>
        <span className={`attempt-status ${a.status}`}>{a.status}</span>
        <span className="attempt-time">started {formatTime(a.startedAt)}</span>
        <span className="attempt-time">{formatDuration(a.durationMs)}</span>
        {a.faultType && <span className="attempt-fault">injected {FAULT_LABELS[a.faultType] || a.faultType}</span>}
      </div>
      {a.error && <div className="attempt-error">{a.error}</div>}
      {a.retryInMs != null && <div className="attempt-retry">retry scheduled in {formatDuration(a.retryInMs)}</div>}
    </li>)}
  </ol>;
}

export function TraceGraph({ data, onSelect, selectedSeq, connection, retrying, retryRemainingMs, localInterrupted }: { data: RunData; onSelect: (step: Step) => void; selectedSeq: number | null; connection: string; retrying: AttemptEvent | null; retryRemainingMs: number; localInterrupted: string[] }) {
  const steps: Step[] = ORDERED_STEPS.map((name, index) => data.steps.find((step) => step.name === name) || ({
    id: `waiting-${name}`, runId: data.run.id, seq: index + 1, name, status: 'pending',
    attempt: 0, startedAt: null, durationMs: null, output: null, outputSummary: null, error: null,
    fallbackUsed: false, interrupted: false, updatedAt: '',
  }));
  const attemptsFor = (name: string) => (data.attempts || []).filter((a) => a.stepName === name).sort((a, b) => a.attempt - b.attempt || Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const interruptState = (step: Step): 'none' | 'interrupted' | 'recovered' => {
    const hit = step.interrupted || localInterrupted.includes(step.name) || attemptsFor(step.name).some((a) => a.status === 'interrupted' || (a.status === 'running' && a.faultType === 'worker_crash'));
    if (!hit) return 'none';
    return step.status === 'completed' ? 'recovered' : step.status === 'pending' && step.interrupted ? 'recovered' : step.status === 'running' && step.interrupted ? 'recovered' : 'interrupted';
  };
  const centers = [100, 300, 500, 700, 900];
  const statusClass = (status: DisplayStatus) => status === 'completed' ? 'done' : status === 'fallback_used' ? 'fallback' : status === 'needs_input' ? 'needs-input' : status;
  const summaryLines = (summary: string) => summary.split(/\s+/).reduce<string[]>((lines, word) => {
    const last = lines.length - 1;
    if (last < 0 || `${lines[last]} ${word}`.length > 30) lines.push(word);
    else lines[last] += ` ${word}`;
    return lines;
  }, []);
  return <div className="trace-card">
    <div className="section-label"><span>Run trace</span><span className={`stream-state ${connection}`} role="status" data-testid="status-sse-connection">{connection === 'replay' ? 'Saved replay' : connection === 'complete' ? 'Complete' : connection === 'reconnecting' ? 'Reconnecting' : connection === 'connected' ? 'Live' : connection === 'idle' ? 'Loading' : 'Connecting'}</span></div>
    <div className="trace-svg-scroll">
      <svg className="trace-svg" viewBox="0 0 1000 250" role="group" aria-label="Five ordered review steps connected in a horizontal run trace">
        <defs><marker id="trace-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="none" stroke="#a5aaa5" strokeWidth="1.2" /></marker></defs>
        {steps.slice(0, -1).map((step, index) => {
          const status = normalizedStatus(step);
          const complete = status === 'completed' || status === 'fallback_used';
          return <line key={`connector-${step.seq}`} className={`svg-connector ${complete ? 'done' : ''}`} x1={centers[index] + 24} y1="39" x2={centers[index + 1] - 27} y2="39" markerEnd="url(#trace-arrow)" />;
        })}
        {steps.map((step, index) => {
          const status = normalizedStatus(step);
          const summary = formatSummary(step);
          const label = STEP_LABELS[step.name] || step.name;
          const interrupt = interruptState(step);
          const count = attemptsFor(step.name).length;
          const accessibleText = `${label}, ${statusText(status)}${interrupt !== 'none' ? `, ${interrupt}` : ''}, attempt ${step.attempt || 'not started'}, ${formatDuration(step.durationMs)}. Summary: ${summary}${step.error ? `. Error: ${step.error}` : ''}`;
          return <g
            key={step.name}
            className={`svg-step ${selectedSeq === step.seq ? 'selected' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={accessibleText}
            aria-pressed={selectedSeq === step.seq}
            data-testid={`step-${step.name}`}
            onClick={() => onSelect(step)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(step); }
            }}
          >
            <title>{accessibleText}</title>
            {retrying?.phase === 'retry_scheduled' && retrying.stepName === step.name && <g className="retry-loop" aria-hidden="true">
              <path d={`M ${centers[index] - 13} 20 C ${centers[index] - 31} -1 ${centers[index] + 31} -1 ${centers[index] + 13} 20`} markerEnd="url(#trace-arrow)" />
              <text x={centers[index]} y="8">retrying in {Math.ceil(retryRemainingMs / 1000)}s</text>
            </g>}
            {interrupt !== 'none' && <circle className={`interrupt-ring ${interrupt}`} cx={centers[index]} cy="39" r="25" />}
            <circle className={`svg-node ${statusClass(status)}`} cx={centers[index]} cy="39" r="19" />
            <text className="svg-seq" x={centers[index]} y="43">{String(step.seq).padStart(2, '0')}</text>
            <text className="svg-name" x={centers[index]} y="82">{label}</text>
            <text className={`svg-status ${statusClass(status)}`} x={centers[index]} y="103">{statusText(status)}</text>
            <text className="svg-meta" x={centers[index]} y="125">{formatDuration(step.durationMs)}{count ? ` · ${count} attempt${count === 1 ? '' : 's'}` : ''}</text>
            <text className="svg-summary" x={centers[index]} y="151">{summaryLines(summary).map((line, lineIndex) => <tspan key={lineIndex} x={centers[index]} dy={lineIndex ? 14 : 0}>{line}</tspan>)}</text>
            {interrupt !== 'none' && <text className={`interrupt-text ${interrupt}`} x={centers[index] - 26} y="220" data-testid={`status-interrupt-${step.name}`}>{interrupt === 'recovered' ? 'interrupted / recovered' : 'interrupted'}</text>}
          </g>;
        })}
      </svg>
    </div>
    {selectedSeq != null && (() => {
      const step = steps.find((entry) => entry.seq === selectedSeq);
      if (!step) return null;
      const interrupt = interruptState(step);
      return <div className="step-detail fade-in" data-testid="detail-selected-step">
        <div className="detail-head"><span>{STEP_LABELS[step.name] || step.name}{interrupt !== 'none' && <span className={`interrupt-pill ${interrupt}`}>{interrupt === 'recovered' ? 'interrupted, recovered' : 'interrupted'}</span>}</span><span className="node-status">{statusText(normalizedStatus(step))} · attempt {step.attempt || '—'} · {formatDuration(step.durationMs)}</span></div>
        <p className="detail-body">{step.outputSummary || 'No step summary is available yet.'}</p>
        <div className="detail-sub">Attempt history</div>
        <AttemptHistory attempts={attemptsFor(step.name)} />
        {pathOf(step) && <p className="path-note" data-testid={`text-path-${step.name}`}>Path used: {pathOf(step)}</p>}
        {step.error && <div className="detail-error"><strong>Error</strong><br />{step.error}</div>}
        {step.output && <details key={step.id} className="raw-output">
          <summary>Show raw output</summary>
          <pre className="detail-body">{JSON.stringify(step.output, null, 2)}</pre>
        </details>}
      </div>;
    })()}
  </div>;
}

function pathOf(step?: Step): string {
  const o = step?.output as Record<string, unknown> | null | undefined;
  if (!o) return '';
  const v = o.extraction_path ?? o.wording_path;
  return typeof v === 'string' ? processingPathLabel(v) : '';
}
function PathSummary({ steps }: { steps: Step[] }) {
  const extract = pathOf(steps.find((s) => s.name === 'extract'));
  const plan = pathOf(steps.find((s) => s.name === 'plan'));
  if (!extract && !plan) return null;
  return <div className="path-summary" data-testid="text-path-summary">
    {extract && <span><strong>Extraction path</strong> {extract}</span>}
    {plan && <span><strong>Checklist wording path</strong> {plan}</span>}
  </div>;
}

function FaultsPanel({ faults }: { faults: RunFault[] }) {
  if (!faults.length) return null;
  return <section className="faults-card" data-testid="panel-run-faults">
    <div className="section-label"><span>Injected faults</span><span>{faults.reduce((n, f) => n + f.injectedCount, 0)} fired</span></div>
    <table className="faults-table">
      <thead><tr><th>Step</th><th>Failure</th><th>Configured</th><th>Injected</th><th>Remaining</th></tr></thead>
      <tbody>
        {faults.map((f) => <tr key={f.id} data-testid={`row-run-fault-${f.id}`}>
          <td className="mono">{f.stepName}</td>
          <td><span className={`fault-type ${f.type === 'worker_crash' ? 'crash' : ''}`}>{FAULT_LABELS[f.type] || f.type}</span></td>
          <td className="mono">{timesText(f.initialTimes)}</td>
          <td className="mono" data-testid={`text-fault-injected-${f.id}`}>{f.injectedCount}</td>
          <td className="mono" data-testid={`text-fault-remaining-${f.id}`}>{f.remaining === -1 ? 'always' : f.remaining === 0 ? 'spent' : f.remaining}</td>
        </tr>)}
      </tbody>
    </table>
  </section>;
}

function RunView({ initial, data, isLoading, error, onRetry, showId = true, connection, retrying, retryRemainingMs, localInterrupted }: {
  initial: RunData | null; data: RunData | null; isLoading: boolean; error: boolean; onRetry: () => void; showId?: boolean; connection: string; retrying: AttemptEvent | null; retryRemainingMs: number; localInterrupted: string[];
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState('Copy message');
  const [linkStatus, setLinkStatus] = useState('Copy link');
  const [resumeText, setResumeText] = useState('');
  const [resumeError, setResumeError] = useState('');
  const resumeInput = useSubmitRunInput();
  const queryClient = useQueryClient();
  const live = data || initial;
  const replaySource = live && isTerminal(live.run.status) ? live : null;
  const replay = useReplay(replaySource);
  if (isLoading && !live) return <div className="loading-state" data-testid="status-run-loading"><div className="skeleton" style={{ height: 20, width: '35%', marginBottom: 22 }} /><div className="skeleton" style={{ height: 150, width: '100%' }} /></div>;
  if (error && !live) return <div className="empty-state" data-testid="status-run-error">This run could not be loaded. <button className="nav-link" onClick={onRetry} data-testid="button-retry-run">Retry</button></div>;
  if (!live) return <div className="empty-state">No run data is available.</div>;
  const heading = runTitle(live.run.input);
  const finalBrief = live.steps.find((step) => step.name === 'brief')?.output;
  const markdown = typeof finalBrief?.markdown === 'string' ? finalBrief.markdown : typeof finalBrief?.brief === 'string' ? finalBrief.brief : '';
  const teamValue = finalBrief?.team_message;
  const teamMessage = presentTeamMessage(typeof teamValue === 'string' ? teamValue : Array.isArray(teamValue) ? teamValue.filter((line): line is string => typeof line === 'string').join('\n') : '', live.steps);
  const statusClass = live.run.status === 'completed' ? 'complete' : live.run.status === 'failed' ? 'failed' : live.run.status === 'needs_input' ? 'needs-input' : '';
  const submitResume = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = resumeText.trim();
    if (!value) { setResumeError('Paste the advisory text to resume this run.'); return; }
    if (value.length > MAX_INPUT) { setResumeError(`Your text is ${value.length.toLocaleString()} characters; the limit is 20,000. Shorten it and resume again. Your text has been kept.`); return; }
    setResumeError('');
    resumeInput.mutate(
      { id: live.run.id, data: { input: value } },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(getGetRunQueryKey(live.run.id), updated);
          queryClient.setQueryData(getGetLatestRunQueryKey(), (old: RunData | undefined) => old?.run.id === live.run.id ? updated : old);
          setResumeText('');
        },
        onError: (failure) => setResumeError(describeApiError(failure, 'The run could not be resumed. Try again.')),
      },
    );
  };
  const copyTeamMessage = async () => {
    try {
      await navigator.clipboard.writeText(teamMessage);
      setCopyStatus('Copied');
      window.setTimeout(() => setCopyStatus('Copy message'), 1800);
    } catch {
      setCopyStatus('Copy unavailable');
    }
  };
  const copyLink = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(window.location.href);
      setLinkStatus('Link copied');
    } catch {
      setLinkStatus('Copy failed, use the address bar');
    }
    window.setTimeout(() => setLinkStatus('Copy link'), 2400);
  };
  return <div className="run-content">
    <div className="page-heading">
      <div>
        <h1>{heading.title}</h1>
        {heading.preview && <p className="advisory-preview">{heading.preview}</p>}
        <p>Run trace</p>
        <div className="status-line">
          <span className={`live-dot ${statusClass}`} />
          <span data-testid="status-run">{live.run.status === 'completed' ? 'Run complete' : live.run.status === 'failed' ? 'Review failed' : live.run.status === 'needs_input' ? 'Needs advisory input' : live.run.status === 'queued' ? 'Queued for a worker' : 'Review in progress'}</span>
          {live.run.degraded && <span className="degraded-badge">Degraded</span>}
          {live.run.resumeCount > 1 && <span className="resumed-badge" data-testid="badge-resumed">Resumed · count {live.run.resumeCount}</span>}
          {live.run.slowMode && <span className="slow-badge" data-testid="badge-slow-mode">Slow mode / artificial 1.5s delay between steps</span>}
        </div>
      </div>
      <div className="heading-side">
        {showId && <div className="run-id" data-testid="text-run-id">{live.run.id}</div>}
        {showId && <button type="button" className="copy-button" onClick={copyLink} data-testid="button-copy-link">{linkStatus}</button>}
      </div>
    </div>
    {live.run.llmDisabledReason && heading.title === 'Pasted advisory' && <div className="llm-note" data-testid="text-llm-disabled">
      <strong>Rule-based (no LLM)</strong> The model was not used for this run: {live.run.llmDisabledReason}
    </div>}
    {live.run.status === 'needs_input' && <form className="resume-panel fade-in" onSubmit={submitResume} data-testid="form-resume-run">
      <div className="panel-head"><div><h2 className="panel-title">Paste the advisory to continue</h2><p className="panel-subtitle">NVD could not provide this CVE record. This resumes the same run at the fetch step.</p></div></div>
      <label className="input-label" htmlFor="resume-advisory-input">Advisory text</label>
      <textarea id="resume-advisory-input" className="input-control advisory-input" value={resumeText} onChange={(event) => { setResumeText(event.target.value); if (resumeError) setResumeError(''); }} placeholder="Paste the vendor advisory here" data-testid="input-resume-advisory" />
      <div className="resume-footer"><span className="field-hint">{resumeText.length.toLocaleString()} / 20,000 characters</span><button className="submit-button" type="submit" disabled={resumeInput.isPending || !resumeText.trim()} data-testid="button-resume-run">{resumeInput.isPending ? 'Resuming…' : 'Resume this run'}</button></div>
      {resumeError && <div className="error-box" role="alert" data-testid="status-resume-error">{resumeError}</div>}
    </form>}
    <CvssScores steps={live.steps} />
    {replaySource && <ReplayControls replay={replay} />}
    {replay.frame && <div className="replay-tag" data-testid="status-replay">Replay view. The saved result is unchanged; press Show saved result to return.</div>}
    <PathSummary steps={live.steps} />
    <TraceGraph data={replay.frame ? replay.frame.data : live} selectedSeq={selected} onSelect={(step) => setSelected((prev) => prev === step.seq ? null : step.seq)} connection={replay.frame ? 'replay' : connection} retrying={replay.frame ? null : retrying} retryRemainingMs={retryRemainingMs} localInterrupted={replay.frame ? [] : localInterrupted} />
    <FaultsPanel faults={live.faults || []} />
    {(live.run.status === 'completed' || markdown) && <section className="brief-card">
      <div className="brief-head"><h2>Assessment brief</h2>{live.run.degraded && <span className="degraded-badge">Degraded output</span>}</div>
      <MarkdownBrief content={presentSavedBrief(markdown, live.steps)} />
      {teamMessage && <section className="team-message" aria-labelledby="team-message-heading" data-testid="content-team-message">
        <div className="team-message-head"><h3 id="team-message-heading">Team message</h3><button type="button" className="copy-button" onClick={copyTeamMessage} data-testid="button-copy-team-message">{copyStatus}</button></div>
        <pre>{teamMessage}</pre>
      </section>}
    </section>}
  </div>;
}

type Connection = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'complete' | 'replay';
function useRunStream(id: string, initial: RunData | undefined) {
  const [streamData, setStreamData] = useState<RunData | null>(initial || null);
  const [attemptEvent, setAttemptEvent] = useState<AttemptEvent | null>(null);
  const [localInterrupted, setLocalInterrupted] = useState<string[]>([]);
  const [clock, setClock] = useState(Date.now());
  const [connection, setConnection] = useState<Connection>(() => initial ? (isTerminal(initial.run.status) ? 'replay' : 'connecting') : 'idle');
  const latest = useRef<RunData | null>(initial || null);
  const queryClient = useQueryClient();
  const loaded = !!initial && initial.run.id === id;
  const initialTerminal = loaded && isTerminal(initial.run.status);
  const shouldStream = !!id && loaded && !initialTerminal;
  const streamedRef = useRef(false);
  useEffect(() => {
    if (initial) {
      latest.current = mergeRunData(latest.current, initial);
      setStreamData(latest.current);
      if (isTerminal(latest.current.run.status)) setConnection(streamedRef.current ? 'complete' : 'replay');
    }
  }, [initial]);
  useEffect(() => {
    if (attemptEvent?.phase !== 'retry_scheduled') return;
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [attemptEvent]);
  useEffect(() => {
    if (!shouldStream) return;
    streamedRef.current = true;
    setConnection('connecting');
    let closed = false;
    let rehydrateTimer: number | undefined;
    const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
    const apply = (incoming: RunData, kind: string) => {
      const merged = kind === 'snapshot' ? replaceFromSnapshot(latest.current, incoming) : mergeRunData(latest.current, incoming);
      latest.current = merged;
      setStreamData(merged);
      queryClient.setQueryData(getGetRunQueryKey(id), merged);
      queryClient.setQueryData(getGetLatestRunQueryKey(), (old: RunData | undefined) => old?.run.id === id ? merged : old);
      return merged;
    };
    const rehydrate = (delay = 250) => {
      window.clearTimeout(rehydrateTimer);
      rehydrateTimer = window.setTimeout(() => {
        getRun(id).then((fresh) => apply(fresh, 'snapshot')).catch(() => undefined);
      }, delay);
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      source.close();
      setConnection('complete');
      setAttemptEvent(null);
      // This fetch must survive the effect cleanup caused by the terminal status.
      getRun(id).then((fresh) => apply(fresh, 'snapshot')).catch(() => undefined);
    };
    const ingest = (raw: string, kind: string) => {
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        if (kind === 'attempt') {
          const event = (typeof payload.attempt === 'object' && payload.attempt !== null ? payload.attempt : payload.data || payload) as AttemptEvent;
          if (event.phase === 'retry_scheduled') setAttemptEvent(event);
          else setAttemptEvent((current) => current?.stepName === event.stepName ? null : current);
          if (event.phase === 'interrupted') setLocalInterrupted((list) => list.includes(event.stepName) ? list : [...list, event.stepName]);
          if (event.record && latest.current) apply({ ...latest.current, attempts: unionAttempts(latest.current.attempts, [event.record]) }, 'attempt');
          rehydrate();
          return;
        }
        if (kind === 'fault') {
          const fault = (payload.fault || payload.data || payload) as RunFault;
          if (fault.type === 'worker_crash') setLocalInterrupted((list) => list.includes(fault.stepName) ? list : [...list, fault.stepName]);
          if (latest.current && fault.id) apply({ ...latest.current, faults: unionFaults(latest.current.faults, [fault]) }, 'fault');
          rehydrate();
          return;
        }
        let incoming: RunData | null = null;
        if (payload.run && Array.isArray(payload.steps)) incoming = payload as unknown as RunData;
        else if (kind === 'snapshot' && payload.data && typeof payload.data === 'object') {
          const nested = payload.data as Record<string, unknown>;
          if (nested.run && Array.isArray(nested.steps)) incoming = nested as unknown as RunData;
        } else if (kind === 'step' || (payload.seq != null && payload.name)) {
          const step = (payload.step || payload.data || payload) as Step;
          if (latest.current) incoming = { ...latest.current, steps: [...latest.current.steps.filter((item) => item.seq !== step.seq), step].sort((a, b) => a.seq - b.seq) };
        } else if (kind === 'run' && latest.current) {
          const runUpdate = (payload.run || payload.data || payload) as Partial<RunData['run']>;
          incoming = { ...latest.current, run: { ...latest.current.run, ...runUpdate } };
        }
        if (incoming) {
          const merged = apply(incoming, kind);
          if (isTerminal(merged.run.status)) finish();
        }
      } catch {
        // Ignore malformed stream frames; EventSource will continue the connection.
      }
    };
    source.onopen = () => { if (!closed) setConnection('connected'); };
    source.onerror = () => { if (!closed) setConnection('reconnecting'); };
    source.onmessage = (event) => ingest(event.data, 'message');
    (['snapshot', 'step', 'attempt', 'run', 'fault'] as const).forEach((kind) => source.addEventListener(kind, (event) => ingest((event as MessageEvent).data, kind)));
    return () => { closed = true; window.clearTimeout(rehydrateTimer); source.close(); };
  }, [id, shouldStream, queryClient]);
  const remaining = attemptEvent?.phase === 'retry_scheduled'
    ? Math.max(0, (attemptEvent.retryInMs || 0) - (clock - Date.parse(attemptEvent.timestamp)))
    : 0;
  return { data: streamData, connection, attemptEvent, retryRemainingMs: remaining, localInterrupted };
}

function RunPage() {
  const params = useParams<{ id: string }>();
  const id = params.id || '';
  const query = useGetRun(id, { query: { queryKey: getGetRunQueryKey(id), enabled: !!id, refetchOnWindowFocus: false, refetchOnReconnect: false } });
  const stream = useRunStream(id, query.data);
  return <AppFrame><main className="page-wrap"><RunView initial={query.data || null} data={stream.data} isLoading={query.isLoading} error={query.isError} onRetry={() => void query.refetch()} connection={stream.connection} retrying={stream.attemptEvent} retryRemainingMs={stream.retryRemainingMs} localInterrupted={stream.localInterrupted} /></main></AppFrame>;
}

function HowItWorks() {
  const featuredId = import.meta.env.FEATURED_RUN_ID?.trim() || '';
  const featured = useGetRun(featuredId, { query: { queryKey: getGetRunQueryKey(featuredId), enabled: !!featuredId, retry: false } });
  const featuredData = featured.data?.run.id === featuredId ? featured.data : undefined;
  const stream = useRunStream(featuredId, featuredData);
  return <AppFrame><main className="page-wrap">
    <div className="page-heading"><div><h1>How it works</h1><p>Each run goes through five saved steps. If one fails, the app retries, falls back, or asks for input, and you can replay the run.</p></div></div>
    <ArchitectureDiagram />
    <section className="latest-section">
      {!featuredId ? <div className="empty-state">No featured run set yet</div> : <>
        <h2>Featured run trace</h2>
        {featured.isLoading && <div className="loading-state" data-testid="status-featured-loading"><div className="skeleton" style={{ height: 155 }} /></div>}
        {featured.isError && <div className="empty-state" data-testid="status-featured-error">The featured run could not be loaded. <button className="nav-link" onClick={() => void featured.refetch()}>Try again</button></div>}
        {featuredData && <RunView initial={featuredData} data={stream.data?.run.id === featuredId ? stream.data : null} isLoading={false} error={false} onRetry={() => void featured.refetch()} showId={false} connection={stream.connection} retrying={stream.attemptEvent} retryRemainingMs={stream.retryRemainingMs} localInterrupted={stream.localInterrupted} />}
      </>}
    </section>
    {featuredId && <section className="featured-run">
      <Link href={`/run/${encodeURIComponent(featuredId)}`}>Featured run</Link>
      <p>A run where fetch timed out twice and the server crashed during assess.</p>
    </section>}
  </main></AppFrame>;
}

function Router() {
  return <RoutedErrorBoundary><Switch>
    <Route path="/" component={Home} />
    <Route path="/run/:id" component={RunPage} />
    <Route path="/how-it-works" component={HowItWorks} />
    <Route path="/stack">{() => <AppFrame><StackPage /></AppFrame>}</Route>
    <Route component={NotFound} />
  </Switch></RoutedErrorBoundary>;
}
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function App() {
  return <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
        <footer className="site-footer">
          {import.meta.env.GITHUB_REPO_URL && <a href={import.meta.env.GITHUB_REPO_URL} target="_blank" rel="noreferrer">GitHub</a>}
        </footer>
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>;
}

export default App;
