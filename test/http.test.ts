import { strict as assert } from 'node:assert';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore } from '../src/core/idempotency.js';
import { Journal } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { startHttpServer } from '../src/http.js';

const config = loadConfig({
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
});

const now = Date.parse('2026-08-05T00:00:00.000Z');

async function started() {
  const store = new MemoryOperationStore();
  const events: Array<{ sessionId: string; opened: boolean }> = [];
  let clockNow = now;
  const clock = { advance: (ms: number) => (clockNow += ms) };
  const { server: http, sessions, ready, sweep } = startHttpServer({
    port: 0,
    version: '0.1.0',
    trustedProxyHops: 1,
    now: () => clockNow,
    onSession: (event) => events.push({ sessionId: event.sessionId, opened: event.opened }),
    createMcpServer: (clientIp) =>
      buildServer({
        version: '0.1.0',
        ...(clientIp === undefined ? {} : { clientIp }),
        runtime: {
          api: new ApiClient({
            baseUrl: config.apiUrl,
            token: config.token,
            userAgent: 'test',
            limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
            fetchImpl: async () =>
              new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
          }),
          config,
          journal: new Journal([]),
          confirmations: new Confirmations({ now: () => now }),
          store,
          ledger: new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => now),
          userId: 'u-1',
          now: () => now,
        },
      }).server,
  });
  await ready;
  const port = (http.address() as AddressInfo).port;
  return { http, sessions, events, sweep, clock, base: `http://127.0.0.1:${port}` };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

test('/health отвечает версией и не требует токена клиента', async () => {
  const { http, base } = await started();
  const response = await fetch(`${base}/health`);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(body['version'], '0.1.0');
  assert.equal(body['status'], 'ok');
  // Версия выката: по ней пайплайн понимает, что в прод приехала именно эта сборка
  assert.equal(body['build'], '0.1.0', 'без INVOICEBOX_BUILD build равен версии пакета');
  http.close();
});

test('/health отдаёт версию выката из окружения', async () => {
  process.env['INVOICEBOX_BUILD'] = '1.113137';
  const { http, base } = await started();
  const response = await fetch(`${base}/health`);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body['build'], '1.113137');
  assert.equal(body['version'], '0.1.0', 'версия пакета остаётся отдельным полем');
  delete process.env['INVOICEBOX_BUILD'];
  http.close();
});

test('чужой адрес отвечает 404 с подсказкой, а не пустотой', async () => {
  const { http, base } = await started();
  const response = await fetch(`${base}/api/v2/invoices`);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 404);
  assert.match(String(body['hint']), /\/mcp/);
  http.close();
});

test('рукопожатие по HTTP открывает сессию и выдаёт её идентификатор', async () => {
  const { http, base, sessions, events } = await started();
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(INITIALIZE),
  });
  assert.equal(response.status, 200);
  const sessionId = response.headers.get('mcp-session-id');
  assert.ok(sessionId, 'сервер должен вернуть идентификатор сессии');
  await response.text();

  assert.equal(sessions.size, 1);
  assert.deepEqual(events, [{ sessionId, opened: true }]);
  http.close();
});

test('запрос с неизвестной сессией отклоняется, а не создаёт новую молча', async () => {
  const { http, base } = await started();
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': '11111111-1111-1111-1111-111111111111',
    },
    body: JSON.stringify(INITIALIZE),
  });
  assert.equal(response.status, 404);
  const body = (await response.json()) as Record<string, unknown>;
  assert.match(String(body['error']), /сессия не найдена/);
  http.close();
});

test('слишком большое тело отклоняется по размеру', async () => {
  const { http, base } = await started();
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ ...INITIALIZE, padding: 'я'.repeat(2_000_000) }),
  });
  assert.equal(response.status, 413);
  http.close();
});

test('невалидный JSON в теле объясняется, а не роняет процесс', async () => {
  const { http, base } = await started();
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{"jsonrpc":',
  });
  assert.equal(response.status, 400);
  http.close();
});

test('запрос с чужим Origin отклоняется: браузерная страница до сервера не достучится', async () => {
  const { http, base } = await started();
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: 'https://evil.example',
    },
    body: JSON.stringify(INITIALIZE),
  });
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 403);
  assert.match(String(body['error']), /Origin/);
  http.close();
});

test('чужой Host: /mcp отклоняется, а /health отвечает — пробы Kubernetes приходят с Host из IP пода', async () => {
  const { http, base } = await started();
  // fetch не даёт подменить Host — это запрещённый заголовок, поэтому запрос идёт клиентом node:http
  const probe = (path: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const url = new URL(base);
      const request = get(
        { hostname: url.hostname, port: url.port, path, headers: { host: 'attacker.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
    });
  assert.equal(await probe('/mcp'), 403, 'сессии за проверкой Host');
  assert.equal(await probe('/health'), 200, 'проба живости не зависит от Host');
  http.close();
});

test('сессия закрывается по простою, и уборка не ждёт следующего клиента', async () => {
  const { http, base, sessions, events, sweep, clock } = await started();
  const opened = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(INITIALIZE),
  });
  await opened.text();
  assert.equal(sessions.size, 1);

  clock.advance(31 * 60_000);
  sweep();
  assert.equal(sessions.size, 0);
  assert.ok(events.some((event) => !event.opened), 'о закрытии сессии сообщается наружу');
  http.close();
});
