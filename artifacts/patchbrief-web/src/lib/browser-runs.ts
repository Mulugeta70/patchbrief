export const BROWSER_RUNS_KEY = 'patchbrief.browser-run-ids';
export const BROWSER_RUNS_CHANGED = 'patchbrief-browser-runs-changed';
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RunStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readBrowserRunIds(storage: RunStorage): string[] {
  const raw = storage.getItem(BROWSER_RUNS_KEY);
  if (!raw) return [];
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values)) throw new Error('Invalid browser run history.');
  return [...new Set(values.filter((id): id is string => typeof id === 'string' && RUN_ID.test(id)))].slice(0, 10);
}

// Only the successful create-run callback calls this, never a replay visit.
export function rememberBrowserRun(storage: RunStorage, id: string) {
  if (!RUN_ID.test(id)) throw new Error('Invalid run id.');
  const ids = [id, ...readBrowserRunIds(storage).filter((saved) => saved !== id)].slice(0, 10);
  storage.setItem(BROWSER_RUNS_KEY, JSON.stringify(ids));
}

export function recentRunTitle(input: string) {
  const value = input.trim();
  return /^CVE-\d{4}-\d{4,}$/i.test(value) ? value.toUpperCase() : 'Pasted advisory';
}

export function runTitle(input: string) {
  const title = recentRunTitle(input);
  return { title, preview: title === 'Pasted advisory' ? Array.from(input).slice(0, 80).join('') : null };
}
