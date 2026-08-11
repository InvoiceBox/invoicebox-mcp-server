// Находки второго многоагентного прогона от 5 августа 2026 — в том числе регрессии,
// внесённые исправлениями первого. Каждый тест падает без своего исправления.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore, operationKey } from '../src/core/idempotency.js';
import { Journal } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { reconcileBasket } from '../src/core/money.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig } from '../src/config.js';
import { createOrder, createRefund, createShipment } from '../src/tools/writes.js';
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

interface Sent {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function harness(responses: Array<() => Response>) {
  const store = new MemoryOperationStore();
  const sent: Sent[] = [];
  const runtime: ToolRuntime = {
    api: new ApiClient({
      baseUrl: config.apiUrl,
      token: config.token,
      userAgent: 'test',
      limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
      sleep: async () => {},
      now: () => now,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        const record: Sent = { method: init?.method ?? 'GET', path: url.pathname + url.search };
        if (typeof init?.body === 'string') record.body = JSON.parse(init.body) as Record<string, unknown>;
        sent.push(record);
        const next = responses.shift();
        if (!next) throw new Error(`лишний запрос: ${String(input)}`);
        return next();
      },
    }),
    config,
    journal: new Journal([]),
    confirmations: new Confirmations({ now: () => now }),
    store,
    ledger: new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => now, DEMO_MERCHANT_ID),
    userId: 'u-1',
    now: () => now,
  };
  return { runtime, store, sent };
}

// Позиция с количеством 3: именно здесь расходятся «цена единицы» и «сумма позиции»
const threeItems = {
  sku: 'SKU-3',
  name: 'Три штуки',
  availableAmount: 366.0,
  availableVatAmount: 66.0,
  amount: 122.0,
  quantity: 3,
  vatCode: 'RUS_VAT22',
};

const paidOrder = () => json({ data: { id: orderId, status: 'completed', amount: 366.0 } });
const available = () => json({ data: [threeItems] });

async function fullRefund(): Promise<Sent[]> {
  const { runtime, sent } = harness([
    paidOrder,
    available,
    paidOrder,
    available,
    () => json({ data: { id: 'r-1', status: 'created', merchantOrderId: 'mcp-r' } }),
  ]);
  const args = { parent_order_id: orderId, description: 'полный возврат', amount: '36600' };
  const preview = (await createRefund.run(args, runtime)) as Record<string, unknown>;
  await createRefund.run({ ...args, confirmation_token: String(preview['confirmation_token']) }, runtime);
  return sent.filter((entry) => entry.method === 'POST');
}

test('полный возврат: цена без НДС считается на единицу, а не на всю позицию', async () => {
  const posts = await fullRefund();
  assert.equal(posts.length, 1);
  const item = (posts[0]?.body?.['basketItems'] as Array<Record<string, number>>)[0];
  assert.ok(item);
  const quantity = item['quantity'] ?? 0;
  const amountWoVat = item['amountWoVat'] ?? 0;
  const totalVat = item['totalVatAmount'] ?? 0;
  const total = item['totalAmount'] ?? 0;
  assert.equal(
    Number((amountWoVat * quantity + totalVat).toFixed(2)),
    total,
    `amountWoVat × quantity + НДС должно давать totalAmount, а вышло ${amountWoVat} × ${quantity} + ${totalVat}`,
  );
});

test('полный возврат: НДС шапки равен НДС позиций, а не нулю', async () => {
  const posts = await fullRefund();
  const body = posts[0]?.body ?? {};
  const items = body['basketItems'] as Array<Record<string, number>>;
  const vatOfLines = items.reduce((sum, item) => sum + (item['totalVatAmount'] ?? 0), 0);
  assert.equal(body['vatAmount'], vatOfLines);
  assert.equal(body['vatAmount'], 66.0, 'НДС берётся из availableVatAmount, отданного API');
});

test('полный возврат: несходящийся НДС в аргументах — отказ, а не молчаливая подмена', async () => {
  const { runtime, sent } = harness([paidOrder, available]);
  await assert.rejects(
    createRefund.run({ parent_order_id: orderId, description: 'возврат', amount: '36600', vat_amount: '100' }, runtime),
    (error: unknown) => {
      assert.match(String((error as Error).message), /НДС возврата не сходится/);
      return true;
    },
  );
  assert.equal(sent.filter((entry) => entry.method === 'POST').length, 0);
});

test('счёт: цена единицы без НДС по умолчанию делится на количество', async () => {
  const { runtime, sent } = harness([() => json({ data: { id: orderId, status: 'created' } })]);
  const args = {
    description: 'счёт на три штуки',
    customer: { type: 'legal' as const, name: 'ООО «Ромашка»', vat_number: '7707083893' },
    basket_items: [
      {
        sku: 'SKU-3',
        name: 'Три штуки',
        type: 'commodity' as const,
        measure: 'шт',
        quantity: 3,
        amount: '12200',
        total_amount: '36600',
        total_vat_amount: '6600',
        vat_code: 'RUS_VAT22' as const,
        payment_type: 'full_payment' as const,
      },
    ],
    amount: '36600',
    vat_amount: '6600',
    currency_id: 'RUB' as const,
    language_id: 'ru' as const,
    expiration_date: '2026-08-12T10:00:00+03:00',
  };
  const preview = (await createOrder.run(args, runtime)) as Record<string, unknown>;
  await createOrder.run({ ...args, confirmation_token: String(preview['confirmation_token']) }, runtime);

  const post = sent.find((entry) => entry.method === 'POST');
  const item = (post?.body?.['basketItems'] as Array<Record<string, number>>)[0];
  assert.equal(item?.['amountWoVat'], 100.0, 'три штуки по 122,00 с НДС 22 % — это 100,00 без НДС за штуку');
});

