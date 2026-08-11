import { strict as assert } from 'node:assert';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileSink, Journal, StderrSink, type JournalRecord, type JournalSink } from '../src/log/journal.js';

const record: JournalRecord = {
  traceId: '01J8',
  at: '2026-08-04T20:00:00.000Z',
  tool: 'create_order',
  environment: 'demo',
  outcome: 'ok',
  args: { customer: { email: 'buh@example.invbox.ru' }, token: 'b37c4c689295904ed21eee5d9a48d42e' },
};

test('в stderr уходит одна строка JSON без секретов', () => {
  const lines: string[] = [];
  new StderrSink('info', { write: (text) => lines.push(text) }).write(record);
  assert.equal(lines.length, 1);
  assert.ok(!(lines[0] ?? '').includes('b37c4c689295904ed21eee5d9a48d42e'));
  assert.ok(!(lines[0] ?? '').includes('buh@example.invbox.ru'));
  assert.equal((lines[0] ?? '').trimEnd().split('\n').length, 1);
});

test('на уровне warn удачные вызовы не пишутся, отказы пишутся', () => {
  const lines: string[] = [];
  const sink = new StderrSink('warn', { write: (text) => lines.push(text) });
  sink.write(record);
  sink.write({ ...record, outcome: 'api_error', reason: 'сумма не сходится' });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /api_error/);
});

test('файл журнала пишется в каталог состояния', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ib-mcp-'));
  await new FileSink(dir).write(record);
  const files = await readdir(dir);
  assert.deepEqual(files, ['audit-2026-08-04.jsonl']);
  const content = await readFile(join(dir, files[0] as string), 'utf8');
  assert.ok(content.endsWith('\n'));
  assert.ok(!content.includes('b37c4c689295904ed21eee5d9a48d42e'));
});

test('недоступный приёмник не роняет вызов и сообщает о себе один раз', async () => {
  const errors: unknown[] = [];
  const broken: JournalSink = {
    write() {
      throw new Error('graylog недоступен');
    },
  };
  const journal = new Journal([broken], 256, (error) => errors.push(error));
  journal.record(record);
  journal.record(record);
  await journal.drain();
  assert.equal(errors.length, 1);
});

test('переполненная очередь отбрасывает записи, а не растёт', async () => {
  let written = 0;
  const slow: JournalSink = {
    write: () => new Promise((resolve) => setTimeout(() => { written += 1; resolve(); }, 5)),
  };
  const journal = new Journal([slow], 3);
  for (let i = 0; i < 10; i += 1) journal.record(record);
  await journal.drain();
  assert.ok(written <= 3, `записей ${written}`);
});
