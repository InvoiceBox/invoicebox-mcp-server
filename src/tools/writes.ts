import { z } from 'zod';
import type { ToolDefinition, ToolRuntime } from './registry.js';
import { amount as amountSchema, basketItem, customer as customerSchema, merchantUrl, uuid } from './schemas.js';
import { invalidInput, preconditionFailed, Refusal } from '../core/errors.js';
import { stripInstructions } from '../core/sanitize.js';
import { formatHuman, formatMinor, parseAmount, reconcileBasket, toApiAmount, type Minor } from '../core/money.js';
import { reviewCustomer } from '../core/counterparty.js';
import { resolveUnit } from '../registry/units.js';
import { isVatCode, vatRate } from '../registry/vat.js';
import { operationKey, type Operation } from '../core/idempotency.js';

const CLOSED_STATUSES = ['completed', 'canceled', 'expired'] as const;

/** Пока запись моложе этого срока, считаем операцию выполняющейся, а не брошенной. */
const IN_FLIGHT_MS = 60_000;

interface ApiOrder {
  id?: string;
  merchantOrderId?: string;
  status?: string;
  amount?: number;
  vatAmount?: number;
  currencyId?: string;
  description?: string;
  paymentUrl?: string;
  customer?: { name?: string; vatNumber?: string };
}

interface ApiShipment {
  id?: number;
  orderId?: string;
  status?: string;
  createdAt?: string;
  documentNumber?: string;
  basketItems?: Array<{ sku?: string; quantity?: number; totalAmount?: number }>;
}

interface AvailableItem {
  sku?: string;
  name?: string;
  availableAmount?: number;
  availableVatAmount?: number;
  amount?: number;
  amountWoVat?: number;
  quantity?: number;
  vatCode?: string;
  measure?: string;
  measureCode?: string;
}

/** НДС вынимается из суммы с налогом: `totalAmount` включает НДС при любой ставке, поэтому формула одна. */
function vatFromCode(code: string | undefined, totalMinor: Minor): Minor {
  if (!code || !isVatCode(code)) return 0;
  const rate = vatRate(code);
  if (rate.percent === 0) return 0;
  return Math.round((totalMinor * rate.percent) / (100 + rate.percent));
}

/** Суммы на входе — целые копейки строкой, чтобы модель не портила число с плавающей точкой. */
function minor(value: string): Minor {
  return Number(value);
}

export function orderNumber(now: number, salt: string): string {
  const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  return `mcp-${date}-${salt.slice(0, 8)}`;
}

type PreparedLine = {
  sku: string;
  name: string;
  type: string;
  measure: string;
  measureCode: string;
  quantity: number;
  amount: Minor;
  amountWoVat: Minor;
  totalAmount: Minor;
  totalVatAmount: Minor;
  vatCode: string;
  paymentType: string;
  groupName?: string;
  serviceDate?: string;
};

function prepareLines(items: readonly z.output<typeof basketItem>[]): PreparedLine[] {
  const problems: string[] = [];
  const lines: PreparedLine[] = [];

  items.forEach((item, index) => {
    const position = index + 1;
    const unit = resolveUnit({
      ...(item.measure === undefined ? {} : { measure: item.measure }),
      ...(item.measure_code === undefined ? {} : { measureCode: item.measure_code }),
    });
    if ('problem' in unit) {
      problems.push(`позиция ${position} «${item.name}»: ${unit.problem}`);
      return;
    }
    const totalAmount = minor(item.total_amount);
    const totalVatAmount = minor(item.total_vat_amount);
    const amount = minor(item.amount);
    // amountWoVat — цена одной единицы без НДС, а не сумма позиции.
    const amountWoVat =
      item.amount_wo_vat === undefined
        ? Math.round((totalAmount - totalVatAmount) / (item.quantity || 1))
        : minor(item.amount_wo_vat);

    lines.push({
      sku: item.sku,
      name: item.name,
      type: item.type,
      measure: unit.measure,
      measureCode: unit.measureCode,
      quantity: item.quantity,
      amount,
      amountWoVat,
      totalAmount,
      totalVatAmount,
      vatCode: item.vat_code,
      paymentType: item.payment_type,
      ...(item.group_name === undefined ? {} : { groupName: item.group_name }),
      ...(item.service_date === undefined ? {} : { serviceDate: item.service_date }),
    });
  });

  if (problems.length > 0) throw invalidInput('состав корзины не принят', problems);
  return lines;
}

