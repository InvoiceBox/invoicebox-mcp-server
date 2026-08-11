import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VAT_RATES } from './registry/vat.js';
import { measureByCode } from './registry/units.js';

const UNIT_CODES = ['796', '006', '166', '112', '356', '359', '362', '704', '778'];

interface ResourceEntry {
  uri: string;
  name: string;
  title: string;
  description: string;
  payload: () => unknown;
}

/** Справочники отдаются ресурсами: они ничего не выполняют и кэшируются клиентом. */
export const RESOURCES: readonly ResourceEntry[] = [
  {
    uri: 'invoicebox://registry/vat-rates',
    name: 'vat-rates',
    title: 'Ставки НДС Инвойсбокса',
    description: 'Коды ставок НДС для позиций корзины: /docs/dictionary/tag1199/',
    payload: () => ({
      note: 'с 2026 года основная ставка 22 %: RUS_VAT22_ADDED — налог сверх цены, RUS_VAT22 — налог в цене',
      rates: VAT_RATES,
    }),
  },
  {
    uri: 'invoicebox://registry/okei',
    name: 'okei',
    title: 'Единицы измерения ОКЕИ',
    description: 'Ходовые коды единиц измерения: /docs/dictionary/okei/',
    payload: () => ({
      note: 'достаточно передать measure или measure_code — парное поле сервер заполнит сам',
      units: UNIT_CODES.map((code) => ({ code, measure: measureByCode(code) })),
    }),
  },
  {
    uri: 'invoicebox://templates/order',
    name: 'order-template',
    title: 'Эталонное тело счёта',
    description: 'Минимальный набор параметров create_order с суммами в копейках',
    payload: () => ({
      description: 'Оплата номера в отеле',
      customer: {
        type: 'legal',
        name: 'ООО «Ромашка»',
        vat_number: '7701234560',
        tax_registration_reason_code: '770101001',
        registration_address: '190000, Санкт-Петербург, Невский пр. 147, офис 321',
      },
      basket_items: [
        {
          sku: 'SKU-1',
          name: 'Бронирование номера',
          type: 'service',
          measure: 'шт',
          quantity: 1,
          amount: '12200',
          total_amount: '12200',
          total_vat_amount: '2200',
          vat_code: 'RUS_VAT22',
          payment_type: 'full_payment',
        },
      ],
      amount: '12200',
      vat_amount: '2200',
      currency_id: 'RUB',
      expiration_date: '2026-08-11T00:00:00+00:00',
    }),
  },
];

export function registerResources(server: McpServer): void {
  for (const resource of RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: 'application/json' },
      async () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: 'application/json',
            text: JSON.stringify(resource.payload(), null, 2),
          },
        ],
      }),
    );
  }
}
