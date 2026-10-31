import { Link } from 'wouter';
import { useListRecentRuns, getListRecentRunsQueryKey } from '@workspace/api-client-react';

const STATUS: Record<string, string> = { queued: 'queued', running: 'running', needs_input: 'needs input', completed: 'done', failed: 'failed' };

export function RecentRuns() {
  const q = useListRecentRuns({ query: { queryKey: getListRecentRunsQueryKey(), refetchInterval: 15000, refetchOnWindowFocus: true } });
  return <section className="recent-runs" data-testid="section-recent-runs">
    <div className="section-label"><span>Recent runs</span><span>Latest 10, shared</span></div>
    {q.isLoading && <div className="skeleton" style={{ height: 120 }} />}
    {q.isError && <div className="empty-state" data-testid="status-recent-error">Recent runs could not be loaded. <button className="nav-link" onClick={() => void q.refetch()} data-testid="button-retry-recent">Retry</button></div>}
    {q.data && q.data.length === 0 && <div className="empty-state" data-testid="text-no-runs">No runs yet. Start one above.</div>}
    {q.data && q.data.length > 0 && <ul className="recent-list">
      {q.data.slice(0, 10).map((r) => <li key={r.id}>
        <Link href={`/run/${encodeURIComponent(r.id)}`} className="recent-row" data-testid={`link-run-${r.id}`}>
          <span className="recent-input">{r.input.replace(/\s+/g, ' ').slice(0, 90)}{r.input.length > 90 ? '…' : ''}</span>
          <span className={`recent-status ${r.status}`}>{STATUS[r.status] || r.status}{r.degraded ? ' / degraded' : ''}</span>
          <span className="recent-time">{new Date(r.createdAt).toLocaleString()}</span>
        </Link>
      </li>)}
    </ul>}
  </section>;
}
