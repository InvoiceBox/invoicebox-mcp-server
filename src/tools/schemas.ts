import { z } from 'zod';
import { ITEM_TYPES, PAYMENT_TYPES, VAT_CODES } from '../registry/vat.js';

export const amount = z
  .string()
  .regex(/^\d{1,12}$/, 'сумма в копейках целым числом строкой: 12200 — это 122,00 ₽')
  .describe('сумма в минорных единицах (копейках) строкой: 12200 = 122,00 ₽');

export const uuid = z.string().uuid('идентификатор в формате UUID');

export const responseFormat = z
  .enum(['concise', 'detailed'])
  .default('concise')
  .describe('concise — только ключевые поля (по умолчанию), detailed — полный ответ');

export const page = z.number().int().min(1).max(1000).default(1);
export const pageSize = z.number().int().min(1).max(50).default(20);

const OUR_HOSTS = ['docs.invoicebox.ru', 'invoicebox.ru', 'www.invoicebox.ru', 'app.invoicebox.ru', 'api.invoicebox.ru'];

/** Ссылки возврата ведут на сайт магазина: наши адреса там означают, что покупателя увезли не туда. */
export const merchantUrl = z
  .string()
  .url()
  .max(1000)
  .refine((value) => {
    const host = new URL(value).hostname.toLowerCase();
    return !OUR_HOSTS.includes(host);
  }, 'ссылка должна вести на сайт магазина, а не на адреса Инвойсбокса');

export const basketItem = z
  .object({
    sku: z.string().min(1).max(36),
    name: z.string().min(1).max(300),
    type: z.enum(ITEM_TYPES).default('commodity'),
    measure: z.string().min(1).max(10).optional(),
    measure_code: z.string().regex(/^\d{1,4}$/).optional(),
    quantity: z.number().positive(),
    amount: amount.describe('цена одной единицы с НДС, копейки строкой'),
    amount_wo_vat: amount.optional().describe('цена одной единицы без НДС; по умолчанию считается сама'),
    total_amount: amount.describe('за всё количество с НДС: amount × quantity'),
    total_vat_amount: amount.describe('НДС за всё количество'),
    vat_code: z.enum(VAT_CODES),
    payment_type: z.enum(PAYMENT_TYPES).default('full_payment'),
    group_name: z.string().max(500).optional(),
    service_date: z.string().date().optional(),
  })
  .strict();

export const customer = z
  .object({
    type: z.enum(['legal', 'private']).default('legal'),
    name: z.string().min(1).max(500).optional(),
    vat_number: z.string().regex(/^\d{10}$|^\d{12}$/).optional(),
    tax_registration_reason_code: z.string().regex(/^\d{4}[\dA-Z]{2}\d{3}$/).optional(),
    registration_address: z.string().max(1000).optional(),
    email: z.string().email().max(100).optional(),
    phone: z.string().regex(/^\d{10,15}$/).optional(),
  })
  .strict();

export type BasketItemInput = z.output<typeof basketItem>;
export type CustomerInput = z.output<typeof customer>;
