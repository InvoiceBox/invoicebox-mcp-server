export class Semaphore {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.free = Math.max(permits, 1);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.take();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private take(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.free += 1;
  }
}
