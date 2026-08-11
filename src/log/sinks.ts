import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { mask } from './mask.js';
import type { JournalRecord, JournalSink } from './journal.js';

const GELF_LEVELS: Record<JournalRecord['outcome'], number> = {
  ok: 6,
  rejected_by_server: 4,
  api_error: 3,
  unknown: 3,
};

export interface GraylogOptions {
  url: string;
  host?: string;
}

/** GELF без библиотеки: одна отправка на запись, ошибки не мешают вызову инструмента. */
export class GraylogSink implements JournalSink {
  private readonly protocol: string;
  private readonly hostname: string;
  private readonly port: number;
  private readonly source: string;

  constructor(options: GraylogOptions) {
    const url = new URL(options.url);
    this.protocol = url.protocol.replace(':', '');
    if (this.protocol !== 'udp' && this.protocol !== 'tcp') {
      throw new Error(`GELF поддерживает udp и tcp, получено ${url.protocol}`);
    }
    this.hostname = url.hostname;
    this.port = Number(url.port || 12201);
    this.source = options.host ?? 'invoicebox-mcp-server';
  }

  async write(record: JournalRecord): Promise<void> {
    // Тело вызова наружу не уходит: в GELF идут только метаданные операции.
    const { args: _args, ...metadata } = record;
    const safe = mask(metadata);
    const message: Record<string, unknown> = {
      version: '1.1',
      host: this.source,
      short_message: `${record.tool}: ${record.outcome}`,
      level: GELF_LEVELS[record.outcome],
      timestamp: Date.parse(record.at) / 1000,
    };
    for (const [key, value] of Object.entries(safe)) {
      if (key === 'at' || key === 'tool' || key === 'outcome') continue;
      message[`_${key}`] = typeof value === 'object' ? JSON.stringify(value) : value;
    }
    message['_tool'] = record.tool;
    message['_outcome'] = record.outcome;

    const payload = Buffer.from(JSON.stringify(message));
    if (this.protocol === 'udp') return this.sendUdp(payload);
    return this.sendTcp(payload);
  }

  private sendUdp(payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');
      socket.send(payload, this.port, this.hostname, (error) => {
        socket.close();
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private sendTcp(payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.hostname, port: this.port, timeout: 2000 });
      socket.on('error', reject);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('приёмник GELF не ответил за 2 с'));
      });
      socket.on('connect', () => {
        socket.end(Buffer.concat([payload, Buffer.from([0])]), () => resolve());
      });
    });
  }
}

export interface SentryOptions {
  dsn: string;
  environment: string;
  release: string;
  fetchImpl?: typeof fetch;
}

/** Отправляет только отказы и только состав записи журнала: тел запросов и ответов API в Sentry нет. */
export class SentrySink implements JournalSink {
  private readonly endpoint: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SentryOptions) {
    const url = new URL(options.dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (!url.username || projectId === '') throw new Error('DSN Sentry не разбирается: нужен ключ и идентификатор проекта');
    this.key = url.username;
    this.endpoint = `${url.protocol}//${url.host}/api/${projectId}/store/`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async write(record: JournalRecord): Promise<void> {
    if (record.outcome === 'ok' || record.outcome === 'rejected_by_server') return;

    const safe = mask(record) as unknown as Record<string, unknown>;
    const body = {
      event_id: record.traceId.replace(/-/g, ''),
      timestamp: record.at,
      platform: 'node',
      level: 'error',
      release: this.options.release,
      environment: this.options.environment,
      logger: 'invoicebox-mcp-server',
      message: { formatted: `${record.tool}: ${record.reason ?? record.outcome}` },
      tags: {
        tool: record.tool,
        outcome: record.outcome,
        environment: record.environment,
        api_status: record.apiStatus,
      },
      extra: {
        trace_id: safe['traceId'],
        api_request_id: safe['apiRequestId'],
        merchant_id: safe['merchantId'],
        duration_ms: safe['durationMs'],
      },
    };

    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${this.key}, sentry_client=invoicebox-mcp-server/${this.options.release}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`Sentry ответил ${response.status}`);
  }
}
