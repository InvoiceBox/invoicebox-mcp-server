const INSTRUCTION_TAGS = /<\/?(?:IMPORTANT|SYSTEM|INSTRUCTIONS?|PROMPT|ASSISTANT|USER|TOOL_CALL)[^>]*>/gi;
const FENCE = /```+/g;

export const MAX_FIELD_LENGTH = 500;

function withoutControlChars(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    result += control ? ' ' : char;
  }
  return result;
}

/** Данные API — данные, а не указания: инъекция приходит названием контрагента. */
export function stripInstructions(value: string, maxLength = MAX_FIELD_LENGTH): string {
  const cleaned = withoutControlChars(value.replace(INSTRUCTION_TAGS, ' ').replace(FENCE, '`'))
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}… (обрезано)` : cleaned;
}

export function sanitizeUntrusted<T>(value: T, maxLength = MAX_FIELD_LENGTH): T {
  if (typeof value === 'string') return stripInstructions(value, maxLength) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeUntrusted(item, maxLength)) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = sanitizeUntrusted(item, maxLength);
  }
  return result as T;
}
