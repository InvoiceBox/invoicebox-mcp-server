import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape } from 'zod';
import { CATALOG } from './tools/catalog.js';
import { selectTools, type ToolDefinition, type ToolRuntime } from './tools/registry.js';
import { allowsScope } from './core/sessionAuth.js';
import { Refusal } from './core/errors.js';
import { maskText } from './log/mask.js';
import { sanitizeUntrusted } from './core/sanitize.js';
import { registerResources } from './resources.js';
import type { JournalRecord } from './log/journal.js';

export const MAX_CALLS_PER_SESSION = 200;

export interface Metrics {
  calls: Record<string, number>;
  refusedBeforeApi: number;
  apiErrors: number;
  rateLimited: number;
  unknownResults: number;
  confirmations: number;
  humanRejections: number;
  limitHits: number;
  durationsMs: number[];
}

export function emptyMetrics(): Metrics {
  return {
    calls: {},
    refusedBeforeApi: 0,
    apiErrors: 0,
    rateLimited: 0,
    unknownResults: 0,
    confirmations: 0,
    humanRejections: 0,
    limitHits: 0,
    durationsMs: [],
  };
}

/** Метрики остаются внутри процесса: телеметрии наружу из локального сервера нет. */
export function summarizeMetrics(metrics: Metrics): Record<string, unknown> {
  const durations = [...metrics.durationsMs].sort((left, right) => left - right);
  const percentile = (share: number): number =>
    durations.length === 0 ? 0 : (durations[Math.min(Math.floor(durations.length * share), durations.length - 1)] ?? 0);
  return {
    calls: metrics.calls,
    total: Object.values(metrics.calls).reduce((sum, count) => sum + count, 0),
    refused_before_api: metrics.refusedBeforeApi,
    api_errors: metrics.apiErrors,
    rate_limited: metrics.rateLimited,
    unknown_results: metrics.unknownResults,
    confirmations_issued: metrics.confirmations,
    limit_hits: metrics.limitHits,
    duration_ms_p50: percentile(0.5),
    duration_ms_p95: percentile(0.95),
  };
}

export interface ServerOptions {
  runtime: ToolRuntime;
  version: string;
  clientIp?: string;
  maxCalls?: number;
  catalog?: readonly ToolDefinition[];
  /**
   * Области, подтверждённые сервером авторизации для этой сессии. Проверяются и здесь: у stdio
   * нет транспортного слоя, который отклонил бы вызов раньше. Пусто — прав не сужали.
   */
  sessionScopes?: readonly string[];
}

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type RecordDraft = {
  [K in keyof JournalRecord]?: JournalRecord[K] | undefined;
} & { traceId: string; tool: string; outcome: JournalRecord['outcome'] };

export interface BuiltServer {
  server: McpServer;
  tools: ToolDefinition[];
  invoke: (name: string, args: unknown) => Promise<ToolResult>;
  metrics: Metrics;
}

