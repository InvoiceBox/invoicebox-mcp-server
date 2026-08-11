import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { buildChallenge, buildProtectedResourceMetadata, metadataPaths } from '../src/core/protectedResource.js';
import { catalogScopes } from '../src/tools/catalog.js';
import { startHttpServer } from '../src/http.js';
import { buildServer } from '../src/server.js';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore } from '../src/core/idempotency.js';
import { Journal } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig } from '../src/config.js';

const config = loadConfig({
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
});

const RESOURCE = 'https://mcp.invoicebox.ru/mcp';
const ISSUER = 'https://id.invoicebox.ru';

async function started(protectedResource?: Parameters<typeof startHttpServer>[0]['protectedResource']) {
  const store = new MemoryOperationStore();
  const now = Date.parse('2026-08-06T00:00:00.000Z');
  const { server: http, ready } = startHttpServer({
    port: 0,
    version: '0.1.0',
    ...(protectedResource === undefined ? {} : { protectedResource }),
    createMcpServer: () =>
      buildServer({
        version: '0.1.0',
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

  return { http, base: `http://127.0.0.1:${port}` };
}

test('метаданные ресурса отдаются по адресу из RFC 9728', async () => {
  const { http, base } = await started({
    resource: RESOURCE,
    authorizationServers: [ISSUER],
    scopesSupported: catalogScopes(),
  });

  const response = await fetch(`${base}/.well-known/oauth-protected-resource`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body['resource'], RESOURCE);
  assert.deepEqual(body['authorization_servers'], [ISSUER]);
  assert.deepEqual(body['bearer_methods_supported'], ['header']);
  http.close();
});

test('документ доступен и по адресу с путём ресурса: клиенты спрашивают по-разному', async () => {
  const { http, base } = await started({ resource: RESOURCE, authorizationServers: [ISSUER] });

  const withPath = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);

  assert.equal(withPath.status, 200);
  assert.equal(((await withPath.json()) as Record<string, unknown>)['resource'], RESOURCE);
  http.close();
});

test('документ публичный: читается с любого Origin и с чужим Host', async () => {
  const { http, base } = await started({ resource: RESOURCE, authorizationServers: [ISSUER] });

  // Клиент читает метаданные до всякой авторизации, поэтому проверки Host и
  // Origin (защита от DNS rebinding для /mcp) здесь применяться не должны
  const response = await fetch(`${base}/.well-known/oauth-protected-resource`, {
    headers: { origin: 'https://claude.ai', host: 'mcp.invoicebox.ru' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  http.close();
});

test('без настроенного ресурса раздел не публикуется', async () => {
  const { http, base } = await started();

  const response = await fetch(`${base}/.well-known/oauth-protected-resource`);

  assert.equal(response.status, 404);
  http.close();
});

test('перечень областей действия совпадает с тем, что объявляют инструменты', () => {
  const metadata = buildProtectedResourceMetadata({
    resource: RESOURCE,
    authorizationServers: [ISSUER],
    scopesSupported: catalogScopes(),
  });

  // Разойдись эти списки — клиент попросил бы токен не с теми правами и упёрся
  // в отказ уже при вызове инструмента
  assert.deepEqual(metadata.scopes_supported, catalogScopes());
  assert.ok(catalogScopes().includes('merchant-read'));
});

test('отказ показывает дорогу к метаданным', () => {
  const challenge = buildChallenge(`${RESOURCE}/.well-known/oauth-protected-resource`, 'invalid_token', 'token expired');

  assert.match(challenge, /^Bearer resource_metadata="https:\/\/mcp\.invoicebox\.ru/);
  assert.match(challenge, /error="invalid_token"/);
  assert.match(challenge, /error_description="token expired"/);
});

test('в заголовок попадает только то, что заголовок переносит', () => {
  // Русский текст в заголовке роняет ответ целиком: вместо 401 клиент получал 500 и
  // не понимал, что от него хотят. Описание остаётся человеку — в теле ответа
  const cyrillic = buildChallenge(`${RESOURCE}/.well-known/oauth-protected-resource`, 'invalid_token', 'токен истёк');
  assert.doesNotMatch(cyrillic, /error_description/);
  assert.match(cyrillic, /error="invalid_token"/);

  // Кавычка закрыла бы параметр раньше времени и сделала вызов неразборным
  const quoted = buildChallenge(`${RESOURCE}/.well-known/oauth-protected-resource`, 'insufficient_scope', 'a"b', 'merchant-order');
  assert.match(quoted, /error_description="ab"/);
  assert.match(quoted, /scope="merchant-order"/);
});

test('адрес без пути не даёт второго варианта', () => {
  assert.deepEqual(metadataPaths('https://mcp.invoicebox.ru'), ['/.well-known/oauth-protected-resource']);
  assert.deepEqual(metadataPaths('https://mcp.invoicebox.ru/mcp'), [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]);
});

test('без настроек обмена метаданные не публикуются, но 404 объясняет причину', async () => {
  // Без protectedResource — именно так сервер и запускается в демо-режиме
  const { http, base } = await started();

  const response = await fetch(`${base}/.well-known/oauth-protected-resource`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  // Общее «адрес не обслуживается» заставляло искать ошибку в своём клиенте
  assert.equal(body['error'], 'метаданные ресурса не публикуются');
  assert.match(String(body['hint']), /INVOICEBOX_OAUTH_CLIENT_ID/);
  http.close();
});
