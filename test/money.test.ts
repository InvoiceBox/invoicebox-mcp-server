import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AmountError, formatHuman, parseAmount, reconcileBasket, toApiAmount } from '../src/core/money.js';

test('суммы разбираются в копейки без потерь', () => {
  assert.equal(parseAmount('122.00', 'amount'), 12200);
  assert.equal(parseAmount('122,5', 'amount'), 12250);
  assert.equal(parseAmount(122.01, 'amount'), 12201);
  assert.equal(parseAmount('0.01', 'amount'), 1);
  assert.equal(parseAmount('-5.10', 'amount'), -510);
});

test('лишние знаки и мусор отклоняются с указанием поля', () => {
  assert.throws(() => parseAmount('122.005', 'amount'), AmountError);
  assert.throws(() => parseAmount('сто', 'amount'), /amount/);
  assert.throws(() => parseAmount(Number.NaN, 'vatAmount'), /vatAmount/);
});

test('обратно в API уходит число с двумя знаками', () => {
  assert.equal(toApiAmount(12200), 122);
  assert.equal(toApiAmount(1), 0.01);
  assert.equal(formatHuman(12200), '122,00 ₽');
  assert.equal(formatHuman(1234567), `${(12345).toLocaleString('ru-RU')},67 ₽`);
});

const line = {
  name: 'Бронирование номера',
  quantity: 1,
  amount: 12200,
  totalAmount: 12200,
  totalVatAmount: 2200,
};

test('сходящийся состав проблем не даёт', () => {
  assert.deepEqual(reconcileBasket([line], { amount: 12200, vatAmount: 2200 }), []);
});

test('расхождение внутри позиции называет её номер и числа', () => {
  const problems = reconcileBasket([{ ...line, quantity: 2 }], { amount: 12200 });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.line, 1);
  assert.match(problems[0]?.message ?? '', /позиция 1 «Бронирование номера»/);
  assert.match(problems[0]?.message ?? '', /× 2/);
});

test('расхождение итога называет обе суммы', () => {
  const problems = reconcileBasket([line], { amount: 12000 });
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.message ?? '', /не сходится с суммой заказа/);
});

test('НДС больше суммы и пустой состав отклоняются', () => {
  assert.match(reconcileBasket([], { amount: 0 })[0]?.message ?? '', /состав пуст/);
  const problems = reconcileBasket([{ ...line, totalVatAmount: 20000 }], { amount: 12200 });
  assert.ok(problems.some((problem) => /НДС/.test(problem.message)));
});
