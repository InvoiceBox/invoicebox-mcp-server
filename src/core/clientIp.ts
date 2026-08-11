export interface RemoteAddress {
  socketAddress?: string;
  forwardedFor?: string | undefined;
}

/** Адрес клиента из X-Forwarded-For; число доверенных прокси задаёт конфигурация — иначе адрес подделывается заголовком. */
export function resolveClientIp(address: RemoteAddress, trustedProxyHops = 0): string | undefined {
  const socket = normalize(address.socketAddress);
  if (trustedProxyHops <= 0 || !address.forwardedFor) return socket;

  const chain = address.forwardedFor
    .split(',')
    .map((part) => normalize(part))
    .filter((part): part is string => part !== undefined);
  if (chain.length === 0) return socket;

  const index = chain.length - trustedProxyHops;
  return chain[Math.max(index, 0)] ?? socket;
}

function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/^\[|\]$/g, '');
  if (trimmed === '') return undefined;
  const withoutPort = /^\d+\.\d+\.\d+\.\d+:\d+$/.test(trimmed) ? (trimmed.split(':')[0] as string) : trimmed;
  return withoutPort.startsWith('::ffff:') ? withoutPort.slice('::ffff:'.length) : withoutPort;
}