/** Полный возврат собирается из остатка по одной единице на позицию: остаток не обязан делиться на количество. */
function refundAllLines(available: readonly AvailableItem[]): PreparedLine[] {
  const lines: PreparedLine[] = [];
  for (const item of available) {
    const lineTotal = item.availableAmount === undefined ? 0 : parseAmount(item.availableAmount, 'availableAmount');
    if (lineTotal <= 0) continue;
    const fromApi =
      item.availableVatAmount === undefined ? undefined : parseAmount(item.availableVatAmount, 'availableVatAmount');
    const lineVat = fromApi ?? vatFromCode(item.vatCode, lineTotal);
    lines.push({
      sku: item.sku ?? '',
      name: item.name ?? 'позиция без наименования',
      type: 'commodity',
      measure: item.measure ?? 'шт',
      measureCode: item.measureCode ?? '796',
      quantity: 1,
      amount: lineTotal,
      amountWoVat: lineTotal - lineVat,
      totalAmount: lineTotal,
      totalVatAmount: lineVat,
      vatCode: item.vatCode ?? 'VATNONE',
      paymentType: 'full_payment',
    });
  }
  return lines;
}

function toApiBasket(lines: readonly PreparedLine[]): Array<Record<string, unknown>> {
  return lines.map((line) => ({
    sku: line.sku,
    name: line.name,
    type: line.type,
    measure: line.measure,
    measureCode: line.measureCode,
    quantity: line.quantity,
    amount: toApiAmount(line.amount),
    amountWoVat: toApiAmount(line.amountWoVat),
    totalAmount: toApiAmount(line.totalAmount),
    totalVatAmount: toApiAmount(line.totalVatAmount),
    vatCode: line.vatCode,
    paymentType: line.paymentType,
    ...(line.groupName === undefined ? {} : { groupName: line.groupName }),
    ...(line.serviceDate === undefined ? {} : { serviceDate: line.serviceDate }),
  }));
}

/** Исход брошенной попытки: `failed` — доказано, что не прошла, повтор безопасен; `unknown` — проверить не удалось. */
type Recovery =
  | { outcome: 'done'; result: Record<string, unknown> }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'unknown' };

interface TwoPhase<TArgs> {
  tool: string;
  args: TArgs;
  token?: string | undefined;
  confirmAmount?: string | undefined;
  runtime: ToolRuntime;
  summary: () => Record<string, unknown>;
  execute: (operation: { key: string; merchantOrderId?: string }) => Promise<Record<string, unknown>>;
  amountMinor?: number;
  /** Без него восстановление идёт поиском по номеру заказа: он есть только у счёта и возврата. */
  recover?: (operation: Operation) => Promise<Recovery>;
}

function key0(tool: string, runtime: ToolRuntime, args: unknown): string {
  return operationKey({
    tool,
    ...(runtime.config.merchantId === undefined ? {} : { merchantId: runtime.config.merchantId }),
    args,
  }).slice(0, 12);
}

export function scopeContext(runtime: ToolRuntime): string {
  return runtime.config.merchantId ? `магазин ${runtime.config.merchantId}` : `организация ${runtime.config.counterpartyId ?? 'не указана'}`;
}

/** Первая фаза ничего не отправляет: сводка и одноразовый токен. Вторая — исполняет. */
async function twoPhase<TArgs>(phase: TwoPhase<TArgs>): Promise<Record<string, unknown>> {
  const { runtime, tool, args, token } = phase;
  const subject = { tool, userId: runtime.userId, args };

  const threshold = runtime.config.confirmThresholdMinor;
  const aboveThreshold = phase.amountMinor !== undefined && phase.amountMinor > threshold;

  // При крупной сумме диалог с человеком тем нужнее, поэтому порог его не отключает.
  if (!token && runtime.elicit) {
    const summary = phase.summary();
    const outcome = await runtime.elicit({
      message: aboveThreshold
        ? `Подтвердите операцию ${tool} — сумма выше порога ${formatHuman(threshold)}: ${describeSummary(summary)}`
        : `Подтвердите операцию ${tool}: ${describeSummary(summary)}`,
      summary,
    });
    if (outcome.action !== 'accept') {
      throw new Refusal('confirmation_required', 'человек не подтвердил операцию', {
        hint: outcome.action === 'decline' ? 'ответ «нет» — в API ничего не отправлено' : 'диалог подтверждения закрыт',
      });
    }
    return executeConfirmed(phase, 'client-elicitation', aboveThreshold);
  }

  if (!token) {
    const issued = runtime.confirmations.issue(subject);
    return {
      confirmation_required: true,
      confirmation_token: issued.token,
      expires_at: issued.expiresAt,
      environment: runtime.config.environment,
      scope_context: scopeContext(runtime),
      summary: phase.summary(),
      next_step: aboveThreshold
        ? `сумма выше порога ${formatHuman(threshold)}: повторите вызов с confirmation_token и confirm_amount, ` +
          `равным сумме в копейках — человек называет её сам`
        : 'покажите сводку человеку и повторите вызов с confirmation_token — до этого в API ничего не уходит',
      ...(aboveThreshold ? { confirm_amount_required: true } : {}),
    };
  }

  if (aboveThreshold && phase.confirmAmount !== String(phase.amountMinor)) {
    throw new Refusal('confirmation_required', `сумма выше порога ${formatHuman(threshold)}: нужно подтвердить её отдельно`, {
      hint: `передайте confirm_amount = "${String(phase.amountMinor)}" — так человек подтверждает сумму, а не модель`,
    });
  }

  runtime.confirmations.verify(token, subject);
  return executeConfirmed(phase, 'token', aboveThreshold);
}

