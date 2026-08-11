import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore } from '../src/core/idempotency.js';
import { Journal, type JournalRecord, type JournalSink } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig, type Config } from '../src/config.js';
import { buildServer, summarizeMetrics } from '../src/server.js';

const now = Date.parse('2026-08-04T20:00:00.000Z');
const orderId = '01771534-1a57-f184-dee3-ebeb91dded75';

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
    INVOICEBOX_ENV: 'demo',
    INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
    INVOICEBOX_TOOLSETS: 'write,refund',
    ...overrides,
  });
}

function serverWith(cfg: Config, records: JournalRecord[] = []) {
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
        baseUrl: cfg.apiUrl,
        token: cfg.token,
        userAgent: 'test',
        limiter: new RateLimiter({ limit: cfg.rateLimit, sleep: async () => {} }),
        sleep: async () => {},
        now: () => now,
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: { id: orderId, status: 'created' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
      config: cfg,
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
  amount: '20000000',
  total_amount: '20000000',
  total_vat_amount: '3606557',
  vat_code: 'RUS_VAT22',
};

const bigOrder = {
  description: 'Поставка оборудования',
  customer: { type: 'legal', name: 'ООО «Ромашка»', vat_number: '7701234560', tax_registration_reason_code: '770101001' },
  basket_items: [line],
  amount: '20000000',
  vat_amount: '3606557',
  currency_id: 'RUB',
  expiration_date: '2026-08-11T00:00:00+00:00',
};

function payload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

test('сумма выше порога требует подтверждения самой суммы', async () => {
  const { invoke } = serverWith(config());
  const preview = payload(await invoke('create_order', bigOrder));
  assert.equal(preview['confirm_amount_required'], true);
  assert.match(String(preview['next_step']), /confirm_amount/);

  const refused = payload(await invoke('create_order', { ...bigOrder, confirmation_token: preview['confirmation_token'] }));
  assert.equal(refused['ok'], false);
  assert.match(String(refused['reason']), /выше порога/);

  const done = payload(
    await invoke('create_order', {
      ...bigOrder,
      confirmation_token: preview['confirmation_token'],
      confirm_amount: '20000000',
    }),
  );
  assert.equal(done['order_id'], orderId);
});

test('порог настраивается: при высоком пороге подтверждение суммы не требуется', async () => {
  const { invoke } = serverWith(config({ INVOICEBOX_CONFIRM_THRESHOLD: '900000000' }));
  const preview = payload(await invoke('create_order', bigOrder));
  assert.equal(preview['confirm_amount_required'], undefined);
});

test('ссылки возврата на адреса Инвойсбокса отклоняются', async () => {
  const { invoke } = serverWith(config());
  const refused = payload(
    await invoke('create_order', { ...bigOrder, success_url: 'https://docs.invoicebox.ru/demo/return/' }),
  );
  assert.equal(refused['ok'], false);
  assert.match(String(refused['reason']), /параметры не приняты/);
});

test('валюта не подставляется молча: без неё вызов не проходит', async () => {
  const { invoke } = serverWith(config());
  const { currency_id: _currency, ...withoutCurrency } = bigOrder;
  const refused = payload(await invoke('create_order', withoutCurrency));
  assert.equal(refused['ok'], false);
});

test('в ответе назван контекст: от чьего имени выполнен вызов', async () => {
  const { invoke } = serverWith(config());
  const result = payload(await invoke('get_order', { order_id: orderId, response_format: 'concise' }));
  assert.match(String(result['scope_context']), new RegExp(`магазин ${DEMO_MERCHANT_ID}`));
});

test('в каждом ответе назван эмитент: чужой сервер может объявить такие же имена', async () => {
  const { invoke } = serverWith(config());
  const ok = payload(await invoke('get_order', { order_id: orderId, response_format: 'concise' }));
  assert.match(String(ok['issuer']), /Инвойсбокс/);

  const refused = payload(await invoke('get_order', { response_format: 'concise' }));
  assert.match(String(refused['issuer']), /Инвойсбокс/);
});

test('в сжатом ответе выборки нет данных плательщика', async () => {
  const { invoke } = serverWith(config());
  const result = payload(await invoke('find_orders', { page: 1, page_size: 20, response_format: 'concise' }));
  const serialized = JSON.stringify(result['orders'] ?? []);
  assert.ok(!serialized.includes('customer'), 'контрагент попадает в сжатый ответ');
  assert.ok(!serialized.includes('email'));
});

test('метрики считают вызовы, отказы до API и подтверждения', async () => {
  const { invoke, metrics } = serverWith(config());
  await invoke('get_order', { order_id: orderId, response_format: 'concise' });
  await invoke('get_order', { response_format: 'concise' });
  await invoke('create_order', bigOrder);

  const summary = summarizeMetrics(metrics);
  assert.equal(summary['total'], 3);
  assert.equal(summary['refused_before_api'], 1);
  assert.equal(summary['confirmations_issued'], 1);
  assert.equal((summary['calls'] as Record<string, number>)['get_order'], 2);
  assert.ok(typeof summary['duration_ms_p95'] === 'number');
});

test('на уровне debug в журнал идут имена и размеры полей, а не значения', async () => {
  const records: JournalRecord[] = [];
  const { invoke } = serverWith(config({ INVOICEBOX_LOG_LEVEL: 'debug' }), records);
  await invoke('get_order', { order_id: orderId, response_format: 'concise' });

  const args = records[0]?.args as Record<string, unknown>;
  assert.equal(args['order_id'], `string(${orderId.length})`);
  assert.ok(!JSON.stringify(records[0]).includes(orderId));
});
