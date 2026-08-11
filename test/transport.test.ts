import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { nodeFetch } from '../src/api/transport.js';

async function serving(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
    server.listen(0, '127.0.0.1');
  });
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

test('транспорт отдаёт статус, заголовки и тело', async () => {
  const { server, base } = await serving((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'r-1' });
    res.end(JSON.stringify({ data: [{ id: 1 }], echo: req.headers['x-probe'] }));
  });

  const response = await nodeFetch(`${base}/v3/billing/api/order/order?_page=1`, { headers: { 'x-probe': 'yes' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), 'r-1');
  const body = (await response.json()) as { data: unknown[]; echo: string };
  assert.equal(body.echo, 'yes');
  assert.equal(body.data.length, 1);
  server.close();
});

test('тело запроса и метод доходят до сервера', async () => {
  let seen = '';
  let method = '';
  const { server, base } = await serving((req, res) => {
    method = req.method ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen = Buffer.concat(chunks).toString('utf8');
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"data":{"id":"o-1"}}');
    });
  });

  const response = await nodeFetch(`${base}/v3/billing/api/order/order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: '12200' }),
  });
  assert.equal(response.status, 201);
  assert.equal(method, 'POST');
  assert.equal(seen, '{"amount":"12200"}');
  server.close();
});

test('ответ без тела не ломает разбор', async () => {
  const { server, base } = await serving((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  const response = await nodeFetch(`${base}/v3/billing/api/order/order/1`, { method: 'DELETE' });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  server.close();
});

test('бюджет времени прерывает запрос, а не ждёт бесконечно', async () => {
  const { server, base } = await serving(() => {
    // Ответа нет вовсе: именно так выглядит зависший API
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  await assert.rejects(nodeFetch(`${base}/v3/security/api/auth/auth`, { signal: controller.signal }), (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError');
    return true;
  });
  clearTimeout(timer);
  server.close();
});

test('свой транспорт не наследует предел встроенного клиента на установку соединения', async () => {
  // Медленное рукопожатие — обычное дело в чужой сети; глобальный fetch рвёт связь на
  // десятой секунде и поднять этот предел нечем. Проверяем, что ожидание задаём мы.
  const { server, base } = await serving((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":{}}');
    }, 300);
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const response = await nodeFetch(`${base}/v3/security/api/auth/auth`, { signal: controller.signal });
  clearTimeout(timer);
  assert.equal(response.status, 200);
  server.close();
});
