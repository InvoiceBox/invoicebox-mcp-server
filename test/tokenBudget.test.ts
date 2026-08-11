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

// Описания инструментов и ответы едут в контекст модели на каждом шаге разговора, поэтому
// их размер — такой же предмет проверки, как поведение. Пределы ниже не «идеал», а потолок:
// вырос — либо сокращаем формулировку, либо осознанно поднимаем потолок и объясняем зачем.
// Оценка в токенах — деление на 3,3 символа: для русского текста это близко к правде.
const LIST_LIMIT = 14_000;
const DESCRIPTION_LIMIT = 460;
const CONCISE_ORDER_LIMIT = 260;

const now = Date.parse('2026-08-04T20:00:00.000Z');

function apiOrder(index: number): Record<string, unknown> {
  return {
    id: `11111111-1111-1111-1111-00000000000${index}`,
    merchantOrderId: `SCH-${index}`,
    merchantId: DEMO_MERCHANT_ID,
    status: 'created',
    amount: 1_234_56,
    vatAmount: 222_82,
    currencyId: 'RUB',
    description: 'Оплата по счёту от 4 августа 2026 года, услуги за июль',
    createdAt: '2026-08-04T10:00:00+03:00',
    expirationDate: '2026-08-11T10:00:00+03:00',
    paymentUrl: 'https://pay.invoicebox.ru/order/11111111-1111-1111-1111-000000000001',
    customer: { name: 'ООО «Ромашка»', vatNumber: '7707083893' },
  };
}

