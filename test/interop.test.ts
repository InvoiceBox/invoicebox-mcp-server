import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { z } from 'zod';
import { CATALOG } from '../src/tools/catalog.js';
import { selectTools } from '../src/tools/registry.js';
import {
  assertName,
  dedupeCalls,
  MAX_FIELD_DESCRIPTION_LENGTH,
  NameNotAllowed,
  parseFunctionCall,
  toFunctions,
} from '../src/interop/functions.js';
import { toFlatSchema, UnsupportedSchema } from '../src/interop/schema.js';
import { parseTaggedCalls } from '../src/interop/tagged.js';

test('каталог переводится в функции без anyOf и глубокой вложенности', () => {
  const functions = toFunctions(CATALOG);
  assert.equal(functions.length, CATALOG.length);

  for (const definition of functions) {
    const serialized = JSON.stringify(definition);
    assert.ok(!serialized.includes('anyOf'), `${definition.name}: anyOf`);
    assert.ok(!serialized.includes('oneOf'), `${definition.name}: oneOf`);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.ok(definition.description.length <= 1024);
  }
});

test('описания записей говорят про двухфазность: аннотаций у таких клиентов нет', () => {
  const functions = toFunctions(CATALOG);
  const refund = functions.find((definition) => definition.name === 'create_refund');
  assert.match(refund?.description ?? '', /в два шага/);

  const read = functions.find((definition) => definition.name === 'find_orders');
  assert.ok(!/в два шага/.test(read?.description ?? ''));
});

test('описания укорачиваются под пределы провайдеров', () => {
  const short = toFunctions(CATALOG, { descriptionLimit: 120 });
  for (const definition of short) {
    assert.ok(definition.description.length <= 121, `${definition.name}: ${definition.description.length}`);
  }
});

test('пара «единица или её код» превращается в два необязательных поля', () => {
  const functions = toFunctions(CATALOG);
  const order = functions.find((definition) => definition.name === 'create_order');
  const items = order?.parameters.properties['basket_items'];
  const item = items?.items;
  assert.ok(item?.properties?.['measure']);
  assert.ok(item?.properties?.['measure_code']);
  assert.ok(!(item?.required ?? []).includes('measure'));
  assert.ok(!(item?.required ?? []).includes('measure_code'));
});

test('обязательные поля видны в required, значения по умолчанию — нет', () => {
  const functions = toFunctions(CATALOG);
  const order = functions.find((definition) => definition.name === 'create_order');
  assert.ok(order?.parameters.required.includes('amount'));
  assert.ok(order?.parameters.required.includes('currency_id'));
  assert.ok(!order?.parameters.required.includes('success_url'));
});

test('перечисления доезжают списком значений', () => {
  const functions = toFunctions(CATALOG);
  const order = functions.find((definition) => definition.name === 'create_order');
  const currency = order?.parameters.properties['currency_id'];
  assert.deepEqual(currency?.enum, ['RUB', 'USD', 'EUR', 'GBP', 'CNY']);
});

test('имена проверяются на допустимые символы и длину', () => {
  for (const tool of CATALOG) assertName(tool.name);
  assert.throws(() => assertName('Create-Order'), NameNotAllowed);
  assert.throws(() => assertName('о_заказе'), NameNotAllowed);
  assert.throws(() => assertName('a'.repeat(65)), NameNotAllowed);
});

test('непереводимая схема отклоняется, а не молча теряет поле', () => {
  const schema = z.object({ either: z.union([z.string(), z.number()]) });
  assert.throws(() => toFlatSchema(schema), UnsupportedSchema);
});

test('только чтение отдаёт четыре функции — тот же отбор, что в MCP', () => {
  const tools = selectTools(CATALOG, { toolsets: ['read'], hasMerchant: true, hasCounterparty: true });
  assert.deepEqual(
    toFunctions(tools).map((definition) => definition.name),
    ['lookup_company_by_inn', 'get_order', 'find_orders', 'find_shipments'],
  );
});

test('вызов с выдуманным именем отклоняется с перечислением доступных', () => {
  const outcome = parseFunctionCall({ name: 'create_upd', arguments: {} }, ['create_order', 'create_shipment']);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /create_order, create_shipment/);
});

test('аргументы строкой разбираются, невалидный JSON — нет', () => {
  const good = parseFunctionCall({ name: 'get_order', arguments: '{"order_id":"x"}' }, ['get_order']);
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.call.arguments, { order_id: 'x' });

  const bad = parseFunctionCall({ name: 'get_order', arguments: '{order_id' }, ['get_order']);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /не разбираются как JSON/);
});

test('аргументы массивом не принимаются: догадываться нельзя', () => {
  const outcome = parseFunctionCall({ name: 'get_order', arguments: ['x'] }, ['get_order']);
  assert.equal(outcome.ok, false);
});

test('повтор одного вызова в одном ответе отбрасывается', () => {
  const call = { name: 'create_order', arguments: { amount: '12200' } };
  const deduped = dedupeCalls([call, { ...call }, { name: 'get_order', arguments: {} }]);
  assert.equal(deduped.calls.length, 2);
  assert.deepEqual(deduped.dropped, ['create_order']);
});

test('теговый вызов разбирается, мусор рядом не мешает', () => {
  const text =
    'Сейчас выставлю счёт. <tool_call>{"name":"get_order","arguments":{"order_id":"o-1"}}</tool_call> Готово.';
  const result = parseTaggedCalls(text, ['get_order']);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0]?.arguments, { order_id: 'o-1' });
  assert.deepEqual(result.problems, []);
});

test('битая разметка и выдуманное имя попадают в проблемы, а не в вызовы', () => {
  const text = '<tool_call>{"name":"get_order"</tool_call><tool_call>{"name":"issue_upd"}</tool_call>';
  const result = parseTaggedCalls(text, ['get_order']);
  assert.equal(result.calls.length, 0);
  assert.equal(result.problems.length, 2);
});

test('два одинаковых теговых вызова превращаются в один', () => {
  const one = '<tool_call>{"name":"create_order","arguments":{"amount":"12200"}}</tool_call>';
  const result = parseTaggedCalls(`${one}${one}`, ['create_order']);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.dropped, ['create_order']);
});

test('описания полей укорачиваются до предела провайдера', () => {
  const functions = toFunctions(CATALOG, { fieldDescriptionLimit: 40 });
  for (const definition of functions) {
    for (const property of Object.values(definition.parameters.properties)) {
      if (property.description) assert.ok(property.description.length <= 41, property.description);
    }
  }
  assert.equal(MAX_FIELD_DESCRIPTION_LENGTH, 240);
});
