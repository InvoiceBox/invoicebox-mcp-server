import { Refusal } from '../core/errors.js';
import { CircuitBreaker } from '../core/breaker.js';
import type { RateLimiter } from '../core/rateLimiter.js';
import { backoffMs, isJson, isRetryableStatus, MAX_RETRY_AFTER_MS, parseRateLimitHeaders, parseRetryAfter } from '../core/http.js';
import { Semaphore } from '../core/semaphore.js';
import { nodeFetch } from './transport.js';

export interface Envelope<T> {
  data: T;
  meta?: { totalCount?: number; page?: number; pageSize?: number };
  requestId?: string;
  status: number;
  etag?: string;
  notModified?: boolean;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | readonly string[]>;
  deadlineMs?: number;
  ifNoneMatch?: string;
  attempts?: number;
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  prefix?: string;
  userAgent: string;
  limiter: RateLimiter;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  maxBodyBytes?: number;
  readConcurrency?: number;
  writeConcurrency?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Attempt {
  method: string;
  path: string;
  body?: unknown;
  options: RequestOptions;
  write: boolean;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly prefix: string;
  private readonly token: string;
  private readonly userAgent: string;
  private readonly limiter: RateLimiter;
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly reads: Semaphore;
  private readonly writes: Semaphore;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.prefix = options.prefix ?? 'v3';
    this.token = options.token;
    this.userAgent = options.userAgent;
    this.limiter = options.limiter;
    this.breaker = options.breaker ?? new CircuitBreaker(options.now ? { now: options.now } : {});
    this.fetchImpl = options.fetchImpl ?? nodeFetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.readTimeoutMs = options.readTimeoutMs ?? 12_000;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 30_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
    this.reads = new Semaphore(options.readConcurrency ?? 3);
    this.writes = new Semaphore(options.writeConcurrency ?? 1);
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
    return this.send<T>({ method: 'GET', path, options, write: false });
  }

  post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<Envelope<T>> {
    return this.send<T>({ method: 'POST', path, body, options, write: true });
  }

  put<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<Envelope<T>> {
    return this.send<T>({ method: 'PUT', path, body, options, write: true });
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
    return this.send<T>({ method: 'DELETE', path, options, write: true });
  }

  private async send<T>(attempt: Attempt): Promise<Envelope<T>> {
    const gate = attempt.write ? this.writes : this.reads;
    return gate.run(() => this.sendGuarded<T>(attempt));
  }

  private async sendGuarded<T>(attempt: Attempt): Promise<Envelope<T>> {
    if (!this.breaker.allows()) {
      throw new Refusal('api_unavailable', 'API Инвойсбокса не отвечает, вызовы приостановлены', {
        retryAfterSeconds: this.breaker.retryAfterSeconds,
        hint: 'повторите позже; пока цепь разомкнута, запросы не отправляются',
      });
    }

    const deadline = this.now() + (attempt.options.deadlineMs ?? (attempt.write ? this.writeTimeoutMs : this.readTimeoutMs));
    const maxAttempts = attempt.write ? 1 : (attempt.options.attempts ?? 3);
    let lastRefusal: Refusal | undefined;

    const totalBudget = deadline - this.now();

    for (let tryNumber = 1; tryNumber <= maxAttempts; tryNumber += 1) {
      const budget = deadline - this.now();
      // Повтор с остатком меньше секунды прервётся сразу и подменит причину отказа на «не ответил за 0 с».
      if (budget < 1000) {
        throw lastRefusal ?? new Refusal('api_unavailable', `API Инвойсбокса не ответил за ${Math.round(totalBudget / 1000)} с`);
      }

      await this.limiter.acquire();
      const outcome = await this.attemptOnce<T>(attempt, budget, totalBudget);

      if (outcome.kind === 'ok') {
        this.breaker.onSuccess();
        return outcome.envelope;
      }

      if (outcome.kind === 'fatal') {
        if (outcome.serverFault) this.breaker.onFailure();
        else this.breaker.onClientFault();
        throw outcome.refusal;
      }

      this.breaker.onFailure();
      lastRefusal = outcome.refusal;
      if (tryNumber === maxAttempts) break;

      const pause = outcome.retryAfterMs ?? backoffMs(tryNumber);
      if (pause > MAX_RETRY_AFTER_MS) throw outcome.refusal;
      if (this.now() + pause >= deadline) break;
      await this.sleep(pause);
    }

    throw lastRefusal ?? new Refusal('api_unavailable', 'API Инвойсбокса не ответил');
  }