export function buildServer(options: ServerOptions): BuiltServer {
  const { runtime, version } = options;
  const server = new McpServer(
    { name: 'invoicebox-mcp-server', version },
    { capabilities: { tools: {}, resources: {}, logging: {} } },
  );
  registerResources(server);

  // Элиситация доступна только там, где клиент её объявил: иначе остаётся двухфазная схема.
  const elicit = async (request: { message: string; summary: Record<string, unknown> }) => {
    const capabilities = server.server.getClientCapabilities();
    if (!capabilities?.elicitation) throw new Refusal('confirmation_required', 'клиент не поддерживает элиситацию');
    const result = await server.server.elicitInput({
      message: request.message,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', title: 'Подтверждаю операцию', description: 'Да — операция уйдёт в Инвойсбокс' },
        },
        required: ['confirm'],
      },
    });
    const accepted = result.action === 'accept' && (result.content as { confirm?: boolean } | undefined)?.confirm === true;
    return { action: accepted ? ('accept' as const) : ('decline' as const) };
  };

  const runtimeWithElicit: ToolRuntime = {
    ...runtime,
    elicit: async (request) => {
      try {
        return await elicit(request);
      } catch {
        // Клиент не умеет спрашивать — работает двухфазное подтверждение.
        return { action: 'cancel' };
      }
    },
  };

  const tools = selectTools(options.catalog ?? CATALOG, {
    toolsets: runtime.config.toolsets,
    hasMerchant: runtime.config.merchantId !== undefined,
    hasCounterparty: true,
  });

  let calls = 0;
  const maxCalls = options.maxCalls ?? MAX_CALLS_PER_SESSION;
  const metrics = emptyMetrics();

  const sessionScopes = options.sessionScopes;

  const handle = async (tool: ToolDefinition, args: unknown): Promise<ToolResult> => {
    if (sessionScopes !== undefined && !allowsScope(sessionScopes, tool.scope)) {
      return refuse(
        runtime,
        tool,
        new Refusal('insufficient_scope', `для этого действия нужна область ${tool.scope}`, {
          hint: 'запросите токен с этой областью и подключитесь заново',
        }),
        options.clientIp,
      );
    }

    calls += 1;
    if (calls > maxCalls) {
      return refuse(
        runtime,
        tool,
        new Refusal('limit_reached', `в одной сессии не больше ${maxCalls} вызовов инструментов`, {
          hint: 'перезапустите сессию; предел защищает лимит частоты магазина от вызовов в цикле',
        }),
        options.clientIp,
      );
    }
    return execute(supportsElicitation(server) ? runtimeWithElicit : runtime, tool, args, options.clientIp, metrics);
  };

  for (const tool of tools) {
    const shape = (tool.schema as ZodObject<ZodRawShape>).shape;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: shape,
        annotations: {
          readOnlyHint: !tool.mutates,
          destructiveHint: tool.mutates,
          idempotentHint: !tool.mutates,
          openWorldHint: true,
        },
      },
      async (args: unknown) => handle(tool, args),
    );
  }

  const invoke = async (name: string, args: unknown): Promise<ToolResult> => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`инструмент ${name} не объявлен при этих настройках`);
    return handle(tool, args);
  };

  // Разбор аргументов забран у SDK: он валидирует до нашего обработчика и отдаёт наружу
  // собственное сообщение целиком, минуя и сжатие отказа, и журнал, и метрики.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `инструмент ${request.params.name} не объявлен при этих настройках` }],
        isError: true,
      };
    }
    return handle(tool, request.params.arguments ?? {});
  });

  return { server, tools, invoke, metrics };
}

async function execute(
  runtime: ToolRuntime,
  tool: ToolDefinition,
  args: unknown,
  clientIp: string | undefined,
  metrics: Metrics,
): Promise<ToolResult> {
  const started = runtime.now();
  const traceId = randomUUID();
  metrics.calls[tool.name] = (metrics.calls[tool.name] ?? 0) + 1;

  try {
    const parsed = tool.schema.parse(args);
    // Между разбором и вызовом стоят наши проверки: объект не должен дополниться по пути
    const checked = tool.schema.parse(parsed);
    const result = await tool.run(checked, runtime);
    metrics.durationsMs.push(runtime.now() - started);
    if ((result as Record<string, unknown> | null)?.['confirmation_required'] === true) metrics.confirmations += 1;
    record(runtime, {
      traceId,
      tool: tool.name,
      args: runtime.config.logLevel === 'debug' ? shapeOf(parsed) : parsed,
      outcome: 'ok',
      durationMs: runtime.now() - started,
      clientIp,
      confirmation: confirmationOf(result, tool),
      apiRequestId: requestIdOf(result),
    });
    return text(result);
  } catch (error) {
    const refusal = asRefusal(error);
    metrics.durationsMs.push(runtime.now() - started);
    if (refusal.code === 'api_error' || refusal.code === 'api_unavailable') metrics.apiErrors += 1;
    else if (refusal.code === 'limit_reached') metrics.limitHits += 1;
    else if (refusal.code === 'unknown_result') metrics.unknownResults += 1;
    else metrics.refusedBeforeApi += 1;
    record(runtime, {
      traceId,
      tool: tool.name,
      args,
      outcome: refusal.code === 'api_error' ? 'api_error' : refusal.code === 'unknown_result' ? 'unknown' : 'rejected_by_server',
      reason: refusal.message,
      durationMs: runtime.now() - started,
      clientIp,
      apiRequestId: refusal.details.requestId,
    });
    return text(refusal.toToolResult(), true);
  }
}

