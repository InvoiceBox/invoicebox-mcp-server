import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore } from '../src/core/idempotency.js';
import { Journal } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig } from '../src/config.js';
import { cancelOrder, createOrder, createRefund, createShipment } from '../src/tools/writes.js';
import type { ToolRuntime } from '../src/tools/registry.js';

const config = loadConfig({
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
  INVOICEBOX_TOOLSETS: 'write,refund',
});

const now = Date.parse('2026-08-04T20:00:00.000Z');

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function harness(responses: Array<() => Response>) {
  const sent: Sent[] = [];
  const store = new MemoryOperationStore();
  const api = new ApiClient({
    baseUrl: config.apiUrl,
    token: config.token,
    userAgent: 'test',
    limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
    sleep: async () => {},
    now: () => now,
    fetchImpl: async (input, init) => {
      sent.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const next = responses.shift();
      if (!next) throw new Error(`лишний запрос: ${String(input)}`);
      return next();
    },
  });
  const runtime: ToolRuntime = {
    api,
    config,
    journal: new Journal([]),
    confirmations: new Confirmations({ now: () => now }),
    store,
    ledger: new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => now),
    userId: 'u-1',
    now: () => now,
  };
  return { runtime, sent, store };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-7' },
  });

const line = {
  sku: 'SKU-1',
  name: 'Бронирование номера',
  type: 'commodity' as const,
  measure: 'шт',
  quantity: 1,
  amount: '12200',
  total_amount: '12200',
  total_vat_amount: '2200',
  vat_code: 'RUS_VAT22' as const,
  payment_type: 'full_payment' as const,
};

const orderArgs = {
  description: 'Оплата номера в отеле',
  customer: {
    type: 'legal' as const,
    name: 'ООО «Ромашка»',
    vat_number: '7701234560',
    tax_registration_reason_code: '770101001',
  },
  basket_items: [line],
  amount: '12200',
  vat_amount: '2200',
  currency_id: 'RUB' as const,
  language_id: 'ru' as const,
  expiration_date: '2026-08-11T00:00:00+00:00',
};

test('первый вызов создания счёта ничего не отправляет в API', async () => {
  const { runtime, sent } = harness([]);
  const result = (await createOrder.run(orderArgs, runtime)) as Record<string, unknown>;
  assert.equal(sent.length, 0);
  assert.equal(result['confirmation_required'], true);
  assert.ok(typeof result['confirmation_token'] === 'string');
  const summary = result['summary'] as Record<string, unknown>;
  assert.equal(summary['amount'], '12200');
  assert.match(String(summary['amount_human']), /122,00/);
});

test('со подтверждением уходит тело с копейками, приведёнными к числам API', async () => {
  const { runtime, sent } = harness([() => json({ data: { id: 'o-1', status: 'created', paymentUrl: 'https://pay/1' } })]);
  const first = (await createOrder.run(orderArgs, runtime)) as Record<string, unknown>;
  const result = (await createOrder.run(
    { ...orderArgs, confirmation_token: String(first['confirmation_token']) },
    runtime,
  )) as Record<string, unknown>;

  assert.equal(sent.length, 1);
  const body = sent[0]?.body as Record<string, unknown>;
  assert.equal(body['amount'], 122);
  assert.equal(body['vatAmount'], 22);
  assert.match(String(body['merchantOrderId']), /^mcp-20260804-/);
  const basket = body['basketItems'] as Array<Record<string, unknown>>;
  assert.equal(basket[0]?.['measureCode'], '796');
  assert.equal(result['payment_url'], 'https://pay/1');
  assert.equal(result['environment'], 'demo');
});

test('несходящиеся суммы отклоняются до запроса, с указанием позиции', async () => {
  const { runtime, sent } = harness([]);
  await assert.rejects(
    createOrder.run({ ...orderArgs, amount: '12000' }, runtime),
    (error: unknown) => {
      assert.match(String(error), /суммы не сходятся/);
      return true;
    },
  );
  assert.equal(sent.length, 0);
});

test('КПП у физлица — отказ без обращения к API', async () => {
  const { runtime, sent } = harness([]);
  await assert.rejects(
    createOrder.run(
      { ...orderArgs, customer: { type: 'private', tax_registration_reason_code: '770101001' } },
      runtime,
    ),
    (error: unknown) => {
      assert.match(String((error as { details?: { problems?: string[] } }).details?.problems?.join(' ')), /физлица КПП не бывает/);
      return true;
    },
  );
  assert.equal(sent.length, 0);
});

