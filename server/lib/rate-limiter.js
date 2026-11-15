// server/lib/rate-limiter.js
const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 10 } = {}) {
  return (req, res, next) => {
    const key = req.sessionToken || req.ip;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    next();
  };
}

// Evict stale buckets every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now > b.resetAt + 120_000) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();