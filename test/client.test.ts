import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { CircuitBreaker } from '../src/core/breaker.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Refusal } from '../src/core/errors.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function harness(responses: Array<() => Response>) {
  const calls: Recorded[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    token: 'demo-token',
    userAgent: 'invoicebox-mcp-server/test',
    limiter: new RateLimiter({ limit: { requests: 60, windowSeconds: 30 }, now: () => clock, sleep: async () => {} }),
    breaker: new CircuitBreaker({ now: () => clock }),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      });
      const next = responses.shift();
      if (!next) throw new Error('лишний запрос');
      return next();
    },
  });
  return { client, calls, sleeps, advance: (ms: number) => (clock += ms) };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
    ...init,
  });

test('конверт списка разбирается, постраничность уходит с подчёркиванием', async () => {
  const { client, calls } = harness([
    () => json({ data: [{ id: 1 }], metaData: { totalCount: 7, page: 1, pageSize: 20 } }),
  ]);
  const result = await client.get<Array<{ id: number }>>('/filter/api/order/order', {
    query: { _page: 1, _pageSize: 20 },
  });
  assert.deepEqual(result.data, [{ id: 1 }]);
  assert.equal(result.meta?.totalCount, 7);
  assert.equal(result.requestId, 'req-1');
  assert.match(calls[0]?.url ?? '', /_page=1&_pageSize=20/);
  assert.match(calls[0]?.url ?? '', /\/v3\/filter\/api\/order\/order/);
});

test('429 с Retry-After в секундах выжидается ровно столько', async () => {
  const { client, sleeps } = harness([
    () => new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
    () => json({ data: [] }),
  ]);
  await client.get('/filter/api/order/order');
  assert.deepEqual(sleeps, [2000]);
});

test('Retry-After датой тоже понимается', async () => {
  const { client, sleeps } = harness([
    () =>
      new Response('{}', {
        status: 503,
        headers: { 'retry-after': new Date(1_000_000 + 3000).toUTCString() },
      }),
    () => json({ data: [] }),
  ]);
  await client.get('/filter/api/order/order');
  assert.equal(sleeps.length, 1);
  assert.ok((sleeps[0] ?? 0) >= 2000 && (sleeps[0] ?? 0) <= 4000);
});

test('422 не повторяется', async () => {
  const { client, calls } = harness([
    () =>
      new Response(JSON.stringify({ code: 'validation', message: 'сумма не сходится' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
  ]);
  await assert.rejects(client.get('/filter/api/order/order'), (error: unknown) => {
    assert.ok(error instanceof Refusal);
    assert.equal(error.code, 'api_error');
    assert.match(error.message, /сумма не сходится/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('304 отдаётся как «не изменилось», без разбора тела', async () => {
  const { client } = harness([() => new Response(null, { status: 304, headers: { 'x-request-id': 'req-1' } })]);
  const result = await client.get('/filter/api/counterparty-detail', { ifNoneMatch: 'W/"1"' });
  assert.equal(result.notModified, true);
});

test('HTML вместо JSON — понятная ошибка, а не пустой список', async () => {
  const { client } = harness([
    () => new Response('<html>502 Bad Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  ]);
  await assert.rejects(client.get('/filter/api/order/order'), /не в JSON/);
});

test('запись не повторяется и сообщает о неизвестном результате', async () => {
  const { client, calls } = harness([() => new Response('{}', { status: 503, headers: { 'retry-after': '1' } })]);
  await assert.rejects(client.post('/billing/api/order/order', { amount: 1 }), (error: unknown) => {
    assert.ok(error instanceof Refusal);
    assert.equal(error.code, 'api_unavailable');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('перенаправление на записи не выполняется автоматически', async () => {
  const { client } = harness([
    () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.test' } }),
  ]);
  await assert.rejects(client.post('/billing/api/order/order', {}), /перенаправлением 307/);
});

test('после пяти отказов цепь размыкается и запросы не уходят', async () => {
  const failing = Array.from({ length: 5 }, () => () => new Response('{}', { status: 503 }));
  const { client, calls } = harness(failing);
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(client.post('/billing/api/order/shipment', {}));
  }
  await assert.rejects(client.get('/filter/api/order/order'), (error: unknown) => {
    assert.ok(error instanceof Refusal);
    assert.equal(error.code, 'api_unavailable');
    assert.match(error.message, /приостановлены/);
    return true;
  });
  assert.equal(calls.length, 5);
});
