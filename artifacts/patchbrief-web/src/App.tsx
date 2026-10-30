import { type FormEvent, type ReactNode, useEffect, useMemo, useState, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Link, Route, Switch, useLocation, useParams, Router as WouterRouter } from 'wouter';
import { getGetLatestRunQueryKey, getGetRunQueryKey, useCreateRun, useGetLatestRun, useGetRun, useSubmitRunInput } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient();
type StepStatus = 'completed' | 'running' | 'needs_input' | 'failed' | 'waiting' | 'fallback_used';
type Step = {
  id: string; runId: string; seq: number; name: string; status: StepStatus; attempt: number;
  startedAt: string | null; durationMs: number | null; output: Record<string, unknown> | null;
  outputSummary: string | null; error: string | null; fallbackUsed: boolean; updatedAt: string;
};
type Run = { id: string; idempotencyKey: string; input: string; status: string; degraded: boolean; createdAt: string; finishedAt: string | null };
type RunData = { run: Run; steps: Step[] };
type AttemptEvent = { runId: string; stepId: string; stepName: string; attempt: number; phase: 'started' | 'failed' | 'retry_scheduled'; timestamp: string; retryInMs?: number; durationMs?: number; error?: string };
const ORDERED_STEPS = ['fetch', 'extract', 'assess', 'plan', 'brief'];
const STEP_LABELS: Record<string, string> = { fetch: 'Fetch advisory', extract: 'Extract facts', assess: 'Assess stack', plan: 'Map remediation', brief: 'Write brief' };

function Header() {
  const [location] = useLocation();
  return <header className="topbar">
    <Link href="/" className="brand" data-testid="link-home"><span>PatchBrief</span></Link>
    <nav className="nav-links" aria-label="Primary navigation">
      <Link href="/" className={`nav-link ${location === '/' ? 'active' : ''}`} data-testid="link-new-review">New review</Link>
      <Link href="/how-it-works" className={`nav-link ${location === '/how-it-works' ? 'active' : ''}`} data-testid="link-how-it-works">How it works</Link>
    </nav>
  </header>;
}

function AppFrame({ children }: { children: ReactNode }) {
  return <div className="app-shell"><Header />{children}</div>;
}

function Home() {
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState('');
  const idempotencyHeaders = useRef(new Headers());
  const createRun = useCreateRun({ request: { headers: idempotencyHeaders.current } });
  const [, setLocation] = useLocation();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = input.trim();
    if (!value) { setInputError('Add a CVE identifier or advisory text to begin.'); return; }
    setInputError('');
    const idempotencyKey = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    idempotencyHeaders.current.set('Idempotency-Key', idempotencyKey);
    createRun.mutate(
      { data: { input: value } },
      {
        onSuccess: (result) => {
          const typed = result as unknown as RunData;
          setLocation(`/run/${encodeURIComponent(typed.run.id)}`);
        },
        onError: () => setInputError('The review could not be started. Check the input and try again.'),
      },
    );
  };

  return <AppFrame>
    <main className="page-wrap">
      <div className="home-grid">
        <section className="fade-in">
          <div className="eyebrow">Evidence before conclusions</div>
          <h1 className="hero-title">Know what a vulnerability means for your stack.</h1>
          <p className="hero-copy">Give PatchBrief a CVE or an advisory. It checks the evidence, compares it with your tracked components, and leaves a reviewable trail from source to recommendation.</p>
          <div className="proof-row">
            <div><strong>Source-led</strong>Evidence is kept close to each finding.</div>
            <div><strong>Traceable</strong>Every assessment step is visible.</div>
          </div>
        </section>
        <form className="form-panel fade-in" onSubmit={submit} data-testid="form-create-run">
          <div className="panel-head">
            <div><h2 className="panel-title">Start a vulnerability review</h2><p className="panel-subtitle">One identifier or the full advisory text.</p></div>
            <span className="eyebrow">01 / Input</span>
          </div>
          <label className="input-label" htmlFor="advisory-input">CVE ID or advisory</label>
          <textarea id="advisory-input" className="input-control advisory-input" value={input} maxLength={20000} onChange={(event) => { setInput(event.target.value); if (inputError) setInputError(''); }} placeholder={'CVE-2024-3094\n\n—or paste the vendor advisory here…'} data-testid="input-advisory" />
          <p className="field-hint">The supplied text is the source material. {input.length.toLocaleString()} / 20,000 characters.</p>
          {inputError && <div className="error-box" role="alert" data-testid="status-submit-error">{inputError}</div>}
          <button className="submit-button" type="submit" disabled={createRun.isPending} data-testid="button-submit-run">
             <span>{createRun.isPending ? 'Starting review…' : 'Run assessment'}</span>
          </button>
          {createRun.isPending && <p className="field-hint" aria-live="polite">Creating a fresh run. This may take a moment.</p>}
        </form>
      </div>
      <div className="footer-note"><span>PATCHBRIEF / EVIDENCE REVIEW</span><span>Assess. Verify. Track.</span></div>
    </main>
  </AppFrame>;
}

