import { z } from 'zod';
import { capToAccountLimit, DEFAULT_LIMIT, parseRateLimit, type RateLimit } from './core/rateLimiter.js';

export const DEMO_MERCHANT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
export const DEFAULT_API_URL = 'https://api.invoicebox.ru';

export type Toolset = 'read' | 'write' | 'refund';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const DEFAULT_CONFIRM_THRESHOLD_MINOR = 100_000_00;

/**
 * Адреса Инвойсбокс ID по умолчанию; секретов среди них нет — идентификатор и секрет клиента
 * обязательны. Issuer — api.invoicebox.ru: от него собираются адреса метаданных, id — экран согласия.
 */
export const DEFAULT_PUBLIC_URL = 'https://mcp.invoicebox.ru/mcp';
export const DEFAULT_OAUTH_ISSUERS = [DEFAULT_API_URL];
export const DEFAULT_OAUTH_TOKEN_ENDPOINT = 'https://api.invoicebox.ru/v3/security/oauth/token';
export const DEFAULT_OAUTH_API_RESOURCE = DEFAULT_API_URL;

export interface DailyLimits {
  refundCount: number;
  refundAmountMinor: number;
  orderCount: number;
  shipmentCount: number;
}

export const DEFAULT_DAILY_LIMITS: DailyLimits = {
  refundCount: 10,
  refundAmountMinor: 50_000_00,
  orderCount: 100,
  shipmentCount: 100,
};

export interface Config {
  token: string;
  tokenSource: 'env' | 'file';
  merchantId?: string;
  counterpartyId?: string;
  environment: 'demo' | 'production';
  apiUrl: string;
  apiPrefix: 'v3' | 'l3';
  toolsets: Toolset[];
  stateDir?: string;
  rateLimit: RateLimit;
  rateLimitCappedFrom?: RateLimit;
  dailyLimits: DailyLimits;
  confirmThresholdMinor: number;
  httpPort?: number;
  httpHost: string;
  httpAllowedHosts?: string[];
  httpAllowedOrigins?: string[];
  httpSessionIdleMs: number;
  httpMaxSessions: number;
  /** Канонический адрес ресурса для метаданных RFC 9728 и параметра `resource` (RFC 8707) */
  publicUrl?: string;
  /** Серверы авторизации, выдающие токены к этому ресурсу */
  oauthIssuers?: string[];
  /** Учётные данные посредника для обмена токена (RFC 8693) */
  oauthClientId?: string;
  oauthClientSecret?: string;
  /** Адрес эндпоинта токена сервера авторизации */
  oauthTokenEndpoint?: string;
  /** Ресурс, для которого сервер просит токен при обмене: наш API */
  oauthApiResource?: string;
  trustedProxyHops: number;
  logLevel: LogLevel;
  graylogUrl?: string;
  sentryDsn?: string;
  sentryEnvironment?: string;
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`конфигурация не принята:\n${problems.map((line) => `  — ${line}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const schema = z.object({
  INVOICEBOX_API_TOKEN: z
    .string({ required_error: 'не задан токен: переменная INVOICEBOX_API_TOKEN или файл, созданный командой login' })
    .min(8, 'токен короче восьми символов не бывает'),
  INVOICEBOX_MERCHANT_ID: uuid.optional(),
  INVOICEBOX_COUNTERPARTY_ID: uuid.optional(),
  INVOICEBOX_ENV: z.enum(['demo', 'production'], {
    required_error: 'не задан контур: demo (демонстрационный магазин) или production',
    invalid_type_error: 'контур бывает только demo или production',
  }),
  INVOICEBOX_API_URL: z.string().url().optional(),
  INVOICEBOX_API_PREFIX: z.enum(['v3', 'l3']).optional(),
  INVOICEBOX_TOOLSETS: z.string().optional(),
  INVOICEBOX_STATE_DIR: z.string().min(1).optional(),
  INVOICEBOX_TOKEN_FILE: z.string().min(1).optional(),
  INVOICEBOX_RATE_LIMIT: z.string().optional(),
  INVOICEBOX_LIMITS: z.string().optional(),
  INVOICEBOX_CONFIRM_THRESHOLD: z.string().regex(/^\d{1,15}$/).optional(),
  INVOICEBOX_HTTP_PORT: z.string().regex(/^\d{2,5}$/).optional(),
  INVOICEBOX_HTTP_HOST: z.string().min(1).optional(),
  INVOICEBOX_HTTP_ALLOWED_HOSTS: z.string().min(1).optional(),
  INVOICEBOX_HTTP_ALLOWED_ORIGINS: z.string().min(1).optional(),
  INVOICEBOX_HTTP_SESSION_IDLE_MS: z.string().regex(/^\d{4,9}$/).optional(),
  INVOICEBOX_HTTP_MAX_SESSIONS: z.string().regex(/^\d{1,5}$/).optional(),
  INVOICEBOX_PUBLIC_URL: z.string().url().optional(),
  INVOICEBOX_OAUTH_ISSUERS: z.string().min(1).optional(),
  INVOICEBOX_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  INVOICEBOX_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  INVOICEBOX_OAUTH_TOKEN_ENDPOINT: z.string().url().optional(),
  INVOICEBOX_OAUTH_API_RESOURCE: z.string().url().optional(),
  TRUSTED_PROXY_HOPS: z.string().regex(/^\d$/).optional(),
  INVOICEBOX_LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).optional(),
  INVOICEBOX_GRAYLOG_URL: z.string().url().optional(),
  INVOICEBOX_SENTRY_DSN: z.string().url().optional(),
  INVOICEBOX_SENTRY_ENV: z.string().min(1).optional(),
});

