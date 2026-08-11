import { strict as assert } from 'node:assert';
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
import { firstMissingScope, startHttpServer } from '../src/http.js';
import { CATALOG } from '../src/tools/catalog.js';
import type { Session } from '../src/core/sessionAuth.js';

/**
 * Отказ по областям действия.
 *
 * Проверяется главное свойство: прав не хватило — клиент узнаёт об этом кодом, по
 * которому сам запускает повышение прав, и узнаёт, какая именно область нужна. Ошибка
 * внутри протокола этого не даёт: её клиент показывает пользователю как «что-то пошло
 * не так», и дальше человек сидит и гадает.
 */

const config = loadConfig({
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
  INVOICEBOX_TOOLSETS: 'read,write,refund',
});

const now = Date.parse('2026-08-11T00:00:00.000Z');

const scopeOf = (name: string) => CATALOG.find((tool) => tool.name === name)?.scope;

const runtime = () => {
  const store = new MemoryOperationStore();

  return {
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
  };
};

const session = (scopes: readonly string[]): Session => ({
  apiToken: 'session-token',
  scopes,
  expiresAt: now + 600_000,
});

const call = (name: string) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name, arguments: {} },
});

test('нехватка области видна до транспорта, и это именно область инструмента', () => {
  assert.equal(firstMissingScope(call('create_order'), ['merchant-read'], scopeOf), 'merchant-order');
  assert.equal(firstMissingScope(call('get_order'), ['merchant-read'], scopeOf), undefined);
});

test('пустой список областей означает, что права не сужали', () => {
  assert.equal(firstMissingScope(call('create_order'), [], scopeOf), undefined);
});

test('в пачке вызовов проверяется каждый', () => {
  const batch = [call('get_order'), call('create_refund')];

  // Частичный ответ клиент прочитал бы как «часть прошла», не понимая, какая
  assert.equal(firstMissingScope(batch, ['merchant-read'], scopeOf), 'merchant-refund');
});

test('чужие сообщения проверку не запускают', () => {
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

  assert.equal(firstMissingScope(initialize, ['merchant-read'], scopeOf), undefined);
  assert.equal(firstMissingScope({ method: 'tools/call' }, [], scopeOf), undefined);
  assert.equal(firstMissingScope(null, ['merchant-read'], scopeOf), undefined);
});

test('вызов без прав получает 403 с областью в заголовке', async () => {
  const { server: http, ready } = startHttpServer({
    port: 0,
    version: '0.1.0',
    authenticate: async () => ({ ok: true, session: session(['merchant-read']) }),
    scopeOf,
    protectedResource: {
      resource: 'https://mcp.invoicebox.ru/mcp',
      authorizationServers: ['https://api.invoicebox.ru'],
    },
    createMcpServer: () => buildServer({ version: '0.1.0', runtime: runtime() }).server,
  });
  await ready;
  const port = (http.address() as AddressInfo).port;

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer client-token',
    },
    body: JSON.stringify(call('create_order')),
  });
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 403);
  assert.equal(body['error'], 'insufficient_scope');
  const challenge = response.headers.get('www-authenticate') ?? '';
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /scope="merchant-order"/, 'клиенту нужно знать, какие права просить');
  assert.match(challenge, /resource_metadata=/, 'и куда идти за ними');
  http.close();
});

test('сам сервер тоже проверяет область: у stdio слоя HTTP нет вовсе', async () => {
  const { invoke } = buildServer({
    version: '0.1.0',
    runtime: runtime(),
    sessionScopes: ['merchant-read'],
  });

  const result = await invoke('create_order', {});
  const payload = JSON.parse(String(result.content[0]?.text ?? '{}')) as Record<string, unknown>;

  assert.equal(result.isError, true);
  assert.equal(payload['code'], 'insufficient_scope');
  assert.match(String(payload['reason']), /merchant-order/);
});

test('русский текст в заголовке не роняет ответ: вместо 500 приходит 401', async () => {
  const { server: http, ready } = startHttpServer({
    port: 0,
    version: '0.1.0',
    // Именно так отвечает SessionAuth: описание по-русски, для человека
    authenticate: async () => ({
      ok: false,
      status: 401,
      error: 'invalid_token',
      description: 'токен не принят сервером авторизации',
    }),
    scopeOf,
    protectedResource: {
      resource: 'https://mcp.invoicebox.ru/mcp',
      authorizationServers: ['https://api.invoicebox.ru'],
    },
    createMcpServer: () => buildServer({ version: '0.1.0', runtime: runtime() }).server,
  });
  await ready;
  const port = (http.address() as AddressInfo).port;

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(call('get_order')),
  });
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 401);
  // Объяснение человеку остаётся в теле, а в заголовке — код и адрес метаданных
  assert.equal(body['hint'], 'токен не принят сервером авторизации');
  const challenge = response.headers.get('www-authenticate') ?? '';
  assert.match(challenge, /error="invalid_token"/);
  assert.doesNotMatch(challenge, /error_description/, 'от русского описания в заголовке ничего не остаётся');
  http.close();
});
