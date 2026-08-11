import type { z } from 'zod';
import type { Config, Toolset } from '../config.js';
import type { ApiClient } from '../api/client.js';
import type { Confirmations } from '../core/confirmation.js';
import type { DailyLedger } from '../core/limits.js';
import type { OperationStore } from '../core/idempotency.js';
import type { Journal } from '../log/journal.js';
import type { Cache } from '../core/cache.js';

/** Область действия инструмента — код группы прав Инвойсбокс: с ним же клиент просит токен. */
export type Scope =
  | 'merchant-read'
  | 'merchant-order'
  | 'merchant-refund'
  | 'merchant-document-read'
  | 'merchant-notification-read'
  | 'merchant-notification-resend';

export type ToolContextKind = 'merchant' | 'counterparty' | 'none';
export type Confirmation = 'none' | 'annotation' | 'two-phase';
export type ResponseFormat = 'concise' | 'detailed';

export interface ElicitRequest {
  message: string;
  summary: Record<string, unknown>;
}

export interface ElicitOutcome {
  action: 'accept' | 'decline' | 'cancel';
}

export interface ToolRuntime {
  api: ApiClient;
  /** Спросить человека прямо в диалоге. Есть только там, где клиент это умеет. */
  elicit?: (request: ElicitRequest) => Promise<ElicitOutcome>;
  innCache?: Cache<Record<string, unknown>>;
  innLimit?: number;
  config: Config;
  journal: Journal;
  confirmations: Confirmations;
  store: OperationStore;
  ledger: DailyLedger;
  userId: string;
  now: () => number;
}

export interface ToolDefinition<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  schema: Schema;
  scope: Scope;
  context: ToolContextKind;
  mutates: boolean;
  confirmation: Confirmation;
  toolset: Toolset;
  endpoints: readonly string[];
  run(args: z.output<Schema>, runtime: ToolRuntime): Promise<unknown>;
}

export interface CatalogFilter {
  toolsets: readonly Toolset[];
  hasMerchant: boolean;
  hasCounterparty: boolean;
}

/** Порядок фиксирован: перестановка меняет поведение моделей, поэтому он покрыт тестом. */
export function selectTools(
  all: readonly ToolDefinition[],
  filter: CatalogFilter,
): ToolDefinition[] {
  return all.filter((tool) => {
    if (!filter.toolsets.includes(tool.toolset)) return false;
    if (tool.context === 'merchant' && !filter.hasMerchant) return false;
    if (tool.context === 'counterparty' && !filter.hasCounterparty) return false;
    return true;
  });
}

export function describeCatalog(tools: readonly ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    scope: tool.scope,
    context: tool.context,
    mutates: tool.mutates,
    confirmation: tool.confirmation,
    toolset: tool.toolset,
    endpoints: tool.endpoints,
  }));
}
