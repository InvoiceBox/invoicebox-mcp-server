export type RefusalCode =
  | 'invalid_input'
  | 'precondition_failed'
  | 'confirmation_required'
  | 'confirmation_invalid'
  | 'limit_reached'
  | 'api_error'
  | 'api_unavailable'
  | 'unknown_result'
  | 'not_permitted'
  | 'insufficient_scope';

export interface RefusalDetails {
  hint?: string;
  problems?: string[];
  requestId?: string;
  retryAfterSeconds?: number;
}

export class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly details: RefusalDetails = {},
  ) {
    super(message);
    this.name = 'Refusal';
  }

  toToolResult(): { ok: false; code: RefusalCode; reason: string; details: RefusalDetails } {
    return { ok: false, code: this.code, reason: this.message, details: this.details };
  }
}

export function invalidInput(message: string, problems?: string[]): Refusal {
  return new Refusal('invalid_input', message, problems ? { problems } : {});
}

export function preconditionFailed(message: string, hint?: string): Refusal {
  return new Refusal('precondition_failed', message, hint ? { hint } : {});
}
