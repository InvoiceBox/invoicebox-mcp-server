import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore } from '../src/core/idempotency.js';
import { Journal } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { CATALOG } from '../src/tools/catalog.js';

const config = loadConfig({
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
  INVOICEBOX_TOOLSETS: 'write,refund',
});

const now = Date.parse('2026-08-04T20:00:00.000Z');

async function connected() {
  const store = new MemoryOperationStore();
  const { server } = buildServer({
    version: '0.1.0',
    clientIp: 'stdio',
    runtime: {
      api: new ApiClient({
        baseUrl: config.apiUrl,
        token: config.token,
        userAgent: 'test',
        limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      }),
      config,
      journal: new Journal([]),
      confirmations: new Confirmations({ now: () => now }),
      store,
      ledger: new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => now),
      userId: 'u-1',
      now: () => now,
    },
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test('рукопожатие проходит и сервер называет себя', async () => {
  const { client, server } = await connected();
  const info = client.getServerVersion();
  assert.equal(info?.name, 'invoicebox-mcp-server');
  assert.equal(info?.version, '0.1.0');
  await server.close();
});

test('tools/list отдаёт восемь инструментов в том же порядке, что каталог', async () => {
  const { client, server } = await connected();
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    CATALOG.map((tool) => tool.name),
  );
  await server.close();
});

test('схемы приходят строгими: лишнее поле не допускается', async () => {
  const { client, server } = await connected();
  const listed = await client.listTools();
  const createOrder = listed.tools.find((tool) => tool.name === 'create_order');
  assert.equal(createOrder?.inputSchema['additionalProperties'], false);
  assert.ok(Array.isArray(createOrder?.inputSchema['required']));
  await server.close();
});

test('аннотации отличают чтение от записи', async () => {
  const { client, server } = await connected();
  const listed = await client.listTools();
  const read = listed.tools.find((tool) => tool.name === 'find_orders');
  const write = listed.tools.find((tool) => tool.name === 'create_refund');
  assert.equal(read?.annotations?.readOnlyHint, true);
  assert.equal(write?.annotations?.destructiveHint, true);
  await server.close();
});

test('справочники отдаются ресурсами и читаются', async () => {
  const { client, server } = await connected();
  const listed = await client.listResources();
  const uris = listed.resources.map((resource) => resource.uri);
  assert.ok(uris.includes('invoicebox://registry/vat-rates'));

  const read = await client.readResource({ uri: 'invoicebox://registry/vat-rates' });
  const first = read.contents[0] as { text?: string } | undefined;
  const text = first?.text;
  assert.ok(typeof text === 'string');
  const parsed = JSON.parse(text) as { rates: Array<{ code: string }> };
  assert.ok(parsed.rates.some((rate) => rate.code === 'RUS_VAT22'));
  await server.close();
});

test('промптов сервер не отдаёт вовсе', async () => {
  const { client, server } = await connected();
  await assert.rejects(client.listPrompts(), /prompts|not supported|Method not found/i);
  await server.close();
});

test('вызов инструмента через протокол возвращает JSON в тексте', async () => {
  const { client, server } = await connected();
  const result = await client.callTool({
    name: 'find_orders',
    arguments: { page: 1, page_size: 20, response_format: 'concise' },
  });
  const content = result.content as Array<{ type: string; text: string }>;
  assert.equal(content[0]?.type, 'text');
  const payload = JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
  assert.equal(payload['environment'], 'demo');
  await server.close();
});

test('невалидные параметры возвращаются ошибкой инструмента, а не обрывом протокола', async () => {
  const { client, server } = await connected();
  const result = await client.callTool({ name: 'lookup_company_by_inn', arguments: { inn: '123' } });
  assert.equal(result.isError, true);
  await server.close();
});