function refuse(
  runtime: ToolRuntime,
  tool: ToolDefinition,
  refusal: Refusal,
  clientIp: string | undefined,
): ToolResult {
  record(runtime, {
    traceId: randomUUID(),
    tool: tool.name,
    outcome: 'rejected_by_server',
    reason: refusal.message,
    clientIp,
  });
  return text(refusal.toToolResult(), true);
}

function supportsElicitation(server: McpServer): boolean {
  return server.server.getClientCapabilities()?.elicitation !== undefined;
}

function record(runtime: ToolRuntime, draft: RecordDraft): void {
  const defined = Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined));
  runtime.journal.record({
    at: new Date(runtime.now()).toISOString(),
    environment: runtime.config.environment,
    ...(runtime.config.merchantId === undefined ? {} : { merchantId: runtime.config.merchantId }),
    ...(runtime.config.counterpartyId === undefined ? {} : { counterpartyId: runtime.config.counterpartyId }),
    ...defined,
  } as JournalRecord);
}

interface ZodIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * Ошибка схемы — перечнем полей: целиком сообщение Zod у корзины из ста позиций стоит клиенту
 * тысячи токенов. Номера позиций сворачиваются в `*`, потому что ошибка у них одна и та же.
 */
function describeIssues(error: Error): string {
  const issues = (error as unknown as { issues?: ZodIssue[] }).issues ?? [];
  const byPath = new Map<string, string>();
  for (const issue of issues) {
    const path = issue.path.map((step) => (typeof step === 'number' ? '*' : step)).join('.') || 'корень';
    if (!byPath.has(path)) byPath.set(path, maskText(issue.message).slice(0, 120));
  }
  if (byPath.size === 0) return maskText(error.message).slice(0, 300);
  const listed = [...byPath].slice(0, 10).map(([path, message]) => `${path} — ${message}`);
  return byPath.size > 10 ? `${listed.join('; ')}; и ещё ${byPath.size - 10} полей` : listed.join('; ');
}

function asRefusal(error: unknown): Refusal {
  if (error instanceof Refusal) return error;
  if (error instanceof Error && error.name === 'ZodError') {
    return new Refusal('invalid_input', 'параметры не приняты', { hint: describeIssues(error) });
  }
  if (error instanceof Error) {
    return new Refusal('api_error', maskText(error.message));
  }
  return new Refusal('api_error', 'неизвестная ошибка');
}

function confirmationOf(result: unknown, tool: ToolDefinition): JournalRecord['confirmation'] {
  if (!tool.mutates) return 'none';
  const asRecord = result as Record<string, unknown> | null;
  return asRecord && asRecord['confirmation_required'] === true ? 'none' : 'token';
}

function requestIdOf(result: unknown): string | undefined {
  const asRecord = result as Record<string, unknown> | null;
  const value = asRecord?.['request_id'];
  return typeof value === 'string' ? value : undefined;
}

/** На уровне debug пишем состав, а не значения: имена полей и размеры. */
function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 3) return '…';
  if (Array.isArray(value)) return { array: value.length, item: value.length > 0 ? shapeOf(value[0], depth + 1) : undefined };
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return `string(${value.length})`;
    return typeof value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shapeOf(item, depth + 1)]));
}

/** Эмитент назван в каждом ответе: имена инструментов не уникальны, и чужой сервер может объявить такие же. */
function withIssuer(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return { ...(payload as Record<string, unknown>), issuer: 'Инвойсбокс, invoicebox-mcp-server' };
}

function text(payload: unknown, isError = false): ToolResult {
  return {
    // Без отступов: форматирование ответа — это плюс четверть токенов у клиента ни за что
    content: [{ type: 'text', text: JSON.stringify(withIssuer(sanitizeUntrusted(payload))) }],
    ...(isError ? { isError: true } : {}),
  };
}
