export interface CacheOptions {
  ttlMs: number;
  jitterRatio?: number;
  maxEntries?: number;
  now?: () => number;
  random?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
  etag?: string;
}

/** Срок жизни со случайной добавкой: иначе весь кэш истекает одновременно и получается свой шквал. */
export class Cache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly jitterRatio: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: CacheOptions) {
    this.ttlMs = options.ttlMs;
    this.jitterRatio = options.jitterRatio ?? 0.1;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Просроченное значение остаётся доступным для деградации: справочник лучше старый, чем никакой. */
  getStale(key: string): { value: V; stale: boolean; etag?: string } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return {
      value: entry.value,
      stale: entry.expiresAt <= this.now(),
      ...(entry.etag === undefined ? {} : { etag: entry.etag }),
    };
  }

  set(key: string, value: V, options: { ttlMs?: number; etag?: string } = {}): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const base = options.ttlMs ?? this.ttlMs;
    const jitter = base * this.jitterRatio * this.random();
    this.entries.set(key, {
      value,
      expiresAt: this.now() + base + jitter,
      ...(options.etag === undefined ? {} : { etag: options.etag }),
    });
  }

  touch(key: string, ttlMs?: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const base = ttlMs ?? this.ttlMs;
    entry.expiresAt = this.now() + base + base * this.jitterRatio * this.random();
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}

/** Срок из Cache-Control, но не длиннее нашего: no-store запрещает хранить, max-age может укоротить. */
export function ttlFromCacheControl(header: string | null, fallbackMs: number): number {
  if (!header) return fallbackMs;
  const value = header.toLowerCase();
  if (value.includes('no-store') || value.includes('no-cache')) return 0;
  const maxAge = /max-age=(\d+)/.exec(value);
  if (!maxAge?.[1]) return fallbackMs;
  return Math.min(Number(maxAge[1]) * 1000, fallbackMs);
}