function connected(orders: number, toolsets = 'write,refund') {
  const config = loadConfig({
    INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
    INVOICEBOX_ENV: 'demo',
    INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
    INVOICEBOX_TOOLSETS: toolsets,
  });
  const body = JSON.stringify({
    data: Array.from({ length: orders }, (_, index) => apiOrder(index + 1)),
    metaData: { totalCount: orders * 4, page: 1, pageSize: orders },
  });
  const store = new MemoryOperationStore();
  const { server, invoke } = buildServer({
    version: '0.1.0',
    clientIp: 'stdio',
    runtime: {
      api: new ApiClient({
        baseUrl: config.apiUrl,
        token: config.token,
        userAgent: 'test',
        limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
        fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
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
  return { server, invoke };
}

async function listed(toolsets?: string) {
  const { server } = connected(1, toolsets);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const list = await client.listTools();
  await server.close();
  return list;
}

test('описания инструментов укладываются в бюджет контекста', async () => {
  const list = await listed();
  const size = JSON.stringify(list.tools).length;
  console.log(`  tools/list: ${size} символов, ≈${Math.round(size / 3.3)} токенов на ${list.tools.length} инструментов`);
  assert.ok(size <= LIST_LIMIT, `tools/list вырос до ${size} символов при потолке ${LIST_LIMIT}`);
});

test('ни одно описание инструмента не превращается в инструкцию', async () => {
  const list = await listed();
  for (const tool of list.tools) {
    const length = (tool.description ?? '').length;
    assert.ok(length > 0, `${tool.name}: описание пустое`);
    assert.ok(length <= DESCRIPTION_LIMIT, `${tool.name}: описание ${length} символов при потолке ${DESCRIPTION_LIMIT}`);
  }
});

test('набор read дешевле полного: клиент платит только за то, что включил', async () => {
  const read = JSON.stringify((await listed('read')).tools).length;
  const full = JSON.stringify((await listed('write,refund')).tools).length;
  assert.ok(read < full, `read (${read}) должен быть дешевле полного набора (${full})`);
});

test('краткий ответ вместо подробного экономит больше половины', async () => {
  const { server, invoke } = connected(20);
  const concise = await invoke('find_orders', { page: 1, page_size: 20, response_format: 'concise' });
  const detailed = await invoke('find_orders', { page: 1, page_size: 20, response_format: 'detailed' });
  const conciseSize = (concise.content[0]?.text ?? '').length;
  const detailedSize = (detailed.content[0]?.text ?? '').length;
  console.log(`  find_orders на 20 заказах: краткий ${conciseSize}, подробный ${detailedSize} символов`);
  assert.ok(conciseSize * 2 < detailedSize, `краткий ${conciseSize} против подробного ${detailedSize}`);
  assert.ok(
    conciseSize / 20 < CONCISE_ORDER_LIMIT,
    `на заказ в кратком ответе уходит ${Math.round(conciseSize / 20)} символов при потолке ${CONCISE_ORDER_LIMIT}`,
  );
  await server.close();
});

test('усечение списка названо в ответе, а не оставлено на догадку модели', async () => {
  const { server, invoke } = connected(20);
  const result = await invoke('find_orders', { page: 1, page_size: 20, response_format: 'concise' });
  const payload = JSON.parse(result.content[0]?.text ?? '{}') as { truncated?: string; total_count?: number };
  assert.match(payload.truncated ?? '', /показано 20 из 80/);
  await server.close();
});

test('отказ по схеме не выедает контекст: сто позиций дают перечень полей, а не сто сообщений', async () => {
  const { server } = connected(1);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const broken = Array.from({ length: 100 }, (_, index) => ({
    sku: `SKU-${index}`,
    name: 'Позиция',
    quantity: 1,
    amount: '12200',
    total_amount: '12200',
    total_vat_amount: '2200',
    vat_code: 'НЕТ ТАКОЙ СТАВКИ',
  }));
  const result = (await client.callTool({
    name: 'create_order',
    arguments: {
      description: 'счёт',
      customer: { type: 'legal', name: 'ООО «Ромашка»', vat_number: '7707083893' },
      basket_items: broken,
      amount: '1220000',
      vat_amount: '220000',
      currency_id: 'RUB',
      expiration_date: '2026-08-12T10:00:00+03:00',
    },
  })) as { isError?: boolean; content: Array<{ text?: string }> };

  const text = result.content[0]?.text ?? '';
  console.log(`  отказ по схеме на 100 позициях: ${text.length} символов`);
  assert.equal(result.isError, true);
  assert.ok(text.length < 1_500, `отказ разросся до ${text.length} символов`);
  assert.match(text, /basket_items\.\*\.vat_code/, 'номера позиций сворачиваются в звёздочку');
  await server.close();
});

test('подробные отгрузки усечены по составу: страница не превращается в сотни тысяч токенов', async () => {
  const config = loadConfig({
    INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
    INVOICEBOX_ENV: 'demo',
    INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
  });
  const items = Array.from({ length: 100 }, (_, index) => ({
    sku: `SKU-${index}`,
    name: 'Позиция с довольно длинным наименованием, как в жизни',
    quantity: 1,
    totalAmount: 122.0,
  }));
  const body = JSON.stringify({
    data: Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      orderId: '11111111-1111-1111-1111-000000000001',
      status: 'completed',
      amount: 12_200.0,
      basketItems: items,
    })),
    metaData: { totalCount: 50, page: 1, pageSize: 50 },
  });
  const store = new MemoryOperationStore();
  const { invoke, server } = buildServer({
    version: '0.1.0',
    runtime: {
      api: new ApiClient({
        baseUrl: config.apiUrl,
        token: config.token,
        userAgent: 'test',
        limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
        fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
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

  const result = await invoke('find_shipments', { page: 1, page_size: 50, response_format: 'detailed' });
  const size = (result.content[0]?.text ?? '').length;
  console.log(`  find_shipments detailed, 50 отгрузок по 100 позиций: ${size} символов ≈ ${Math.round(size / 3.3)} токенов`);
  assert.ok(size < 40_000, `подробный ответ разросся до ${size} символов`);
  const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
    shipments: Array<{ basket_items?: unknown[]; basket_items_note?: string }>;
  };
  assert.equal(payload.shipments[0]?.basket_items?.length, 5);
  assert.match(payload.shipments[0]?.basket_items_note ?? '', /5 позиций из 100/);
  await server.close();
});

test('страница ограничена сверху: одним вызовом контекст не выесть', () => {
  const findOrders = CATALOG.find((tool) => tool.name === 'find_orders');
  const parsed = findOrders?.schema.safeParse({ page: 1, page_size: 500, response_format: 'concise' });
  assert.equal(parsed?.success, false);
  const byDefault = findOrders?.schema.parse({}) as { page_size?: number; response_format?: string };
  assert.equal(byDefault.page_size, 20);
  assert.equal(byDefault.response_format, 'concise');
});
