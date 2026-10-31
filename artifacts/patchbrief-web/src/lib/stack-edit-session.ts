export const STACK_EDIT_SESSION_KEY = 'patchbrief.stack-edit-key';
export const STACK_VERSION_MESSAGE = 'Use a full version, like 18.19.1';
export function validStackVersion(version: string) {
  return version.length <= 50 && /^\d+(?:\.\d+)+$/.test(version);
}

// Verification must finish before writing any candidate to browser storage.
export async function verifyAndStoreStackKey(
  storage: Pick<Storage, 'setItem'>,
  candidate: string,
  verify: (key: string) => Promise<unknown>,
) {
  const key = candidate.trim();
  await verify(key);
  try {
    storage.setItem(STACK_EDIT_SESSION_KEY, key);
    return { key, persisted: true };
  } catch {
    // A browser storage failure must not turn server acceptance into a failed
    // unlock. Keep the accepted key in component memory and disclose the limit.
    return { key, persisted: false };
  }
}
