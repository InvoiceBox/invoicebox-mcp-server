const SECRET_KEYS = [
  'token',
  'apitoken',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'password',
  'secret',
  'signkey',
  'signature',
  'confirmationtoken',
  'cookie',
];

const PERSONAL_KEYS = [
  'email',
  'phone',
  'registrationaddress',
  'deliveryaddress',
  'passport',
  'vatnumber',
  'inn',
  'taxregistrationreasoncode',
  'kpp',
  'name',
  'namefull',
  'namei18n',
  'description',
];

/** Состав корзины — коммерческая тайна магазина: в журнал идёт только число позиций. */
const COLLAPSED_KEYS = ['basketitems', 'basket_items'];

const BEARER = /Bearer\s+[A-Za-z0-9._-]+/gi;
const LONG_HEX = /\b[0-9a-f]{24,}\b/gi;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;
const PHONE = /(?<!\d)(?:\+7|7|8)\d{10}(?!\d)/g;

export function maskText(value: string): string {
  return value
    .replace(BEARER, 'Bearer ***')
    .replace(EMAIL, (match) => maskEmail(match))
    .replace(PHONE, (match) => `${match.slice(0, 2)}******${match.slice(-2)}`)
    .replace(LONG_HEX, (match) => `${match.slice(0, 4)}***`);
}

export function mask<T>(value: T): T {
  return walk(value, false) as T;
}

function walk(value: unknown, hide: boolean): unknown {
  if (typeof value === 'string') return hide ? hidden(value) : maskText(value);
  if (typeof value !== 'object' || value === null) return hide ? '***' : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, hide));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (SECRET_KEYS.includes(normalized)) {
      result[key] = '***';
      continue;
    }
    if (COLLAPSED_KEYS.includes(normalized) && Array.isArray(item)) {
      result[key] = `позиций: ${item.length}`;
      continue;
    }
    result[key] = walk(item, hide || PERSONAL_KEYS.includes(normalized));
  }
  return result;
}

function hidden(value: string): string {
  if (value.includes('@')) return maskEmail(value);
  // ИНН и КПП: последние четыре знака оставляем — по ним ищут операцию, восстановить номер целиком нельзя.
  if (/^\d{9,12}$/.test(value)) return `***${value.slice(-4)}`;
  return value.length <= 4 ? '***' : `${value.slice(0, 2)}***`;
}

function maskEmail(value: string): string {
  const [name = '', domain = ''] = value.split('@');
  return `${name.slice(0, 2)}***@${domain}`;
}
