import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fingerprint } from './canonical.js';
import { Refusal } from './errors.js';

export const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

export interface ConfirmationSubject {
  tool: string;
  userId: string;
  args: unknown;
}

export interface ConfirmationOptions {
  secret?: Buffer;
  now?: () => number;
  ttlMs?: number;
}

interface TokenPayload {
  digest: string;
  expiresAt: number;
  nonce: string;
}

export class Confirmations {
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly used = new Set<string>();

  constructor(options: ConfirmationOptions = {}) {
    this.secret = options.secret ?? randomBytes(32);
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? CONFIRMATION_TTL_MS;
  }

  issue(subject: ConfirmationSubject): { token: string; expiresAt: string } {
    const payload: TokenPayload = {
      digest: fingerprint(subject),
      expiresAt: this.now() + this.ttlMs,
      nonce: randomBytes(9).toString('base64url'),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return {
      token: `${body}.${this.sign(body)}`,
      expiresAt: new Date(payload.expiresAt).toISOString(),
    };
  }

  /** Токен привязан к набору параметров: изменилась сумма — он недействителен. */
  verify(token: string, subject: ConfirmationSubject): void {
    const [body, signature] = token.split('.');
    if (!body || !signature || !this.matches(body, signature)) {
      throw new Refusal('confirmation_invalid', 'подтверждение не принято: подпись не совпадает', {
        hint: 'вызовите инструмент без токена, покажите человеку сводку и подтвердите заново',
      });
    }

    let payload: TokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    } catch {
      throw new Refusal('confirmation_invalid', 'подтверждение не разбирается');
    }

    if (payload.expiresAt < this.now()) {
      throw new Refusal('confirmation_invalid', 'подтверждение просрочено', {
        hint: `оно действует ${Math.round(this.ttlMs / 60000)} минут — запросите новое`,
      });
    }
    if (this.used.has(payload.nonce)) {
      throw new Refusal('confirmation_invalid', 'подтверждение уже использовано', {
        hint: 'второй раз тем же токеном операция не проходит — это защита от повтора',
      });
    }
    if (payload.digest !== fingerprint(subject)) {
      throw new Refusal('confirmation_invalid', 'подтверждали другую операцию: параметры изменились', {
        hint: 'сумма, контрагент или состав отличаются от подтверждённых',
      });
    }
    this.used.add(payload.nonce);
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  private matches(body: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