type RawEnv = Record<string, string | undefined>;

function pick(env: RawEnv): RawEnv {
  const result: RawEnv = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') result[key] = value.trim();
  }
  return result;
}

export interface LoadOptions {
  fileToken?: string;
  fileWarnings?: readonly string[];
}

export function loadConfig(env: RawEnv = process.env, options: LoadOptions = {}): Config {
  const raw0 = pick(env);
  if (raw0['INVOICEBOX_API_TOKEN'] === undefined && options.fileToken !== undefined) {
    raw0['INVOICEBOX_API_TOKEN'] = options.fileToken;
  }
  const parsed = schema.safeParse(raw0);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }

  const raw = parsed.data;
  const problems: string[] = [];
  const warnings: string[] = [];

  const toolsets = parseToolsets(raw.INVOICEBOX_TOOLSETS, problems);
  const rate = parseRate(raw.INVOICEBOX_RATE_LIMIT, problems);
  const dailyLimits = parseLimits(raw.INVOICEBOX_LIMITS, problems);

  const isDemoMerchant = raw.INVOICEBOX_MERCHANT_ID?.toLowerCase() === DEMO_MERCHANT_ID;
  if (raw.INVOICEBOX_ENV === 'demo' && raw.INVOICEBOX_MERCHANT_ID !== undefined && !isDemoMerchant) {
    problems.push(
      `INVOICEBOX_ENV=demo, а INVOICEBOX_MERCHANT_ID не демонстрационный магазин (${DEMO_MERCHANT_ID}). ` +
        'Демо и бой не смешиваются: либо уберите идентификатор, либо укажите production',
    );
  }
  if (raw.INVOICEBOX_ENV === 'production' && isDemoMerchant) {
    problems.push('INVOICEBOX_ENV=production с идентификатором демонстрационного магазина');
  }
  if (raw.INVOICEBOX_MERCHANT_ID === undefined && raw.INVOICEBOX_COUNTERPARTY_ID === undefined) {
    warnings.push(
      'ни INVOICEBOX_MERCHANT_ID, ни INVOICEBOX_COUNTERPARTY_ID не заданы: инструменты появятся только те, ' +
        'что не требуют контекста',
    );
  }
  if (raw.INVOICEBOX_API_PREFIX === 'l3') {
    warnings.push('префикс l3 оставлен для прежних интеграций; в новых берут v3 — /docs/api/');
  }
  if (raw.INVOICEBOX_LOG_LEVEL === 'debug') {
    warnings.push('уровень журнала debug: в записи попадут имена полей и размеры тел, значения — нет');
  }
  if (toolsets.includes('refund') && !toolsets.includes('write')) {
    warnings.push('набор refund включён без write: возврат будет доступен, а выставление счёта — нет');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  if (rate.cappedFrom) {
    warnings.push(
      `ограничитель ${rate.cappedFrom.requests}/${rate.cappedFrom.windowSeconds} выше лимита учётной записи; ` +
        `взят максимум допустимого ${rate.limit.requests}/${rate.limit.windowSeconds}`,
    );
  }

  warnings.push(...(options.fileWarnings ?? []));

  const config: Config = {
    token: raw.INVOICEBOX_API_TOKEN,
    tokenSource: pick(env)['INVOICEBOX_API_TOKEN'] === undefined ? 'file' : 'env',
    environment: raw.INVOICEBOX_ENV,
    apiUrl: (raw.INVOICEBOX_API_URL ?? DEFAULT_API_URL).replace(/\/$/, ''),
    apiPrefix: raw.INVOICEBOX_API_PREFIX ?? 'v3',
    toolsets,
    rateLimit: rate.limit,
    dailyLimits,
    confirmThresholdMinor: raw.INVOICEBOX_CONFIRM_THRESHOLD === undefined
      ? DEFAULT_CONFIRM_THRESHOLD_MINOR
      : Number(raw.INVOICEBOX_CONFIRM_THRESHOLD),
    trustedProxyHops: raw.TRUSTED_PROXY_HOPS === undefined ? 0 : Number(raw.TRUSTED_PROXY_HOPS),
    // Транспорт HTTP по умолчанию слушает только петлю: расширять периметр приходится
    // явным значением, а не забывчивостью
    httpHost: raw.INVOICEBOX_HTTP_HOST ?? '127.0.0.1',
    httpSessionIdleMs: raw.INVOICEBOX_HTTP_SESSION_IDLE_MS === undefined ? 30 * 60_000 : Number(raw.INVOICEBOX_HTTP_SESSION_IDLE_MS),
    httpMaxSessions: raw.INVOICEBOX_HTTP_MAX_SESSIONS === undefined ? 200 : Number(raw.INVOICEBOX_HTTP_MAX_SESSIONS),
    logLevel: raw.INVOICEBOX_LOG_LEVEL ?? 'info',
    warnings,
  };
  if (raw.INVOICEBOX_HTTP_PORT) config.httpPort = Number(raw.INVOICEBOX_HTTP_PORT);
  const hosts = list(raw.INVOICEBOX_HTTP_ALLOWED_HOSTS);
  const origins = list(raw.INVOICEBOX_HTTP_ALLOWED_ORIGINS);
  if (hosts) config.httpAllowedHosts = hosts;
  if (origins) config.httpAllowedOrigins = origins;
  // Адрес ресурса задаётся явно: клиент передаёт его же в `resource`, и сервер
  // авторизации сверяет строки буквально — собранный из Host он бы не совпал
  config.publicUrl = raw.INVOICEBOX_PUBLIC_URL ?? DEFAULT_PUBLIC_URL;
  config.oauthIssuers = list(raw.INVOICEBOX_OAUTH_ISSUERS) ?? [...DEFAULT_OAUTH_ISSUERS];
  config.oauthTokenEndpoint = raw.INVOICEBOX_OAUTH_TOKEN_ENDPOINT ?? DEFAULT_OAUTH_TOKEN_ENDPOINT;
  config.oauthApiResource = raw.INVOICEBOX_OAUTH_API_RESOURCE ?? DEFAULT_OAUTH_API_RESOURCE;
  // Секретам дефолта нет и быть не может: пока их не задали, обмен токена не
  // включается — и это правильнее, чем включиться с чужими значениями
  if (raw.INVOICEBOX_OAUTH_CLIENT_ID) config.oauthClientId = raw.INVOICEBOX_OAUTH_CLIENT_ID;
  if (raw.INVOICEBOX_OAUTH_CLIENT_SECRET) config.oauthClientSecret = raw.INVOICEBOX_OAUTH_CLIENT_SECRET;
  if (raw.INVOICEBOX_MERCHANT_ID) config.merchantId = raw.INVOICEBOX_MERCHANT_ID;
  if (raw.INVOICEBOX_COUNTERPARTY_ID) config.counterpartyId = raw.INVOICEBOX_COUNTERPARTY_ID;
  if (raw.INVOICEBOX_STATE_DIR) config.stateDir = raw.INVOICEBOX_STATE_DIR;
  if (rate.cappedFrom) config.rateLimitCappedFrom = rate.cappedFrom;
  if (raw.INVOICEBOX_GRAYLOG_URL) config.graylogUrl = raw.INVOICEBOX_GRAYLOG_URL;
  if (raw.INVOICEBOX_SENTRY_DSN) config.sentryDsn = raw.INVOICEBOX_SENTRY_DSN;
  config.sentryEnvironment = raw.INVOICEBOX_SENTRY_ENV ?? raw.INVOICEBOX_ENV;
  return config;
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts;
}

