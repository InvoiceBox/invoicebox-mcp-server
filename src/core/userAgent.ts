export const PRODUCT = 'Invoicebox MCP Server';

export interface UserAgentParts {
  version: string;
  runtime?: string;
  platform?: string;
  arch?: string;
  client?: { name: string; version?: string };
}

/** Инвойсбокс видит в журнале, кто именно пришёл: продукт, версия, платформа и приложение клиента. */
export function buildUserAgent(parts: UserAgentParts): string {
  const runtime = parts.runtime ?? `Node.js/${process.versions.node}`;
  const platform = parts.platform ?? process.platform;
  const arch = parts.arch ?? process.arch;
  const details = [runtime, `${platform} ${arch}`];
  if (parts.client) {
    details.push(`client ${sanitize(parts.client.name)}${parts.client.version ? `/${sanitize(parts.client.version)}` : ''}`);
  }
  return `${PRODUCT}/${parts.version} (${details.join('; ')})`;
}

function sanitize(value: string): string {
  return value.replace(/[^\w.\-+/]/g, '_').slice(0, 40);
}
