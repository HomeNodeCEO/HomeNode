import type {
  MarketConditionsAreaKey,
  MarketConditionsResponse,
} from './api';

export type MarketTrendConclusion =
  | 'increasing'
  | 'stable'
  | 'decreasing'
  | 'mixed'
  | 'insufficient';

export type MarketConditionsReconciliation = {
  trendConclusion: MarketTrendConclusion;
  reliedUponAreaKeys: MarketConditionsAreaKey[];
  explanation: string;
};

export type MarketConditionsDraft = {
  version: 1;
  accountId: string;
  savedAt: string;
  asOfDate: string;
  periodMonths: 12 | 24 | 36;
  selectedAreaKeys: MarketConditionsAreaKey[];
  response: MarketConditionsResponse;
  reconciliation: MarketConditionsReconciliation;
};

const STORAGE_PREFIX = 'homenode-market-conditions:';

function storageKey(accountId: string): string {
  return `${STORAGE_PREFIX}${accountId.trim()}`;
}

export function readMarketConditionsDraft(
  accountId: string,
): MarketConditionsDraft | null {
  if (typeof window === 'undefined' || !accountId.trim()) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(accountId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MarketConditionsDraft;
    if (
      parsed?.version !== 1 ||
      parsed?.accountId !== accountId.trim() ||
      !Array.isArray(parsed?.response?.analyses)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveMarketConditionsDraft(
  draft: MarketConditionsDraft,
): void {
  if (typeof window === 'undefined' || !draft.accountId.trim()) return;
  try {
    window.localStorage.setItem(storageKey(draft.accountId), JSON.stringify(draft));
  } catch {
    // The market study remains visible for the active browser session.
  }
}