function describeSummary(summary: Record<string, unknown>): string {
  // Значения приходят из API, поэтому текст для человека чистится так же, как ответ инструмента.
  const parts = ['amount_human', 'refund_amount_human', 'customer', 'order_id', 'this_shipment', 'final']
    .filter((key) => summary[key] !== undefined)
    .map((key) => `${key} ${stripInstructions(String(summary[key]), 120)}`);
  return parts.length > 0 ? parts.join(', ') : 'параметры в сводке';
}

async function executeConfirmed<TArgs>(
  phase: TwoPhase<TArgs>,
  confirmation: 'token' | 'client-elicitation',
  aboveThreshold = false,
): Promise<Record<string, unknown>> {
  const { runtime, tool, args } = phase;
  runtime.journal.record({
    traceId: `confirm-${key0(tool, runtime, args)}`,
    at: new Date(runtime.now()).toISOString(),
    tool,
    environment: runtime.config.environment,
    outcome: 'ok',
    confirmation: confirmation === 'token' ? 'token' : 'client-annotation',
    reason: `подтверждение принято (${confirmation})${aboveThreshold ? ' с подтверждением суммы' : ''}`,
  });

  const key = operationKey({
    tool,
    ...(runtime.config.merchantId === undefined ? {} : { merchantId: runtime.config.merchantId }),
    args,
  });
  const known = await runtime.store.find(key);
  if (known?.status === 'done' && known.result !== undefined) {
    return {
      repeated: true,
      note: 'вызов с тем же содержимым уже проходил — возвращён прежний результат, дубль не создан',
      ...(known.result as Record<string, unknown>),
    };
  }
  if (known?.status === 'failed') {
    // Упавшая операция не выполнялась ни разу: запись не останавливает повтор, а только объясняет причину.
    runtime.journal.record({
      traceId: `retry-${key.slice(0, 12)}`,
      at: new Date(runtime.now()).toISOString(),
      tool,
      environment: runtime.config.environment,
      outcome: 'ok',
      reason: `повтор после неудачи: ${known.reason ?? 'причина не записана'}`,
    });
  }
  if (known?.status === 'pending' || known?.status === 'unknown') {
    if (known.status === 'pending') {
      const startedAt = Date.parse(known.at);
      const ageMs = Number.isFinite(startedAt) ? runtime.now() - startedAt : Number.POSITIVE_INFINITY;
      if (ageMs < IN_FLIGHT_MS) {
        throw new Refusal('precondition_failed', 'такая же операция уже выполняется', {
          hint: `начата ${known.at}; дождитесь ответа, иначе получится второй документ`,
        });
      }
    }

    const recovery = await (phase.recover
      ? phase.recover(known)
      : findByNumber(runtime, known.merchantOrderId).then<Recovery>((found) =>
          found ? { outcome: 'done', result: found } : { outcome: 'unknown' },
        ));

    if (recovery.outcome === 'done') {
      await save(runtime, { ...known, status: 'done', result: recovery.result }, phase.amountMinor);
      return {
        recovered: true,
        note: 'прежняя попытка прервалась, но операция в Инвойсбоксе нашлась — повтор не нужен',
        ...recovery.result,
      };
    }
    if (recovery.outcome === 'unknown') {
      // Запись переписывается, иначе она навсегда осталась бы «в полёте».
      await save(runtime, { ...known, status: 'unknown', reason: 'проверить исход не удалось' });
      throw new Refusal('unknown_result', 'прежняя попытка прервалась, и результат неизвестен', {
        hint: 'проверьте в кабинете или инструментами чтения, прежде чем повторять',
      });
    }
    await save(runtime, { ...known, status: 'failed', reason: recovery.reason });
    runtime.journal.record({
      traceId: `recover-${key.slice(0, 12)}`,
      at: new Date(runtime.now()).toISOString(),
      tool,
      environment: runtime.config.environment,
      outcome: 'ok',
      reason: `брошенная попытка признана неудачной: ${recovery.reason}`,
    });
  }

  const at = new Date(runtime.now()).toISOString();
  const merchantOrderId = orderNumber(runtime.now(), key);
  const tenant = runtime.config.counterpartyId ?? runtime.config.merchantId;
  const pending: Operation = {
    key,
    tool,
    status: 'pending',
    at,
    merchantOrderId,
    ...(tenant === undefined ? {} : { tenant }),
  };
  await runtime.store.save(pending);

  try {
    const result = await phase.execute({ key, merchantOrderId });
    await save(runtime, { ...pending, status: 'done', result }, phase.amountMinor);
    return { ...result, environment: runtime.config.environment, scope_context: scopeContext(runtime) };
  } catch (error) {
    const unknownResult = error instanceof Refusal && error.code === 'unknown_result';
    await save(
      runtime,
      {
        ...pending,
        // Не прошла — значит failed, а не done: иначе повтор того же тела отвечал бы «дубль не создан».
        status: unknownResult ? 'unknown' : 'failed',
        reason: error instanceof Error ? error.message : String(error),
      },
      unknownResult ? phase.amountMinor : undefined,
    );
    throw error;
  }
}

