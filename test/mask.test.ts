import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mask, maskText } from '../src/log/mask.js';

test('токены и подписи не попадают в журнал', () => {
  const masked = mask({
    apiToken: 'b37c4c689295904ed21eee5d9a48d42e',
    signKey: '5a3797956281681be7cbb33ffc390ea1',
    headers: { Authorization: 'Bearer b37c4c689295904ed21eee5d9a48d42e' },
    nested: { confirmationToken: 'abc123' },
  });
  const text = JSON.stringify(masked);
  assert.ok(!text.includes('b37c4c689295904ed21eee5d9a48d42e'));
  assert.ok(!text.includes('5a3797956281681be7cbb33ffc390ea1'));
  assert.ok(!text.includes('abc123'));
});

test('персональные данные плательщика маскируются', () => {
  const masked = mask({
    customer: {
      name: 'ООО «Ромашка»',
      email: 'buh@example.invbox.ru',
      phone: '79001112233',
      registrationAddress: '190000, Санкт-Петербург, Невский пр. 147',
    },
  });
  const text = JSON.stringify(masked);
  assert.ok(!text.includes('buh@example.invbox.ru'));
  assert.ok(!text.includes('79001112233'));
  assert.ok(!text.includes('Невский'));
  // Наименование маскируется независимо от типа покупателя: различить юрлицо и
  // физлицо по одному полю в журнале нельзя, а имя физлица — персональные данные.
  assert.ok(!text.includes('Ромашка'));
});

test('ИНН и КПП оставляют только последние четыре знака: по ним ищут, но не восстанавливают', () => {
  const masked = mask({ customer: { vatNumber: '7701234560', taxRegistrationReasonCode: '770101001' } });
  assert.equal(masked.customer.vatNumber, '***4560');
  assert.equal(masked.customer.taxRegistrationReasonCode, '***1001');
});

test('состав корзины в журнал не попадает: остаётся число позиций', () => {
  const masked = mask({
    basketItems: [
      { sku: 'A', name: 'Позиция 1', totalAmount: 100 },
      { sku: 'B', name: 'Позиция 2', totalAmount: 200 },
    ],
  }) as Record<string, unknown>;
  assert.equal(masked['basketItems'], 'позиций: 2');
});

test('свободный текст тоже чистится: токен мог попасть в сообщение об ошибке', () => {
  const text = maskText('отказ по токену Bearer b37c4c689295904ed21eee5d9a48d42e для buh@example.invbox.ru');
  assert.ok(!text.includes('b37c4c689295904ed21eee5d9a48d42e'));
  assert.match(text, /Bearer \*\*\*/);
  assert.ok(!text.includes('buh@example.invbox.ru'));
});

test('суммы и номера заказов остаются читаемыми', () => {
  const masked = mask({ merchantOrderId: 'mcp-20260804-1', amount: '12200', currencyId: 'RUB' }) as Record<string, unknown>;
  assert.equal(masked['merchantOrderId'], 'mcp-20260804-1');
  assert.equal(masked['amount'], '12200');
});
