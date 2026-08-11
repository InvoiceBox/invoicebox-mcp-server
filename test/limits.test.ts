import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_DAILY_LIMITS } from '../src/config.js';
import { DailyLedger } from '../src/core/limits.js';
import { MemoryOperationStore } from '../src/core/idempotency.js';

const noon = Date.parse('2026-08-04T12:00:00.000Z');

test('потолок по числу возвратов называет цифры', async () => {
  const store = new MemoryOperationStore();
  for (let i = 0; i < 10; i += 1) {
    await store.save({ key: `k${i}`, tool: 'create_refund', status: 'done', at: '2026-08-04T09:00:00.000Z' });
  }
  const ledger = new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => noon);
  await assert.rejects(ledger.assertAllowed({ tool: 'create_refund' }), /10 из 10 за сутки/);
});

test('потолок по сумме считает уже потраченное', async () => {
  const store = new MemoryOperationStore();
  await store.save({ key: 'a', tool: 'create_refund', status: 'done', at: '2026-08-04T09:00:00.000Z' }, 4_900_000);
  const ledger = new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => noon);
  await ledger.assertAllowed({ tool: 'create_refund', amountMinor: 100_000 });
  await assert.rejects(ledger.assertAllowed({ tool: 'create_refund', amountMinor: 200_000 }), /потолок по сумме/);
});

test('операции прошлых суток потолок не занимают', async () => {
  const store = new MemoryOperationStore();
  for (let i = 0; i < 10; i += 1) {
    await store.save({ key: `k${i}`, tool: 'create_refund', status: 'done', at: '2026-08-03T09:00:00.000Z' });
  }
  const ledger = new DailyLedger(store, DEFAULT_DAILY_LIMITS, () => noon);
  await ledger.assertAllowed({ tool: 'create_refund' });
});
