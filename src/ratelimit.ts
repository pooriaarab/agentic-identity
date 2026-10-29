// A fixed-window counter in the Store. A row holds a window start and a count under
// the hash of a key, so no IP address or principal id is stored. A request over the
// limit only reads. A row that is not what we wrote denies, and the window starts
// again, so a bad row heals when the window ends.
import { sha256Hex } from "./credentials.js";
import type { Store } from "./ports.js";

export interface RateRule {
  /** Whole requests allowed in one window. */
  limit: number;
  windowMs: number;
}

export interface RateLimiter {
  hit(key: string, rule: RateRule): Promise<{ allowed: boolean; retryAfterMs: number }>;
}

const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function createStoreRateLimiter(store: Store, options: { now?: () => number } = {}): RateLimiter {
  const now = options.now ?? Date.now;
  return {
    async hit(key, { limit, windowMs }) {
      if (![limit, windowMs].every((n) => Number.isSafeInteger(n) && n >= 1)) throw new Error("invalid rate rule");
      const id = (await sha256Hex(key)).slice(0, 32);
      return store.transaction(async (tx) => {
        const at = now();
        const row = await tx.get("rate_limits", id);
        const sound = row !== null && time(row.windowStart) && time(row.count) && row.windowStart <= at + windowMs;
        if (row !== null && !sound) {
          await tx.put("rate_limits", id, { windowStart: at, count: limit });
          return { allowed: false, retryAfterMs: windowMs };
        }
        if (row === null || at >= (row.windowStart as number) + windowMs) {
          await tx.put("rate_limits", id, { windowStart: at, count: 1 });
          return { allowed: true, retryAfterMs: 0 };
        }
        if ((row.count as number) >= limit) return { allowed: false, retryAfterMs: Math.max(1, (row.windowStart as number) + windowMs - at) };
        await tx.put("rate_limits", id, { windowStart: row.windowStart as number, count: (row.count as number) + 1 });
        return { allowed: true, retryAfterMs: 0 };
      });
    },
  };
}
