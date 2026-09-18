'use strict';

/** Classic token bucket: `capacity` burst, refilled continuously. */
class TokenBucket {
  constructor(capacity, refillPerSecond, now = Date.now()) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.tokens = capacity;
    this.updatedAt = now;
  }

  refill(now) {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.updatedAt = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
  }

  take(cost = 1, now = Date.now()) {
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  msUntil(cost = 1, now = Date.now()) {
    this.refill(now);
    if (this.tokens >= cost) return 0;
    return Math.ceil((cost - this.tokens) / this.refillPerMs);
  }
}

/** Token buckets keyed by IP, participant, room, etc., with bounded memory. */
class KeyedRateLimiter {
  constructor({ capacity, refillPerSecond, maxKeys = 50000 }) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.maxKeys = maxKeys;
    this.fullRefillMs = (capacity / refillPerSecond) * 1000;
    this.buckets = new Map();
  }

  bucket(key, now) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      bucket = new TokenBucket(this.capacity, this.refillPerSecond, now);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  take(key, cost = 1, now = Date.now()) {
    return this.bucket(key, now).take(cost, now);
  }

  retryAfterMs(key, cost = 1, now = Date.now()) {
    return this.bucket(key, now).msUntil(cost, now);
  }

  // A bucket that has had time to refill completely holds no information.
  prune(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= this.fullRefillMs) this.buckets.delete(key);
    }
    while (this.buckets.size >= this.maxKeys) {
      this.buckets.delete(this.buckets.keys().next().value);
    }
  }
}

/** At most `limit` hits in any rolling `windowMs` (used for AI spend caps). */
class SlidingWindowCounter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = [];
  }

  tryHit(now = Date.now()) {
    while (this.hits.length && now - this.hits[0] >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}

function rateLimitMiddleware(limiter, { key = (req) => req.ip, message = 'Too many requests. Please slow down.' } = {}) {
  return (req, res, next) => {
    const k = key(req);
    if (limiter.take(k)) return next();
    const seconds = Math.max(1, Math.ceil(limiter.retryAfterMs(k) / 1000));
    res.set('Retry-After', String(seconds));
    res.status(429).json({ error: message });
  };
}

module.exports = { TokenBucket, KeyedRateLimiter, SlidingWindowCounter, rateLimitMiddleware };
