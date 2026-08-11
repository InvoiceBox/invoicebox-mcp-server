import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore, operationKey } from '../src/core/idempotency.js';
import { Journal } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig } from '../src/config.js';
import { cancelOrder, createRefund } from '../src/tools/writes.js';
import type { ToolRuntime } from '../src/tools/registry.js';

const config = loadConfig({
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
  INVOICEBOX_TOOLSETS: 'write,refund',
});

const now = Date.parse('2026-08-04T20:00:00.000Z');
const orderId = '01771534-1a57-f184-dee3-ebeb91dded75';

function harness(responses: Array<() => Response>) {
  const store = new MemoryOperationStore();
  const runtime: ToolRuntime = {
    api: new ApiClient({
      baseUrl: config.apiUrl,
      token: config.token,
      userAgent: 'test',
      limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
      sleep: async () => {},
      now: () => now,
      fetchImpl: async () => {
        const next = responses.shift();
        if (!next) throw new Error('лишний запрос');
        return next();
      },
    }),
    config,
    journal: new Journal([]),
    confirmations: new Confirmations({ now: () => now }),
    store,
    ledger: new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => now),
    userId: 'u-1',
    now: () => now,
  };
  return { runtime, store };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const args = { order_id: orderId, reason: 'клиент отказался' };
const openOrder = () => json({ data: { id: orderId, status: 'created' } });

test('брошенная отмена восстанавливается по статусу заказа, а не поиском по номеру', async () => {
  const { runtime, store } = harness([
    openOrder,
    openOrder,
    () => json({ data: { id: orderId, merchantOrderId: 'mcp-20260804-abc', status: 'canceled' } }),
  ]);
  const key = operationKey({ tool: 'cancel_order', merchantId: DEMO_MERCHANT_ID, args });
  await store.save({
    key,
    tool: 'cancel_order',
    status: 'unknown',
    at: '2026-08-04T19:00:00.000Z',
    merchantOrderId: 'mcp-20260804-abc',
    reason: 'таймаут',
  });

  const first = (await cancelOrder.run(args, runtime)) as Record<string, unknown>;
  const result = (await cancelOrder.run(
    { ...args, confirmation_token: String(first['confirmation_token']) },
    runtime,
  )) as Record<string, unknown>;

  assert.equal(result['recovered'], true);
  assert.equal(result['status'], 'canceled');
  assert.equal((await store.find(key))?.status, 'done');
});

test('открытый заказ — доказательство, что отмена не прошла: повтор выполняется штатно', async () => {
  const { runtime, store } = harness([
    openOrder,
    openOrder,
    openOrder,
    () => json({ data: { id: orderId, status: 'canceled' } }),
  ]);
  const key = operationKey({ tool: 'cancel_order', merchantId: DEMO_MERCHANT_ID, args });
  await store.save({
    key,
    tool: 'cancel_order',
    status: 'unknown',
    at: '2026-08-04T19:00:00.000Z',
    merchantOrderId: 'mcp-20260804-abc',
  });

  const first = (await cancelOrder.run(args, runtime)) as Record<string, unknown>;
  const result = (await cancelOrder.run(
    { ...args, confirmation_token: String(first['confirmation_token']) },
    runtime,
  )) as Record<string, unknown>;

  assert.equal(result['recovered'], undefined, 'ничего не восстанавливали — операция выполнена заново');
  assert.equal(result['status'], 'canceled');
  assert.equal((await store.find(key))?.status, 'done');
});

test('если исход проверить нельзя, сервер честно говорит «результат неизвестен»', async () => {
  const refundArgs = { parent_order_id: orderId, description: 'возврат', amount: '12200' };
  const paid = () => json({ data: { id: orderId, status: 'completed', amount: 122.0 } });
  const available = () =>
    json({
      data: [{ sku: 'SKU-1', name: 'Позиция', availableAmount: 122.0, availableVatAmount: 22.0, amount: 122.0, quantity: 1, vatCode: 'RUS_VAT22' }],
    });
  const { runtime, store } = harness([paid, available, paid, available, () => json({ data: [] })]);

  const key = operationKey({
    tool: 'create_refund',
    merchantId: DEMO_MERCHANT_ID,
    args: refundArgs,
  });
  await store.save({
    key,
    tool: 'create_refund',
    status: 'unknown',
    at: '2026-08-04T19:00:00.000Z',
    merchantOrderId: 'mcp-20260804-abc',
  });

  const first = (await createRefund.run(refundArgs, runtime)) as Record<string, unknown>;
  await assert.rejects(
    createRefund.run({ ...refundArgs, confirmation_token: String(first['confirmation_token']) }, runtime),
    (error: unknown) => {
      assert.match(String((error as Error).message), /результат неизвестен/);
      return true;
    },
  );
  assert.equal((await store.find(key))?.status, 'unknown', 'запись переписана, а не оставлена «в полёте»');
});
