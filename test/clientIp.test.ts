import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveClientIp } from '../src/core/clientIp.js';

test('без прокси берётся адрес соединения', () => {
  assert.equal(resolveClientIp({ socketAddress: '203.0.113.7' }), '203.0.113.7');
  assert.equal(resolveClientIp({ socketAddress: '::ffff:203.0.113.7' }), '203.0.113.7');
  assert.equal(resolveClientIp({ socketAddress: '203.0.113.7:52344' }), '203.0.113.7');
});

test('заголовок без доверенных прокси игнорируется: иначе адрес подделывается', () => {
  const ip = resolveClientIp({ socketAddress: '10.0.0.5', forwardedFor: '1.2.3.4' }, 0);
  assert.equal(ip, '10.0.0.5');
});

test('за одним прокси берётся последний адрес цепочки', () => {
  const ip = resolveClientIp({ socketAddress: '10.0.0.5', forwardedFor: '1.2.3.4, 203.0.113.7' }, 1);
  assert.equal(ip, '203.0.113.7');
});

test('подделанная цепочка не даёт заглянуть дальше числа доверенных прокси', () => {
  const ip = resolveClientIp({ socketAddress: '10.0.0.5', forwardedFor: 'evil, 1.2.3.4, 203.0.113.7' }, 2);
  assert.equal(ip, '1.2.3.4');
});

test('пустой заголовок не ломает разбор', () => {
  assert.equal(resolveClientIp({ socketAddress: '10.0.0.5', forwardedFor: '   ' }, 1), '10.0.0.5');
  assert.equal(resolveClientIp({}), undefined);
});
