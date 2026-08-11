#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiClient } from './api/client.js';
import { StartupError, verifyToken } from './api/auth.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { CircuitBreaker } from './core/breaker.js';
import { Confirmations } from './core/confirmation.js';
import { FileOperationStore, MemoryOperationStore, type OperationStore } from './core/idempotency.js';
import { DailyLedger } from './core/limits.js';
import { RateLimiter } from './core/rateLimiter.js';
import { buildUserAgent } from './core/userAgent.js';
import { Cache } from './core/cache.js';
import { SessionAuth } from './core/sessionAuth.js';
import { createTokenExchange } from './core/tokenExchange.js';
import { DEFAULT_TOKEN_FILE, readTokenFile, writeTokenFile } from './core/tokenStore.js';
import { FileSink, Journal, StderrSink, type JournalSink } from './log/journal.js';
import { GraylogSink, SentrySink } from './log/sinks.js';
import { buildServer, summarizeMetrics } from './server.js';
import { startHttpServer } from './http.js';
import { CATALOG, catalogFingerprint, catalogScopes } from './tools/catalog.js';

export const VERSION = '0.2.1';

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

function buildRuntimeParts(config: Config) {
  const limiter = new RateLimiter({ limit: config.rateLimit });
  const breaker = new CircuitBreaker();
  // Ограничитель и предохранитель общие, а токен у сессии свой: иначе потолки обходятся
  // открытием второй сессии, а токен одного клиента уходит в вызовы другого.
  const makeApi = (token: string) =>
    new ApiClient({
      baseUrl: config.apiUrl,
      token,
      prefix: config.apiPrefix,
      userAgent: buildUserAgent({ version: VERSION }),
      limiter,
      breaker,
    });
  const api = makeApi(config.token);

  const sinks: JournalSink[] = [new StderrSink(config.logLevel)];
  if (config.stateDir) sinks.push(new FileSink(config.stateDir));
  if (config.graylogUrl) {
    try {
      sinks.push(new GraylogSink({ url: config.graylogUrl }));
    } catch (error) {
      note(`Graylog не настроен: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (config.sentryDsn) {
    try {
      sinks.push(
        new SentrySink({
          dsn: config.sentryDsn,
          environment: config.sentryEnvironment ?? config.environment,
          release: VERSION,
        }),
      );
    } catch (error) {
      note(`Sentry не настроен: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const journal = new Journal(sinks, 256, (error) => {
    note(`журнал: приёмник недоступен, записи отбрасываются — ${error instanceof Error ? error.message : String(error)}`);
  });

  const store: OperationStore = config.stateDir ? new FileOperationStore(config.stateDir) : new MemoryOperationStore();
  if (!config.stateDir) {
    note('INVOICEBOX_STATE_DIR не задан: защита от дублей работает только в пределах запуска');
  }

  const tenant = config.counterpartyId ?? config.merchantId;
  return {
    api,
    makeApi,
    journal,
    store,
    ledger: new DailyLedger(store, config.dailyLimits, Date.now, tenant),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function login(token: string | undefined): Promise<void> {
  if (!token) {
    note('использование: invoicebox-mcp-server login <токен>');
    note('токен читается из аргумента и кладётся в файл с правами только для владельца');
    process.exit(2);
  }
  const path = process.env['INVOICEBOX_TOKEN_FILE'] ?? DEFAULT_TOKEN_FILE;
  await writeTokenFile(token, path);
  note(`токен сохранён в ${path} с правами 600; переменная INVOICEBOX_API_TOKEN больше не нужна`);
}

export async function main(): Promise<void> {
  if (process.argv[2] === 'login') {
    await login(process.argv[3]);
    return;
  }

  const file = await readTokenFile(process.env['INVOICEBOX_TOKEN_FILE'] ?? DEFAULT_TOKEN_FILE);
  const config = loadConfig(process.env, {
    ...(file ? { fileToken: file.token, fileWarnings: file.warnings } : {}),
  });
  for (const warning of config.warnings) note(`внимание: ${warning}`);

  const { api, makeApi, journal, store, ledger } = buildRuntimeParts(config);
  const identity = await verifyToken(api);

  // Экземпляр сервера на каждое подключение: счётчики вызовов, подтверждения и кэш ИНН у
  // сессий свои, а SDK к тому же не подключает один сервер к двум транспортам.
  const build = (clientIp: string, sessionApiToken?: string, sessionScopes?: readonly string[]) =>
    buildServer({
      version: VERSION,
      clientIp,
      ...(sessionScopes === undefined ? {} : { sessionScopes }),
      runtime: {
        // С токеном сессии вызовы идут от имени того, кто её открыл, без него — от имени сервера
        api: sessionApiToken === undefined ? api : makeApi(sessionApiToken),
        config,
        journal,
        confirmations: new Confirmations(),
        store,
        ledger,
        innCache: new Cache<Record<string, unknown>>({ ttlMs: DAY_MS, maxEntries: 10 }),
        innLimit: 10,
        userId: identity.userId,
        now: Date.now,
      },
    });

  const { server, tools, metrics } = build('stdio');

  // Проверка токена включается, только когда настроено всё нужное для обмена: с половиной
  // настроек клиент видит метаданные, идёт за токеном и получает отказ на каждом вызове.
  const sessionAuth =
    config.oauthClientId !== undefined
    && config.oauthClientSecret !== undefined
    && config.oauthTokenEndpoint !== undefined
    && config.oauthApiResource !== undefined
      ? new SessionAuth({
          exchange: createTokenExchange({
            tokenEndpoint: config.oauthTokenEndpoint,
            clientId: config.oauthClientId,
            clientSecret: config.oauthClientSecret,
            resource: config.oauthApiResource,
          }),
        })
      : undefined;

  note(
    `invoicebox-mcp-server ${VERSION}: токен из ${config.tokenSource === 'file' ? 'файла' : 'переменной окружения'}, ` +
      `контур ${config.environment}, наборы ${config.toolsets.join(', ')}, ` +
      `инструментов ${tools.length}, каталог ${catalogFingerprint()}`,
  );

  if (config.httpPort !== undefined) {
    startHttpServer({
      port: config.httpPort,
      version: VERSION,
      host: config.httpHost,
      ...(config.httpAllowedHosts === undefined ? {} : { allowedHosts: config.httpAllowedHosts }),
      ...(config.httpAllowedOrigins === undefined ? {} : { allowedOrigins: config.httpAllowedOrigins }),
      sessionIdleMs: config.httpSessionIdleMs,
      maxSessions: config.httpMaxSessions,
      trustedProxyHops: config.trustedProxyHops,
      createMcpServer: (clientIp, session) =>
        build(clientIp ?? 'неизвестный адрес', session?.apiToken, session?.scopes).server,
      // Область берётся из каталога: список в метаданных ресурса, права в токене и
      // проверка на вызове обязаны говорить об одном и том же
      scopeOf: (name) => CATALOG.find((tool) => tool.name === name)?.scope,
      ...(sessionAuth === undefined ? {} : { authenticate: (header) => sessionAuth.authenticate(header) }),
      onSession: (event) => note(`сессия ${event.sessionId} ${event.opened ? 'открыта' : 'закрыта'}`),
      // Метаданные ресурса публикуются, только если сервер действительно проверяет токены:
      // иначе «идите за токеном сюда» вводит клиента в заблуждение.
      ...(sessionAuth === undefined || config.publicUrl === undefined || config.oauthIssuers === undefined
        ? {}
        : {
            protectedResource: {
              resource: config.publicUrl,
              authorizationServers: config.oauthIssuers,
              scopesSupported: catalogScopes(),
              documentation: 'https://docs.invoicebox.ru/mcp/',
            },
          }),
    });
    note(`транспорт Streamable HTTP на ${config.httpHost}:${config.httpPort}: /mcp и /health`);
    if (sessionAuth !== undefined && config.publicUrl !== undefined) {
      note(`метаданные ресурса: ${config.publicUrl}/.well-known/oauth-protected-resource`);
    }
    if (sessionAuth === undefined) {
      note('внимание: транспорт без аутентификации — закрывайте его сетью или прокси');
    } else {
      note('аутентификация сессии: токен проверяется обменом на сервере авторизации');
    }
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    note(`получен ${signal}: дописываем журнал и закрываемся`);
    note(`метрики сессии: ${JSON.stringify(summarizeMetrics(metrics))}`);
    void journal
      .drain()
      .then(() => server.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError || error instanceof StartupError) {
      note(error.message);
      if (error instanceof StartupError && error.hint) note(`подсказка: ${error.hint}`);
      process.exit(2);
    }
    note(`не удалось запустить сервер: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