const SHIPMENT_PAGE = 50;
const SHIPMENT_MAX_PAGES = 20;

const ours = (shipments: readonly ApiShipment[], orderId: string): ApiShipment[] =>
  shipments.filter((shipment) => shipment.orderId === orderId && shipment.status !== 'canceled');

/**
 * Отгрузки берутся фильтром по заказу, но принадлежность проверяется, а при негодном фильтре
 * идёт перебор страниц: остаток по части отгрузок считать нельзя — от него зависят документы.
 */
async function collectShipments(runtime: ToolRuntime, orderId: string): Promise<ApiShipment[]> {
  const filtered = await runtime.api.get<ApiShipment[]>('/billing/api/order/shipment', {
    query: { orderId, _pageSize: SHIPMENT_PAGE },
  });
  const batch = filtered.data ?? [];
  const filterWorked = batch.every((shipment) => shipment.orderId === orderId);
  const total = filtered.meta?.totalCount;
  if (filterWorked && (batch.length < SHIPMENT_PAGE || (total !== undefined && total <= batch.length))) {
    return ours(batch, orderId);
  }

  const found: ApiShipment[] = [];
  let known: number | undefined;
  for (let page = 1; page <= SHIPMENT_MAX_PAGES; page += 1) {
    const response = await runtime.api.get<ApiShipment[]>('/billing/api/order/shipment', {
      query: { ...(filterWorked ? { orderId } : {}), _page: page, _pageSize: SHIPMENT_PAGE, '_order[createdAt]': 'asc' },
    });
    const chunk = response.data ?? [];
    known = response.meta?.totalCount ?? known;
    found.push(...ours(chunk, orderId));
    if (chunk.length < SHIPMENT_PAGE) return found;
    if (known !== undefined && page * SHIPMENT_PAGE >= known) return found;
  }

  throw new Refusal('precondition_failed', `не удалось прочитать все отгрузки: их больше ${SHIPMENT_MAX_PAGES * SHIPMENT_PAGE}`, {
    hint: 'остаток по заказу нельзя посчитать надёжно; отгрузите с явным составом или обратитесь в поддержку',
  });
}

/** После неизвестного результата сервер сам проверяет выборкой, прошла ли операция. */
async function findByNumber(
  runtime: ToolRuntime,
  merchantOrderId: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!merchantOrderId) return undefined;
  try {
    const response = await runtime.api.get<ApiOrder[]>('/filter/api/order/order', {
      query: { merchantOrderId, _pageSize: 2 },
    });
    const found = (response.data ?? [])[0];
    if (!found) return undefined;
    return {
      order_id: found.id,
      merchant_order_id: found.merchantOrderId ?? merchantOrderId,
      status: found.status,
      request_id: response.requestId,
    };
  } catch {
    return undefined;
  }
}

async function save(runtime: ToolRuntime, operation: Operation, amountMinor?: number): Promise<void> {
  const store = runtime.store as { save(op: Operation, amount?: number): Promise<void> };
  await store.save(operation, amountMinor);
}

const createOrderSchema = z
  .object({
    description: z.string().min(1).max(1000),
    customer: customerSchema,
    basket_items: z.array(basketItem).min(1).max(100),
    amount: amountSchema,
    vat_amount: amountSchema,
    currency_id: z.enum(['RUB', 'USD', 'EUR', 'GBP', 'CNY']),
    language_id: z.enum(['ru', 'en']).default('ru'),
    expiration_date: z.string().datetime({ offset: true }),
    success_url: merchantUrl.optional(),
    fail_url: merchantUrl.optional(),
    return_url: merchantUrl.optional(),
    notification_url: merchantUrl.optional(),
    confirmation_token: z.string().optional(),
    confirm_amount: amountSchema.optional(),
  })
  .strict();

