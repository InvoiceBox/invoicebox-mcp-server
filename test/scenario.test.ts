import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore } from '../src/core/idempotency.js';
import { Journal, type JournalRecord, type JournalSink } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const config = loadConfig({
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
  INVOICEBOX_TOOLSETS: 'write,refund',
});

const now = Date.parse('2026-08-04T20:00:00.000Z');
const orderId = '01771534-1a57-f184-dee3-ebeb91dded75';

/** Подменённый Инвойсбокс: держит один заказ, отгрузки и возвраты, как это делает API. */
class FakeInvoicebox {
  status = 'created';
  shipments: Array<{ id: number; orderId: string; status: string; basketItems: Array<{ sku: string; totalAmount: number }> }> = [];
  refunds: Array<{ id: string; amount: number }> = [];
  refunded = 0;
  readonly requests: string[] = [];

  constructor(readonly amount = 122.0) {}

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    this.requests.push(`${method} ${path}`);
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);

    if (method === 'POST' && path.endsWith('/order/order')) {
      return this.json({
        data: { id: orderId, merchantOrderId: body?.['merchantOrderId'], status: 'created', paymentUrl: 'https://pay/1' },
      });
    }
    if (method === 'GET' && path.endsWith(`/order/order/${orderId}`)) {
      return this.json({ data: { id: orderId, merchantOrderId: 'mcp-1', status: this.status, amount: this.amount, customer: { name: 'ООО «Ромашка»' } } });
    }
    if (method === 'GET' && path.endsWith('/refund-basket-item')) {
      const available = this.amount - this.refunded;
      return this.json({ data: [{ sku: 'SKU-1', name: 'Бронирование номера', availableAmount: available, amount: this.amount, quantity: 1, vatCode: 'RUS_VAT22' }] });
    }
    if (method === 'GET' && path.endsWith('/order/shipment')) {
      return this.json({ data: this.shipments, metaData: { totalCount: this.shipments.length, page: 1, pageSize: 20 } });
    }
    if (method === 'POST' && path.endsWith('/order/shipment')) {
      const items = (body?.['basketItems'] as Array<{ sku: string; totalAmount: number }>) ?? [];
      const shipment = { id: this.shipments.length + 1, orderId, status: 'completed', basketItems: items };
      this.shipments.push(shipment);
      return this.json({ data: shipment });
    }
    if (method === 'POST' && path.endsWith('/order/refund-order')) {
      const amount = Number(body?.['amount'] ?? 0);
      this.refunded += amount;
      const refund = { id: `r-${this.refunds.length + 1}`, amount };
      this.refunds.push(refund);
      return this.json({ data: { id: refund.id, merchantOrderId: body?.['merchantOrderId'], status: 'created' } });
    }
    if (method === 'GET' && path.endsWith('/filter/api/order/order')) {
      return this.json({ data: [{ id: orderId, merchantOrderId: 'mcp-1', status: this.status, amount: this.amount }], metaData: { totalCount: 1, page: 1, pageSize: 20 } });
    }
    return this.json({ data: [] });
  };

  private json(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-scenario' },
    });
  }
}

function serverOn(api: FakeInvoicebox, records: JournalRecord[]) {
  const sink: JournalSink = {
    write: (record) => {
      records.push(record);
    },
  };
  const store = new MemoryOperationStore();
  return buildServer({
    version: '0.1.0',
    clientIp: 'stdio',
    runtime: {
      api: new ApiClient({
        baseUrl: config.apiUrl,
        token: config.token,
        userAgent: 'test',
        limiter: new RateLimiter({ limit: config.rateLimit, sleep: async () => {} }),
        sleep: async () => {},
        now: () => now,
        fetchImpl: api.fetch,
      }),
      config,
      journal: new Journal([sink]),
      confirmations: new Confirmations({ now: () => now }),
      store,
      ledger: new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => now),
      userId: 'u-1',
      now: () => now,
    },
  });
}

const line = {
  sku: 'SKU-1',
  name: 'Бронирование номера',
  measure: 'шт',
  quantity: 1,
  amount: '12200',
  total_amount: '12200',
  total_vat_amount: '2200',
  vat_code: 'RUS_VAT22',
};

const halfLine = { ...line, amount: '6100', total_amount: '6100', total_vat_amount: '1100' };

function payload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function confirmed(
  invoke: (name: string, args: unknown) => Promise<{ content: Array<{ text: string }> }>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const preview = payload(await invoke(name, args));
  assert.equal(preview['confirmation_required'], true, `${name}: первый вызов должен вернуть сводку`);
  return payload(await invoke(name, { ...args, confirmation_token: preview['confirmation_token'] }));
}

