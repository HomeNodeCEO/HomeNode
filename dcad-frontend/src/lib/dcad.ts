// src/lib/dcad.ts
// Shim around the new DB-backed API helpers (src/lib/api.ts).
// - Re-exports: getHealth, getProperty, searchProperties + types
// - Back-compat aliases: search, searchByAddress, fetchDetail
//   (defaults countyId to 1 = Dallas; override if you support more counties)

import {
  apiSearch,
  getAccount as getAccountDb,
  health as getApiHealth,
  type AccountRow,
} from './api';
import { mapAccountDetailToLegacy } from './legacyDcadDetail';

// Health endpoint (proxied to the app server)
export async function getHealth(): Promise<unknown> {
  return getApiHealth();
}

// Legacy shape for older UI code that expected { query, results }
export type LegacySearchResponse = {
  query: string;
  results: AccountRow[];
};

/**
 * Legacy: searchByAddress(q, limit?, countyId?)
 * - Calls the new searchProperties under the hood.
 * - Defaults countyId to 1 (Dallas) to match your current dataset.
 */
export async function searchByAddress(
  q: string,
  limit = 5,
  countyId = 1
): Promise<LegacySearchResponse> {
  if (!q?.trim()) return { query: q ?? '', results: [] };
  void countyId;
  const results = await apiSearch(q, limit);
  return { query: q, results };
}

// Legacy alias some code might still import as { search }
export const search = searchByAddress;

/**
 * Legacy: fetchDetail(accountId, countyId?)
 * - Calls the new getProperty(countyId, accountId).
 * - Defaults countyId to 1 (Dallas).
 */
export async function fetchDetail(accountId: string, countyId = 1) {
  void countyId;
  // Database-backed detail only (no scraper). Map DB result to the legacy detail shape
  const normalizedAccountId = (accountId || '').trim();
  const data = await getAccountDb(normalizedAccountId);
  return mapAccountDetailToLegacy(data);
}

/** Utility kept from your previous file */
export function fmtMoney(x: string | number | null | undefined): string {
  if (x == null) return '—';
  if (typeof x === 'number') {
    return x.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    });
  }
  if (x.includes('$') || x.includes(',')) return x;
  const n = Number(x.replace(/[^\d.-]/g, ''));
  if (Number.isFinite(n)) {
    return n.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    });
  }
  return String(x);
}





