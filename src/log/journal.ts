import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mask } from './mask.js';
import type { LogLevel } from '../config.js';

export type Outcome = 'ok' | 'rejected_by_server' | 'api_error' | 'unknown';

export interface JournalRecord {
  traceId: string;
  at: string;
  tool: string;
  client?: string;
  clientIp?: string;
  merchantId?: string;
  counterpartyId?: string;
  environment: string;
  args?: unknown;
  merchantOrderId?: string;
  confirmation?: 'client-annotation' | 'token' | 'cabinet' | 'none';
  apiStatus?: number;
  apiRequestId?: string;
  durationMs?: number;
  outcome: Outcome;
  reason?: string;
}

export interface JournalSink {
  write(record: JournalRecord): void | Promise<void>;
}

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export class StderrSink implements JournalSink {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly stream: { write(text: string): unknown } = process.stderr,
  ) {}

  write(record: JournalRecord): void {
    if (record.outcome === 'ok' && LEVELS[this.level] < LEVELS.info) return;
    this.stream.write(`${JSON.stringify(mask(record))}\n`);
  }
}

export class FileSink implements JournalSink {
  private ready?: Promise<void>;

  constructor(private readonly dir: string) {}

  async write(record: JournalRecord): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => undefined);
    await this.ready;
    const day = record.at.slice(0, 10);
    await appendFile(join(this.dir, `audit-${day}.jsonl`), `${JSON.stringify(mask(record))}\n`, { mode: 0o600 });
  }
}

/** Недоступный приёмник не должен ронять денежную операцию: очередь ограничена, о сбое сообщаем один раз. */
export class Journal {
  private readonly failed = new Set<JournalSink>();
  private pending = 0;

  constructor(
    private readonly sinks: JournalSink[],
    private readonly maxPending = 256,
    private readonly onSinkError: (error: unknown) => void = () => {},
  ) {}

  record(record: JournalRecord): void {
    if (this.pending >= this.maxPending) return;
    for (const sink of this.sinks) {
      this.pending += 1;
      void Promise.resolve()
        .then(() => sink.write(record))
        .catch((error: unknown) => {
          if (this.failed.has(sink)) return;
          this.failed.add(sink);
          this.onSinkError(error);
        })
        .finally(() => {
          this.pending -= 1;
        });
    }
  }

  async drain(): Promise<void> {
    for (let i = 0; i < 100 && this.pending > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
