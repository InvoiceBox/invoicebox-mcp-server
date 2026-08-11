import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionAuth, type ExchangeOutcome } from '../src/core/sessionAuth.js';

/**
 * Аутентификация сессии. Проверяем не сеть, а решения: когда токен принят, когда
 * запомнен, когда забыт и какой отказ уходит клиенту.
 */

const ok = (overrides: Partial<{ access_token: string; expires_in: number; scope: string }> = {}): ExchangeOutcome => ({
  ok: true,
  value: {
    access_token: 'api-token',
    expires_in: 3600,
    scope: 'merchant-read merchant-order',
    ...overrides,
  },
});

test('токен принят — сессия получает токен для API и области', async () => {
  const auth = new SessionAuth({ exchange: async () => ok(), now: () => 1_000 });

  const outcome = await auth.authenticate('Bearer client-token');

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.session.apiToken, 'api-token');
  assert.deepEqual([...outcome.session.scopes], ['merchant-read', 'merchant-order']);
  assert.equal(outcome.session.expiresAt, 1_000 + 3_600_000);
});

test('второй вызов не ходит за обменом снова', async () => {
  let calls = 0;
  const auth = new SessionAuth({
    exchange: async () => {
      calls += 1;
      return ok();
    },
    now: () => 1_000,
  });

  await auth.authenticate('Bearer client-token');
  await auth.authenticate('Bearer client-token');

  // Иначе каждое чтение заказа стоило бы лишнего круга к серверу авторизации
  assert.equal(calls, 1);
});

test('к истечению срока сессия обменивается заново', async () => {
  let calls = 0;
  let now = 0;
  const auth = new SessionAuth({
    exchange: async () => {
      calls += 1;
      return ok({ expires_in: 60 });
    },
    now: () => now,
    skewMs: 30_000,
  });

  await auth.authenticate('Bearer client-token');
  // Осталось меньше запаса — обновляем заранее, чтобы вызов не упал уже в API
  now = 40_000;
  await auth.authenticate('Bearer client-token');

  assert.equal(calls, 2);
});

test('без заголовка — отказ 401, а не тишина', async () => {
  const auth = new SessionAuth({ exchange: async () => ok() });

  for (const header of [undefined, '', 'Basic abc', 'Bearer', 'Bearer   ']) {
    const outcome = await auth.authenticate(header);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 401);
  }
});

test('отказ обмена по токену клиента — это 401, по нашим учётным данным — 403', async () => {
  const rejected = new SessionAuth({
    exchange: async () => ({ ok: false, failure: { error: 'invalid_grant', description: 'expired' } }),
  });
  const misconfigured = new SessionAuth({
    exchange: async () => ({ ok: false, failure: { error: 'invalid_client' } }),
  });

  const first = await rejected.authenticate('Bearer client-token');
  const second = await misconfigured.authenticate('Bearer client-token');

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  if (first.ok || second.ok) return;
  // Клиенту нужно идти за новым токеном
  assert.equal(first.status, 401);
  assert.equal(first.error, 'invalid_token');
  // А здесь дело в нас: пусть клиент не переавторизовывается бесконечно
  assert.equal(second.status, 403);
});

test('неудачный обмен не запоминается', async () => {
  let calls = 0;
  const auth = new SessionAuth({
    exchange: async () => {
      calls += 1;
      return { ok: false, failure: { error: 'invalid_grant' } };
    },
  });

  await auth.authenticate('Bearer client-token');
  await auth.authenticate('Bearer client-token');

  assert.equal(calls, 2);
  assert.equal(auth.size, 0);
});

test('нехватка области — отдельный отказ с её именем', async () => {
  const auth = new SessionAuth({ exchange: async () => ok({ scope: 'merchant-read' }) });
  const outcome = await auth.authenticate('Bearer client-token');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const allowed = SessionAuth.requireScope(outcome.session, 'merchant-read');
  const denied = SessionAuth.requireScope(outcome.session, 'merchant-refund');

  assert.equal(allowed.ok, true);
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.status, 403);
  assert.equal(denied.error, 'insufficient_scope');
  // Имя области в тексте: по нему клиент запускает повышение прав
  assert.match(denied.description, /merchant-refund/);
});

test('сервер авторизации не сузил права — не додумываем за него', async () => {
  const auth = new SessionAuth({ exchange: async () => ok({ scope: '' }) });
  const outcome = await auth.authenticate('Bearer client-token');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(SessionAuth.requireScope(outcome.session, 'merchant-refund').ok, true);
});

test('закрытие соединения забывает сессию', async () => {
  const auth = new SessionAuth({ exchange: async () => ok() });
  await auth.authenticate('Bearer client-token');
  assert.equal(auth.size, 1);

  auth.forget('Bearer client-token');

  assert.equal(auth.size, 0);
});
