// src/middleware/rateLimit.js

/**
 * Simple in-memory rate limiter (per key).
 * Good for single-instance deployments.
 * If you scale horizontally, you'd want Redis-based limiter later.
 */

export const createRateLimiter = ({
  windowMs = 60_000,
  max = 5,
  keyFn = (req) => req.user?.user_id || req.ip,
  message = "Too many requests. Please try again later.",
} = {}) => {
  const hits = new Map(); // key -> { count, resetAt }

  // cleanup occasionally to avoid memory growth
  const cleanup = () => {
    const now = Date.now();
    for (const [k, v] of hits.entries()) {
      if (v.resetAt <= now) hits.delete(k);
    }
  };

  let reqCount = 0;

  return (req, res, next) => {
    reqCount++;
    if (reqCount % 200 === 0) cleanup();

    const now = Date.now();
    const key = String(keyFn(req));
    if (!key) return next();

    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", String(max - 1));
      return next();
    }

    if (entry.count >= max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", "0");
      return res.status(429).json({ error: message });
    }

    entry.count += 1;
    hits.set(key, entry);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(max - entry.count));
    return next();
  };
};
