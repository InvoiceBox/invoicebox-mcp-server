import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isValidInn, isValidKpp, reviewCustomer } from '../src/core/counterparty.js';

test('ИНН проверяется по контрольной сумме', () => {
  assert.ok(isValidInn('7701234560'));
  assert.ok(!isValidInn('7701234567'));
  assert.ok(!isValidInn('770123456'));
  assert.ok(!isValidInn('77012345601'));
  assert.ok(!isValidInn('abcdefghij'));
});

test('КПП — девять знаков, первые четыре цифры', () => {
  assert.ok(isValidKpp('770101001'));
  assert.ok(!isValidKpp('77010100'));
  assert.ok(!isValidKpp('abc101001'));
});

test('у физлица КПП не бывает', () => {
  const review = reviewCustomer({ type: 'private', taxRegistrationReasonCode: '770101001' });
  assert.ok(review.problems.some((problem) => /физлица КПП не бывает/.test(problem)));
});

test('двенадцатизначный ИНН с КПП — противоречие, это ИП', () => {
  const review = reviewCustomer({ type: 'legal', vatNumber: '500100732259', taxRegistrationReasonCode: '770101001' });
  assert.ok(review.problems.some((problem) => /ИП нет КПП/.test(problem)));
});

test('нехватка данных для документов — предупреждение, а не отказ', () => {
  const review = reviewCustomer({ type: 'legal', name: 'ООО «Ромашка»' });
  assert.deepEqual(review.problems, []);
  assert.ok(review.warnings.some((warning) => /без ИНН/.test(warning)));
});

test('юрлицо с полными реквизитами не вызывает замечаний', () => {
  const review = reviewCustomer({
    type: 'legal',
    name: 'ООО «Ромашка»',
    vatNumber: '7701234560',
    taxRegistrationReasonCode: '770101001',
    registrationAddress: '190000, Санкт-Петербург, Невский пр. 147',
  });
  assert.deepEqual(review.problems, []);
  assert.deepEqual(review.warnings, []);
});