test('сквозной сценарий: счёт юрлицу, оплата, две отгрузки, возврат по составу', async () => {
  const api = new FakeInvoicebox();
  const records: JournalRecord[] = [];
  const { invoke } = serverOn(api, records);

  const created = await confirmed(invoke, 'create_order', {
    description: 'Оплата номера в отеле',
    customer: { type: 'legal', name: 'ООО «Ромашка»', vat_number: '7701234560', tax_registration_reason_code: '770101001' },
    basket_items: [line],
    amount: '12200',
    vat_amount: '2200',
    currency_id: 'RUB',
    expiration_date: '2026-08-11T00:00:00+00:00',
  });
  assert.equal(created['order_id'], orderId);
  assert.equal(created['payment_url'], 'https://pay/1');

  api.status = 'completed';
  const status = payload(await invoke('get_order', { order_id: orderId, response_format: 'detailed' }));
  assert.equal(status['status'], 'completed');

  const first = await confirmed(invoke, 'create_shipment', { order_id: orderId, basket_items: [halfLine], final: false });
  assert.equal(first['shipment_id'], 1);

  const between = payload(await invoke('find_shipments', { order_id: orderId, page: 1, page_size: 20, response_format: 'detailed' }));
  assert.equal((between['shipments'] as unknown[]).length, 1);

  const last = await confirmed(invoke, 'create_shipment', { order_id: orderId, basket_items: [halfLine], final: true });
  assert.equal(last['shipment_id'], 2);
  assert.equal(last['final'], true);

  const refund = await confirmed(invoke, 'create_refund', {
    parent_order_id: orderId,
    description: 'возврат по обращению',
    basket_items: [halfLine],
  });
  assert.equal(refund['refund_id'], 'r-1');
  assert.match(String(refund['timing_note']), /до двух рабочих дней/);

  assert.ok(api.requests.includes('POST /v3/billing/api/order/order'));
  assert.ok(api.requests.includes('POST /v3/billing/api/order/shipment'));
  assert.ok(api.requests.includes('POST /v3/billing/api/order/refund-order'));
  assert.ok(records.every((record) => record.environment === 'demo'));
});

test('счёт ИП: двенадцать цифр ИНН и пустой КПП принимаются', async () => {
  const api = new FakeInvoicebox();
  const { invoke } = serverOn(api, []);
  const result = await confirmed(invoke, 'create_order', {
    description: 'Разработка сайта',
    customer: { type: 'legal', name: 'ИП Иванов И. И.', vat_number: '500100732259' },
    basket_items: [line],
    amount: '12200',
    vat_amount: '2200',
    currency_id: 'RUB',
    expiration_date: '2026-08-11T00:00:00+00:00',
  });
  assert.equal(result['order_id'], orderId);
});

test('счёт физлицу: ИНН и КПП не нужны, предупреждений о документах нет', async () => {
  const api = new FakeInvoicebox();
  const { invoke } = serverOn(api, []);
  const result = await confirmed(invoke, 'create_order', {
    description: 'Курс английского',
    customer: { type: 'private', name: 'Иван Иванов', email: 'buh@example.invbox.ru' },
    basket_items: [line],
    amount: '12200',
    vat_amount: '2200',
    currency_id: 'RUB',
    expiration_date: '2026-08-11T00:00:00+00:00',
  });
  assert.equal(result['order_id'], orderId);
  assert.equal(result['warnings'], undefined);
});

test('третья отгрузка сверх остатка не проходит', async () => {
  const api = new FakeInvoicebox();
  const { invoke } = serverOn(api, []);
  api.status = 'completed';
  await confirmed(invoke, 'create_shipment', { order_id: orderId, basket_items: [halfLine], final: false });
  await confirmed(invoke, 'create_shipment', { order_id: orderId, basket_items: [halfLine], final: true });

  const refused = payload(await invoke('create_shipment', { order_id: orderId, basket_items: [halfLine], final: false }));
  assert.equal(refused['ok'], false);
  assert.match(String(refused['reason']), /выходит за остаток/);
});

test('второй возврат сверх остатка отклоняется по availableAmount', async () => {
  const api = new FakeInvoicebox();
  const { invoke } = serverOn(api, []);
  api.status = 'completed';
  await confirmed(invoke, 'create_refund', {
    parent_order_id: orderId,
    description: 'первый',
    amount: '6100',
    vat_amount: '1100',
    basket_items: [halfLine],
  });

  const refused = payload(await invoke('create_refund', { parent_order_id: orderId, description: 'второй', amount: '12200' }));
  assert.equal(refused['ok'], false);
  assert.match(String(refused['reason']), /к возврату доступно/);
});

test('в журнале сценария есть трассировка, инструмент и итог каждого вызова', async () => {
  const api = new FakeInvoicebox();
  const records: JournalRecord[] = [];
  const { invoke } = serverOn(api, records);
  await invoke('find_orders', { page: 1, page_size: 20, response_format: 'concise' });
  await invoke('get_order', { order_id: orderId, response_format: 'concise' });

  assert.equal(records.length, 2);
  for (const record of records) {
    assert.ok(record.traceId.length > 10);
    assert.ok(record.durationMs !== undefined);
    assert.equal(record.outcome, 'ok');
  }
});
