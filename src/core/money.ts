export type Minor = number;

const MINOR_IN_MAJOR = 100;
const AMOUNT_PATTERN = /^-?\d+([.,]\d{1,2})?$/;

export class AmountError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'AmountError';
  }
}

export function parseAmount(value: string | number, field: string): Minor {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AmountError(field, `${field}: ожидалось число, получено ${value}`);
    const minor = Math.round(value * MINOR_IN_MAJOR);
    if (Math.abs(value * MINOR_IN_MAJOR - minor) > 1e-6) {
      throw new AmountError(field, `${field}: больше двух знаков после запятой — ${value}`);
    }
    return minor;
  }

  const text = value.trim();
  if (!AMOUNT_PATTERN.test(text)) {
    throw new AmountError(field, `${field}: не похоже на сумму — «${value}»`);
  }
  const [major, fraction = ''] = text.replace(',', '.').split('.');
  const sign = text.startsWith('-') ? -1 : 1;
  const majorMinor = Math.abs(Number(major)) * MINOR_IN_MAJOR;
  const fractionMinor = Number(fraction.padEnd(2, '0') || '0');
  return sign * (majorMinor + fractionMinor);
}

export function toApiAmount(minor: Minor): number {
  return Number((minor / MINOR_IN_MAJOR).toFixed(2));
}

export function formatMinor(minor: Minor): string {
  return String(minor);
}

export function formatHuman(minor: Minor, currency = 'RUB'): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.trunc(abs / MINOR_IN_MAJOR);
  const fraction = String(abs % MINOR_IN_MAJOR).padStart(2, '0');
  const unit = currency === 'RUB' ? ' ₽' : ` ${currency}`;
  return `${sign}${major.toLocaleString('ru-RU')},${fraction}${unit}`;
}

export interface BasketLine {
  name: string;
  quantity: number;
  amount: Minor;
  amountWoVat?: Minor;
  totalAmount: Minor;
  totalVatAmount: Minor;
}

export interface ReconciliationProblem {
  line?: number;
  message: string;
}

export function reconcileBasket(
  lines: readonly BasketLine[],
  declared: { amount: Minor; vatAmount?: Minor },
): ReconciliationProblem[] {
  const problems: ReconciliationProblem[] = [];
  if (lines.length === 0) {
    problems.push({ message: 'состав пуст: заказ без позиций Инвойсбокс не примет' });
    return problems;
  }

  lines.forEach((line, index) => {
    const position = index + 1;
    if (line.quantity <= 0) {
      problems.push({ line: position, message: `позиция ${position} «${line.name}»: количество ${line.quantity}` });
    }
    // Количество бывает дробным (BasketItem.quantity — float в API), поэтому
    // произведение округляется до копейки: /docs/merchant/order/create/#basketitem
    const expected = Math.round(line.amount * line.quantity);
    if (expected !== line.totalAmount) {
      problems.push({
        line: position,
        message:
          `позиция ${position} «${line.name}»: ${formatHuman(line.amount)} × ${line.quantity} = ` +
          `${formatHuman(expected)}, а в totalAmount ${formatHuman(line.totalAmount)}`,
      });
    }
    // amountWoVat — цена единицы без НДС, поэтому проверяется произведением, а не суммой позиции:
    // /docs/merchant/order/create/#basketitem
    if (line.amountWoVat !== undefined) {
      const expectedWoVat = Math.round(line.amountWoVat * line.quantity) + line.totalVatAmount;
      if (Math.abs(expectedWoVat - line.totalAmount) > 1) {
        problems.push({
          line: position,
          message:
            `позиция ${position} «${line.name}»: ${formatHuman(line.amountWoVat)} × ${line.quantity} + НДС ` +
            `${formatHuman(line.totalVatAmount)} = ${formatHuman(expectedWoVat)}, а в totalAmount ` +
            `${formatHuman(line.totalAmount)}. amountWoVat — цена одной единицы без НДС`,
        });
      }
    }
    if (line.totalVatAmount > line.totalAmount) {
      problems.push({
        line: position,
        message: `позиция ${position} «${line.name}»: НДС ${formatHuman(line.totalVatAmount)} больше суммы позиции`,
      });
    }
  });

  const linesTotal = lines.reduce((sum, line) => sum + line.totalAmount, 0);
  if (linesTotal !== declared.amount) {
    problems.push({
      message: `сумма позиций ${formatHuman(linesTotal)} не сходится с суммой заказа ${formatHuman(declared.amount)}`,
    });
  }

  if (declared.vatAmount !== undefined) {
    const linesVat = lines.reduce((sum, line) => sum + line.totalVatAmount, 0);
    if (linesVat !== declared.vatAmount) {
      problems.push({
        message: `НДС позиций ${formatHuman(linesVat)} не сходится с НДС заказа ${formatHuman(declared.vatAmount)}`,
      });
    }
    if (declared.vatAmount > declared.amount) {
      problems.push({ message: 'НДС заказа больше суммы заказа' });
    }
  }

  return problems;
}
