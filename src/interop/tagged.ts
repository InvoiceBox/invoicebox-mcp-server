import { dedupeCalls, parseFunctionCall, type FunctionCall } from './functions.js';

const TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

export interface TaggedResult {
  calls: FunctionCall[];
  problems: string[];
  dropped: string[];
}

/**
 * Локальные модели вставляют вызов разметкой в текст ответа. Разбор ненадёжен, поэтому
 * невалидное отклоняется молча и понятно, а не «дополняется» до похожего на правду.
 */
export function parseTaggedCalls(text: string, known: readonly string[]): TaggedResult {
  const calls: FunctionCall[] = [];
  const problems: string[] = [];

  for (const match of text.matchAll(TAG)) {
    const body = match[1] ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      problems.push(`разметка вызова не разбирается как JSON: ${body.slice(0, 80)}`);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.push('в разметке вызова ожидался объект с полями name и arguments');
      continue;
    }
    const outcome = parseFunctionCall(parsed, known);
    if (outcome.ok) calls.push(outcome.call);
    else problems.push(outcome.reason);
  }

  const deduped = dedupeCalls(calls);
  return { calls: deduped.calls, problems, dropped: deduped.dropped };
}