export const createOrder: ToolDefinition<typeof createOrderSchema> = {
  name: 'create_order',
  title: 'Выставить счёт',
  description:
    'Выставляет счёт покупателю и возвращает ссылку на оплату. Покупатель — организация или ИП ' +
    '(type = legal, у ИП ИНН из 12 цифр и без КПП) либо физлицо (type = private, тогда из документов ' +
    'только фискальный чек). Первый вызов ничего не отправляет: возвращает итоговое тело запроса и ' +
    'одноразовый токен подтверждения. Номер заказа генерирует сервер.',
  schema: createOrderSchema,
  scope: 'merchant-order',
  context: 'merchant',
  endpoints: ['POST /billing/api/order/order'],
  mutates: true,
  confirmation: 'two-phase',
  toolset: 'write',
  async run(args, runtime) {
    const merchantId = runtime.config.merchantId;
    if (!merchantId) throw preconditionFailed('не задан INVOICEBOX_MERCHANT_ID: счёт выставляется от имени магазина');

    const lines = prepareLines(args.basket_items);
    const amount = minor(args.amount);
    const vatAmount = minor(args.vat_amount);
    const problems = reconcileBasket(lines, { amount, vatAmount });
    if (problems.length > 0) {
      throw invalidInput('суммы не сходятся', problems.map((problem) => problem.message));
    }

    const review = reviewCustomer({
      type: args.customer.type,
      ...(args.customer.name === undefined ? {} : { name: args.customer.name }),
      ...(args.customer.vat_number === undefined ? {} : { vatNumber: args.customer.vat_number }),
      ...(args.customer.tax_registration_reason_code === undefined
        ? {}
        : { taxRegistrationReasonCode: args.customer.tax_registration_reason_code }),
      ...(args.customer.registration_address === undefined
        ? {}
        : { registrationAddress: args.customer.registration_address }),
    });
    if (review.problems.length > 0) throw invalidInput('реквизиты покупателя противоречивы', review.problems);

    const expiration = Date.parse(args.expiration_date);
    if (Number.isFinite(expiration) && expiration <= runtime.now()) {
      throw invalidInput('срок действия счёта уже прошёл', [`expiration_date = ${args.expiration_date}`]);
    }

    const { confirmation_token: token, confirm_amount: confirmAmount, ...subjectArgs } = args;

    return twoPhase({
      tool: 'create_order',
      args: subjectArgs,
      token,
      confirmAmount,
      runtime,
      amountMinor: amount,
      summary: () => ({
        customer: {
          type: args.customer.type,
          name: args.customer.name,
          inn: args.customer.vat_number,
          kpp: args.customer.tax_registration_reason_code,
        },
        amount: formatMinor(amount),
        amount_human: formatHuman(amount, args.currency_id),
        vat_amount: formatMinor(vatAmount),
        currency: args.currency_id,
        description: args.description,
        expiration_date: args.expiration_date,
        positions: lines.length,
        warnings: review.warnings.length > 0 ? review.warnings : undefined,
      }),
      execute: async ({ merchantOrderId }) => {
        await runtime.ledger.assertAllowed({ tool: 'create_order' });
        const body = {
          merchantId,
          merchantOrderId,
          description: args.description,
          amount: toApiAmount(amount),
          vatAmount: toApiAmount(vatAmount),
          currencyId: args.currency_id,
          languageId: args.language_id,
          expirationDate: args.expiration_date,
          basketItems: toApiBasket(lines),
          customer: {
            type: args.customer.type,
            ...(args.customer.name === undefined ? {} : { name: args.customer.name }),
            ...(args.customer.vat_number === undefined ? {} : { vatNumber: args.customer.vat_number }),
            ...(args.customer.tax_registration_reason_code === undefined
              ? {}
              : { taxRegistrationReasonCode: args.customer.tax_registration_reason_code }),
            ...(args.customer.registration_address === undefined
              ? {}
              : { registrationAddress: args.customer.registration_address }),
            ...(args.customer.email === undefined ? {} : { email: args.customer.email }),
            ...(args.customer.phone === undefined ? {} : { phone: args.customer.phone }),
          },
          ...(args.success_url === undefined ? {} : { successUrl: args.success_url }),
          ...(args.fail_url === undefined ? {} : { failUrl: args.fail_url }),
          ...(args.return_url === undefined ? {} : { returnUrl: args.return_url }),
          ...(args.notification_url === undefined ? {} : { notificationUrl: args.notification_url }),
        };
        const response = await runtime.api.post<ApiOrder>('/billing/api/order/order', body);
        return {
          order_id: response.data?.id,
          merchant_order_id: response.data?.merchantOrderId ?? merchantOrderId,
          status: response.data?.status,
          payment_url: response.data?.paymentUrl,
          amount: formatMinor(amount),
          request_id: response.requestId,
          warnings: review.warnings.length > 0 ? review.warnings : undefined,
        };
      },
    });
  },
};

const cancelOrderSchema = z
  .object({
    order_id: uuid,
    reason: z.string().min(1).max(500),
    confirmation_token: z.string().optional(),
  })
  .strict();