function parseToolsets(value: string | undefined, problems: string[]): Toolset[] {
  if (value === undefined) return ['read'];
  const allowed: Toolset[] = ['read', 'write', 'refund'];
  const parts = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
  const result = new Set<Toolset>(['read']);
  for (const part of parts) {
    if (!allowed.includes(part as Toolset)) {
      problems.push(`INVOICEBOX_TOOLSETS: набор «${part}» не существует, доступны ${allowed.join(', ')}`);
      continue;
    }
    result.add(part as Toolset);
  }
  return [...result];
}

function parseRate(value: string | undefined, problems: string[]) {
  if (value === undefined) return capToAccountLimit(DEFAULT_LIMIT);
  try {
    return capToAccountLimit(parseRateLimit(value));
  } catch (error) {
    problems.push(`INVOICEBOX_RATE_LIMIT: ${error instanceof Error ? error.message : String(error)}`);
    return capToAccountLimit(DEFAULT_LIMIT);
  }
}

function parseLimits(value: string | undefined, problems: string[]): DailyLimits {
  if (value === undefined) return { ...DEFAULT_DAILY_LIMITS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    problems.push('INVOICEBOX_LIMITS: ожидался JSON, например {"refundCount":5}');
    return { ...DEFAULT_DAILY_LIMITS };
  }
  const shape = z
    .object({
      refundCount: z.number().int().positive().optional(),
      refundAmountMinor: z.number().int().positive().optional(),
      orderCount: z.number().int().positive().optional(),
      shipmentCount: z.number().int().positive().optional(),
    })
    .strict()
    .safeParse(parsed);
  if (!shape.success) {
    problems.push(`INVOICEBOX_LIMITS: ${shape.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
    return { ...DEFAULT_DAILY_LIMITS };
  }
  const overrides = Object.fromEntries(Object.entries(shape.data).filter(([, value]) => value !== undefined));
  return { ...DEFAULT_DAILY_LIMITS, ...(overrides as Partial<DailyLimits>) };
}
