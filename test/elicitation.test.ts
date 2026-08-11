import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client.js';
import { Confirmations } from '../src/core/confirmation.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore } from '../src/core/idempotency.js';
import { Journal } from '../src/log/journal.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DEFAULT_DAILY_LIMITS, DEMO_MERCHANT_ID, loadConfig } from '../src/config.js';
import { cancelOrder } from '../src/tools/writes.js';
import type { ElicitOutcome, ToolRuntime } from '../src/tools/registry.js';

const config = loadConfig({
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
  INVOICEBOX_TOOLSETS: 'write',
});

const now = Date.parse('2026-08-05T00:00:00.000Z');
const orderId = '01771534-1a57-f184-dee3-ebeb91dded75';
const args = { order_id: orderId, reason: 'клиент отказался' };

function runtimeWith(answer: ElicitOutcome | undefined, responses: Array<() => Response>) {
  const asked: string[] = [];
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
    ...(answer === undefined
      ? {}
      : {
          elicit: async (request) => {
            asked.push(request.message);
            return answer;
          },
        }),
  };
  return { runtime, asked };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('где клиент умеет спрашивать, подтверждение идёт одним вызовом', async () => {
  const { runtime, asked } = runtimeWith({ action: 'accept' }, [
    () => json({ data: { id: orderId, status: 'created', amount: 122.0, merchantOrderId: 'mcp-1' } }),
    () => json({ data: { id: orderId, status: 'canceled' } }),
  ]);
  const result = (await cancelOrder.run(args, runtime)) as Record<string, unknown>;
  assert.equal(result['status'], 'canceled');
  assert.equal(asked.length, 1);
  assert.match(asked[0] ?? '', /cancel_order/);
});

test('ответ «нет» останавливает операцию до обращения к API', async () => {
  const { runtime } = runtimeWith({ action: 'decline' }, [
    () => json({ data: { id: orderId, status: 'created', amount: 122.0 } }),
  ]);
  await assert.rejects(cancelOrder.run(args, runtime), /человек не подтвердил/);
});

test('закрытый диалог подтверждения — тоже не подтверждение', async () => {
  const { runtime } = runtimeWith({ action: 'cancel' }, [
    () => json({ data: { id: orderId, status: 'created', amount: 122.0 } }),
  ]);
  await assert.rejects(cancelOrder.run(args, runtime), (error: unknown) => {
    assert.match(String((error as Error).message), /не подтвердил/);
    assert.match(String((error as { details?: { hint?: string } }).details?.hint), /диалог подтверждения закрыт/);
    return true;
  });
});

test('без элиситации остаётся двухфазная схема', async () => {
  const { runtime } = runtimeWith(undefined, [
    () => json({ data: { id: orderId, status: 'created', amount: 122.0 } }),
  ]);
  const preview = (await cancelOrder.run(args, runtime)) as Record<string, unknown>;
  assert.equal(preview['confirmation_required'], true);
});
