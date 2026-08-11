// Находки многоагентного прогона от 5 августа 2026. Каждый тест закрывает
// подтверждённый дефект: без исправления он падает.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { CircuitBreaker } from '../src/core/breaker.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore, operationKey } from '../src/core/idempotency.js';
import { Journal } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Refusal } from '../src/core/errors.js';
import { reconcileBasket } from '../src/core/money.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig } from '../src/config.js';
import { cancelOrder, createRefund, createShipment } from '../src/tools/writes.js';
import type { ToolRuntime } from '../src/tools/registry.js';

const config = loadConfig({
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
  INVOICEBOX_TOOLSETS: 'write,refund',
});

const now = Date.parse('2026-08-05T12:00:00.000Z');
const orderId = '01771534-1a57-f184-dee3-ebeb91dded75';

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function harness(responses: Array<() => Response>, clock: () => number = () => now) {
  const store = new MemoryOperationStore();
  const sent: string[] = [];
  const runtime: ToolRuntime = {
    api: new ApiClient({
      baseUrl: config.apiUrl,
      token: config.token,
      userAgent: 'test',
      limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
      sleep: async () => {},
      now: clock,
      fetchImpl: async (input, init) => {
        sent.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
        const next = responses.shift();
        if (!next) throw new Error(`лишний запрос: ${String(input)}`);
        return next();
      },
    }),
    config,
    journal: new Journal([]),
    confirmations: new Confirmations({ now: clock }),
    store,
    ledger: new DailyLedger(store, DEFAULT_DAILY_LIMITS, clock, DEMO_MERCHANT_ID),
    userId: 'u-1',
    now: clock,
  };
  return { runtime, store, sent };
}

const cancelArgs = { order_id: orderId, reason: 'клиент отказался' };
const unpaidOrder = () => json({ data: { id: orderId, status: 'created', amount: 122.0, merchantOrderId: 'mcp-1' } });

test('упавшая операция не выдаёт себя за выполненную: повтор действительно повторяет', async () => {
  const { runtime, store, sent } = harness([
    unpaidOrder,
    unpaidOrder,
    () => new Response('{"code":"validation","message":"магазин отклонил отмену"}', { status: 422, headers: { 'content-type': 'application/json' } }),
    unpaidOrder,
    unpaidOrder,
    () => json({ data: { id: orderId, status: 'canceled' } }),
  ]);

  const first = (await cancelOrder.run(cancelArgs, runtime)) as Record<string, unknown>;
  await assert.rejects(cancelOrder.run({ ...cancelArgs, confirmation_token: String(first['confirmation_token']) }, runtime));

  const key = operationKey({ tool: 'cancel_order', merchantId: DEMO_MERCHANT_ID, args: cancelArgs });
  assert.equal((await store.find(key))?.status, 'failed', 'неудача должна помечаться failed, а не done');

  const second = (await cancelOrder.run(cancelArgs, runtime)) as Record<string, unknown>;
  const done = (await cancelOrder.run(
    { ...cancelArgs, confirmation_token: String(second['confirmation_token']) },
    runtime,
  )) as Record<string, unknown>;
  assert.equal(done['status'], 'canceled', 'повтор после неудачи должен пройти, а не вернуть «дубль не создан»');
  assert.equal(done['repeated'], undefined);
  assert.equal(sent.filter((line) => line.startsWith('DELETE')).length, 2);
});

test('неудача не занимает суточный потолок', async () => {
  const { store } = harness([]);
  const key = 'failed-1';
  await store.save({ key, tool: 'create_refund', tenant: DEMO_MERCHANT_ID, status: 'failed', at: new Date(now).toISOString() });
  const spent = await store.countSince('create_refund', new Date(now - 3600_000).toISOString(), DEMO_MERCHANT_ID);
  assert.equal(spent.count, 0, 'упавшая операция не должна съедать потолок');
});

test('потолок считается по арендатору и срабатывает: ключ записи и запроса совпадают', async () => {
  const { store } = harness([]);
  const ledger = new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => now, DEMO_MERCHANT_ID);
  for (let i = 0; i < DEFAULT_DAILY_LIMITS.refundCount; i += 1) {
    await store.save({
      key: `k${i}`,
      tool: 'create_refund',
      tenant: DEMO_MERCHANT_ID,
      status: 'done',
      at: new Date(now - 60_000).toISOString(),
      result: {},
    });
  }
  await assert.rejects(ledger.assertAllowed({ tool: 'create_refund' }), /суточный потолок исчерпан/);

  const otherTenant = new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => now, 'другая-организация');
  await otherTenant.assertAllowed({ tool: 'create_refund' });
});