function normalizedStatus(step?: Step): StepStatus {
  if (!step) return 'waiting';
  if (step.fallbackUsed || step.status === 'fallback_used') return 'fallback_used';
  return step.status;
}
function statusText(status: StepStatus) {
  return status === 'completed' ? 'done' : status === 'fallback_used' ? 'fallback used' : status === 'needs_input' ? 'needs input' : status;
}
function formatDuration(ms: number | null | undefined) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function formatSummary(step?: Step) {
  return step?.outputSummary || step?.error || (step?.status === 'running' ? 'Working through this step.' : 'Waiting for the previous step.');
}
function mergeRunData(current: RunData | null, incoming: RunData): RunData {
  if (!current || current.run.id !== incoming.run.id) return incoming;
  const newer = new Map(current.steps.map((step) => [step.seq, step]));
  incoming.steps.forEach((next) => {
    const prior = newer.get(next.seq);
    if (!prior || Date.parse(next.updatedAt || '') >= Date.parse(prior.updatedAt || '') || prior.status === 'waiting') newer.set(next.seq, next);
  });
  const terminalCurrent = ['completed', 'failed'].includes(current.run.status);
  return {
    run: terminalCurrent && !['completed', 'failed'].includes(incoming.run.status) ? current.run : { ...current.run, ...incoming.run },
    steps: [...newer.values()].sort((a, b) => a.seq - b.seq),
  };
}
function replaceFromSnapshot(current: RunData | null, snapshot: RunData): RunData {
  if (!current || current.run.id !== snapshot.run.id) return snapshot;
  const currentIsTerminal = ['completed', 'failed'].includes(current.run.status);
  const steps = snapshot.steps.map((next) => {
    const previous = current.steps.find((step) => step.seq === next.seq);
    if (!previous) return next;
    const previousTime = Date.parse(previous.updatedAt || '');
    const nextTime = Date.parse(next.updatedAt || '');
    return Number.isFinite(previousTime) && (!Number.isFinite(nextTime) || previousTime > nextTime) ? previous : next;
  });
  return {
    run: currentIsTerminal && !['completed', 'failed'].includes(snapshot.run.status) ? current.run : snapshot.run,
    steps: steps.sort((a, b) => a.seq - b.seq),
  };
}

