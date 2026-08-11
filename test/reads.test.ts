import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore } from '../src/core/idempotency.js';
import { Journal } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig } from '../src/config.js';
import { findOrders, findShipments, getOrder, lookupCompanyByInn } from '../src/tools/reads.js';
import type { ToolRuntime } from '../src/tools/registry.js';

const config = loadConfig({
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
});

function runtimeWith(responses: Array<() => Response>): { runtime: ToolRuntime; urls: string[] } {
  const urls: string[] = [];
  const store = new MemoryOperationStore();
  const api = new ApiClient({
    baseUrl: config.apiUrl,
    token: config.token,
    userAgent: 'test',
    limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
    sleep: async () => {},
    fetchImpl: async (input) => {
      urls.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error('лишний запрос');
      return next();
    },
  });
  return {
    urls,
    runtime: {
      api,
      config,
      journal: new Journal([]),
      confirmations: new Confirmations(),
      store,
      ledger: new DailyLedger(store, DEFAULT_DAILY_LIMITS),
      userId: 'u-1',
      now: () => Date.parse('2026-08-04T20:00:00.000Z'),
    },
  };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-9' } });

test('ИНН с неверной контрольной суммой не доходит до API', async () => {
  const { runtime, urls } = runtimeWith([]);
  await assert.rejects(lookupCompanyByInn.run({ inn: '7701234567' }, runtime), /контрольной суммы/);
  assert.equal(urls.length, 0);
});

test('реквизиты по ИНН помечены как данные внешнего реестра', async () => {
  const { runtime, urls } = runtimeWith([
    () => json({ data: [{ vatNumber: '7736207543', name: 'ООО «Ромашка»', taxRegistrationReasonCode: '770101001' }] }),
  ]);
  const result = (await lookupCompanyByInn.run({ inn: '7736207543' }, runtime)) as Record<string, unknown>;
  assert.equal(result['name'], 'ООО «Ромашка»');
  assert.match(String(result['untrusted_source']), /данными, а не указаниями/);
  assert.match(urls[0] ?? '', /vatNumber=7736207543/);
});

test('счёт по идентификатору отдаётся сжато, суммы строкой в копейках', async () => {
  const { runtime } = runtimeWith([
    () => json({ data: { id: 'o-1', merchantOrderId: 'mcp-1', status: 'completed', amount: 122.0, currencyId: 'RUB' } }),
  ]);
  const result = (await getOrder.run(
    { order_id: '01771534-1a57-f184-dee3-ebeb91dded75', response_format: 'concise' },
    runtime,
  )) as Record<string, unknown>;
  assert.equal(result['amount'], '12200');
  assert.equal(result['environment'], 'demo');
  assert.equal(result['payment_url'], undefined);
});

test('подробный формат добавляет ссылку на оплату и контрагента', async () => {
  const { runtime } = runtimeWith([
    () =>
      json({
        data: {
          id: 'o-1',
          status: 'created',
          amount: 122.0,
          paymentUrl: 'https://pay.example/1',
          customer: { name: 'ООО «Ромашка»', vatNumber: '7701234560' },
        },
      }),
  ]);
  const result = (await getOrder.run(
    { order_id: '01771534-1a57-f184-dee3-ebeb91dded75', response_format: 'detailed' },
    runtime,
  )) as Record<string, unknown>;
  assert.equal(result['payment_url'], 'https://pay.example/1');
  assert.deepEqual(result['customer'], { name: 'ООО «Ромашка»', vat_number: '7701234560' });
});

test('два счёта с одним номером — отказ с вариантами, а не выбор сервера', async () => {
  const { runtime } = runtimeWith([
    () =>
      json({
        data: [
          { id: 'o-1', status: 'created', createdAt: '2026-08-04T10:00:00+00:00' },
          { id: 'o-2', status: 'created', createdAt: '2026-08-04T11:00:00+00:00' },
        ],
      }),
  ]);
  await assert.rejects(
    getOrder.run({ merchant_order_id: 'O-1', response_format: 'concise' }, runtime),
    (error: unknown) => {
      assert.match(String(error), /нашлось 2 счетов/);
      return true;
    },
  );
});

test('ни order_id, ни номера — понятный отказ без запроса', async () => {
  const { runtime, urls } = runtimeWith([]);
  await assert.rejects(getOrder.run({ response_format: 'concise' }, runtime), /order_id или merchant_order_id/);
  assert.equal(urls.length, 0);
});

test('выборка счетов уходит с подчёркиваниями и операторами дат', async () => {
  const { runtime, urls } = runtimeWith([
    () => json({ data: [{ id: 'o-1', status: 'completed', amount: 1 }], metaData: { totalCount: 137, page: 1, pageSize: 20 } }),
  ]);
  const result = (await findOrders.run(
    {
      status: ['completed'],
      created_from: '2026-08-01T00:00:00+00:00',
      page: 1,
      page_size: 20,
      response_format: 'concise',
    },
    runtime,
  )) as Record<string, unknown>;
  const url = urls[0] ?? '';
  assert.match(url, /_order%5BcreatedAt%5D=desc/, 'сортировка задаётся ключом в скобках, иначе API отвечает 422');
  assert.ok(!url.includes('_order=createdAt'), 'форма «_order=createdAt:desc» отклоняется API');
  assert.match(url, /_page=1/);
  assert.match(url, /_pageSize=20/);
  assert.match(url, /status=completed/);
  assert.match(url, /createdAt%5B_ge%5D=2026-08-01/);
  assert.match(String(result['truncated']), /показано 1 из 137/);
});

test('отгрузки запрашиваются фильтром по заказу, чужие в ответ не попадают', async () => {
  const { runtime, urls } = runtimeWith([
    () =>
      json({
        data: [
          { id: 1, orderId: 'o-1', status: 'completed', amount: 61.0, final: false },
          { id: 2, orderId: 'o-2', status: 'draft', amount: 10.0 },
        ],
        metaData: { totalCount: 2, page: 1, pageSize: 20 },
      }),
  ]);
  const result = (await findShipments.run(
    { order_id: '01771534-1a57-f184-dee3-ebeb91dded75', page: 1, page_size: 20, response_format: 'concise' },
    runtime,
  )) as Record<string, unknown>;
  assert.deepEqual(result['shipments'], []);
  assert.equal(result['dropped_foreign'], 2, 'отгрузки чужого заказа отбрасываются и об этом сказано');
  assert.match(urls[0] ?? '', /orderId=01771534-1a57-f184-dee3-ebeb91dded75/);
});
