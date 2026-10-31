import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListStackItemsQueryKey, useAddStackItem, useDeleteStackItem, useListStackItems } from '@workspace/api-client-react';
import { describeApiError } from '@/lib/api-errors';

const MAX = 30;

export default function StackPage() {
  const qc = useQueryClient();
  const list = useListStackItems({ query: { queryKey: getListStackItemsQueryKey(), refetchInterval: 15000, refetchOnWindowFocus: true } });
  const add = useAddStackItem();
  const del = useDeleteStackItem();
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [error, setError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const items = list.data || [];
  const full = items.length >= MAX;
  const refresh = () => qc.invalidateQueries({ queryKey: getListStackItemsQueryKey() });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const n = name.trim(); const v = version.trim();
    if (!n) return setError('Enter a software name.');
    if (n.length > 80) return setError('Name must be 80 characters or fewer.');
    if (!v) return setError('Enter a version, for example 4.17.20.');
    if (v.length > 50) return setError('Version must be 50 characters or fewer.');
    if (full) return setError(`The stack holds at most ${MAX} items. Remove one first.`);
    if (items.some((i) => i.name.toLowerCase() === n.toLowerCase() && i.version === v)) return setError('That name and version is already in the stack.');
    setError('');
    add.mutate({ data: { name: n, version: v } }, {
      onSuccess: () => { setName(''); setVersion(''); void refresh(); },
      onError: (f) => { setError(describeApiError(f, 'The item could not be added.')); void refresh(); },
    });
  };

  return <main className="page-wrap stack-page">
    <div className="page-heading"><div>
      <div className="eyebrow">Assessed against every run</div>
      <h1>My stack</h1>
      <p>The software and versions the assess step checks advisories against.</p>
    </div></div>
    <div className="shared-note" data-testid="text-shared-note">This is one shared, app-wide stack. There are no accounts: anyone using this app sees and edits the same list, and changes show on every device.</div>
    <form className="form-panel stack-form" onSubmit={submit} data-testid="form-add-stack">
      <label><span className="input-label">Name</span><input className="input-control" value={name} onChange={(e) => { setName(e.target.value); setError(''); }} placeholder="lodash" data-testid="input-stack-name" /></label>
      <label><span className="input-label">Version</span><input className="input-control" value={version} onChange={(e) => { setVersion(e.target.value); setError(''); }} placeholder="4.17.20" data-testid="input-stack-version" /></label>
      <button className="submit-button" type="submit" disabled={add.isPending || full} data-testid="button-add-stack">{add.isPending ? 'Adding…' : 'Add item'}</button>
    </form>
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
          <button type="button" className="remove-fault" disabled={del.isPending && del.variables?.id === i.id}
            onClick={() => { setDeleteError(''); del.mutate({ id: i.id }, { onSuccess: () => void refresh(), onError: (f) => { setDeleteError(describeApiError(f, `Could not remove ${i.name}.`)); void refresh(); } }); }}
            data-testid={`button-remove-stack-${i.id}`}>{del.isPending && del.variables?.id === i.id ? 'Removing…' : 'Remove'}</button>
        </li>)}
      </ul>}
    </section>
  </main>;
}