function TraceGraph({ data, onSelect, selectedSeq, connection, retrying, retryRemainingMs }: { data: RunData; onSelect: (step: Step) => void; selectedSeq: number | null; connection: string; retrying: AttemptEvent | null; retryRemainingMs: number }) {
  const steps = ORDERED_STEPS.map((name, index) => data.steps.find((step) => step.name === name) || ({
    id: `waiting-${name}`, runId: data.run.id, seq: index + 1, name, status: 'waiting' as StepStatus,
    attempt: 0, startedAt: null, durationMs: null, output: null, outputSummary: null, error: null,
    fallbackUsed: false, updatedAt: '',
  }));
  const centers = [100, 300, 500, 700, 900];
  const statusClass = (status: StepStatus) => status === 'completed' ? 'done' : status === 'fallback_used' ? 'fallback' : status === 'needs_input' ? 'needs-input' : status;
  const shortSummary = (summary: string) => summary.length > 24 ? `${summary.slice(0, 23).trimEnd()}…` : summary;
  return <div className="trace-card">
    <div className="section-label"><span>Run trace</span><span className={`stream-state ${connection}`} role="status" data-testid="status-sse-connection">{connection === 'complete' ? 'Complete' : connection === 'reconnecting' ? 'Reconnecting' : connection === 'connected' ? 'Connected' : 'Connecting'}</span></div>
    <div className="trace-svg-scroll">
      <svg className="trace-svg" viewBox="0 0 1000 218" role="group" aria-label="Five ordered review steps connected in a horizontal run trace">
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
          const accessibleText = `${label}, ${statusText(status)}, attempt ${step.attempt || 'not started'}, ${formatDuration(step.durationMs)}. Summary: ${summary}${step.error ? `. Error: ${step.error}` : ''}`;
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
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(step);
              }
            }}
          >
            <title>{accessibleText}</title>
            {retrying?.phase === 'retry_scheduled' && retrying.stepName === step.name && <g className="retry-loop" aria-hidden="true">
              <path d={`M ${centers[index] - 13} 20 C ${centers[index] - 31} -1 ${centers[index] + 31} -1 ${centers[index] + 13} 20`} markerEnd="url(#trace-arrow)" />
              <text x={centers[index]} y="8">retrying in {Math.ceil(retryRemainingMs / 1000)}s</text>
            </g>}
            <circle className={`svg-node ${statusClass(status)}`} cx={centers[index]} cy="39" r="19" />
            <text className="svg-seq" x={centers[index]} y="43">{String(step.seq).padStart(2, '0')}</text>
            <text className="svg-name" x={centers[index]} y="82">{label}</text>
            <text className={`svg-status ${statusClass(status)}`} x={centers[index]} y="103">{statusText(status)}</text>
            <text className="svg-meta" x={centers[index]} y="125">{step.attempt > 1 ? `attempt ${step.attempt} · ` : ''}{formatDuration(step.durationMs)}</text>
            <text className="svg-summary" x={centers[index]} y="151">{shortSummary(summary)}</text>
            {step.fallbackUsed && <g className="fallback-branch" aria-label={`${label} used a fallback`}>
              <path d={`M ${centers[index] + 13} 55 C ${centers[index] + 35} 81 ${centers[index] + 35} 145 ${centers[index] + 12} 171`} />
              <circle cx={centers[index] + 12} cy="178" r="7" />
              <text x={centers[index] + 12} y="202">fallback</text>
            </g>}
          </g>;
        })}
      </svg>
    </div>
    {selectedSeq != null && (() => {
      const step = steps.find((entry) => entry.seq === selectedSeq);
      if (!step) return null;
      return <div className="step-detail fade-in" data-testid="detail-selected-step">
        <div className="detail-head"><span>{STEP_LABELS[step.name] || step.name}</span><span className="node-status">{statusText(normalizedStatus(step))} · attempt {step.attempt || '—'} · {formatDuration(step.durationMs)}</span></div>
        <p className="detail-body">{step.outputSummary || 'No step summary is available yet.'}</p>
        {step.output && <pre className="detail-body">{JSON.stringify(step.output, null, 2)}</pre>}
        {step.error && <div className="detail-error"><strong>Error</strong><br />{step.error}</div>}
      </div>;
    })()}
  </div>;
}

