import { shorten, toFlatSchema, type FlatSchema } from './schema.js';
import type { ToolDefinition } from '../tools/registry.js';

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_FIELD_DESCRIPTION_LENGTH = 240;
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: FlatSchema;
}

export class NameNotAllowed extends Error {}

/** Проверка имён живёт здесь, а не в голове разработчика: у провайдеров свои пределы. */
export function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new NameNotAllowed(`имя «${name}»: допустимы строчные латинские буквы, цифры и подчёркивание`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new NameNotAllowed(`имя «${name}» длиннее ${MAX_NAME_LENGTH} символов`);
  }
}

export interface FunctionsOptions {
  descriptionLimit?: number;
  fieldDescriptionLimit?: number;
  includeConfirmationNote?: boolean;
}

/**
 * Один каталог, два представления. Для клиентов без MCP аннотации «изменяет данные»
 * не существует, поэтому про двухфазность сказано прямо в описании: серверный гейт
 * у них единственный.
 */
export function toFunctions(tools: readonly ToolDefinition[], options: FunctionsOptions = {}): FunctionDefinition[] {
  const descriptionLimit = options.descriptionLimit ?? MAX_DESCRIPTION_LENGTH;
  const fieldLimit = options.fieldDescriptionLimit ?? MAX_FIELD_DESCRIPTION_LENGTH;
  const includeNote = options.includeConfirmationNote ?? true;

  return tools.map((tool) => {
    assertName(tool.name);
    const note =
      includeNote && tool.confirmation === 'two-phase'
        ? ' Подтверждение в два шага: первый вызов возвращает сводку и confirmation_token, второй исполняет.'
        : '';
    return {
      name: tool.name,
      description: shorten(`${tool.description}${note}`, descriptionLimit),
      parameters: toFlatSchema(tool.schema, fieldLimit),
    };
  });
}

export interface FunctionCall {
  name: string;
  arguments: unknown;
}

export type CallOutcome =
  | { ok: true; call: FunctionCall }
  | { ok: false; reason: string };

/**
 * Модель может выдать невалидный JSON, выдумать имя или позвать инструмент дважды в
 * одном ответе. Дополнять догадками нельзя: отклоняем понятно.
 */
export function parseFunctionCall(
  raw: { name?: unknown; arguments?: unknown },
  known: readonly string[],
): CallOutcome {
  if (typeof raw.name !== 'string' || raw.name === '') {
    return { ok: false, reason: 'в вызове нет имени функции' };
  }
  if (!known.includes(raw.name)) {
    return { ok: false, reason: `функции «${raw.name}» нет: доступны ${known.join(', ')}` };
  }

  let args: unknown = raw.arguments ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return { ok: false, reason: `аргументы функции «${raw.name}» не разбираются как JSON` };
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: `аргументы функции «${raw.name}» должны быть объектом` };
  }

  return { ok: true, call: { name: raw.name, arguments: args } };
}

export interface DedupedCalls {
  calls: FunctionCall[];
  dropped: string[];
}

/** Повтор одного и того же вызова в одном ответе — реальное поведение части моделей. */
export function dedupeCalls(calls: readonly FunctionCall[]): DedupedCalls {
  const seen = new Set<string>();
  const result: FunctionCall[] = [];
  const dropped: string[] = [];

  for (const call of calls) {
    const key = `${call.name}:${JSON.stringify(call.arguments)}`;
    if (seen.has(key)) {
      dropped.push(call.name);
      continue;
    }
    seen.add(key);
    result.push(call);
  }

  return { calls: result, dropped };
}
