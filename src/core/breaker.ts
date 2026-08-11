export interface BreakerOptions {
  failureThreshold?: number;
  openMs?: number;
  now?: () => number;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(options: BreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.openMs = options.openMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.failures < this.failureThreshold) return 'closed';
    if (this.now() - this.openedAt >= this.openMs) return 'half-open';
    return 'open';
  }

  get retryAfterSeconds(): number {
    return Math.max(Math.ceil((this.openedAt + this.openMs - this.now()) / 1000), 0);
  }

  allows(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.probing = false;
  }

  /** Отказ не по вине сервера (4xx, перенаправление, не-JSON): цепь не размыкает, но снимает пробу — иначе half-open залипает. */
  onClientFault(): void {
    this.probing = false;
  }

  onFailure(): void {
    this.failures += 1;
    this.probing = false;
    if (this.failures >= this.failureThreshold) this.openedAt = this.now();
  }
}
