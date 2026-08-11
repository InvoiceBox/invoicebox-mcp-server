import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, fingerprint } from '../src/core/canonical.js';
import { FileOperationStore, operationKey } from '../src/core/idempotency.js';

test('ключ считается по содержимому, а не по порядку полей', () => {
  const left = operationKey({ tool: 'create_order', merchantId: 'm', args: { amount: '12200', description: 'Счёт' } });
  const right = operationKey({ tool: 'create_order', merchantId: 'm', args: { description: 'Счёт', amount: '12200' } });
  assert.equal(left, right);
});

test('изменение суммы меняет ключ', () => {
  const left = operationKey({ tool: 'create_order', args: { amount: '12200' } });
  const right = operationKey({ tool: 'create_order', args: { amount: '12300' } });
  assert.notEqual(left, right);
});

test('undefined не влияет на отпечаток, а null влияет', () => {
  assert.equal(fingerprint({ a: 1, b: undefined }), fingerprint({ a: 1 }));
  assert.notEqual(fingerprint({ a: 1, b: null }), fingerprint({ a: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('повтор с тем же содержимым возвращает прежнюю операцию после перезапуска', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ib-ops-'));
  const key = operationKey({ tool: 'create_shipment', args: { orderId: 'o-1' } });
  const first = new FileOperationStore(dir);
  await first.save({ key, tool: 'create_shipment', status: 'pending', at: '2026-08-04T20:00:00.000Z' });
  await first.save({
    key,
    tool: 'create_shipment',
    status: 'done',
    at: '2026-08-04T20:00:01.000Z',
    result: { id: 2 },
  });

  const restarted = new FileOperationStore(dir);
  const found = await restarted.find(key);
  assert.equal(found?.status, 'done');
  assert.deepEqual(found?.result, { id: 2 });
});

test('неизвестный результат сохраняется отдельным состоянием', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ib-ops-'));
  const store = new FileOperationStore(dir);
  await store.save({
    key: 'k1',
    tool: 'create_order',
    status: 'unknown',
    at: '2026-08-04T20:00:00.000Z',
    reason: 'таймаут',
  });
  const found = await store.find('k1');
  assert.equal(found?.status, 'unknown');
  assert.equal(found?.reason, 'таймаут');
});

test('суточный счётчик считает завершённые операции и суммы', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ib-ops-'));
  const store = new FileOperationStore(dir);
  await store.save({ key: 'a', tool: 'create_refund', status: 'done', at: '2026-08-04T10:00:00.000Z' }, 10_000);
  await store.save({ key: 'b', tool: 'create_refund', status: 'done', at: '2026-08-04T11:00:00.000Z' }, 5_000);
  await store.save({ key: 'c', tool: 'create_refund', status: 'pending', at: '2026-08-04T12:00:00.000Z' }, 99_000);
  const spent = await store.countSince('create_refund', '2026-08-04T00:00:00.000Z');
  assert.deepEqual(spent, { count: 2, amountMinor: 15_000 });
});

test('второй процесс видит операции первого: снимок файла не кэшируется навсегда', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ib-ops-'));
  const first = new FileOperationStore(dir);
  const second = new FileOperationStore(dir);

  // Второй читает пустоту и запоминает её — именно здесь и жил дефект
  assert.equal(await second.find('k-1'), undefined);
  assert.equal((await second.countSince('create_refund', '2026-08-04T00:00:00.000Z')).count, 0);

  await first.save(
    { key: 'k-1', tool: 'create_refund', tenant: 'm-1', status: 'done', at: '2026-08-05T10:00:00.000Z' },
    250_000,
  );

  assert.equal((await second.find('k-1'))?.status, 'done', 'операция первого процесса должна быть видна второму');
  const counted = await second.countSince('create_refund', '2026-08-04T00:00:00.000Z', 'm-1');
  assert.equal(counted.count, 1);
  assert.equal(counted.amountMinor, 250_000);
});