function MarkdownBrief({ content }: { content: string }) {
  const blocks = useMemo(() => content.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean), [content]);
  if (!content.trim()) return <div className="empty-state">The final brief will appear here when the run completes.</div>;
  return <div className="brief-content" data-testid="content-final-brief">
    {blocks.map((block, index) => {
      const lines = block.split('\n');
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return <ul key={index}>{lines.map((line, item) => <li key={item}>{line.replace(/^\s*[-*]\s+/, '')}</li>)}</ul>;
      const heading = lines[0].match(/^(#{1,3})\s+(.*)$/);
      if (heading && lines.length === 1) {
        const text = heading[2];
        if (heading[1].length === 1) return <h1 key={index}>{text}</h1>;
        if (heading[1].length === 2) return <h2 key={index}>{text}</h2>;
        return <h3 key={index}>{text}</h3>;
      }
      return <p key={index}>{lines.map((line, item) => <span key={item}>{item > 0 && <br />}{line.replace(/^#{1,3}\s+/, '')}</span>)}</p>;
    })}
  </div>;
}

function RunView({ initial, data, isLoading, error, onRetry, showId = true, connection, retrying, retryRemainingMs }: {
  initial: RunData | null; data: RunData | null; isLoading: boolean; error: boolean; onRetry: () => void; showId?: boolean; connection: string; retrying: AttemptEvent | null; retryRemainingMs: number;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState('Copy message');
  const [resumeText, setResumeText] = useState('');
  const [resumeError, setResumeError] = useState('');
  const resumeInput = useSubmitRunInput();
  const queryClient = useQueryClient();
  const live = data || initial;
  if (isLoading && !live) return <div className="loading-state" data-testid="status-run-loading"><div className="skeleton" style={{ height: 20, width: '35%', marginBottom: 22 }} /><div className="skeleton" style={{ height: 150, width: '100%' }} /></div>;
  if (error && !live) return <div className="empty-state" data-testid="status-run-error">This run could not be loaded. <button className="nav-link" onClick={onRetry} data-testid="button-retry-run">Retry</button></div>;
  if (!live) return <div className="empty-state">No run data is available.</div>;
  const finalBrief = live.steps.find((step) => step.name === 'brief')?.output;
  const markdown = typeof finalBrief?.markdown === 'string' ? finalBrief.markdown : typeof finalBrief?.brief === 'string' ? finalBrief.brief : '';
  const teamValue = finalBrief?.team_message;
  const teamMessage = typeof teamValue === 'string' ? teamValue : Array.isArray(teamValue) ? teamValue.filter((line): line is string => typeof line === 'string').join('\n') : '';
  const statusClass = live.run.status === 'completed' ? 'complete' : live.run.status === 'failed' ? 'failed' : live.run.status === 'needs_input' ? 'needs-input' : '';
  const submitResume = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = resumeText.trim();
    if (!value) { setResumeError('Paste the advisory text to resume this run.'); return; }
    setResumeError('');
    resumeInput.mutate(
      { id: live.run.id, data: { input: value } },
      {
        onSuccess: (result) => {
          const updated = result as unknown as RunData;
          queryClient.setQueryData(getGetRunQueryKey(live.run.id), updated);
          queryClient.setQueryData(getGetLatestRunQueryKey(), (old: unknown) => {
            const current = old as RunData | undefined;
            return current?.run.id === live.run.id ? updated : old;
          });
          setResumeText('');
        },
        onError: (failure) => {
          const apiMessage = (failure as { data?: { error?: string } }).data?.error;
          setResumeError(apiMessage || 'The run could not be resumed. Try again.');
        },
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
  return <div className="run-content">
    <div className="page-heading">
      <div>
        <div className="eyebrow">Vulnerability assessment</div>
        <h1>{live.run.input.length > 70 ? `${live.run.input.slice(0, 70)}…` : live.run.input}</h1>
        <p>Live review trace and evidence summary</p>
        <div className="status-line"><span className={`live-dot ${statusClass}`} /><span>{live.run.status === 'completed' ? 'Review complete' : live.run.status === 'failed' ? 'Review failed' : live.run.status === 'needs_input' ? 'Needs advisory input' : 'Review in progress'}</span>{live.run.degraded && <span className="degraded-badge">Degraded</span>}</div>
      </div>
      {showId && <div className="run-id" data-testid="text-run-id">{live.run.id}</div>}
    </div>
    {live.run.status === 'needs_input' && <form className="resume-panel fade-in" onSubmit={submitResume} data-testid="form-resume-run">
      <div className="panel-head"><div><h2 className="panel-title">Paste the advisory to continue</h2><p className="panel-subtitle">NVD could not provide this CVE record. This resumes the same run at the fetch step.</p></div><span className="eyebrow">Input needed</span></div>
      <label className="input-label" htmlFor="resume-advisory-input">Advisory text</label>
      <textarea id="resume-advisory-input" className="input-control advisory-input" value={resumeText} onChange={(event) => { setResumeText(event.target.value); if (resumeError) setResumeError(''); }} maxLength={20000} placeholder="Paste the vendor advisory here…" data-testid="input-resume-advisory" />
      <div className="resume-footer"><span className="field-hint">{resumeText.length.toLocaleString()} / 20,000 characters</span><button className="submit-button" type="submit" disabled={resumeInput.isPending || !resumeText.trim()} data-testid="button-resume-run">{resumeInput.isPending ? 'Resuming…' : 'Resume this run'}</button></div>
      {resumeError && <div className="error-box" role="alert" data-testid="status-resume-error">{resumeError}</div>}
    </form>}
    <TraceGraph data={live} selectedSeq={selected} onSelect={(step) => setSelected((prev) => prev === step.seq ? null : step.seq)} connection={connection} retrying={retrying} retryRemainingMs={retryRemainingMs} />
    {(live.run.status === 'completed' || markdown) && <section className="brief-card">
      <div className="brief-head"><h2>Assessment brief</h2>{live.run.degraded && <span className="degraded-badge">Degraded output</span>}</div>
      <MarkdownBrief content={markdown} />
      {teamMessage && <section className="team-message" aria-labelledby="team-message-heading" data-testid="content-team-message">
        <div className="team-message-head"><h3 id="team-message-heading">Team message</h3><button type="button" className="copy-button" onClick={copyTeamMessage} data-testid="button-copy-team-message">{copyStatus}</button></div>
        <pre>{teamMessage}</pre>
      </section>}
    </section>}
  </div>;
}

function useRunStream(id: string, initial: RunData | undefined) {
  const [streamData, setStreamData] = useState<RunData | null>(initial || null);
  const [attemptEvent, setAttemptEvent] = useState<AttemptEvent | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting' | 'complete'>(() => initial && ['completed', 'failed'].includes(initial.run.status) ? 'complete' : 'connecting');
  const latest = useRef<RunData | null>(initial || null);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (initial) {
      latest.current = mergeRunData(latest.current, initial);
      setStreamData(latest.current);
      if (['completed', 'failed'].includes(latest.current.run.status)) setConnection('complete');
    }
  }, [initial]);
  useEffect(() => {
    if (attemptEvent?.phase !== 'retry_scheduled') return;
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [attemptEvent]);
  useEffect(() => {
    if (!id) return;
    if (latest.current && ['completed', 'failed'].includes(latest.current.run.status)) return;
    const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
    const ingest = (raw: string, kind: string) => {
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        if (kind === 'attempt') {
          const event = (payload.attempt || payload.data || payload) as AttemptEvent;
          if (event.phase === 'retry_scheduled') setAttemptEvent(event);
          else if (event.phase === 'started') {
            setAttemptEvent((current) => current?.stepName === event.stepName ? null : current);
          }
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
          const runUpdate = (payload.run || payload.data || payload) as Partial<Run>;
          incoming = { ...latest.current, run: { ...latest.current.run, ...runUpdate } };
        }
        if (incoming) {
          const merged = kind === 'snapshot'
            ? replaceFromSnapshot(latest.current, incoming)
            : mergeRunData(latest.current, incoming);
          latest.current = merged;
          setStreamData(merged);
          queryClient.setQueryData(getGetRunQueryKey(id), merged);
          queryClient.setQueryData(getGetLatestRunQueryKey(), (old: unknown) => {
            const value = old as RunData | undefined;
            return value?.run.id === id ? merged : old;
          });
          if (['completed', 'failed'].includes(merged.run.status)) {
            setConnection('complete');
            source.close();
          }
        }
      } catch {
        // Ignore malformed stream frames; EventSource will continue the connection.
      }
    };
    source.onopen = () => setConnection('connected');
    source.onerror = () => setConnection('reconnecting');
    source.onmessage = (event) => ingest(event.data, 'message');
    source.addEventListener('snapshot', (event) => ingest((event as MessageEvent).data, 'snapshot'));
    source.addEventListener('step', (event) => ingest((event as MessageEvent).data, 'step'));
    source.addEventListener('attempt', (event) => ingest((event as MessageEvent).data, 'attempt'));
    source.addEventListener('run', (event) => ingest((event as MessageEvent).data, 'run'));
    return () => source.close();
  }, [id, queryClient]);
  const remaining = attemptEvent?.phase === 'retry_scheduled'
    ? Math.max(0, (attemptEvent.retryInMs || 0) - (clock - Date.parse(attemptEvent.timestamp)))
    : 0;
  return { data: streamData, connection, attemptEvent, retryRemainingMs: remaining };
}

function RunPage() {
  const params = useParams<{ id: string }>();
  const id = params.id || '';
  const query = useGetRun(id, { query: { queryKey: getGetRunQueryKey(id), enabled: !!id, refetchOnWindowFocus: false } });
  const initial = query.data as unknown as RunData | undefined;
  const stream = useRunStream(id, initial);
  return <AppFrame><main className="page-wrap"><RunView initial={initial || null} data={stream.data} isLoading={query.isLoading} error={query.isError} onRetry={() => void query.refetch()} connection={stream.connection} retrying={stream.attemptEvent} retryRemainingMs={stream.retryRemainingMs} /></main></AppFrame>;
}

function ArchitectureDiagram() {
  return <div className="architecture-card">
    <div className="section-label"><span>Review path</span><span>Request / evidence / assessment</span></div>
    <svg className="architecture-svg" viewBox="0 0 900 300" role="img" aria-label="Architecture diagram showing browser, API server, runner, Postgres, advisory source, and LLM connected by arrows">
      <defs><marker id="arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="none" stroke="#728581" strokeWidth="1.2" /></marker></defs>
      <path className="arch-line" markerEnd="url(#arrowhead)" d="M190 102 H280" /><path className="arch-line" markerEnd="url(#arrowhead)" d="M435 102 H525" />
      <path className="arch-line" markerEnd="url(#arrowhead)" d="M360 135 V209 H278" /><path className="arch-line" markerEnd="url(#arrowhead)" d="M600 135 V207 H666" />
      <path className="arch-line dashed" markerEnd="url(#arrowhead)" d="M601 82 C650 35 715 35 750 82" /><path className="arch-line dashed" markerEnd="url(#arrowhead)" d="M750 113 C710 164 650 166 600 125" />
      <text x="222" y="91" className="arch-sub">REST / SSE</text><text x="467" y="91" className="arch-sub">enqueue</text>
      <text x="640" y="51" className="arch-sub">retrieve source</text><text x="663" y="154" className="arch-sub">assessment</text>
      <rect className="arch-box" x="35" y="73" rx="5" width="155" height="62" /><text className="arch-title" x="57" y="101">Browser</text><text className="arch-sub" x="57" y="120">Review UI · live trace</text>
      <rect className="arch-box primary" x="280" y="73" rx="5" width="155" height="62" /><text className="arch-title" x="302" y="101">API server</text><text className="arch-sub" x="302" y="120">Runs · events · state</text>
      <rect className="arch-box primary" x="525" y="73" rx="5" width="155" height="62" /><text className="arch-title" x="547" y="101">Runner</text><text className="arch-sub" x="547" y="120">Five ordered steps</text>
      <rect className="arch-box external" x="710" y="73" rx="5" width="155" height="62" /><text className="arch-title" x="732" y="101">Advisory source</text><text className="arch-sub" x="732" y="120">Public vulnerability data</text>
      <rect className="arch-box" x="183" y="207" rx="5" width="155" height="62" /><text className="arch-title" x="205" y="235">Postgres</text><text className="arch-sub" x="205" y="254">Runs · step evidence</text>
      <rect className="arch-box external" x="588" y="207" rx="5" width="155" height="62" /><text className="arch-title" x="610" y="235">LLM</text><text className="arch-sub" x="610" y="254">Assessment · brief</text>
    </svg>
    <div className="architecture-caption">
      <div className="caption-item"><strong>01 / Capture</strong><span>The browser submits an identifier or advisory with a fresh idempotency key.</span></div>
      <div className="caption-item"><strong>02 / Evaluate</strong><span>The runner records each stage as durable evidence and streams updates to the UI.</span></div>
      <div className="caption-item"><strong>03 / Review</strong><span>Findings and recommendations arrive as a brief alongside the complete run trace.</span></div>
    </div>
  </div>;
}

function HowItWorks() {
  const latest = useGetLatestRun({ query: { queryKey: getGetLatestRunQueryKey(), retry: false } });
  const latestData = latest.data as unknown as RunData | undefined;
  const stream = useRunStream(latestData?.run.id || '', latestData);
  return <AppFrame><main className="page-wrap">
    <div className="page-heading"><div><div className="eyebrow">System overview</div><h1>From advisory to evidence.</h1><p>A small, observable pipeline keeps each conclusion tied to its source.</p></div></div>
    <ArchitectureDiagram />
    <section className="latest-section">
      <h2>Latest run trace</h2>
      {latest.isLoading && <div className="loading-state" data-testid="status-latest-loading"><div className="skeleton" style={{ height: 155 }} /></div>}
      {latest.isError && <div className="empty-state" data-testid="status-latest-error">No latest run is available right now. <button className="nav-link" onClick={() => void latest.refetch()} data-testid="button-retry-latest">Try again</button></div>}
      {!latest.isLoading && !latest.isError && !latestData && <div className="empty-state">There are no runs to show yet. Start a review to see its live trace here.</div>}
      {latestData && <RunView initial={latestData} data={stream.data} isLoading={false} error={false} onRetry={() => void latest.refetch()} showId={false} connection={stream.connection} retrying={stream.attemptEvent} retryRemainingMs={stream.retryRemainingMs} />}
    </section>
    <div className="footer-note"><span>PATCHBRIEF / ARCHITECTURE</span><span>Every step leaves a record.</span></div>
  </main></AppFrame>;
}

function Router() {
  return <RoutedErrorBoundary><Switch>
    <Route path="/" component={Home} />
    <Route path="/run/:id" component={RunPage} />
    <Route path="/how-it-works" component={HowItWorks} />
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
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>;
}

export default App;
