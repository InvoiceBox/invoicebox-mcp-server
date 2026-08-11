/**
 * Метаданные защищённого ресурса (RFC 9728): по документу клиент сам находит сервер
 * авторизации. Идентификатор задаётся явно, а не из заголовка Host: его сверяют буквально.
 */

export interface ProtectedResourceOptions {
  /** Канонический адрес ресурса: он же уезжает в `resource` при запросе токена */
  resource: string;
  /** Серверы авторизации, выдающие токены для этого ресурса */
  authorizationServers: readonly string[];
  /** Области действия, которые ресурс различает */
  scopesSupported?: readonly string[];
  /** Человеческая документация: клиенты показывают её при отказе */
  documentation?: string;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
  resource_documentation?: string;
}

export function buildProtectedResourceMetadata(options: ProtectedResourceOptions): ProtectedResourceMetadata {
  return {
    resource: options.resource,
    authorization_servers: [...options.authorizationServers],
    // Токен принимается только заголовком Authorization: в строке запроса он
    // осел бы в логах прокси, в теле — ломал бы потоковый ответ
    bearer_methods_supported: ['header'],
    ...(options.scopesSupported === undefined ? {} : { scopes_supported: [...options.scopesSupported] }),
    ...(options.documentation === undefined ? {} : { resource_documentation: options.documentation }),
  };
}

/** Значение заголовка `WWW-Authenticate` для 401: отказ показывает дорогу к метаданным (RFC 9728, §5.1) */
export function buildChallenge(
  metadataUrl: string,
  error?: string,
  description?: string,
  scope?: string,
): string {
  const parts = [`Bearer resource_metadata="${metadataUrl}"`];
  if (error !== undefined) parts.push(`error="${headerSafe(error)}"`);
  const safeDescription = description === undefined ? undefined : headerSafe(description);
  // В заголовке помещается только ASCII, а тексты по-русски: если после чистки ничего
  // не осталось, параметр пропускаем — объяснение есть в теле ответа
  if (safeDescription !== undefined && safeDescription !== '') {
    parts.push(`error_description="${safeDescription}"`);
  }
  // Область в вызове обязательна для insufficient_scope (RFC 6750, §3.1): без неё
  // клиент знает, что прав не хватило, но не знает, каких — и повышать ему нечего
  if (scope !== undefined) parts.push(`scope="${headerSafe(scope)}"`);

  return parts.join(', ');
}

/**
 * Значение, пригодное для заголовка HTTP: заголовки переносят только ASCII, а кавычки
 * и обратные слэши закрыли бы строку параметра раньше времени.
 */
function headerSafe(value: string): string {
  return value
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);

      return code >= 0x20 && code <= 0x7e && char !== '"' && char !== String.fromCharCode(92);
    })
    .join('')
    .trim();
}

/**
 * Адреса, по которым клиенты ищут документ: RFC 9728 требует вставлять путь ресурса
 * между `.well-known` и остатком, но клиенты спрашивают и короткий — отвечаем на оба.
 */
export function metadataPaths(resource: string): string[] {
  const short = '/.well-known/oauth-protected-resource';
  let path = '';
  try {
    path = new URL(resource).pathname;
  } catch {
    path = '';
  }

  return path === '' || path === '/' ? [short] : [short, `${short}${path}`];
}