export const cancelOrder: ToolDefinition<typeof cancelOrderSchema> = {
  name: 'cancel_order',
  title: 'Отменить неоплаченный счёт',
  description:
    'Отменяет счёт в статусе created. Оплаченный счёт не отменяется — по нему оформляют возврат. ' +
    'У счёта, оплаченного гарантийным инструментом, отмена запускает настоящий возврат, поэтому ' +
    'подтверждение нужно всегда.',
  schema: cancelOrderSchema,
  scope: 'merchant-order',
  context: 'merchant',
  endpoints: ['GET /billing/api/order/order/{id}', 'DELETE /billing/api/order/order/{id}'],
  mutates: true,
  confirmation: 'two-phase',
  toolset: 'write',
  async run(args, runtime) {
    const current = await runtime.api.get<ApiOrder>(`/billing/api/order/order/${args.order_id}`);
    const order = current.data ?? {};
    const status = order.status ?? 'unknown';

    if (status === 'completed') {
      throw preconditionFailed(
        'счёт оплачен, отмена к нему не применяется',
        'деньги возвращают инструментом create_refund — /docs/merchant/refund/create/',
      );
    }
    if ((CLOSED_STATUSES as readonly string[]).includes(status)) {
      throw preconditionFailed(`счёт в статусе ${status}: отменять нечего`);
    }

    const { confirmation_token: token, ...subjectArgs } = args;

    return twoPhase({
      tool: 'cancel_order',
      args: subjectArgs,
      token,
      runtime,
      // Отмена уходит по идентификатору заказа, номера в ней нет — исход читается статусом
      recover: async () => {
        const again = await runtime.api.get<ApiOrder>(`/billing/api/order/order/${args.order_id}`);
        const current = again.data?.status;
        if (current === 'canceled') {
          return {
            outcome: 'done',
            result: {
              order_id: args.order_id,
              merchant_order_id: again.data?.merchantOrderId,
              status: current,
              request_id: again.requestId,
            },
          };
        }
        return { outcome: 'failed', reason: `заказ в статусе ${current ?? 'неизвестном'}: отмена не прошла` };
      },
      summary: () => ({
        order_id: args.order_id,
        merchant_order_id: order.merchantOrderId,
        status,
        amount: order.amount === undefined ? undefined : formatMinor(parseAmount(order.amount, 'amount')),
        customer: order.customer?.name,
        reason: args.reason,
      }),
      execute: async () => {
        const response = await runtime.api.delete<ApiOrder>(`/billing/api/order/order/${args.order_id}`);
        return {
          order_id: args.order_id,
          status: response.data?.status ?? 'canceled',
          request_id: response.requestId,
          note: 'прочитайте заказ: статус canceled означает, что отмена прошла',
        };
      },
    });
  },
};

const createShipmentSchema = z
  .object({
    order_id: uuid,
    basket_items: z.array(basketItem).min(1).max(100),
    final: z.boolean().default(false),
    document_number: z.string().max(36).optional(),
    document_date: z.string().date().optional(),
    confirmation_token: z.string().optional(),
  })
  .strict();

