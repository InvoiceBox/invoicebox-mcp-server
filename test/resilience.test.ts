import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { CircuitBreaker } from '../src/core/breaker.js';
import { Refusal } from '../src/core/errors.js';
import { StderrSink } from '../src/log/journal.js';

const TOKEN = 'b37c4c689295904ed21eee5d9a48d42e';

function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

function client(options: {
  fetchImpl: typeof fetch;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  readConcurrency?: number;
  writeConcurrency?: number;
  maxBodyBytes?: number;
}) {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    token: TOKEN,
    userAgent: 'test',
    limiter: new RateLimiter({ limit: { requests: 60, windowSeconds: 30 }, now: options.now, sleep: options.sleep ?? (async () => {}) }),
    breaker: new CircuitBreaker({ now: options.now }),
    now: options.now,
    sleep: options.sleep ?? (async () => {}),
    fetchImpl: options.fetchImpl,
    ...(options.readConcurrency === undefined ? {} : { readConcurrency: options.readConcurrency }),
    ...(options.writeConcurrency === undefined ? {} : { writeConcurrency: options.writeConcurrency }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  });
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('при исчерпании лимита запросы становятся в очередь, а не отправляются', async () => {
  const time = clock();
  const sleeps: number[] = [];
  let sent = 0;
  const limiter = new RateLimiter({
    limit: { requests: 2, windowSeconds: 30 },
    now: time.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      time.advance(ms);
    },
  });
  const api = new ApiClient({
    baseUrl: 'https://api.example.test',
    token: TOKEN,
    userAgent: 'test',
    limiter,
    now: time.now,
    sleep: async () => {},
    readConcurrency: 3,
    fetchImpl: async () => {
      sent += 1;
      return json({ data: [] });
    },
  });

  await Promise.all([api.get('/filter/api/order/order'), api.get('/filter/api/order/order'), api.get('/filter/api/order/order')]);
  assert.equal(sent, 3);
  assert.equal(sleeps.length, 1, 'третий запрос должен был подождать окна');
  assert.ok((sleeps[0] ?? 0) >= 29_000);
});

test('не больше четырёх запросов к API одновременно: три чтения и одна запись', async () => {
  const time = clock();
  let inFlight = 0;
  let peak = 0;
  const slow: typeof fetch = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return json({ data: [] });
  };
  const api = client({ fetchImpl: slow, now: time.now });

  await Promise.all([
    ...Array.from({ length: 8 }, () => api.get('/filter/api/order/order')),
    ...Array.from({ length: 4 }, () => api.post('/billing/api/order/shipment', {}).catch(() => undefined)),
  ]);
  assert.ok(peak <= 4, `в полёте было ${peak} запросов`);
});

test('медленный API прерывается по бюджету времени с понятной причиной', async () => {
  const time = clock();
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  const api = client({ fetchImpl: hanging, now: time.now });

  await assert.rejects(api.get('/filter/api/order/order', { deadlineMs: 30, attempts: 1 }), (error: unknown) => {
    assert.ok(error instanceof Refusal);
    assert.match(error.message, /не ответил за/);
    return true;
  });
});

test('обрыв середины ответа не превращается в пустой список', async () => {
  const time = clock();
  const truncated: typeof fetch = async () =>
    new Response('{"data":[{"id":"o-1"', { status: 200, headers: { 'content-type': 'application/json' } });
  const api = client({ fetchImpl: truncated, now: time.now });

  await assert.rejects(api.get('/filter/api/order/order', { attempts: 1 }), /не разбирается как JSON/);
});

test('гигантский ответ отклоняется по размеру, а не съедает память', async () => {
  const time = clock();
  const huge: typeof fetch = async () =>
    new Response(JSON.stringify({ data: Array.from({ length: 5000 }, (_item, index) => ({ id: index })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const api = client({ fetchImpl: huge, now: time.now, maxBodyBytes: 1024 });

  await assert.rejects(api.get('/filter/api/order/order', { attempts: 1 }), /больше 0 МБ|МБ/);
});

test('токен не попадает ни в текст ошибки, ни в журнал', async () => {
  const time = clock();
  const failing: typeof fetch = async () =>
    new Response(JSON.stringify({ code: 'unauthorized', message: `токен ${TOKEN} не принят` }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  const api = client({ fetchImpl: failing, now: time.now });

  const error = await api.get('/filter/api/order/order', { attempts: 1 }).catch((reason: unknown) => reason);
  assert.ok(error instanceof Refusal);

  const lines: string[] = [];
  new StderrSink('debug', { write: (text) => lines.push(text) }).write({
    traceId: 't',
    at: '2026-08-05T00:00:00.000Z',
    tool: 'find_orders',
    environment: 'demo',
    outcome: 'api_error',
    reason: error.message,
  });
  assert.ok(!(lines[0] ?? '').includes(TOKEN), 'токен просочился в журнал');
});

test('недоступный API даёт объяснение, а не стек', async () => {
  const time = clock();
  const broken: typeof fetch = async () => {
    const error = new Error('fetch failed');
    (error as { cause?: { code?: string } }).cause = { code: 'ENOTFOUND' };
    throw error;
  };
  const api = client({ fetchImpl: broken, now: time.now });

  await assert.rejects(api.get('/filter/api/order/order', { attempts: 1 }), (error: unknown) => {
    assert.ok(error instanceof Refusal);
    assert.match(error.message, /ENOTFOUND/);
    assert.equal(error.details.hint, 'повторите вызов позже');
    return true;
  });
});

test('причина таймаута называет весь бюджет, а не остаток последней попытки', async () => {
  const time = clock();
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  const api = client({
    fetchImpl: hanging,
    now: time.now,
    sleep: async (ms) => {
      time.advance(ms);
    },
  });

  await assert.rejects(api.get('/filter/api/order/order', { deadlineMs: 12_000, attempts: 3 }), (error: unknown) => {
    assert.ok(error instanceof Refusal);
    assert.match(error.message, /не ответил за 12 с/);
    assert.ok(!/за 0 с/.test(error.message), 'бессмысленный остаток в тексте причины');
    return true;
  });
});