test('повтор подтверждённого вызова не создаёт второй счёт', async () => {
  const { runtime, sent } = harness([() => json({ data: { id: 'o-1', status: 'created' } })]);
  const first = (await createOrder.run(orderArgs, runtime)) as Record<string, unknown>;
  const token = String(first['confirmation_token']);
  await createOrder.run({ ...orderArgs, confirmation_token: token }, runtime);

  const second = (await createOrder.run(orderArgs, runtime)) as Record<string, unknown>;
  const repeated = (await createOrder.run(
    { ...orderArgs, confirmation_token: String(second['confirmation_token']) },
    runtime,
  )) as Record<string, unknown>;

  assert.equal(sent.length, 1);
  assert.equal(repeated['repeated'], true);
  assert.equal(repeated['order_id'], 'o-1');
});

test('оплаченный счёт не отменяется, ответ указывает на возврат', async () => {
  const { runtime } = harness([() => json({ data: { id: 'o-1', status: 'completed' } })]);
  await assert.rejects(
    cancelOrder.run({ order_id: '01771534-1a57-f184-dee3-ebeb91dded75', reason: 'ошибка' }, runtime),
    (error: unknown) => {
      assert.match(String((error as Error).message), /счёт оплачен/);
      assert.match(String((error as { details?: { hint?: string } }).details?.hint), /create_refund/);
      return true;
    },
  );
});

test('отмена неоплаченного идёт двумя фазами и уходит методом DELETE', async () => {
  const { runtime, sent } = harness([
    () => json({ data: { id: 'o-1', status: 'created', amount: 122.0, merchantOrderId: 'mcp-1' } }),
    () => json({ data: { id: 'o-1', status: 'created', amount: 122.0, merchantOrderId: 'mcp-1' } }),
    () => json({ data: { id: 'o-1', status: 'canceled' } }),
  ]);
  const args = { order_id: '01771534-1a57-f184-dee3-ebeb91dded75', reason: 'клиент отказался' };
  const first = (await cancelOrder.run(args, runtime)) as Record<string, unknown>;
  assert.equal(first['confirmation_required'], true);

  const result = (await cancelOrder.run(
    { ...args, confirmation_token: String(first['confirmation_token']) },
    runtime,
  )) as Record<string, unknown>;
  assert.equal(result['status'], 'canceled');
  assert.equal(sent[2]?.method, 'DELETE');
});

test('отгрузка сверх остатка отклоняется с числами', async () => {
  const { runtime } = harness([
    () => json({ data: { id: 'o-1', status: 'completed', amount: 122.0 } }),
    () => json({ data: [{ id: 1, orderId: '01771534-1a57-f184-dee3-ebeb91dded75', status: 'completed', basketItems: [{ sku: 'SKU-1', totalAmount: 100.0 }] }] }),
  ]);
  await assert.rejects(
    createShipment.run(
      { order_id: '01771534-1a57-f184-dee3-ebeb91dded75', basket_items: [line], final: false },
      runtime,
    ),
    /выходит за остаток/,
  );
});

test('сводка отгрузки называет признак final и документы', async () => {
  const { runtime } = harness([
    () => json({ data: { id: 'o-1', status: 'completed', amount: 122.0, merchantOrderId: 'mcp-1' } }),
    () => json({ data: [] }),
  ]);
  const result = (await createShipment.run(
    { order_id: '01771534-1a57-f184-dee3-ebeb91dded75', basket_items: [line], final: true },
    runtime,
  )) as Record<string, unknown>;
  const summary = result['summary'] as Record<string, unknown>;
  assert.equal(summary['final'], true);
  assert.match(String(summary['final_note']), /остаток резерва разблокируется/);
  assert.match(String(summary['documents_note']), /УПД/);
});

test('возврат по неоплаченному счёту отклоняется', async () => {
  const { runtime } = harness([() => json({ data: { id: 'o-1', status: 'created' } })]);
  await assert.rejects(
    createRefund.run({ parent_order_id: '01771534-1a57-f184-dee3-ebeb91dded75', description: 'возврат' }, runtime),
    /возврат делают по оплаченному/,
  );
});