export const createShipment: ToolDefinition<typeof createShipmentSchema> = {
  name: 'create_shipment',
  title: 'Подтвердить отгрузку',
  description:
    'Подтверждает отгрузку товара или оказание услуги. По отгрузке Инвойсбокс формирует акт или ' +
    'ТОРГ-12, счёт-фактуру и УПД, а у заказов с холдированием списывает заблокированные средства. ' +
    'Отгрузок по заказу может быть несколько; final = true закрывает заказ и разблокирует остаток ' +
    'резерва. Отдельного «сформировать УПД» в API нет: документы идут по отгрузке.',
  schema: createShipmentSchema,
  scope: 'merchant-order',
  context: 'merchant',
  endpoints: ['GET /billing/api/order/order/{id}', 'GET /billing/api/order/shipment', 'POST /billing/api/order/shipment'],
  mutates: true,
  confirmation: 'two-phase',
  toolset: 'write',
  async run(args, runtime) {
    const lines = prepareLines(args.basket_items);
    const total = lines.reduce((sum, line) => sum + line.totalAmount, 0);
    const vatTotal = lines.reduce((sum, line) => sum + line.totalVatAmount, 0);

    const orderResponse = await runtime.api.get<ApiOrder>(`/billing/api/order/order/${args.order_id}`);
    const order = orderResponse.data ?? {};
    const orderAmount = order.amount === undefined ? undefined : parseAmount(order.amount, 'amount');

    const existing = await collectShipments(runtime, args.order_id);
    const shipped = existing.reduce(
      (sum, shipment) =>
        sum +
        (shipment.basketItems ?? []).reduce(
          (lineSum, item) => lineSum + (item.totalAmount === undefined ? 0 : parseAmount(item.totalAmount, 'totalAmount')),
          0,
        ),
      0,
    );

    if (orderAmount !== undefined && shipped + total > orderAmount) {
      throw preconditionFailed(
        `отгрузка выходит за остаток: по заказу ${formatHuman(orderAmount)}, уже отгружено ` +
          `${formatHuman(shipped)}, в этой отгрузке ${formatHuman(total)}`,
        'сумма всех отгрузок не превышает сумму заказа — /docs/merchant/order/shipment_create/',
      );
    }

    const { confirmation_token: token, ...subjectArgs } = args;

    return twoPhase({
      tool: 'create_shipment',
      args: subjectArgs,
      token,
      runtime,
      // Своего номера у отгрузки нет: исход читается по номеру документа, иначе — по сумме и времени.
      recover: async (operation) => {
        const after = await collectShipments(runtime, args.order_id);
        const startedAt = Date.parse(operation.at);
        const match = after.find((shipment) => {
          if (args.document_number !== undefined) return shipment.documentNumber === args.document_number;
          const createdAt = shipment.createdAt === undefined ? Number.NaN : Date.parse(shipment.createdAt);
          const sum = (shipment.basketItems ?? []).reduce(
            (lineSum, item) => lineSum + (item.totalAmount === undefined ? 0 : parseAmount(item.totalAmount, 'totalAmount')),
            0,
          );
          return sum === total && Number.isFinite(createdAt) && createdAt >= startedAt - IN_FLIGHT_MS;
        });
        if (match) {
          return {
            outcome: 'done',
            result: { shipment_id: match.id, order_id: args.order_id, status: match.status, amount: formatMinor(total) },
          };
        }
        const shippedNow = after.reduce(
          (sum, shipment) =>
            sum +
            (shipment.basketItems ?? []).reduce(
              (lineSum, item) => lineSum + (item.totalAmount === undefined ? 0 : parseAmount(item.totalAmount, 'totalAmount')),
              0,
            ),
          0,
        );
        if (shippedNow === shipped) return { outcome: 'failed', reason: 'отгрузок по заказу не прибавилось' };
        return { outcome: 'unknown' };
      },
      summary: () => ({
        order_id: args.order_id,
        merchant_order_id: order.merchantOrderId,
        order_amount: orderAmount === undefined ? undefined : formatMinor(orderAmount),
        already_shipped: formatMinor(shipped),
        this_shipment: formatMinor(total),
        vat_amount: formatMinor(vatTotal),
        positions: lines.length,
        final: args.final,
        final_note: args.final
          ? 'final = true: заказ считается выполненным, остаток резерва разблокируется, документы уходят'
          : 'заказ останется открытым для следующих отгрузок',
        documents_note: 'по завершённой отгрузке формируются акт или ТОРГ-12, счёт-фактура и УПД',
      }),
      execute: async () => {
        await runtime.ledger.assertAllowed({ tool: 'create_shipment' });
        const body = {
          orderId: args.order_id,
          basketItems: toApiBasket(lines),
          final: args.final,
          ...(args.document_number === undefined ? {} : { documentNumber: args.document_number }),
          ...(args.document_date === undefined ? {} : { documentDate: args.document_date }),
        };
        const response = await runtime.api.post<ApiShipment>('/billing/api/order/shipment', body, {
          deadlineMs: 30_000,
        });
        return {
          shipment_id: response.data?.id,
          order_id: args.order_id,
          status: response.data?.status,
          amount: formatMinor(total),
          final: args.final,
          request_id: response.requestId,
        };
      },
    });
  },
};

const createRefundSchema = z
  .object({
    parent_order_id: uuid,
    description: z.string().min(1).max(1000),
    amount: amountSchema.optional(),
    vat_amount: amountSchema.optional(),
    basket_items: z.array(basketItem).min(1).max(100).optional(),
    confirmation_token: z.string().optional(),
    confirm_amount: amountSchema.optional(),
  })
  .strict();

