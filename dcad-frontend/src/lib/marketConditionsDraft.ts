import type {
  MarketContextOverride,
  MarketConditionsAreaKey,
  MarketConditionsResponse,
} from './api';
import {
  browserDraftIdentityKey,
  type BrowserDraftSession,
} from './browserDraftIdentity.ts';

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
  version: 3;
  accountId: string;
  assignmentFileId?: number | null;
  savedAt: string;
  asOfDate: string;
  periodMonths: 12 | 24 | 36;
  selectedAreaKeys: MarketConditionsAreaKey[];
  contextOverride?: MarketContextOverride | null;
  response: MarketConditionsResponse;
  reconciliation: MarketConditionsReconciliation;
};

const STORAGE_PREFIX = 'homenode-market-conditions:';

function normalizedAccountId(accountId: string): string {
  return accountId.trim().toUpperCase();
}

function normalizedAssignmentFileId(assignmentFileId: number | null | undefined): number | null {
  return Number.isSafeInteger(assignmentFileId) && Number(assignmentFileId) > 0
    ? Number(assignmentFileId)
    : null;
}

function storageKey(accountId: string, assignmentFileId: number, identityKey: string): string {
  return `${STORAGE_PREFIX}${normalizedAccountId(accountId)}:${assignmentFileId}:${identityKey}`;
}

export function readMarketConditionsDraft(
  accountId: string,
  assignmentFileId?: number | null,
  session?: BrowserDraftSession | null,
): MarketConditionsDraft | null {
  const normalizedId = normalizedAssignmentFileId(assignmentFileId);
  const normalizedAccount = normalizedAccountId(accountId);
  const identityKey = browserDraftIdentityKey(session);
  if (typeof window === 'undefined' || !normalizedAccount || !normalizedId || !identityKey) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(normalizedAccount, normalizedId, identityKey));
    if (!raw) return null;
    const stored = JSON.parse(raw) as {
      storageVersion?: number;
      identityKey?: string;
      draft?: MarketConditionsDraft;
    };
    const parsed = stored.draft;
    if (
      stored.storageVersion !== 1 ||
      stored.identityKey !== identityKey ||
      parsed?.version !== 3 ||
      normalizedAccountId(parsed?.accountId || '') !== normalizedAccount ||
      normalizedAssignmentFileId(parsed?.assignmentFileId) !== normalizedId ||
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
  session?: BrowserDraftSession | null,
): void {
  const accountId = normalizedAccountId(draft.accountId);
  const assignmentFileId = normalizedAssignmentFileId(draft.assignmentFileId);
  const identityKey = browserDraftIdentityKey(session);
  if (typeof window === 'undefined' || !accountId || !assignmentFileId || !identityKey) return;
  try {
    window.localStorage.setItem(
      storageKey(accountId, assignmentFileId, identityKey),
      JSON.stringify({
        storageVersion: 1,
        identityKey,
        draft: { ...draft, accountId, assignmentFileId },
      }),
    );
  } catch {
    // The market study remains visible for the active browser session.
  }
}
