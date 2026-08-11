export const MAX_RETRY_AFTER_MS = 60_000;

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(date - now, 0);
}

export function parseRateLimitHeaders(headers: Headers): { remaining?: number; resetSeconds?: number } {
  const remaining = firstNumber(headers, ['ratelimit-remaining', 'x-ratelimit-remaining']);
  const reset = firstNumber(headers, ['ratelimit-reset', 'x-ratelimit-reset']);
  const result: { remaining?: number; resetSeconds?: number } = {};
  if (remaining !== undefined) result.remaining = remaining;
  if (reset !== undefined) result.resetSeconds = reset;
  return result;
}

function firstNumber(headers: Headers, names: readonly string[]): number | undefined {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const value = Number(raw.trim());
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Повтор допустим только там, где запрос точно не выполнен. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 503;
}

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = 1000 * 2 ** (attempt - 1);
  return base + Math.round(random() * 250);
}

export function isJson(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || type.endsWith('+json');
}
