import { type FormEvent, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListStackItemsQueryKey, unlockStackEditing, useAddStackItem, useDeleteStackItem, useListStackItems } from '@workspace/api-client-react';
import { describeApiError } from '@/lib/api-errors';
import { STACK_EDIT_SESSION_KEY, STACK_VERSION_MESSAGE, validStackVersion, verifyAndStoreStackKey } from '@/lib/stack-edit-session';

const MAX = 30;

export default function StackPage() {
  const qc = useQueryClient();
  const list = useListStackItems({ query: { queryKey: getListStackItemsQueryKey(), refetchInterval: 15000, refetchOnWindowFocus: true } });
  const [editKey, setEditKey] = useState('');
  const [candidate, setCandidate] = useState('');
  const [checking, setChecking] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const headers: Record<string, string> = editKey ? { Authorization: `Bearer ${editKey}` } : {};
  const add = useAddStackItem({ request: { headers } });
  const del = useDeleteStackItem({ request: { headers } });
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [error, setError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const items = list.data || [];
  const full = items.length >= MAX;
  const refresh = () => qc.invalidateQueries({ queryKey: getListStackItemsQueryKey() });
  const lock = () => {
    setEditKey('');
    setStorageNotice('');
    try { window.sessionStorage.removeItem(STACK_EDIT_SESSION_KEY); } catch { /* Remain read-only. */ }
  };
  const verify = (key: string) => unlockStackEditing({ headers: { Authorization: `Bearer ${key}` } });
  const message = (failure: unknown, fallback: string) =>
    (failure as { data?: { error?: string } })?.data?.error || describeApiError(failure, fallback);
  const checkWriteFailure = (failure: unknown) => {
    const status = (failure as { status?: number })?.status;
    if (status === 401 || status === 403 || status === 503 || status === 429) lock();
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const saved = window.sessionStorage.getItem(STACK_EDIT_SESSION_KEY);
        if (!saved) return;
        setChecking(true);
        await verify(saved);
        if (active) { setEditKey(saved); await refresh(); }
      } catch (failure) {
        try { window.sessionStorage.removeItem(STACK_EDIT_SESSION_KEY); } catch { /* Remain read-only. */ }
        if (active) setUnlockError(message(failure, 'The editing key could not be checked.'));
      } finally { if (active) setChecking(false); }
    })();
    return () => { active = false; };
  }, []);
  const unlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!candidate.trim() || checking) return;
    setChecking(true); setUnlockError('');
    try {
      const accepted = await verifyAndStoreStackKey(window.sessionStorage, candidate, verify);
      setEditKey(accepted.key); setCandidate('');
      setStorageNotice(accepted.persisted ? '' : 'Editing is unlocked for this page only. Browser session storage is unavailable; unlock again after leaving this page.');
      setError(''); setDeleteError('');
      add.reset(); del.reset();
      await refresh();
    } catch (failure) {
      setUnlockError(message(failure, 'Editing could not be unlocked. Check the key and try again.'));
      setCandidate('');
    } finally { setChecking(false); }
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editKey) return;
    const n = name.trim(); const v = version.trim();
    if (!n) return setError('Enter a software name.');
    if (n.length > 80) return setError('Name must be 80 characters or fewer.');
    if (!validStackVersion(v)) return setError(STACK_VERSION_MESSAGE);
    if (full) return setError(`The stack holds at most ${MAX} items. Remove one first.`);
    if (items.some((i) => i.name.toLowerCase() === n.toLowerCase() && i.version === v)) return setError('That name and version is already in the stack.');
    setError('');
    add.mutate({ data: { name: n, version: v } }, {
      onSuccess: () => { setName(''); setVersion(''); void refresh(); },
      onError: (f) => { checkWriteFailure(f); setError(message(f, 'The item could not be added.')); void refresh(); },
    });
  };

  return <main className="page-wrap stack-page">
    <div className="page-heading"><div>
      <h1>My stack</h1>
      <p>The software and versions the assess step checks advisories against.</p>
    </div></div>
    <div className="shared-note" data-testid="text-shared-note">This is the list the app checks advisories against. Only the owner can edit it.</div>
    {editKey ? <div className="stack-edit-controls"><span>Editing unlocked for this tab</span><button type="button" className="nav-link" onClick={lock} data-testid="button-lock-stack">Lock</button></div>
      : <form className="stack-unlock" onSubmit={(event) => { void unlock(event); }} data-testid="form-unlock-stack">
        <label><span className="input-label">Unlock editing</span><input type="password" className="input-control" value={candidate}
          autoComplete="current-password" onChange={(event) => { setCandidate(event.target.value); setUnlockError(''); }}
          placeholder="Owner editing key" aria-describedby={unlockError ? 'stack-unlock-error' : undefined} data-testid="input-stack-edit-key" /></label>
        <button type="submit" className="copy-button" disabled={checking || !candidate.trim()} data-testid="button-unlock-stack">{checking ? 'Checking…' : 'Unlock'}</button>
      </form>}
    {unlockError && <div id="stack-unlock-error" className="error-box" role="alert">{unlockError}</div>}
    {storageNotice && <p className="field-hint" role="status">{storageNotice}</p>}
    {editKey && <form className="form-panel stack-form" onSubmit={submit} data-testid="form-add-stack">
      <label><span className="input-label">Name</span><input className="input-control" value={name} onChange={(e) => { setName(e.target.value); setError(''); }} placeholder="lodash" data-testid="input-stack-name" /></label>
      <label><span className="input-label">Version</span><input className="input-control" value={version} onChange={(e) => { setVersion(e.target.value); setError(''); }} placeholder="4.17.20" data-testid="input-stack-version" /></label>
      <button className="submit-button" type="submit" disabled={add.isPending || full} data-testid="button-add-stack">{add.isPending ? 'Adding…' : 'Add item'}</button>
    </form>}
    <p className="field-hint" data-testid="text-stack-count">{items.length} / {MAX} items{full ? '. The stack is full; remove an item to add another.' : ''}</p>
    {error && <div className="error-box" role="alert" data-testid="status-stack-error">{error}</div>}
    {deleteError && <div className="error-box" role="alert" data-testid="status-stack-delete-error">{deleteError}</div>}
    <section className="stack-list-card">
      {list.isLoading && <div className="skeleton" style={{ height: 120 }} />}
      {list.isError && <div className="empty-state" data-testid="status-stack-load-error">The stack could not be loaded. <button className="nav-link" onClick={() => void list.refetch()} data-testid="button-retry-stack">Retry</button></div>}
      {list.data && items.length === 0 && <div className="empty-state" data-testid="text-stack-empty">The stack is empty. Add the software you run so assessments can match affected versions.</div>}
      {items.length > 0 && <ul className="stack-list">
        {items.map((i) => <li key={i.id} className="stack-row" data-testid={`row-stack-${i.id}`}>
          <span className="stack-name">{i.name}</span><span className="stack-version">{i.version}</span>
           {editKey && <button type="button" className="remove-fault" disabled={del.isPending && del.variables?.id === i.id}
             onClick={() => { setDeleteError(''); del.mutate({ id: i.id }, { onSuccess: () => void refresh(), onError: (f) => { checkWriteFailure(f); setDeleteError(message(f, `Could not remove ${i.name}.`)); void refresh(); } }); }}
             data-testid={`button-remove-stack-${i.id}`}>{del.isPending && del.variables?.id === i.id ? 'Removing…' : 'Remove'}</button>}
        </li>)}
      </ul>}
    </section>
  </main>;
}
