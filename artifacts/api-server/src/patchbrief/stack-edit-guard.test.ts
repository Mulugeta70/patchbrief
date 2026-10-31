import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { createStackEditGuard } from "../middlewares/stackEditGuard";
import { isDottedVersion } from "./stackValidation";

async function guardServer(readKey: () => string | undefined, clock?: () => number) {
  const app = express();
  const guard = createStackEditGuard(readKey, clock);
  let writes = 0;
  app.get("/stack", (_req, res) => { res.json([]); });
  app.post("/stack/unlock", guard, (_req, res) => { res.status(204).end(); });
  app.post("/stack", guard, (_req, res) => { writes++; res.status(204).end(); });
  app.delete("/stack/item", guard, (_req, res) => { writes++; res.status(204).end(); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    writes: () => writes,
    request: (path: string, method = "GET", key?: string) => fetch(base + path, {
      method, headers: key ? { Authorization: `Bearer ${key}` } : {},
    }),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("unconfigured stack editing fails closed while read-only access stays public", async () => {
  const server = await guardServer(() => undefined);
  try {
    assert.equal((await server.request("/stack")).status, 200);
    for (const [path, method] of [["/stack", "POST"], ["/stack/item", "DELETE"], ["/stack/unlock", "POST"]]) {
      assert.equal((await server.request(path, method, "anything")).status, 503);
    }
    assert.equal(server.writes(), 0);
  } finally { await server.close(); }
});

test("unlock and every stack mutation require the correct owner key, including after unlock", async () => {
  const server = await guardServer(() => "test-owner");
  try {
    assert.equal((await server.request("/stack", "POST")).status, 401);
    assert.equal((await server.request("/stack/item", "DELETE", "incorrect")).status, 401);
    assert.equal((await server.request("/stack/unlock", "POST", "incorrect")).status, 401);
    assert.equal(server.writes(), 0);
    assert.equal((await server.request("/stack/unlock", "POST", "test-owner")).status, 204);
    assert.equal((await server.request("/stack", "POST", "test-owner")).status, 204);
    assert.equal((await server.request("/stack/item", "DELETE", "test-owner")).status, 204);
    assert.equal((await server.request("/stack", "POST")).status, 401, "Unlock is not an IP/session bypass");
    assert.equal(server.writes(), 2);
  } finally { await server.close(); }
});

test("failed unlocks are rate-limited across unlock, POST and DELETE and expire after cooldown", async () => {
  let now = 1_000;
  const server = await guardServer(() => "test-owner", () => now);
  try {
    for (let i = 0; i < 5; i++) assert.equal((await server.request("/stack/unlock", "POST", "wrong")).status, 401);
    for (const [path, method] of [["/stack/unlock", "POST"], ["/stack", "POST"], ["/stack/item", "DELETE"]]) {
      const response = await server.request(path, method, "test-owner");
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("Retry-After"), "900");
    }
    assert.equal(server.writes(), 0);
    now += 900_001;
    assert.equal((await server.request("/stack/unlock", "POST", "test-owner")).status, 204);
    assert.equal((await server.request("/stack", "POST", "test-owner")).status, 204);
  } finally { await server.close(); }
});

test("key rotation immediately rejects a previously accepted key", async () => {
  let key = "first-test-key";
  const server = await guardServer(() => key);
  try {
    assert.equal((await server.request("/stack/unlock", "POST", key)).status, 204);
    key = "second-test-key";
    assert.equal((await server.request("/stack", "POST", "first-test-key")).status, 401);
    assert.equal((await server.request("/stack", "POST", key)).status, 204);
  } finally { await server.close(); }
});

test("installed versions must have at least two dotted numeric parts", () => {
  for (const value of ["18.19", "4.17.20", "15.0", "4.0.30319.42000"]) assert.equal(isDottedVersion(value), true);
  for (const value of ["18", "15", "v18.19", "1.2-beta", "1.", ".1", ">=1.2.3", ""]) assert.equal(isDottedVersion(value), false);
});
