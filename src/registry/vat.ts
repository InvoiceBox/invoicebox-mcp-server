/** Коды ставок НДС Инвойсбокса: /docs/dictionary/tag1199/ */
export const VAT_CODES = [
  'RUS_VAT22_ADDED',
  'RUS_VAT22',
  'RUS_VAT20_ADDED',
  'RUS_VAT20',
  'RUS_VAT10_ADDED',
  'RUS_VAT10',
  'RUS_VAT7_ADDED',
  'RUS_VAT7',
  'RUS_VAT5_ADDED',
  'RUS_VAT5',
  'RUS_VAT0',
  'VATNONE',
] as const;

export type VatCode = (typeof VAT_CODES)[number];

export interface VatRate {
  code: VatCode;
  title: string;
  percent: number;
  included: boolean;
}

export const VAT_RATES: readonly VatRate[] = [
  { code: 'RUS_VAT22_ADDED', title: 'НДС 22 % сверх цены', percent: 22, included: false },
  { code: 'RUS_VAT22', title: 'НДС 22/122, налог в цене', percent: 22, included: true },
  { code: 'RUS_VAT20_ADDED', title: 'НДС 20 % сверх цены', percent: 20, included: false },
  { code: 'RUS_VAT20', title: 'НДС 20/120, налог в цене', percent: 20, included: true },
  { code: 'RUS_VAT10_ADDED', title: 'НДС 10 % сверх цены', percent: 10, included: false },
  { code: 'RUS_VAT10', title: 'НДС 10/110, налог в цене', percent: 10, included: true },
  { code: 'RUS_VAT7_ADDED', title: 'НДС 7 % сверх цены', percent: 7, included: false },
  { code: 'RUS_VAT7', title: 'НДС 7/107, налог в цене', percent: 7, included: true },
  { code: 'RUS_VAT5_ADDED', title: 'НДС 5 % сверх цены', percent: 5, included: false },
  { code: 'RUS_VAT5', title: 'НДС 5/105, налог в цене', percent: 5, included: true },
  { code: 'RUS_VAT0', title: 'НДС 0 %', percent: 0, included: false },
  { code: 'VATNONE', title: 'НДС не облагается', percent: 0, included: false },
];

export function isVatCode(value: string): value is VatCode {
  return (VAT_CODES as readonly string[]).includes(value);
}

export function vatRate(code: VatCode): VatRate {
  return VAT_RATES.find((rate) => rate.code === code) as VatRate;
}

/** Признак способа расчёта, тег 1214: /docs/dictionary/tag1214/ */
export const PAYMENT_TYPES = ['full_prepayment', 'prepayment', 'advance', 'full_payment'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

/** Тип позиции: /docs/dictionary/tag1212/ */
export const ITEM_TYPES = ['commodity', 'service'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
