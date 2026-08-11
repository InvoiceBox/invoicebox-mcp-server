import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveClientIp } from './core/clientIp.js';
import {
  buildChallenge,
  buildProtectedResourceMetadata,
  metadataPaths,
  type ProtectedResourceOptions,
} from './core/protectedResource.js';
import { allowsScope, type AuthOutcome, type Session as AuthenticatedSession } from './core/sessionAuth.js';
import { catalogFingerprint } from './tools/catalog.js';

export interface HttpOptions {
  port: number;
  version: string;
  host?: string;
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  sessionIdleMs?: number;
  maxSessions?: number;
  trustedProxyHops?: number;
  createMcpServer: (clientIp: string | undefined, session?: AuthenticatedSession) => McpServer;
  onSession?: (event: { sessionId: string; clientIp: string | undefined; opened: boolean }) => void;
  maxBodyBytes?: number;
  now?: () => number;
  /** Метаданные защищённого ресурса (RFC 9728); без них раздел не публикуется */
  protectedResource?: ProtectedResourceOptions;
  /**
   * Проверка предъявленного токена. Не задана — транспорт работает без аутентификации,
   * и об этом сказано при запуске.
   */
  authenticate?: (authorization: string | undefined) => Promise<AuthOutcome>;
  /**
   * Область, нужная инструменту: вызов без неё отклоняется до инструмента. Функцией, а не
   * списком, — каталог собирается по настройкам, и второй список расходился бы с ним.
   */
  scopeOf?: (toolName: string) => string | undefined;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  clientIp: string | undefined;
  lastSeenAt: number;
}

/**
 * Транспорт SaaS. Сессия привязана к клиенту и живёт своим экземпляром сервера:
 * общий экземпляр смешал бы счётчики вызовов и подтверждения разных организаций.
 */
