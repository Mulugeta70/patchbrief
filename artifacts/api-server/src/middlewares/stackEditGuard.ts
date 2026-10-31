import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export function createStackEditGuard(
  readKey = () => process.env.STACK_EDIT_KEY,
  clock = Date.now,
): RequestHandler {
  const failures = new Map<string, { count: number; resetAt: number }>();
  const windowMs = 15 * 60_000;
  const maxFailures = 5;
  return (req, res, next) => {
    const expected = readKey()?.trim();
    if (!expected) {
      res.status(503).json({ error: "Stack editing is not configured. Add STACK_EDIT_KEY in Secrets." });
      return;
    }
    const now = clock();
    for (const [ip, entry] of failures) if (entry.resetAt <= now) failures.delete(ip);
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const previous = failures.get(ip);
    if (previous && previous.count >= maxFailures) {
      const seconds = Math.max(1, Math.ceil((previous.resetAt - now) / 1000));
      res.set("Retry-After", String(seconds)).status(429).json({
        error: `Too many unlock attempts. Try again in ${seconds} seconds.`,
      });
      return;
    }
    const authorization = req.get("Authorization") ?? "";
    const supplied = /^Bearer /i.test(authorization) ? authorization.slice(7).trim() : "";
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!supplied || !timingSafeEqual(digest(supplied), digest(expected))) {
      failures.set(ip, { count: (previous?.count ?? 0) + 1, resetAt: previous?.resetAt ?? now + windowMs });
      res.status(401).json({ error: "Editing key was not accepted." });
      return;
    }
    failures.delete(ip);
    next();
  };
}

// Shared by unlock and both write endpoints, so guessing a key directly on
// POST/DELETE cannot bypass the failed-attempt limit.
export const requireStackEditKey = createStackEditGuard();
