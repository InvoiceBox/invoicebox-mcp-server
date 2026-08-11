/**
 * Аутентификация сессии: токен клиента проверяется тем, что его обменивают на токен API
 * (RFC 8693) — проверять подпись самим значило бы держать у посредника ключ выпуска токенов.
 */

/** Ответ сервера авторизации на обмен (RFC 8693, §2.2.1) */
export interface ExchangeResult {
  access_token: string;
  issued_token_type?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface ExchangeFailure {
  /** Код ошибки протокола: по нему решаем, что сказать клиенту */
  error: string;
  description?: string;
}

export type ExchangeOutcome = { ok: true; value: ExchangeResult } | { ok: false; failure: ExchangeFailure };

/** Что сессия получила в обмен на предъявленный токен */
export interface Session {
  /** Токен для вызовов API от имени пользователя */
  apiToken: string;
  /** Области действия, которые подтвердил сервер авторизации */
  scopes: readonly string[];
  /** Когда токен перестанет действовать (мс эпохи) */
  expiresAt: number;
}

export type AuthOutcome =
  | { ok: true; session: Session }
  | { ok: false; status: 401 | 403; error: string; description: string };

export interface SessionAuthOptions {
  /** Обмен токена: сеть живёт снаружи, чтобы эту логику можно было проверить */
  exchange: (subjectToken: string) => Promise<ExchangeOutcome>;
  now?: () => number;
  /** Запас перед истечением: вызов, начатый за миг до конца срока, упал бы уже в API */
  skewMs?: number;
}

const DEFAULT_SKEW_MS = 30_000;
const DEFAULT_LIFETIME_MS = 60_000;

/**
 * Проверка предъявленного токена; результат помнится, пока токен жив, чтобы не ходить
 * за обменом на каждый вызов инструмента.
 */
export class SessionAuth {
  private readonly sessions = new Map<string, Session>();

  private readonly now: () => number;

  private readonly skewMs: number;

  constructor(private readonly options: SessionAuthOptions) {
    this.now = options.now ?? Date.now;
    this.skewMs = options.skewMs ?? DEFAULT_SKEW_MS;
  }

  /** @param authorization значение заголовка `Authorization`, как пришло */
  async authenticate(authorization: string | undefined): Promise<AuthOutcome> {
    const subjectToken = readBearer(authorization);
    if (subjectToken === undefined) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_request',
        description: 'нужен заголовок Authorization: Bearer <токен>',
      };
    }

    const cached = this.sessions.get(subjectToken);
    if (cached !== undefined && cached.expiresAt - this.skewMs > this.now()) {
      return { ok: true, session: cached };
    }

    // Просроченный ответ не оставляем: иначе он переживёт отзыв токена
    this.sessions.delete(subjectToken);

    const outcome = await this.options.exchange(subjectToken);
    if (!outcome.ok) {
      return describeFailure(outcome.failure);
    }

    const session = toSession(outcome.value, this.now());
    this.sessions.set(subjectToken, session);

    return { ok: true, session };
  }

  /**
   * Хватает ли сессии прав на инструмент; отдельный код отказа нужен клиенту, чтобы
   * запустить повышение прав, а не показать «что-то пошло не так».
   */
  static requireScope(session: Session, scope: string): AuthOutcome {
    if (allowsScope(session.scopes, scope)) {
      return { ok: true, session };
    }

    return {
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      description: `для этого действия нужна область ${scope}`,
    };
  }

  /** Забыть сессию: вызывается при закрытии соединения */
  forget(authorization: string | undefined): void {
    const token = readBearer(authorization);
    if (token !== undefined) this.sessions.delete(token);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/**
 * Разрешает ли набор областей это действие; пустой набор означает, что сервер авторизации
 * права не сузил, а сужать за него мы не будем.
 */
export function allowsScope(scopes: readonly string[], scope: string): boolean {
  return scopes.length === 0 || scopes.includes(scope);
}

function readBearer(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const [scheme, value] = authorization.split(' ');
  if (scheme === undefined || value === undefined) return undefined;
  if (scheme.toLowerCase() !== 'bearer') return undefined;
  const token = value.trim();

  return token === '' ? undefined : token;
}

function toSession(result: ExchangeResult, now: number): Session {
  const lifetimeMs = result.expires_in === undefined ? DEFAULT_LIFETIME_MS : result.expires_in * 1000;

  return {
    apiToken: result.access_token,
    scopes: result.scope === undefined || result.scope === '' ? [] : result.scope.split(' ').filter(Boolean),
    expiresAt: now + lifetimeMs,
  };
}

/**
 * Перевод отказа обмена в отказ сессии: `invalid_grant` — дело клиентского токена (401),
 * прочее наше (403), иначе клиент будет бесконечно переавторизовываться.
 */
function describeFailure(failure: ExchangeFailure): AuthOutcome {
  if (failure.error === 'invalid_grant' || failure.error === 'invalid_request') {
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      description: failure.description ?? 'токен не принят сервером авторизации',
    };
  }

  return {
    ok: false,
    status: 403,
    error: failure.error,
    description: failure.description ?? 'сервер не смог обменять токен',
  };
}