export function startHttpServer(options: HttpOptions): {
  server: Server;
  sessions: Map<string, Session>;
  sweep: () => void;
  ready: Promise<void>;
} {
  const sessions = new Map<string, Session>();
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const host = options.host ?? '127.0.0.1';
  const idleMs = options.sessionIdleMs ?? 30 * 60_000;
  const maxSessions = options.maxSessions ?? 200;
  const now = options.now ?? Date.now;
  const allowedOrigins = options.allowedOrigins;

  /** Порт бывает нулевым (его выбирает система), поэтому список считается после listen. */
  const allowedHosts = (): string[] => {
    if (options.allowedHosts !== undefined) return [...options.allowedHosts];
    const address = http.address();
    const port = typeof address === 'object' && address !== null ? address.port : options.port;
    return ['localhost', '127.0.0.1', '[::1]'].flatMap((name) => [name, `${name}:${port}`]);
  };

  const http = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      reply(res, 500, { error: 'внутренняя ошибка', reason: error instanceof Error ? error.message : String(error) });
    });
  });

  /** Клиент, который ушёл не попрощавшись, иначе держал бы сессию до перезапуска процесса. */
  const sweep = (): void => {
    for (const [id, session] of sessions) {
      if (now() - session.lastSeenAt <= idleMs) continue;
      sessions.delete(id);
      void session.transport.close();
    }
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // /health отвечает до проверки Host: пробы Kubernetes приходят с Host из IP пода, который
    // в белый список не внести. Секретов здесь нет, а от DNS rebinding защищается /mcp.
    if (url.pathname === '/health') {
      // `build` — версия выката от чарта, `catalog` — отпечаток набора инструментов:
      // по нему видно, тот же ли набор описан в опубликованном справочнике.
      reply(res, 200, {
        status: 'ok',
        version: options.version,
        build: process.env['INVOICEBOX_BUILD'] ?? options.version,
        catalog: catalogFingerprint(),
        sessions: sessions.size,
      });
      return;
    }

    // Метаданные ресурса клиент читает до всякой авторизации — узнать, у кого просить токен.
    // Отвечаем до проверок Host и Origin: документ публичный и нужен с любого источника.
    if (options.protectedResource !== undefined
      && metadataPaths(options.protectedResource.resource).includes(url.pathname)
    ) {
      reply(res, 200, buildProtectedResourceMetadata(options.protectedResource), {
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=3600',
      });
      return;
    }

    // Тот же адрес, когда токены не проверяются: общее «адрес не обслуживается» отправило бы
    // искать ошибку в клиенте, хотя причина в настройках сервера.
    if (options.protectedResource === undefined && url.pathname.startsWith('/.well-known/oauth-')) {
      reply(res, 404, {
        error: 'метаданные ресурса не публикуются',
        hint: 'сервер работает без проверки токенов: не заданы INVOICEBOX_OAUTH_CLIENT_ID, INVOICEBOX_OAUTH_CLIENT_SECRET и INVOICEBOX_PUBLIC_URL (адреса сервера авторизации подставляются по умолчанию)',
      });
      return;
    }

    // Проверка Host и Origin — защита от DNS rebinding: в SDK она выключена по умолчанию,
    // а браузерная страница иначе достучится до сервера, слушающего петлю.
    const hostHeader = header(req, 'host')?.toLowerCase();
    if (hostHeader !== undefined && !allowedHosts().includes(hostHeader)) {
      reply(res, 403, { error: 'запрос с неизвестным Host отклонён', hint: 'INVOICEBOX_HTTP_ALLOWED_HOSTS' });
      return;
    }
    const origin = header(req, 'origin')?.toLowerCase();
    if (origin !== undefined && (allowedOrigins === undefined || !allowedOrigins.includes(origin))) {
      reply(res, 403, { error: 'запрос с неизвестным Origin отклонён', hint: 'INVOICEBOX_HTTP_ALLOWED_ORIGINS' });
      return;
    }

    if (url.pathname !== '/mcp') {
      reply(res, 404, { error: 'адрес не обслуживается', hint: 'сервер отвечает на /mcp и /health' });
      return;
    }

    const clientIp = resolveClientIp(
      {
        ...(req.socket.remoteAddress === undefined ? {} : { socketAddress: req.socket.remoteAddress }),
        forwardedFor: header(req, 'x-forwarded-for'),
      },
      options.trustedProxyHops ?? 0,
    );

    // Токен проверяется до поиска сессии и до её создания: иначе отозванный токен работал бы
    // до истечения простоя сессии, то есть отзыв не отзывал бы.
    let authenticated: AuthenticatedSession | undefined;
    if (options.authenticate !== undefined) {
      const outcome = await options.authenticate(header(req, 'authorization'));
      if (!outcome.ok) {
        const headers: Record<string, string> = {};
        if (outcome.status === 401 && options.protectedResource !== undefined) {
          // Отказ обязан показать дорогу к метаданным (RFC 9728, §5.1)
          headers['www-authenticate'] = buildChallenge(
            `${options.protectedResource.resource.replace(/\/$/, '')}/.well-known/oauth-protected-resource`,
            outcome.error,
            outcome.description,
          );
        }
        reply(res, outcome.status, { error: outcome.error, hint: outcome.description }, headers);
        return;
      }
      authenticated = outcome.session;
    }

    const sessionId = header(req, 'mcp-session-id');
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      if (existing.clientIp !== undefined && clientIp !== undefined && existing.clientIp !== clientIp) {
        reply(res, 403, { error: 'сессия принадлежит другому клиенту' });
        return;
      }
      existing.lastSeenAt = now();
      const body = await readBody(req, maxBodyBytes, res);
      if (body.rejected) return;
      if (rejectMissingScope(res, body.value, authenticated, options)) return;
      await existing.transport.handleRequest(req, res, body.value);
      return;
    }

    if (sessionId) {
      reply(res, 404, { error: 'сессия не найдена', hint: 'начните заново запросом initialize без mcp-session-id' });
      return;
    }

    sweep();
    if (sessions.size >= maxSessions) {
      reply(res, 503, { error: `открыто ${sessions.size} сессий — это потолок`, hint: 'INVOICEBOX_HTTP_MAX_SESSIONS' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, clientIp, lastSeenAt: now() });
        options.onSession?.({ sessionId: id, clientIp, opened: true });
      },
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHosts(),
      ...(allowedOrigins === undefined ? {} : { allowedOrigins: [...allowedOrigins] }),
    });
    const server = options.createMcpServer(clientIp, authenticated);
    // Обработчик ставится до connect: SDK оборачивает существующий onclose своей уборкой,
    // а назначение после connect эту обёртку затирает.
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        sessions.delete(id);
        options.onSession?.({ sessionId: id, clientIp, opened: false });
      }
    };
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    const body = await readBody(req, maxBodyBytes, res);
    if (body.rejected) return;
    if (rejectMissingScope(res, body.value, authenticated, options)) return;
    await transport.handleRequest(req, res, body.value);
  }

  // Привязка к именованному адресу проходит через разрешение имени, то есть асинхронно:
  // порт становится известен только после события listening.
  const ready = new Promise<void>((resolve) => http.once('listening', () => resolve()));
  http.listen(options.port, host);
  return { server: http, sessions, sweep, ready };
}

