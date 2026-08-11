import type { DailyLimits } from '../config.js';
import { Refusal } from './errors.js';
import type { OperationStore } from './idempotency.js';
import { formatHuman } from './money.js';

export interface LimitCheck {
  tool: 'create_order' | 'create_shipment' | 'create_refund';
  amountMinor?: number;
}

const TOOL_LIMITS: Record<LimitCheck['tool'], { count: keyof DailyLimits; amount?: keyof DailyLimits }> = {
  create_order: { count: 'orderCount' },
  create_shipment: { count: 'shipmentCount' },
  create_refund: { count: 'refundCount', amount: 'refundAmountMinor' },
};

export class DailyLedger {
  constructor(
    private readonly store: OperationStore,
    private readonly limits: DailyLimits,
    private readonly now: () => number = Date.now,
    private readonly tenant?: string,
  ) {}

  private dayStart(): string {
    const date = new Date(this.now());
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
  }

  /** Превышение потолка — эскалация к человеку, а не тихий отказ: причина называет цифры. */
  async assertAllowed(check: LimitCheck): Promise<void> {
    const rule = TOOL_LIMITS[check.tool];
    // Потолок считается на организацию: иначе он обходится второй сессией.
    const spent = await this.store.countSince(check.tool, this.dayStart(), this.tenant);
    const countLimit = this.limits[rule.count];

    if (spent.count >= countLimit) {
      throw new Refusal('limit_reached', `суточный потолок исчерпан: ${spent.count} из ${countLimit} за сутки`, {
        hint: 'потолок задаётся INVOICEBOX_LIMITS; поднять его — решение человека, а не ассистента',
      });
    }

    if (rule.amount && check.amountMinor !== undefined) {
      const amountLimit = this.limits[rule.amount];
      const after = spent.amountMinor + check.amountMinor;
      if (after > amountLimit) {
        throw new Refusal(
          'limit_reached',
          `суточный потолок по сумме: уже ${formatHuman(spent.amountMinor)} из ${formatHuman(amountLimit)}, ` +
            `этот вызов добавит ${formatHuman(check.amountMinor)}`,
          { hint: 'операцию проводит человек в личном кабинете либо поднимает потолок в INVOICEBOX_LIMITS' },
        );
      }
    }
  }
}