test('сверка корзины ловит цену без НДС, посчитанную на всю позицию', () => {
  const problems = reconcileBasket(
    [{ name: 'Три штуки', quantity: 3, amount: 12_200, amountWoVat: 30_000, totalAmount: 36_600, totalVatAmount: 6_600 }],
    { amount: 36_600, vatAmount: 6_600 },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.message ?? '', /цена одной единицы без НДС/);
});

test('потолок по сумме работает и в хранилище в памяти: контракт save соблюдён', async () => {
  const store = new MemoryOperationStore();
  await store.save(
    {
      key: 'k-1',
      tool: 'create_refund',
      tenant: DEMO_MERCHANT_ID,
      status: 'done',
      at: new Date(now - 60_000).toISOString(),
    },
    500_000,
  );
  const counted = await store.countSince('create_refund', new Date(now - 24 * 3_600_000).toISOString(), DEMO_MERCHANT_ID);
  assert.equal(counted.amountMinor, 500_000, 'сумма, переданная в save, должна учитываться потолком');
});

test('остаток отгрузок берётся фильтром по заказу: один запрос вместо перебора страниц', async () => {
  const shipmentArgs = {
    order_id: orderId,
    basket_items: [
      {
        sku: 'SKU-1',
        name: 'Позиция',
        type: 'commodity' as const,
        measure: 'шт',
        quantity: 1,
        amount: '12200',
        total_amount: '12200',
        total_vat_amount: '2200',
        vat_code: 'RUS_VAT22' as const,
        payment_type: 'full_payment' as const,
      },
    ],
    final: true,
  };
  const order = () => json({ data: { id: orderId, status: 'completed', amount: 122.0 } });
  const noShipments = () => json({ data: [], metaData: { totalCount: 0, page: 1, pageSize: 50 } });
  const { runtime, sent } = harness([
    order,
    noShipments,
    order,
    noShipments,
    () => json({ data: { id: 501, status: 'draft' } }),
  ]);

  const preview = (await createShipment.run(shipmentArgs, runtime)) as Record<string, unknown>;
  await createShipment.run({ ...shipmentArgs, confirmation_token: String(preview['confirmation_token']) }, runtime);

  const shipmentReads = sent.filter((entry) => entry.method === 'GET' && entry.path.includes('/order/shipment'));
  assert.equal(shipmentReads.length, 2, 'по одному запросу отгрузок на каждую фазу, без перебора страниц');
  for (const read of shipmentReads) assert.match(read.path, /orderId=01771534-1a57-f184-dee3-ebeb91dded75/);
});

test('брошенная отгрузка восстанавливается по номеру документа', async () => {
  const shipmentArgs = {
    order_id: orderId,
    document_number: 'НАКЛ-77',
    basket_items: [
      {
        sku: 'SKU-1',
        name: 'Позиция',
        type: 'commodity' as const,
        measure: 'шт',
        quantity: 1,
        amount: '12200',
        total_amount: '12200',
        total_vat_amount: '2200',
        vat_code: 'RUS_VAT22' as const,
        payment_type: 'full_payment' as const,
      },
    ],
    final: false,
  };
  const order = () => json({ data: { id: orderId, status: 'completed', amount: 244.0 } });
  const noShipments = () => json({ data: [], metaData: { totalCount: 0, page: 1, pageSize: 50 } });
  const withOurs = () =>
    json({
      data: [
        {
          id: 777,
          orderId,
          status: 'completed',
          documentNumber: 'НАКЛ-77',
          createdAt: '2026-08-05T11:59:00+00:00',
          basketItems: [{ sku: 'SKU-1', totalAmount: 122.0 }],
        },
      ],
      metaData: { totalCount: 1, page: 1, pageSize: 50 },
    });

  const { runtime, store } = harness([order, noShipments, order, noShipments, withOurs]);
  const { confirmation_token: _token, ...subject } = { ...shipmentArgs, confirmation_token: undefined };
  const key = operationKey({ tool: 'create_shipment', merchantId: DEMO_MERCHANT_ID, args: subject });
  await store.save({
    key,
    tool: 'create_shipment',
    tenant: DEMO_MERCHANT_ID,
    status: 'pending',
    at: new Date(now - 10 * 60_000).toISOString(),
    merchantOrderId: 'mcp-20260805-stale',
  });

  const preview = (await createShipment.run(shipmentArgs, runtime)) as Record<string, unknown>;
  const result = (await createShipment.run(
    { ...shipmentArgs, confirmation_token: String(preview['confirmation_token']) },
    runtime,
  )) as Record<string, unknown>;

  assert.equal(result['recovered'], true);
  assert.equal(result['shipment_id'], 777);
  assert.equal((await store.find(key))?.status, 'done');
});
