import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore } from '../src/core/idempotency.js';
import { Journal, type JournalRecord, type JournalSink } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { CATALOG, catalogFingerprint } from '../src/tools/catalog.js';
import { selectTools } from '../src/tools/registry.js';
import type { ToolRuntime } from '../src/tools/registry.js';

const now = Date.parse('2026-08-04T20:00:00.000Z');

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
    INVOICEBOX_ENV: 'demo',
    INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
    ...overrides,
  });
}

function runtimeFor(cfg: Config, records: JournalRecord[] = []): ToolRuntime {
  const sink: JournalSink = {
    write: (record) => {
      records.push(record);
    },
  };
  const store = new MemoryOperationStore();
  return {
    api: new ApiClient({
      baseUrl: cfg.apiUrl,
      token: cfg.token,
      userAgent: 'test',
      limiter: new RateLimiter({ limit: cfg.rateLimit, sleep: async () => {} }),
      fetchImpl: async () => new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
    config: cfg,
    journal: new Journal([sink]),
    confirmations: new Confirmations({ now: () => now }),
    store,
    ledger: new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => now),
    userId: 'u-1',
    now: () => now,
  };
}

test('каталог содержит восемь инструментов в фиксированном порядке', () => {
  assert.deepEqual(
    CATALOG.map((tool) => tool.name),
    [
      'lookup_company_by_inn',
      'get_order',
      'find_orders',
      'find_shipments',
      'create_order',
      'cancel_order',
      'create_shipment',
      'create_refund',
    ],
  );
});

test('хеш каталога зафиксирован: правка описания без правки эталона видна', () => {
  assert.equal(catalogFingerprint(), 'bd36e3aa8964b467b3d5f6fe4f6514b9');
});

test('по умолчанию видно только чтение', () => {
  const tools = selectTools(CATALOG, { toolsets: ['read'], hasMerchant: true, hasCounterparty: true });
  assert.deepEqual(tools.map((tool) => tool.name), [
    'lookup_company_by_inn',
    'get_order',
    'find_orders',
    'find_shipments',
  ]);
});

test('набор write открывает записи, но не возврат', () => {
  const tools = selectTools(CATALOG, { toolsets: ['read', 'write'], hasMerchant: true, hasCounterparty: true });
  assert.ok(tools.some((tool) => tool.name === 'create_order'));
  assert.ok(!tools.some((tool) => tool.name === 'create_refund'));
});

test('без идентификатора магазина инструменты магазина не показываются', () => {
  const tools = selectTools(CATALOG, { toolsets: ['read', 'write', 'refund'], hasMerchant: false, hasCounterparty: true });
  assert.deepEqual(tools.map((tool) => tool.name), ['lookup_company_by_inn']);
});

test('сервер поднимается и объявляет отобранные инструменты', () => {
  const cfg = config({ INVOICEBOX_TOOLSETS: 'write,refund' });
  const { tools } = buildServer({ runtime: runtimeFor(cfg), version: '0.1.0' });
  assert.equal(tools.length, 8);
});

test('вызовы в цикле останавливаются пределом на сессию', async () => {
  const cfg = config();
  const records: JournalRecord[] = [];
  const runtime = runtimeFor(cfg, records);
  const { invoke } = buildServer({ runtime, version: '0.1.0', maxCalls: 1, clientIp: 'stdio' });

  const first = await invoke('find_orders', { page: 1, page_size: 20, response_format: 'concise' });
  assert.ok(!first.isError);

  const second = await invoke('find_orders', { page: 1, page_size: 20, response_format: 'concise' });
  assert.equal(second.isError, true);
  assert.match(second.content[0]?.text ?? '', /не больше 1 вызовов/);
});

test('журнал записывает вызов с адресом, контуром и итогом', async () => {
  const cfg = config();
  const records: JournalRecord[] = [];
  const runtime = runtimeFor(cfg, records);
  const { invoke } = buildServer({ runtime, version: '0.1.0', clientIp: 'stdio' });
  await invoke('find_orders', { page: 1, page_size: 20, response_format: 'concise' });
  await runtime.journal.drain();

  const record = records[0];
  assert.equal(record?.tool, 'find_orders');
  assert.equal(record?.clientIp, 'stdio');
  assert.equal(record?.environment, 'demo');
  assert.equal(record?.outcome, 'ok');
  assert.equal(record?.merchantId, DEMO_MERCHANT_ID);
});

test('невалидные параметры возвращаются отказом инструмента, а не падением', async () => {
  const cfg = config();
  const runtime = runtimeFor(cfg);
  const { invoke } = buildServer({ runtime, version: '0.1.0' });
  const result = await invoke('lookup_company_by_inn', { inn: 'нет' });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /invalid_input/);
});
