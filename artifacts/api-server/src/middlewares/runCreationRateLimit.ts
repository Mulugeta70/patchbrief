import type { NextFunction, Request, Response } from "express";

const WINDOW_MS = 60_000;
const MAX_RUNS_PER_WINDOW = 5;
const requestsByIp = new Map<string, { count: number; resetAt: number }>();

export function runCreationRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  for (const [key, window] of requestsByIp) {
    if (window.resetAt <= now) requestsByIp.delete(key);
  }

  const current = requestsByIp.get(ip);
  if (!current || current.resetAt <= now) {
    requestsByIp.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  if (current.count >= MAX_RUNS_PER_WINDOW) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((current.resetAt - now) / 1000),
    );
    res.set("Retry-After", String(retryAfterSeconds)).status(429).json({
      error: `Run creation is limited to ${MAX_RUNS_PER_WINDOW} requests per minute per IP. Try again in ${retryAfterSeconds} seconds.`,
    });
    return;
  }

  current.count += 1;
  next();
}
