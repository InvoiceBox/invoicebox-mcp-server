import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ConfigError,
  DEFAULT_OAUTH_TOKEN_ENDPOINT,
  DEFAULT_PUBLIC_URL,
  DEMO_MERCHANT_ID,
  loadConfig,
} from '../src/config.js';

const base = {
  INVOICEBOX_API_TOKEN: 'b37c4c689295904ed21eee5d9a48d42e',
  INVOICEBOX_ENV: 'demo',
  INVOICEBOX_MERCHANT_ID: DEMO_MERCHANT_ID,
};

test('минимальная конфигурация принимается, по умолчанию только чтение', () => {
  const config = loadConfig(base);
  assert.deepEqual(config.toolsets, ['read']);
  assert.equal(config.apiPrefix, 'v3');
  assert.equal(config.apiUrl, 'https://api.invoicebox.ru');
  assert.deepEqual(config.rateLimit, { requests: 60, windowSeconds: 30 });
});

test('пустой токен объясняется именем переменной, а не стеком', () => {
  assert.throws(() => loadConfig({ ...base, INVOICEBOX_API_TOKEN: '' }), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /INVOICEBOX_API_TOKEN/);
    return true;
  });
});

test('демо-окружение с боевым магазином не поднимается', () => {
  assert.throws(
    () => loadConfig({ ...base, INVOICEBOX_MERCHANT_ID: '01771534-1a57-f184-dee3-ebeb91dded75' }),
    /Демо и бой не смешиваются/,
  );
});

test('бой с демонстрационным магазином тоже не поднимается', () => {
  assert.throws(() => loadConfig({ ...base, INVOICEBOX_ENV: 'production' }), /демонстрационного магазина/);
});

test('ограничитель выше лимита учётной записи срезается с предупреждением', () => {
  const config = loadConfig({ ...base, INVOICEBOX_RATE_LIMIT: '500/30' });
  assert.deepEqual(config.rateLimit, { requests: 100, windowSeconds: 30 });
  assert.deepEqual(config.rateLimitCappedFrom, { requests: 500, windowSeconds: 30 });
  assert.ok(config.warnings.some((warning) => /выше лимита учётной записи/.test(warning)));
});

test('неверный формат ограничителя называет ожидаемый вид', () => {
  assert.throws(() => loadConfig({ ...base, INVOICEBOX_RATE_LIMIT: '60 в минуту' }), /запросы\/секунды/);
});

test('несуществующий набор инструментов отклоняется', () => {
  assert.throws(() => loadConfig({ ...base, INVOICEBOX_TOOLSETS: 'read,everything' }), /не существует/);
});

test('чтение включено всегда, даже если задан только write', () => {
  const config = loadConfig({ ...base, INVOICEBOX_TOOLSETS: 'write' });
  assert.deepEqual(config.toolsets, ['read', 'write']);
});

test('суточные потолки переопределяются JSON, лишние ключи отклоняются', () => {
  const config = loadConfig({ ...base, INVOICEBOX_LIMITS: '{"refundCount":3}' });
  assert.equal(config.dailyLimits.refundCount, 3);
  assert.equal(config.dailyLimits.orderCount, 100);
  assert.throws(() => loadConfig({ ...base, INVOICEBOX_LIMITS: '{"refunds":3}' }), /INVOICEBOX_LIMITS/);
});

test('префикс l3 и уровень debug предупреждают о себе', () => {
  const config = loadConfig({ ...base, INVOICEBOX_API_PREFIX: 'l3', INVOICEBOX_LOG_LEVEL: 'debug' });
  assert.ok(config.warnings.some((warning) => /l3/.test(warning)));
  assert.ok(config.warnings.some((warning) => /debug/.test(warning)));
});

test('адреса Инвойсбокс ID имеют боевые значения по умолчанию', () => {
  const config = loadConfig(base);
  assert.equal(config.publicUrl, DEFAULT_PUBLIC_URL);
  assert.deepEqual(config.oauthIssuers, ['https://api.invoicebox.ru']);
  assert.equal(config.oauthTokenEndpoint, DEFAULT_OAUTH_TOKEN_ENDPOINT);
  assert.equal(config.oauthApiResource, 'https://api.invoicebox.ru');
});

test('дефолта у секретов посредника нет: без них обмен токена не включается', () => {
  const config = loadConfig(base);
  assert.equal(config.oauthClientId, undefined);
  assert.equal(config.oauthClientSecret, undefined);
});

test('заданные значения перебивают дефолты', () => {
  const config = loadConfig({
    ...base,
    INVOICEBOX_PUBLIC_URL: 'https://mcp.example.test/mcp',
    INVOICEBOX_OAUTH_ISSUERS: 'https://id.example.test',
    INVOICEBOX_OAUTH_TOKEN_ENDPOINT: 'https://api.example.test/token',
    INVOICEBOX_OAUTH_API_RESOURCE: 'https://api.example.test',
  });
  assert.equal(config.publicUrl, 'https://mcp.example.test/mcp');
  assert.deepEqual(config.oauthIssuers, ['https://id.example.test']);
  assert.equal(config.oauthTokenEndpoint, 'https://api.example.test/token');
  assert.equal(config.oauthApiResource, 'https://api.example.test');
});