test('операция в полёте не выполняется вторым вызовом', async () => {
  const { runtime, store, sent } = harness([unpaidOrder, unpaidOrder]);
  const key = operationKey({ tool: 'cancel_order', merchantId: DEMO_MERCHANT_ID, args: cancelArgs });
  await store.save({
    key,
    tool: 'cancel_order',
    tenant: DEMO_MERCHANT_ID,
    status: 'pending',
    at: new Date(now - 5_000).toISOString(),
    merchantOrderId: 'mcp-20260805-inflight',
  });

  const preview = (await cancelOrder.run(cancelArgs, runtime)) as Record<string, unknown>;
  await assert.rejects(
    cancelOrder.run({ ...cancelArgs, confirmation_token: String(preview['confirmation_token']) }, runtime),
    /уже выполняется/,
  );
  assert.equal(sent.filter((line) => line.startsWith('DELETE')).length, 0, 'второй записи быть не должно');
});

test('брошенная запись старше минуты проверяется, а не повторяется слепо', async () => {
  const { runtime, store } = harness([
    unpaidOrder,
    unpaidOrder,
    () => json({ data: { id: orderId, merchantOrderId: 'mcp-20260805-stale', status: 'canceled' } }),
  ]);
  const key = operationKey({ tool: 'cancel_order', merchantId: DEMO_MERCHANT_ID, args: cancelArgs });
  await store.save({
    key,
    tool: 'cancel_order',
    tenant: DEMO_MERCHANT_ID,
    status: 'pending',
    at: new Date(now - 10 * 60_000).toISOString(),
    merchantOrderId: 'mcp-20260805-stale',
  });

  const preview = (await cancelOrder.run(cancelArgs, runtime)) as Record<string, unknown>;
  const result = (await cancelOrder.run(
    { ...cancelArgs, confirmation_token: String(preview['confirmation_token']) },
    runtime,
  )) as Record<string, unknown>;
  assert.equal(result['recovered'], true);
  assert.equal(result['status'], 'canceled');
});

test('частичный возврат без состава отклоняется, а не возвращает весь остаток', async () => {
  const { runtime, sent } = harness([
    () => json({ data: { id: orderId, status: 'completed', amount: 244.0 } }),
    () => json({ data: [{ sku: 'SKU-1', availableAmount: 244.0, amount: 244.0, quantity: 1, vatCode: 'RUS_VAT22' }] }),
  ]);
  await assert.rejects(
    createRefund.run({ parent_order_id: orderId, description: 'частичный', amount: '12200' }, runtime),
    (error: unknown) => {
      assert.match(String((error as Error).message), /перечислить составом/);
      return true;
    },
  );
  assert.equal(sent.filter((line) => line.startsWith('POST')).length, 0);
});

test('полный возврат без состава считает НДС по ставке, а не отправляет ноль', async () => {
  const { runtime, sent } = harness([
    () => json({ data: { id: orderId, status: 'completed', amount: 122.0 } }),
    () => json({ data: [{ sku: 'SKU-1', name: 'Позиция', availableAmount: 122.0, amount: 122.0, quantity: 1, vatCode: 'RUS_VAT22' }] }),
    () => json({ data: { id: orderId, status: 'completed', amount: 122.0 } }),
    () => json({ data: [{ sku: 'SKU-1', name: 'Позиция', availableAmount: 122.0, amount: 122.0, quantity: 1, vatCode: 'RUS_VAT22' }] }),
    () => json({ data: { id: 'r-1', status: 'created', merchantOrderId: 'mcp-r' } }),
  ]);
  const args = { parent_order_id: orderId, description: 'полный возврат', amount: '12200', vat_amount: '2200' };
  const preview = (await createRefund.run(args, runtime)) as Record<string, unknown>;
  await createRefund.run({ ...args, confirmation_token: String(preview['confirmation_token']) }, runtime);

  assert.equal(sent.filter((line) => line.startsWith('POST')).length, 1);
});

