import { systemClock, type Clock, type RateLimiter } from "../graph/deps.js";

export interface SlidingWindowOptions {
  /** Messages allowed per window and key. Default 8. */
  max?: number;
  /** Window length in ms. Default 30 seconds. */
  windowMs?: number;
  clock?: Clock;
}

/** In-memory sliding window per key (thread). Enough for a single agent instance. */
export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly clock: Clock;

  constructor(o: SlidingWindowOptions = {}) {
    this.max = o.max ?? 8;
    this.windowMs = o.windowMs ?? 30_000;
    this.clock = o.clock ?? systemClock;
  }

  hit(key: string): boolean {
    const now = this.clock.now().getTime();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.evict(now);
    return recent.length <= this.max;
  }

  private evict(now: number): void {
    for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
  }
}

/** Never limits. For tests that are not about flooding. */
export const noRateLimit: RateLimiter = { hit: () => true };
