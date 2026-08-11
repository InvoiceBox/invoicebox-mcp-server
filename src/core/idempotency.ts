import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprint } from './canonical.js';

export type OperationStatus = 'pending' | 'done' | 'failed' | 'unknown';

export interface Operation {
  key: string;
  tool: string;
  /** Организация или магазин: потолки считаются на арендатора, а не на процесс. */
  tenant?: string;
  status: OperationStatus;
  at: string;
  merchantOrderId?: string;
  result?: unknown;
  reason?: string;
}

export interface OperationStore {
  find(key: string): Promise<Operation | undefined>;
  save(operation: Operation, amountMinor?: number): Promise<void>;
  countSince(tool: string, since: string, tenant?: string): Promise<{ count: number; amountMinor: number }>;
}

/** В потолок идут только состоявшиеся операции: незавершённые и упавшие его не занимают. */
function countsTowardsLimit(status: OperationStatus): boolean {
  return status === 'done' || status === 'unknown';
}

export function operationKey(input: {
  tool: string;
  merchantId?: string;
  counterpartyId?: string;
  args: unknown;
}): string {
  return fingerprint(input);
}

export class MemoryOperationStore implements OperationStore {
  protected readonly operations = new Map<string, Operation>();
  protected readonly amounts = new Map<string, number>();

  async find(key: string): Promise<Operation | undefined> {
    return this.operations.get(key);
  }

  async save(operation: Operation, amountMinor?: number): Promise<void> {
    this.operations.set(operation.key, operation);
    if (amountMinor !== undefined) this.amounts.set(operation.key, amountMinor);
  }

  async countSince(tool: string, since: string, tenant?: string): Promise<{ count: number; amountMinor: number }> {
    let count = 0;
    let amountMinor = 0;
    for (const operation of this.operations.values()) {
      if (operation.tool !== tool || operation.at < since) continue;
      if (tenant !== undefined && operation.tenant !== tenant) continue;
      if (!countsTowardsLimit(operation.status)) continue;
      count += 1;
      amountMinor += this.amounts.get(operation.key) ?? 0;
    }
    return { count, amountMinor };
  }
}

/**
 * Журнал операций дописывается строками: запись до вызова API, результат — после.
 * Формат JSONL, а не SQLite: node:sqlite в Node 22 требует флага запуска.
 */
export class FileOperationStore implements OperationStore {
  private readonly index = new Map<string, Operation>();
  private readonly amounts = new Map<string, number>();
  private prepared?: Promise<void>;
  private offset = 0;

  constructor(
    private readonly dir: string,
    private readonly file = 'operations.jsonl',
  ) {}

  private get path(): string {
    return join(this.dir, this.file);
  }

  /**
   * Хвост файла дочитывается на каждом обращении: со снимком «на момент запуска» два процесса
   * с одним каталогом состояния не видят операций друг друга, и защита от дублей не работает.
   */
  private async load(): Promise<Map<string, Operation>> {
    this.prepared ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => undefined);
    await this.prepared;

    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return this.index;
    }
    if (size === this.offset) return this.index;
    if (size < this.offset) {
      // Файл заменили или усекли: снимок больше не годится
      this.index.clear();
      this.amounts.clear();
      this.offset = 0;
    }

    const handle = await open(this.path, 'r');
    try {
      const buffer = Buffer.alloc(size - this.offset);
      await handle.read(buffer, 0, buffer.length, this.offset);
      const chunk = buffer.toString('utf8');
      const lastBreak = chunk.lastIndexOf('\n');
      if (lastBreak < 0) return this.index;
      for (const line of chunk.slice(0, lastBreak).split('\n')) {
        if (line.trim() === '') continue;
        try {
          const record = JSON.parse(line) as Operation & { amountMinor?: number };
          this.index.set(record.key, record);
          if (typeof record.amountMinor === 'number') this.amounts.set(record.key, record.amountMinor);
        } catch {
          continue;
        }
      }
      this.offset += Buffer.byteLength(chunk.slice(0, lastBreak + 1), 'utf8');
    } finally {
      await handle.close();
    }
    return this.index;
  }

  async find(key: string): Promise<Operation | undefined> {
    return (await this.load()).get(key);
  }

  async save(operation: Operation, amountMinor?: number): Promise<void> {
    await this.load();
    const line = JSON.stringify(amountMinor === undefined ? operation : { ...operation, amountMinor });
    await appendFile(this.path, `${line}\n`, { mode: 0o600 });
    await this.load();
  }

  async countSince(tool: string, since: string, tenant?: string): Promise<{ count: number; amountMinor: number }> {
    const index = await this.load();
    let count = 0;
    let amountMinor = 0;
    for (const operation of index.values()) {
      if (operation.tool !== tool || operation.at < since) continue;
      if (tenant !== undefined && operation.tenant !== tenant) continue;
      if (!countsTowardsLimit(operation.status)) continue;
      count += 1;
      amountMinor += this.amounts.get(operation.key) ?? 0;
    }
    return { count, amountMinor };
  }
}
