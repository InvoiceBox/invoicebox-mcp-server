import { nodeFetch } from '../api/transport.js';
import type { ExchangeOutcome } from './sessionAuth.js';

/**
 * Запрос обмена токена к серверу авторизации (RFC 8693): здесь только запрос и разбор
 * ответа. Свой fetch — у встроенного предел соединения короче рукопожатия TLS из этой сети.
 */

export interface TokenExchangeOptions {
  /** Адрес эндпоинта токена — берётся из метаданных сервера авторизации */
  tokenEndpoint: string;
  /** Мы как клиент: обменивать может только тот, кому токен выдали */
  clientId: string;
  clientSecret: string;
  /** Ресурс, для которого нужен токен: наш API */
  resource: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';

const TOKEN_TYPE_ACCESS = 'urn:ietf:params:oauth:token-type:access_token';

const DEFAULT_TIMEOUT_MS = 8_000;

export function createTokenExchange(options: TokenExchangeOptions) {
  const fetchImpl = options.fetchImpl ?? nodeFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function exchange(subjectToken: string): Promise<ExchangeOutcome> {
    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      subject_token: subjectToken,
      subject_token_type: TOKEN_TYPE_ACCESS,
      resource: options.resource,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(options.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      const payload = (await readJson(response)) as Record<string, unknown>;

      if (!response.ok) {
        return {
          ok: false,
          failure: {
            // Код протокола важнее кода HTTP: по нему видно, чей это отказ
            error: typeof payload['error'] === 'string' ? payload['error'] : `http_${response.status}`,
            ...(typeof payload['error_description'] === 'string'
              ? { description: payload['error_description'] }
              : {}),
          },
        };
      }

      if (typeof payload['access_token'] !== 'string') {
        return { ok: false, failure: { error: 'invalid_response', description: 'в ответе нет access_token' } };
      }

      return {
        ok: true,
        value: {
          access_token: payload['access_token'],
          ...(typeof payload['issued_token_type'] === 'string'
            ? { issued_token_type: payload['issued_token_type'] }
            : {}),
          ...(typeof payload['token_type'] === 'string' ? { token_type: payload['token_type'] } : {}),
          ...(typeof payload['expires_in'] === 'number' ? { expires_in: payload['expires_in'] } : {}),
          ...(typeof payload['scope'] === 'string' ? { scope: payload['scope'] } : {}),
        },
      };
    } catch (error) {
      // Недоступный сервер авторизации — не повод сказать клиенту «твой токен плох»:
      // код отличается от invalid_grant намеренно
      return {
        ok: false,
        failure: {
          error: 'authorization_server_unavailable',
          description: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
