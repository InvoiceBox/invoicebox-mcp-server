import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Confirmations } from '../src/core/confirmation.js';
import { Refusal } from '../src/core/errors.js';

const subject = { tool: 'create_refund', userId: 'u-1', args: { parentOrderId: 'o-1', amount: '12200' } };

function fixed(start = 1_000_000) {
  let clock = start;
  return { confirmations: new Confirmations({ now: () => clock }), advance: (ms: number) => (clock += ms) };
}

test('свой токен принимается один раз', () => {
  const { confirmations } = fixed();
  const { token } = confirmations.issue(subject);
  confirmations.verify(token, subject);
  assert.throws(() => confirmations.verify(token, subject), /уже использовано/);
});

test('изменённая сумма делает токен недействительным', () => {
  const { confirmations } = fixed();
  const { token } = confirmations.issue(subject);
  assert.throws(
    () => confirmations.verify(token, { ...subject, args: { parentOrderId: 'o-1', amount: '12300' } }),
    /параметры изменились/,
  );
});

test('чужой токен не проходит: подпись своя у каждого процесса', () => {
  const mine = fixed();
  const other = fixed();
  const { token } = other.confirmations.issue(subject);
  assert.throws(
    () => mine.confirmations.verify(token, subject),
    (error: unknown) => {
      assert.ok(error instanceof Refusal);
      assert.equal(error.code, 'confirmation_invalid');
      return true;
    },
  );
});

test('просроченный токен отклоняется с указанием срока', () => {
  const { confirmations, advance } = fixed();
  const { token } = confirmations.issue(subject);
  advance(16 * 60 * 1000);
  assert.throws(() => confirmations.verify(token, subject), /просрочено/);
});

test('подделанное тело токена не проходит', () => {
  const { confirmations } = fixed();
  const { token } = confirmations.issue(subject);
  const signature = token.split('.')[1] ?? '';
  const body = Buffer.from(JSON.stringify({ digest: 'x', expiresAt: 9e15, nonce: 'n' })).toString('base64url');
  assert.throws(() => confirmations.verify(`${body}.${signature}`, subject), /подпись не совпадает/);
});
