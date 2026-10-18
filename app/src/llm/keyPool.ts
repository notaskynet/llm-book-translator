// Port of src/core/llm/key_pool.py: round-robin API key pool with per-key
// throttle tracking. JS is single-threaded between awaits, so no lock is needed.

/** Splits a comma/newline separated key string into a clean list, order preserved. */
export function normalizeApiKeys(raw: string | Iterable<string> | null | undefined): string[] {
  if (raw == null) return [];
  const parts = typeof raw === 'string' ? raw.split(/[,\n]/) : [...raw];
  return parts.map((k) => k.trim()).filter(Boolean);
}

export class KeyPool {
  private readonly keys: string[];
  private readonly throttledUntil = new Map<string, number>();
  private cursor = 0;

  constructor(
    keys: string | Iterable<string>,
    readonly providerName = 'unknown',
    private readonly now: () => number = () => performance.now(),
  ) {
    this.keys = [...new Set(normalizeApiKeys(keys))];
    if (!this.keys.length) {
      throw new Error(`KeyPool for '${providerName}' requires at least one non-empty key`);
    }
    for (const k of this.keys) this.throttledUntil.set(k, 0);
  }

  get size(): number {
    return this.keys.length;
  }

  /** The next key without advancing the cursor (model listing and the like). */
  peek(): string {
    return this.keys[this.cursor % this.keys.length];
  }

  /** 1-based index of `key` for log messages; 0 if unknown. */
  indexOf(key: string): number {
    return this.keys.indexOf(key) + 1;
  }

  /**
   * Next non-throttled key, round-robin. If all are throttled, returns the one
   * that recovers soonest; the caller sleeps or raises via the rate-limit handler.
   */
  acquire(): string {
    const t = this.now();
    const n = this.keys.length;
    for (let offset = 0; offset < n; offset++) {
      const idx = (this.cursor + offset) % n;
      const key = this.keys[idx];
      if (this.throttledUntil.get(key)! <= t) {
        this.cursor = (idx + 1) % n;
        return key;
      }
    }
    return this.keys.reduce((a, b) => (this.throttledUntil.get(b)! < this.throttledUntil.get(a)! ? b : a));
  }

  /** Marks `key` throttled until `untilMs` (never shortens an existing throttle). */
  markThrottled(key: string, untilMs: number): void {
    if (this.throttledUntil.has(key)) {
      this.throttledUntil.set(key, Math.max(this.throttledUntil.get(key)!, untilMs));
    }
  }

  hasAvailable(): boolean {
    const t = this.now();
    return [...this.throttledUntil.values()].some((u) => u <= t);
  }

  /** Milliseconds until the earliest key is available; 0 if one already is. */
  timeUntilNextAvailableMs(): number {
    const soonest = Math.min(...this.throttledUntil.values());
    return Math.max(0, soonest - this.now());
  }

  currentTime(): number {
    return this.now();
  }
}
