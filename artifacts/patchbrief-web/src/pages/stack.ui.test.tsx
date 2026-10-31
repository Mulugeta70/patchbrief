import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StackPage from './stack';
import { STACK_EDIT_SESSION_KEY } from '../lib/stack-edit-session';

const ownerKey = 'test-owner-key';
let stored: { id: string; name: string; version: string }[];
let requests: { method: string; path: string; authorization: string | null }[];
let client: QueryClient;

beforeEach(() => {
  sessionStorage.clear();
  stored = [{ id: 'one', name: 'express', version: '4.17.20' }];
  requests = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method || 'GET';
    const authorization = new Headers(init?.headers).get('Authorization');
    requests.push({ method, path, authorization });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    if (method === 'GET' && path === '/api/stack') return json(stored);
    if (authorization !== `Bearer ${ownerKey}`) return json({ error: 'Editing key was not accepted.' }, 401);
    if (path === '/api/stack/unlock') return new Response(null, { status: 204 });
    if (method === 'DELETE') {
      stored = stored.filter(item => item.id !== path.split('/').pop());
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && path === '/api/stack') {
      const item = { id: 'added', ...JSON.parse(String(init?.body)) };
      stored.push(item);
      return json(item, 201);
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  }));
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function showPage() {
  return render(<QueryClientProvider client={client}><StackPage /></QueryClientProvider>);
}

async function unlock(user: ReturnType<typeof userEvent.setup>, key = ownerKey) {
  await user.type(screen.getByTestId('input-stack-edit-key'), key);
  await user.click(screen.getByTestId('button-unlock-stack'));
}

test('remove, lock, unlock reloads server items and permits editing again without lock changing stored items', async () => {
  const user = userEvent.setup();
  showPage();
  await screen.findByText('express');
  await unlock(user);
  await screen.findByTestId('form-add-stack');
  await user.click(screen.getByTestId('button-remove-stack-one'));
  await waitFor(() => expect(screen.queryByText('express')).toBeNull());
  const requestsBeforeLock = requests.length;
  await user.click(screen.getByTestId('button-lock-stack'));
  expect(sessionStorage.getItem(STACK_EDIT_SESSION_KEY)).toBeNull();
  expect(screen.queryByTestId('form-add-stack')).toBeNull();
  expect(requests.slice(requestsBeforeLock).filter(r => r.method !== 'GET')).toEqual([]);
  expect(stored).toEqual([]);

  // Simulate another tab updating the shared server list while this tab is locked.
  stored.push({ id: 'remote', name: 'postgres', version: '15.1' });
  const readsBeforeUnlock = requests.filter(r => r.method === 'GET').length;
  await unlock(user);
  await screen.findByTestId('form-add-stack');
  expect(sessionStorage.getItem(STACK_EDIT_SESSION_KEY)).toBe(ownerKey);
  await waitFor(() => expect(requests.filter(r => r.method === 'GET').length).toBeGreaterThan(readsBeforeUnlock));
  await screen.findByTestId('button-remove-stack-remote');
  await user.type(screen.getByTestId('input-stack-name'), 'lodash');
  await user.type(screen.getByTestId('input-stack-version'), '4.17.21');
  await user.click(screen.getByTestId('button-add-stack'));
  await screen.findByText('lodash');
  await user.click(screen.getByTestId('button-remove-stack-added'));
  await waitFor(() => expect(screen.queryByText('lodash')).toBeNull());
  expect(stored.map(item => item.name)).toEqual(['postgres']);

  const savedItems = structuredClone(stored);
  await user.click(screen.getByTestId('button-lock-stack'));
  expect(stored).toEqual(savedItems);
  expect(screen.queryAllByText('Remove')).toHaveLength(0);
  await unlock(user, 'wrong-key');
  expect((await screen.findByRole('alert')).textContent).toContain('Editing key was not accepted.');
  expect(sessionStorage.getItem(STACK_EDIT_SESSION_KEY)).toBeNull();
  expect(screen.queryByTestId('form-add-stack')).toBeNull();
  await unlock(user);
  await screen.findByTestId('form-add-stack');
  await screen.findByTestId('button-remove-stack-remote');
});

test('accepted unlock restores editing after lock even when sessionStorage cannot save the key', async () => {
  const user = userEvent.setup();
  showPage();
  await screen.findByText('express');
  await unlock(user);
  await screen.findByTestId('form-add-stack');
  await user.click(screen.getByTestId('button-remove-stack-one'));
  await waitFor(() => expect(screen.queryByText('express')).toBeNull());
  await user.click(screen.getByTestId('button-lock-stack'));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage unavailable', 'QuotaExceededError');
  });
  await unlock(user);
  await screen.findByTestId('form-add-stack');
  expect(sessionStorage.getItem(STACK_EDIT_SESSION_KEY)).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('this page only');
  await user.type(screen.getByTestId('input-stack-name'), 'lodash');
  await user.type(screen.getByTestId('input-stack-version'), '4.17.21');
  await user.click(screen.getByTestId('button-add-stack'));
  await screen.findByText('lodash');
});
