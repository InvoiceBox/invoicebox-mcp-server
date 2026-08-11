import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildUserAgent } from '../src/core/userAgent.js';

test('User-Agent называет продукт, версию и платформу', () => {
  const value = buildUserAgent({ version: '0.1.0', runtime: 'Node.js/22.14.0', platform: 'win32', arch: 'x64' });
  assert.equal(value, 'Invoicebox MCP Server/0.1.0 (Node.js/22.14.0; win32 x64)');
});

test('приложение клиента попадает в User-Agent', () => {
  const value = buildUserAgent({
    version: '0.1.0',
    runtime: 'Node.js/22.14.0',
    platform: 'linux',
    arch: 'arm64',
    client: { name: 'claude-code', version: '2.1.0' },
  });
  assert.equal(value, 'Invoicebox MCP Server/0.1.0 (Node.js/22.14.0; linux arm64; client claude-code/2.1.0)');
});

test('имя клиента чистится: заголовок не место для произвольной строки', () => {
  const value = buildUserAgent({
    version: '0.1.0',
    runtime: 'Node.js/22',
    platform: 'linux',
    arch: 'x64',
    client: { name: 'evil\r\nX-Injected: 1' },
  });
  assert.ok(!value.includes('\n'));
  assert.match(value, /client evil__X-Injected/);
});