test('остаток отгрузок собирается страницами, а не первой страницей магазина', async () => {
  const otherShop = Array.from({ length: 50 }, (_item, index) => ({
    id: index + 1,
    orderId: 'другой-заказ',
    status: 'completed',
    basketItems: [{ sku: 'X', totalAmount: 1.0 }],
  }));
  const ours = [{ id: 99, orderId, status: 'completed', basketItems: [{ sku: 'SKU-1', totalAmount: 122.0 }] }];

  const { runtime } = harness([
    () => json({ data: { id: orderId, status: 'completed', amount: 122.0 } }),
    () => json({ data: otherShop, metaData: { totalCount: 51, page: 1, pageSize: 50 } }),
    () => json({ data: ours, metaData: { totalCount: 51, page: 2, pageSize: 50 } }),
  ]);

  await assert.rejects(
    createShipment.run(
      {
        order_id: orderId,
        basket_items: [
          {
            sku: 'SKU-1',
            name: 'Позиция',
            type: 'commodity',
            measure: 'шт',
            quantity: 1,
            amount: '12200',
            total_amount: '12200',
            total_vat_amount: '2200',
            vat_code: 'RUS_VAT22',
            payment_type: 'full_payment',
          },
        ],
        final: false,
      },
      runtime,
    ),
    /выходит за остаток/,
    'отгрузка со второй страницы должна учитываться в остатке',
  );
});

test('предохранитель не залипает после отказа с 4xx', async () => {
  let clock = now;
  const breaker = new CircuitBreaker({ now: () => clock, failureThreshold: 2, openMs: 1000 });
  const api = new ApiClient({
    baseUrl: config.apiUrl,
    token: config.token,
    userAgent: 'test',
    limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
    breaker,
    now: () => clock,
    sleep: async () => {},
    fetchImpl: async () => {
      if (breaker.state === 'closed') return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
      return new Response('{"code":"validation"}', { status: 422, headers: { 'content-type': 'application/json' } });
    },
  });

  await assert.rejects(api.get('/filter/api/order/order', { attempts: 1 }));
  await assert.rejects(api.get('/filter/api/order/order', { attempts: 1 }));
  assert.equal(breaker.state, 'open');

  clock += 2000;
  await assert.rejects(api.get('/filter/api/order/order', { attempts: 1 }), /validation|422/);
  assert.equal(breaker.state, 'half-open', 'после пробы состояние должно позволять следующую попытку');
  assert.ok(breaker.allows(), 'проба с 4xx не должна залипать в probing навсегда');
});

test('дробное количество не ломает сверку копеек', () => {
  const problems = reconcileBasket(
    [{ name: 'Услуга', quantity: 2.5, amount: 1000, totalAmount: 2500, totalVatAmount: 451 }],
    { amount: 2500 },
  );
  assert.deepEqual(problems, []);

  const rounded = reconcileBasket(
    [{ name: 'Час работы', quantity: 1.33, amount: 10_000, totalAmount: 13_300, totalVatAmount: 2400 }],
    { amount: 13_300 },
  );
  assert.deepEqual(rounded, []);
});

test('отказ по размеру тела не повторяется', async () => {
  let calls = 0;
  const api = new ApiClient({
    baseUrl: config.apiUrl,
    token: config.token,
    userAgent: 'test',
    limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
    now: () => now,
    sleep: async () => {},
    maxBodyBytes: 64,
    fetchImpl: async () => {
      calls += 1;
      return json({ data: Array.from({ length: 200 }, (_item, index) => ({ id: index })) });
    },
  });

  await assert.rejects(api.get('/filter/api/order/order', { attempts: 3 }), (error: unknown) => {
    assert.ok(error instanceof Refusal);
    return true;
  });
  assert.equal(calls, 1, 'детерминированный отказ по размеру повторять незачем');
});

test('во внешний приёмник уходят метаданные без аргументов вызова', async () => {
  const { GraylogSink } = await import('../src/log/sinks.js');
  const { createSocket } = await import('node:dgram');

  const received: string[] = [];
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  socket.on('message', (message) => received.push(message.toString('utf8')));
  const port = socket.address().port;

  await new GraylogSink({ url: `udp://127.0.0.1:${port}` }).write({
    traceId: 'trace-1',
    at: new Date(now).toISOString(),
    tool: 'create_order',
    environment: 'demo',
    outcome: 'api_error',
    reason: 'API ответил 500',
    args: {
      customer: { name: 'ООО «Ромашка»', vatNumber: '7701234560', email: 'buh@example.invbox.ru' },
      basket_items: [{ sku: 'SKU-1', name: 'Секретная номенклатура' }],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.close();

  const message = received[0] ?? '';
  assert.ok(message.length > 0);
  assert.ok(!message.includes('Ромашка'), 'наименование не должно уходить наружу');
  assert.ok(!message.includes('7701234560'), 'ИНН не должен уходить наружу');
  assert.ok(!message.includes('Секретная номенклатура'), 'состав корзины не должен уходить наружу');
  assert.match(message, /API ответил 500/);
  assert.match(message, /trace-1/);
});
