import { Link } from 'wouter';
import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { getRun } from '@workspace/api-client-react';
import { BROWSER_RUNS_CHANGED, BROWSER_RUNS_KEY, readBrowserRunIds, recentRunTitle } from '../lib/browser-runs';

const STATUS: Record<string, string> = { queued: 'queued', running: 'running', needs_input: 'needs input', completed: 'done', failed: 'failed' };

export function RecentRuns() {
  const readHistory = () => {
    try { return { ids: readBrowserRunIds(window.localStorage), error: '' }; }
    catch { return { ids: [] as string[], error: 'Browser storage is unavailable or invalid. Recent runs cannot be loaded from this browser.' }; }
  };
  const [history, setHistory] = useState(readHistory);
  useEffect(() => {
    const refresh = () => setHistory(readHistory());
    const onStorage = (event: StorageEvent) => {
      if (event.key === BROWSER_RUNS_KEY || event.key === null) refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(BROWSER_RUNS_CHANGED, refresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(BROWSER_RUNS_CHANGED, refresh);
    };
  }, []);
  const queries = useQueries({ queries: history.ids.map((id) => ({
    queryKey: ['browser-recent-run', id],
    queryFn: async ({ signal }: { signal: AbortSignal }) => (await getRun(id, { signal })).run,
    refetchInterval: 15000, refetchOnWindowFocus: true, retry: false,
  })) });
  const runs = queries.flatMap((query) => query.data ? [query.data] : [])
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const loading = queries.some((query) => query.isPending);
  const failed = queries.some((query) => query.isError);
  return <section className="recent-runs" data-testid="section-recent-runs">
    <div className="section-label"><span>Recent runs</span><span>Latest 10 from this browser</span></div>
    {loading && <div className="skeleton" style={{ height: 120 }} />}
    {history.error && <div className="empty-state" role="status">{history.error}</div>}
    {failed && <div className="empty-state" data-testid="status-recent-error">Some recent runs could not be loaded. <button className="nav-link" onClick={() => queries.forEach((query) => void query.refetch())} data-testid="button-retry-recent">Retry</button></div>}
    {!history.error && !history.ids.length && <div className="empty-state" data-testid="text-no-runs">No runs from this browser yet. Start one above.</div>}
    {runs.length > 0 && <ul className="recent-list">
      {runs.map((r) => <li key={r.id}>
        <Link href={`/run/${encodeURIComponent(r.id)}`} className="recent-row" data-testid={`link-run-${r.id}`}>
          <span className="recent-input">{recentRunTitle(r.input)}</span>
          <span className={`recent-status ${r.status}`}>{STATUS[r.status] || r.status}{r.degraded ? ' / degraded' : ''}</span>
          <span className="recent-time">{new Date(r.createdAt).toLocaleString()}</span>
        </Link>
      </li>)}
    </ul>}
  </section>;
}
