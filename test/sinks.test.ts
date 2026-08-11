import { strict as assert } from 'node:assert';
import { createSocket } from 'node:dgram';
import { test } from 'node:test';
import { GraylogSink, SentrySink } from '../src/log/sinks.js';
import type { JournalRecord } from '../src/log/journal.js';

const record: JournalRecord = {
  traceId: '01234567-89ab-cdef-0123-456789abcdef',
  at: '2026-08-04T20:00:00.000Z',
  tool: 'create_refund',
  environment: 'demo',
  outcome: 'api_error',
  reason: 'API ответил 500',
  apiRequestId: 'req-5',
  merchantId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  args: { customer: { email: 'buh@example.invbox.ru' }, token: 'b37c4c689295904ed21eee5d9a48d42e' },
};

test('в GELF уходит запись без секретов и с уровнем по итогу', async () => {
  const received: string[] = [];
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  socket.on('message', (message) => received.push(message.toString('utf8')));
  const port = socket.address().port;

  const sink = new GraylogSink({ url: `udp://127.0.0.1:${port}` });
  await sink.write(record);
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.close();

  assert.equal(received.length, 1);
  const message = JSON.parse(received[0] ?? '{}') as Record<string, unknown>;
  assert.equal(message['version'], '1.1');
  assert.equal(message['level'], 3);
  assert.equal(message['_tool'], 'create_refund');
  assert.ok(!(received[0] ?? '').includes('b37c4c689295904ed21eee5d9a48d42e'));
  assert.ok(!(received[0] ?? '').includes('buh@example.invbox.ru'));
});

test('приёмник GELF принимает только udp и tcp', () => {
  assert.throws(() => new GraylogSink({ url: 'https://gelf.example.ru:12201' }), /udp и tcp/);
});

test('Sentry получает только отказы, тел запросов в отправке нет', async () => {
  const calls: Array<{ url: string; body: string; auth: string }> = [];
  const sink = new SentrySink({
    dsn: 'https://key@sentry.example.ru/42',
    environment: 'demo',
    release: '0.1.0',
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        body: String(init?.body ?? ''),
        auth: String((init?.headers as Record<string, string>)['X-Sentry-Auth'] ?? ''),
      });
      return new Response('{}', { status: 200 });
    },
  });

  await sink.write({ ...record, outcome: 'ok' });
  await sink.write({ ...record, outcome: 'rejected_by_server' });
  assert.equal(calls.length, 0, 'удачные вызовы и отказы проверок наружу не уходят');

  await sink.write(record);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://sentry.example.ru/api/42/store/');
  assert.match(calls[0]?.auth ?? '', /sentry_key=key/);
  assert.ok(!(calls[0]?.body ?? '').includes('b37c4c689295904ed21eee5d9a48d42e'));
  assert.ok(!(calls[0]?.body ?? '').includes('buh@example.invbox.ru'));
  assert.match(calls[0]?.body ?? '', /API ответил 500/);
});

test('битый DSN отклоняется на старте, а не при первой ошибке', () => {
  assert.throws(() => new SentrySink({ dsn: 'https://sentry.example.ru/', environment: 'demo', release: '0.1.0' }), /DSN/);
});