test('возврат больше доступного остатка отклоняется по availableAmount', async () => {
  const { runtime } = harness([
    () => json({ data: { id: 'o-1', status: 'completed', amount: 122.0 } }),
    () => json({ data: [{ sku: 'SKU-1', availableAmount: 50.0, amount: 122.0, quantity: 1 }] }),
  ]);
  await assert.rejects(
    createRefund.run(
      { parent_order_id: '01771534-1a57-f184-dee3-ebeb91dded75', description: 'возврат', amount: '12200' },
      runtime,
    ),
    /к возврату доступно 50,00 ₽/,
  );
});

test('возврат по составу сверяется с остатком позиции, а не только с итогом', async () => {
  const { runtime } = harness([
    () => json({ data: { id: 'o-1', status: 'completed', amount: 244.0 } }),
    () =>
      json({
        data: [
          { sku: 'SKU-1', availableAmount: 50.0, amount: 122.0, quantity: 1 },
          { sku: 'SKU-2', availableAmount: 100.0, amount: 100.0, quantity: 1 },
        ],
      }),
  ]);
  await assert.rejects(
    createRefund.run(
      {
        parent_order_id: '01771534-1a57-f184-dee3-ebeb91dded75',
        description: 'возврат',
        basket_items: [line],
      },
      runtime,
    ),
    (error: unknown) => {
      assert.match(String((error as Error).message), /состав возврата не сходится/);
      assert.match(
        String((error as { details?: { problems?: string[] } }).details?.problems?.join(' ')),
        /по позиции SKU-1 доступно 50,00 ₽/,
      );
      return true;
    },
  );
});

test('подтверждённый возврат уходит с parentId и оговоркой о сроках', async () => {
  const { runtime, sent } = harness([
    () => json({ data: { id: 'o-1', status: 'completed', amount: 122.0, merchantOrderId: 'mcp-1' } }),
    () => json({ data: [{ sku: 'SKU-1', availableAmount: 122.0, amount: 122.0, quantity: 1, vatCode: 'RUS_VAT22' }] }),
    () => json({ data: { id: 'o-1', status: 'completed', amount: 122.0, merchantOrderId: 'mcp-1' } }),
    () => json({ data: [{ sku: 'SKU-1', availableAmount: 122.0, amount: 122.0, quantity: 1, vatCode: 'RUS_VAT22' }] }),
    () => json({ data: { id: 'r-1', status: 'created', merchantOrderId: 'mcp-r' } }),
  ]);
  const args = {
    parent_order_id: '01771534-1a57-f184-dee3-ebeb91dded75',
    description: 'возврат по обращению',
    amount: '12200',
    vat_amount: '2200',
  };
  const first = (await createRefund.run(args, runtime)) as Record<string, unknown>;
  const summary = first['summary'] as Record<string, unknown>;
  assert.match(String(summary['timing_note']), /до двух рабочих дней/);

  const result = (await createRefund.run(
    { ...args, confirmation_token: String(first['confirmation_token']) },
    runtime,
  )) as Record<string, unknown>;
  const body = sent[4]?.body as Record<string, unknown>;
  assert.equal(body['parentId'], args.parent_order_id);
  assert.equal(body['amount'], 122);
  assert.equal(result['refund_id'], 'r-1');
});

test('суточный потолок возвратов останавливает вторую фазу', async () => {
  const { runtime, store } = harness([
    () => json({ data: { id: 'o-1', status: 'completed', amount: 122.0 } }),
    () => json({ data: [{ sku: 'SKU-1', availableAmount: 122.0, amount: 122.0, quantity: 1 }] }),
    () => json({ data: { id: 'o-1', status: 'completed', amount: 122.0 } }),
    () => json({ data: [{ sku: 'SKU-1', availableAmount: 122.0, amount: 122.0, quantity: 1 }] }),
  ]);
  for (let i = 0; i < 10; i += 1) {
    await store.save({ key: `old-${i}`, tool: 'create_refund', status: 'done', at: '2026-08-04T09:00:00.000Z' });
  }
  const args = { parent_order_id: '01771534-1a57-f184-dee3-ebeb91dded75', description: 'возврат', amount: '12200' };
  const first = (await createRefund.run(args, runtime)) as Record<string, unknown>;
  await assert.rejects(
    createRefund.run({ ...args, confirmation_token: String(first['confirmation_token']) }, runtime),
    /суточный потолок исчерпан/,
  );
});
