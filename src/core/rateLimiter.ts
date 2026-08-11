export interface RateLimit {
  requests: number;
  windowSeconds: number;
}

export const ACCOUNT_LIMIT: RateLimit = { requests: 100, windowSeconds: 30 };
export const DEFAULT_LIMIT: RateLimit = { requests: 60, windowSeconds: 30 };

export class RateLimitParseError extends Error {}

export function parseRateLimit(value: string): RateLimit {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
  if (!match) {
    throw new RateLimitParseError(`ожидался формат «запросы/секунды», например 60/30, получено «${value}»`);
  }
  const requests = Number(match[1]);
  const windowSeconds = Number(match[2]);
  if (requests < 1 || windowSeconds < 1) {
    throw new RateLimitParseError(`значения должны быть положительными, получено «${value}»`);
  }
  return { requests, windowSeconds };
}

export interface CappedLimit {
  limit: RateLimit;
  cappedFrom?: RateLimit;
}

export function capToAccountLimit(limit: RateLimit, account: RateLimit = ACCOUNT_LIMIT): CappedLimit {
  const requested = limit.requests / limit.windowSeconds;
  const allowed = account.requests / account.windowSeconds;
  if (requested <= allowed) return { limit };
  return {
    limit: { requests: account.requests, windowSeconds: account.windowSeconds },
    cappedFrom: limit,
  };
}

export interface RateLimiterOptions {
  limit: RateLimit;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly stamps: number[] = [];
  private limit: RateLimit;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<void> = Promise.resolve();
  private pausedUntil = 0;

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get current(): RateLimit {
    return this.limit;
  }

  /** Заголовки лимита от сервера сужают окно до первого 429. */
  observeHeaders(headers: { remaining?: number; resetSeconds?: number }): void {
    if (headers.remaining === undefined || headers.remaining > 0) return;
    const pause = Math.max(headers.resetSeconds ?? 1, 1);
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + pause * 1000);
  }

  async acquire(): Promise<void> {
    const wait = this.chain.then(() => this.reserve());
    this.chain = wait.catch(() => undefined);
    return wait;
  }

  private async reserve(): Promise<void> {
    for (;;) {
      const now = this.now();
      const windowMs = this.limit.windowSeconds * 1000;
      while (this.stamps.length > 0 && (this.stamps[0] as number) <= now - windowMs) this.stamps.shift();

      const pauseLeft = this.pausedUntil - now;
      if (pauseLeft > 0) {
        await this.sleep(pauseLeft);
        continue;
      }
      if (this.stamps.length < this.limit.requests) {
        this.stamps.push(now);
        return;
      }
      const oldest = this.stamps[0] as number;
      await this.sleep(Math.max(oldest + windowMs - now, 1));
    }
  }
}
