import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Cache, ttlFromCacheControl } from '../src/core/cache.js';
import { readTokenFile, writeTokenFile } from '../src/core/tokenStore.js';

function fixed(start = 1_000_000) {
  let clock = start;
  return { now: () => clock, advance: (ms: number) => (clock += ms) };
}

test('значение живёт до истечения срока и исчезает после', () => {
  const clock = fixed();
  const cache = new Cache<string>({ ttlMs: 1000, jitterRatio: 0, now: clock.now });
  cache.set('a', 'значение');
  assert.equal(cache.get('a'), 'значение');
  clock.advance(1001);
  assert.equal(cache.get('a'), undefined);
});

test('срок жизни получает случайную добавку: иначе всё истекает одновременно', () => {
  const clock = fixed();
  const cache = new Cache<string>({ ttlMs: 1000, jitterRatio: 0.5, now: clock.now, random: () => 1 });
  cache.set('a', 'значение');
  clock.advance(1400);
  assert.equal(cache.get('a'), 'значение', 'добавка 50 % должна продлить срок');
  clock.advance(200);
  assert.equal(cache.get('a'), undefined);
});

test('просроченное значение остаётся для деградации', () => {
  const clock = fixed();
  const cache = new Cache<string>({ ttlMs: 1000, jitterRatio: 0, now: clock.now });
  cache.set('a', 'справочник', { etag: 'W/"1"' });
  clock.advance(5000);
  const stale = cache.getStale('a');
  assert.equal(stale?.value, 'справочник');
  assert.equal(stale?.stale, true);
  assert.equal(stale?.etag, 'W/"1"');
});

test('переполнение вытесняет самое старое, а не растёт бесконечно', () => {
  const cache = new Cache<number>({ ttlMs: 1000, jitterRatio: 0, maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('Cache-Control строже нашего срока уважается', () => {
  assert.equal(ttlFromCacheControl('no-store', 60_000), 0);
  assert.equal(ttlFromCacheControl('public, max-age=30', 60_000), 30_000);
  assert.equal(ttlFromCacheControl('public, max-age=6000', 60_000), 60_000);
  assert.equal(ttlFromCacheControl(null, 60_000), 60_000);
});

test('файл токена пишется с правами только для владельца', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ib-token-'));
  const path = join(dir, 'mcp-token');
  await writeTokenFile('b37c4c689295904ed21eee5d9a48d42e', path);

  const content = await readFile(path, 'utf8');
  assert.equal(content.trim(), 'b37c4c689295904ed21eee5d9a48d42e');

  const read = await readTokenFile(path);
  assert.equal(read?.token, 'b37c4c689295904ed21eee5d9a48d42e');
  assert.deepEqual(read?.warnings, []);

  if (process.platform !== 'win32') {
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);
  }
});

test('короткий токен в файл не пишется', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ib-token-'));
  await assert.rejects(writeTokenFile('123', join(dir, 'mcp-token')), /короче восьми/);
});

test('отсутствующий файл не ошибка: токен может приходить из окружения', async () => {
  assert.equal(await readTokenFile(join(tmpdir(), 'нет-такого-файла-мcp')), undefined);
});
