import test from 'node:test';
import assert from 'node:assert/strict';
import { STACK_EDIT_SESSION_KEY, verifyAndStoreStackKey, validStackVersion } from './stack-edit-session';

test('editing key is written to session storage only after server acceptance', async () => {
  const calls: string[] = [];
  const storage = { setItem(key: string, value: string) {
    assert.equal(key, STACK_EDIT_SESSION_KEY);
    assert.equal(value, 'test-key');
    calls.push('stored');
  } };
  const accepted = await verifyAndStoreStackKey(storage, 'test-key', async () => { calls.push('accepted'); });
  assert.deepEqual(accepted, { key: 'test-key', persisted: true });
  assert.deepEqual(calls, ['accepted', 'stored']);
});

test('rejected editing keys are never written to browser storage', async () => {
  let writes = 0;
  await assert.rejects(verifyAndStoreStackKey({ setItem() { writes++; } }, 'wrong', async () => {
    throw new Error('401');
  }));
  assert.equal(writes, 0);
});

test('stack form validates dotted versions with at least two numeric parts', () => {
  assert.equal(validStackVersion('18.19'), true);
  assert.equal(validStackVersion('4.17.20'), true);
  for (const version of ['18', '15', '4.17-beta', '', '>=1.2.3']) assert.equal(validStackVersion(version), false);
});
