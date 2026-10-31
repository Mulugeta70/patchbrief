// Reads the customFetch error shape ({ status, data: { error } }) and returns an actionable message.
export function describeApiError(failure: unknown, fallback: string): string {
  const err = failure as { status?: number; data?: unknown; name?: string; message?: string } | null;
  const data = err?.data as { error?: unknown; message?: unknown } | null | undefined;
  const apiMessage = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : '';
  const status = typeof err?.status === 'number' ? err.status : undefined;
  if (status === 413) return `Your text is too large for the server to accept${apiMessage ? ` (${apiMessage})` : ''}. Shorten it to under 20,000 characters and submit again. Your text has been kept.`;
  if (status === 429) return `Too many requests right now${apiMessage ? ` (${apiMessage})` : ''}. Wait a minute, then submit again. Your text has been kept.`;
  if (status === 400 || status === 422) return `${apiMessage || 'The server rejected the input.'} Fix the input and submit again. Your text has been kept.`;
  if (status && status >= 500) return `${apiMessage || `The server failed (HTTP ${status}).`} Try again shortly. Your text has been kept.`;
  if (status) return `${apiMessage || fallback} Your text has been kept.`;
  if (err instanceof TypeError || /fetch|network/i.test(err?.message || '')) return 'Could not reach the server. Check your connection and submit again. Your text has been kept.';
  return apiMessage || fallback;
}
