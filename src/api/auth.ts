import type { ApiClient } from './client.js';
import { Refusal } from '../core/errors.js';

export interface TokenIdentity {
  userId: string;
}

export class StartupError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'StartupError';
  }
}

/** Проверяет токен: API отдаёт только userId, магазин и организация берутся из конфигурации. */
export async function verifyToken(client: ApiClient): Promise<TokenIdentity> {
  try {
    const response = await client.get<{ userId?: string }>('/security/api/auth/auth', {
      attempts: 2,
      deadlineMs: 30_000,
    });
    const userId = response.data?.userId;
    if (typeof userId !== 'string' || userId === '') {
      throw new StartupError(
        'API принял токен, но не вернул идентификатор пользователя',
        'ответ не похож на /v3/security/api/auth/auth — проверьте адрес и префикс',
      );
    }
    return { userId };
  } catch (error) {
    if (error instanceof StartupError) throw error;
    if (error instanceof Refusal) {
      if (error.code === 'api_error' && /401|unauthor/i.test(`${error.message} ${error.details.hint ?? ''}`)) {
        throw new StartupError('токен не принят API Инвойсбокса', 'проверьте INVOICEBOX_API_TOKEN в личном кабинете');
      }
      throw new StartupError(`не удалось проверить токен: ${error.message}`, error.details.hint);
    }
    throw new StartupError(`не удалось проверить токен: ${String(error)}`);
  }
}
