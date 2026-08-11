import { fingerprint } from '../core/canonical.js';
import { describeCatalog, type ToolDefinition } from './registry.js';
import { findOrders, findShipments, getOrder, lookupCompanyByInn } from './reads.js';
import { cancelOrder, createOrder, createRefund, createShipment } from './writes.js';

/** Порядок фиксирован: он влияет на выбор модели, поэтому закреплён тестом. */
export const CATALOG: readonly ToolDefinition[] = [
  lookupCompanyByInn,
  getOrder,
  findOrders,
  findShipments,
  createOrder,
  cancelOrder,
  createShipment,
  createRefund,
];

/** Области действия сервера; считаются по каталогу, чтобы совпасть с метаданными ресурса (RFC 9728). */
export function catalogScopes(tools: readonly ToolDefinition[] = CATALOG): string[] {
  return [...new Set(tools.map((tool) => tool.scope))].sort();
}

export function catalogFingerprint(tools: readonly ToolDefinition[] = CATALOG): string {
  return fingerprint(describeCatalog(tools));
}