export const createRefund: ToolDefinition<typeof createRefundSchema> = {
  name: 'create_refund',
  title: 'Вернуть деньги по счёту',
  description:
    'Возврат по оплаченному счёту — полный или по составу. Перед сводкой сервер читает состав, ' +
    'доступный к возврату: остаток лежит в availableAmount, и сумма строки его не превышает. ' +
    'Первый вызов ничего не отправляет: сводка и одноразовый токен на 15 минут.',
  schema: createRefundSchema,
  scope: 'merchant-refund',
  context: 'merchant',
  endpoints: [
    'GET /billing/api/order/order/{id}',
    'GET /billing/api/order/order/{id}/refund-basket-item',
    'POST /billing/api/order/refund-order',
  ],
  mutates: true,
  confirmation: 'two-phase',
  toolset: 'refund',
  async run(args, runtime) {
    const parentResponse = await runtime.api.get<ApiOrder>(`/billing/api/order/order/${args.parent_order_id}`);
    const parent = parentResponse.data ?? {};
    if (parent.status !== 'completed') {
      throw preconditionFailed(
        `исходный счёт в статусе ${parent.status ?? 'неизвестном'}: возврат делают по оплаченному`,
        parent.status === 'created' ? 'неоплаченный счёт отменяют инструментом cancel_order' : undefined,
      );
    }

    const availableResponse = await runtime.api.get<AvailableItem[]>(
      `/billing/api/order/order/${args.parent_order_id}/refund-basket-item`,
    );
    const available = availableResponse.data ?? [];
    const availableTotal = available.reduce(
      (sum, item) => sum + (item.availableAmount === undefined ? 0 : parseAmount(item.availableAmount, 'availableAmount')),
      0,
    );
    if (availableTotal <= 0) {
      throw preconditionFailed('по этому счёту возвращать нечего: доступный остаток нулевой');
    }

    const byComposition = args.basket_items !== undefined;
    const lines = byComposition ? prepareLines(args.basket_items ?? []) : refundAllLines(available);
    const linesTotal = lines.reduce((sum, line) => sum + line.totalAmount, 0);
    const linesVat = lines.reduce((sum, line) => sum + line.totalVatAmount, 0);
    const amount = args.amount === undefined ? linesTotal : minor(args.amount);
    // Шапка возврата обязана совпадать с составом: НДС берётся из позиций, переданное значение — сверка.
    const vatAmount = linesVat;
    if (args.vat_amount !== undefined && minor(args.vat_amount) !== linesVat) {
      throw invalidInput(
        `НДС возврата не сходится с составом: передано ${formatHuman(minor(args.vat_amount))}, по позициям ${formatHuman(linesVat)}`,
        byComposition
          ? ['НДС заказа равен сумме total_vat_amount всех позиций']
          : ['при полном возврате НДС считается по доступному остатку — передавать его не нужно'],
      );
    }

    if (amount <= 0) throw invalidInput('сумма возврата должна быть больше нуля');
    if (amount > availableTotal) {
      throw preconditionFailed(
        `к возврату доступно ${formatHuman(availableTotal)}, запрошено ${formatHuman(amount)}`,
        'остаток считается по availableAmount, а не по amount × quantity — /docs/merchant/refund/create/',
      );
    }
    if (!byComposition && amount !== availableTotal) {
      throw invalidInput(
        `частичный возврат нужно перечислить составом: доступно ${formatHuman(availableTotal)}, запрошено ${formatHuman(amount)}`,
        [
          'без basket_items сервер вернул бы весь доступный остаток, а не запрошенную сумму',
          'посмотрите доступные позиции и передайте те, что возвращаете: /docs/merchant/refund/create/',
        ],
      );
    }

    if (byComposition) {
      const problems: string[] = [];
      for (const line of lines) {
        const source = available.find((item) => item.sku === line.sku);
        if (!source) {
          problems.push(`позиции ${line.sku} нет среди доступных к возврату`);
          continue;
        }
        const availableForLine = source.availableAmount === undefined ? 0 : parseAmount(source.availableAmount, 'availableAmount');
        if (line.totalAmount > availableForLine) {
          problems.push(
            `по позиции ${line.sku} доступно ${formatHuman(availableForLine)}, запрошено ${formatHuman(line.totalAmount)}`,
          );
        }
      }
      if (problems.length > 0) throw invalidInput('состав возврата не сходится с доступным остатком', problems);

      const mismatch = reconcileBasket(lines, { amount, vatAmount });
      if (mismatch.length > 0) {
        throw invalidInput(
          'суммы возврата не сходятся',
          mismatch.map((problem) => problem.message),
        );
      }
    }

    const { confirmation_token: token, confirm_amount: confirmAmount, ...subjectArgs } = args;

    return twoPhase({
      tool: 'create_refund',
      args: subjectArgs,
      token,
      confirmAmount,
      runtime,
      amountMinor: amount,
      summary: () => ({
        parent_order_id: args.parent_order_id,
        parent_merchant_order_id: parent.merchantOrderId,
        parent_amount: parent.amount === undefined ? undefined : formatMinor(parseAmount(parent.amount, 'amount')),
        customer: parent.customer?.name,
        available_total: formatMinor(availableTotal),
        available_human: formatHuman(availableTotal),
        refund_amount: formatMinor(amount),
        refund_amount_human: formatHuman(amount),
        vat_amount: formatMinor(vatAmount),
        by_composition: byComposition,
        positions: byComposition ? lines.length : undefined,
        timing_note: 'деньги зачисляются клиенту до двух рабочих дней, в зависимости от способа оплаты',
      }),
      execute: async ({ merchantOrderId }) => {
        await runtime.ledger.assertAllowed({ tool: 'create_refund', amountMinor: amount });
        const body = {
          parentId: args.parent_order_id,
          merchantOrderId,
          description: args.description,
          amount: toApiAmount(amount),
          vatAmount: toApiAmount(vatAmount),
          basketItems: toApiBasket(lines),
        };
        const response = await runtime.api.post<ApiOrder>('/billing/api/order/refund-order', body);
        return {
          refund_id: response.data?.id,
          merchant_order_id: response.data?.merchantOrderId ?? merchantOrderId,
          status: response.data?.status,
          amount: formatMinor(amount),
          request_id: response.requestId,
          timing_note: 'деньги зачисляются клиенту до двух рабочих дней, в зависимости от способа оплаты',
        };
      },
    });
  },
};