/**
 * Отклоняет вызов инструмента, на который у сессии нет прав: `403` с `insufficient_scope`
 * (RFC 6750, §3.1) и названной областью — по ним клиент повышает права сам.
 *
 * @returns отдан ли отказ — тогда запрос дальше не идёт
 */
function rejectMissingScope(
  res: ServerResponse,
  body: unknown,
  session: AuthenticatedSession | undefined,
  options: HttpOptions,
): boolean {
  if (session === undefined || options.scopeOf === undefined) return false;

  const missing = firstMissingScope(body, session.scopes, options.scopeOf);
  if (missing === undefined) return false;

  const headers: Record<string, string> = {};
  if (options.protectedResource !== undefined) {
    headers['www-authenticate'] = buildChallenge(
      `${options.protectedResource.resource.replace(/\/$/, '')}/.well-known/oauth-protected-resource`,
      'insufficient_scope',
      `для этого действия нужна область ${missing}`,
      missing,
    );
  }

  reply(
    res,
    403,
    { error: 'insufficient_scope', hint: `для этого действия нужна область ${missing}` },
    headers,
  );

  return true;
}

/**
 * Первая область, которой не хватает. Тело бывает пачкой вызовов (JSON-RPC batch): отказ по
 * одному отклоняет весь запрос, иначе клиент прочитал бы ответ как «часть прошла».
 */
export function firstMissingScope(
  body: unknown,
  granted: readonly string[],
  scopeOf: (toolName: string) => string | undefined,
): string | undefined {
  for (const call of toolCallsOf(body)) {
    const scope = scopeOf(call);
    if (scope !== undefined && !allowsScope(granted, scope)) return scope;
  }

  return undefined;
}

function toolCallsOf(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const names: string[] = [];

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const record = message as { method?: unknown; params?: unknown };
    if (record.method !== 'tools/call') continue;
    const params = record.params;
    if (typeof params !== 'object' || params === null) continue;
    const name = (params as { name?: unknown }).name;
    if (typeof name === 'string') names.push(name);
  }

  return names;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * «Тела нет» и «тело не приняли» — разные исходы: у GET и DELETE тела не бывает, но передать
 * запрос транспорту всё равно нужно.
 */
interface BodyResult {
  value?: unknown;
  rejected: boolean;
}

async function readBody(req: IncomingMessage, limit: number, res: ServerResponse): Promise<BodyResult> {
  if (req.method === 'GET' || req.method === 'DELETE') return { rejected: false };

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      reply(res, 413, { error: `тело запроса больше ${Math.round(limit / 1024)} КБ` });
      return { rejected: true };
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return { rejected: false };

  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), rejected: false };
  } catch {
    reply(res, 400, { error: 'тело запроса не разбирается как JSON' });
    return { rejected: true };
  }
}

function reply(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}
