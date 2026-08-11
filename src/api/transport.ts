import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';

/** Соединения переиспользуются: рукопожатие TLS занимает секунды, и на каждый запрос его не хватит бюджета времени. */
const keepAlive = { keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 8, timeout: 120_000 };
const agents = { http: new HttpAgent(keepAlive), https: new HttpsAgent(keepAlive) };

/**
 * Транспорт вместо глобального `fetch`: у встроенного клиента жёсткий предел на установку соединения —
 * десять секунд, а рукопожатие TLS из некоторых сетей длиннее. Бюджет времени приходит из ApiClient.
 */
export const nodeFetch: typeof fetch = async (input, init) => {
  const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
  const send = url.protocol === 'http:' ? httpRequest : httpsRequest;

  return new Promise<Response>((resolve, reject) => {
    const request = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        ...(url.port === '' ? {} : { port: Number(url.port) }),
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers: headersOf(init?.headers),
        agent: url.protocol === 'http:' ? agents.http : agents.https,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 502;
          const body = chunks.length === 0 || status === 204 || status === 304 ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers: flatten(response.headers) }));
        });
      },
    );

    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) request.destroy(aborted());
      else signal.addEventListener('abort', () => request.destroy(aborted()), { once: true });
    }

    request.on('error', reject);
    if (typeof init?.body === 'string') request.write(init.body);
    request.end();
  });
};

function aborted(): Error {
  const error = new Error('запрос прерван по бюджету времени');
  error.name = 'AbortError';
  return error;
}

function headersOf(source: RequestInit['headers']): Record<string, string> {
  if (source === undefined) return {};
  if (source instanceof Headers) return Object.fromEntries(source.entries());
  if (Array.isArray(source)) return Object.fromEntries(source);
  return { ...source } as Record<string, string>;
}

function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}
