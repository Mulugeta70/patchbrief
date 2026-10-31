import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_RUNS_KEY, readBrowserRunIds, rememberBrowserRun, recentRunTitle, runTitle } from './browser-runs';

function browserStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('browser history is empty for a fresh browser and isolated from other browsers', () => {
  const a = browserStorage(), b = browserStorage();
  assert.deepEqual(readBrowserRunIds(a), []);
  rememberBrowserRun(a, id(1));
  assert.deepEqual(readBrowserRunIds(a), [id(1)]);
  assert.deepEqual(readBrowserRunIds(b), []);
  rememberBrowserRun(b, id(2));
  assert.deepEqual(readBrowserRunIds(a), [id(1)]);
  assert.deepEqual(readBrowserRunIds(b), [id(2)]);
  assert.equal(a.getItem(BROWSER_RUNS_KEY), JSON.stringify([id(1)]), 'Store IDs only, no advisory text');
});

test('run titles use a generic pasted heading and only an 80-character preview', () => {
  const input = 'Private pasted advisory '.repeat(10);
  assert.deepEqual(runTitle(input), { title: 'Pasted advisory', preview: input.slice(0, 80) });
  assert.deepEqual(runTitle('cve-2024-3094'), { title: 'CVE-2024-3094', preview: null });
  assert.equal(runTitle('Short text').preview, 'Short text');
});

test('browser history survives rereads, deduplicates IDs, and retains the latest ten', () => {
  const storage = browserStorage();
  for (let n = 1; n <= 12; n++) rememberBrowserRun(storage, id(n));
  rememberBrowserRun(storage, id(11));
  const ids = readBrowserRunIds(storage);
  assert.equal(ids.length, 10);
  assert.equal(ids[0], id(11));
  assert.equal(new Set(ids).size, 10);
  assert.ok(!ids.includes(id(1)));
  assert.deepEqual(readBrowserRunIds(storage), ids);
});

test('only valid saved IDs are eligible for recent-run fetches; unavailable storage fails closed', () => {
  const storage = browserStorage();
  storage.setItem(BROWSER_RUNS_KEY, JSON.stringify([id(1), '../runs', 'private pasted text', id(1), null]));
  assert.deepEqual(readBrowserRunIds(storage), [id(1)]);
  assert.throws(() => rememberBrowserRun(storage, 'invalid'));
  storage.setItem(BROWSER_RUNS_KEY, 'broken JSON');
  assert.throws(() => readBrowserRunIds(storage));
  assert.throws(() => readBrowserRunIds({ getItem() { throw new Error('Blocked'); }, setItem() {} }));
});

test('recent-run titles never expose pasted advisory text, even when it contains a CVE', () => {
  assert.equal(recentRunTitle(' cve-2024-3094 '), 'CVE-2024-3094');
  for (const input of ['Private customer advisory', 'CVE-2024-3094: private details',
    '<script>alert(1)</script>', '', 'CVE-2024-3094\nconfidential note']) {
    assert.equal(recentRunTitle(input), 'Pasted advisory');
  }
});
