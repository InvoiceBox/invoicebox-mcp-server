import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sort(value));
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 32);
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, sort(item)]));
}