  private async attemptOnce<T>(
    attempt: Attempt,
    budgetMs: number,
    totalBudgetMs = budgetMs,
  ): Promise<
    | { kind: 'ok'; envelope: Envelope<T> }
    | { kind: 'retry'; refusal: Refusal; retryAfterMs?: number }
    | { kind: 'fatal'; refusal: Refusal; serverFault: boolean }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const url = this.buildUrl(attempt.path, attempt.options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
    if (attempt.body !== undefined) headers['Content-Type'] = 'application/json';
    if (attempt.options.ifNoneMatch) headers['If-None-Match'] = attempt.options.ifNoneMatch;

    try {
      const response = await this.fetchImpl(url, {
        method: attempt.method,
        headers,
        redirect: attempt.write ? 'manual' : 'follow',
        signal: controller.signal,
        ...(attempt.body === undefined ? {} : { body: JSON.stringify(attempt.body) }),
      });
      return await this.readResponse<T>(response, attempt);
    } catch (error) {
      if (error instanceof Refusal) {
        // Свой отказ (размер тела, разбор) детерминирован: повтор скачает то же тело.
        this.breaker.onClientFault();
        return { kind: 'fatal', refusal: error, serverFault: false };
      }
      const aborted = error instanceof Error && error.name === 'AbortError';
      const reason = aborted
        ? `API Инвойсбокса не ответил за ${Math.round(totalBudgetMs / 1000)} с`
        : `не удалось связаться с API Инвойсбокса: ${describe(error)}`;
      const refusal = new Refusal(attempt.write ? 'unknown_result' : 'api_unavailable', reason, {
        hint: attempt.write
          ? 'результат неизвестен: перед повтором нужно проверить выборкой, прошла ли операция'
          : 'повторите вызов позже',
      });
      if (attempt.write) return { kind: 'fatal', refusal, serverFault: true };
      return { kind: 'retry', refusal };
    } finally {
      clearTimeout(timer);
    }
  }

  private async readResponse<T>(
    response: Response,
    attempt: Attempt,
  ): Promise<
    | { kind: 'ok'; envelope: Envelope<T> }
    | { kind: 'retry'; refusal: Refusal; retryAfterMs?: number }
    | { kind: 'fatal'; refusal: Refusal; serverFault: boolean }
  > {
    const requestId = response.headers.get('x-request-id') ?? undefined;
    this.limiter.observeHeaders(parseRateLimitHeaders(response.headers));

    if (response.status === 304) {
      return {
        kind: 'ok',
        envelope: {
          data: undefined as T,
          status: 304,
          notModified: true,
          ...(requestId ? { requestId } : {}),
        },
      };
    }

    if (response.status >= 300 && response.status < 400) {
      return {
        kind: 'fatal',
        serverFault: false,
        refusal: new Refusal('api_error', `API ответил перенаправлением ${response.status}`, {
          hint: 'адрес API изменился — за перенаправлением на записи сервер не идёт, это повод разобраться',
          ...(requestId ? { requestId } : {}),
        }),
      };
    }

    if (isRetryableStatus(response.status)) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now());
      const refusal = new Refusal(
        response.status === 429 ? 'limit_reached' : 'api_unavailable',
        response.status === 429
          ? 'API Инвойсбокса ограничил частоту запросов'
          : `API Инвойсбокса временно недоступен (${response.status})`,
        {
          ...(retryAfterMs === null ? {} : { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) }),
          ...(requestId ? { requestId } : {}),
        },
      );
      if (attempt.write) return { kind: 'fatal', refusal, serverFault: true };
      return { kind: 'retry', refusal, ...(retryAfterMs === null ? {} : { retryAfterMs }) };
    }

    const text = await this.readBody(response);

    if (!response.ok) {
      const parsed = isJson(response.headers.get('content-type')) ? safeJson(text) : undefined;
      const apiCode = typeof parsed?.['code'] === 'string' ? (parsed['code']) : undefined;
      const apiMessage = typeof parsed?.['message'] === 'string' ? (parsed['message']) : undefined;
      return {
        kind: 'fatal',
        serverFault: response.status >= 500,
        refusal: new Refusal(
          response.status >= 500 && attempt.write ? 'unknown_result' : 'api_error',
          apiMessage ?? `API ответил ${response.status}`,
          {
            ...(apiCode ? { hint: `код ошибки API: ${apiCode}` } : { hint: text.slice(0, 200) }),
            ...(requestId ? { requestId } : {}),
          },
        ),
      };
    }

    if (!isJson(response.headers.get('content-type'))) {
      return {
        kind: 'fatal',
        serverFault: false,
        refusal: new Refusal('api_error', 'API ответил не в JSON', {
          hint: `первые символы ответа: ${text.slice(0, 120)}`,
          ...(requestId ? { requestId } : {}),
        }),
      };
    }

    const parsed = safeJson(text);
    if (parsed === undefined) {
      return {
        kind: 'fatal',
        serverFault: false,
        refusal: new Refusal('api_error', 'ответ API не разбирается как JSON', {
          hint: `первые символы ответа: ${text.slice(0, 120)}`,
          ...(requestId ? { requestId } : {}),
        }),
      };
    }

    const envelope: Envelope<T> = {
      data: (parsed['data'] ?? parsed) as T,
      status: response.status,
      ...(requestId ? { requestId } : {}),
    };
    const meta = parsed['metaData'];
    if (meta && typeof meta === 'object') envelope.meta = meta;
    const etag = response.headers.get('etag');
    if (etag) envelope.etag = etag;
    return { kind: 'ok', envelope };
  }

  private async readBody(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      throw new Refusal('api_error', `ответ API больше ${Math.round(this.maxBodyBytes / 1024 / 1024)} МБ`, {
        hint: 'сузьте выборку фильтрами или уменьшите page_size',
      });
    }
    const text = await response.text();
    if (text.length > this.maxBodyBytes) {
      throw new Refusal('api_error', `ответ API больше ${Math.round(this.maxBodyBytes / 1024 / 1024)} МБ`, {
        hint: 'сузьте выборку фильтрами или уменьшите page_size',
      });
    }
    return text;
  }

  private buildUrl(path: string, query: RequestOptions['query']): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}/${this.prefix}${normalized}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return { data: parsed };
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? error.message;
  }
  return String(error);
}
