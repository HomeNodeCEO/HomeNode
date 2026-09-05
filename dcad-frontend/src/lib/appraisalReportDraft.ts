import type { QualitativeAnalysisResponse, SaleRow } from "./api";
import {
  browserDraftIdentityKey,
  type BrowserDraftSession,
} from "./browserDraftIdentity.ts";

export type AppraisalReportSubject = {
  accountId: string;
  address?: string | null;
  neighborhoodCode?: string | null;
  marketValue?: string | number | null;
  livingArea?: string | number | null;
  bedrooms?: string | number | null;
  bathsFull?: string | number | null;
  bathsHalf?: string | number | null;
  bathCount?: string | number | null;
  condition?: string | null;
  quality?: string | null;
};

export type AppraisalReportComparable = {
  sale: SaleRow;
  condition?: string;
  quality?: string;
  netAdjustment: number;
  grossAdjustment: number;
  indicatedValue: number;
  adjustments: {
    concessions: number;
    time: number;
    roomCount: number;
    bedrooms?: number;
    bathrooms?: number;
    livingArea: number;
    garage: number;
    pool: number;
    siteSize?: number;
    age?: number;
    condition: number;
    quality: number;
  };
};

export type AppraisalReportSalesDraft = {
  version: 1 | 2 | 3;
  accountId: string;
  assignmentFileId?: number | null;
  savedAt: string;
  source: "sales-comparison-workspace";
  subject: AppraisalReportSubject;
  comparables: AppraisalReportComparable[];
  opinionOfValue: number | null;
  opinionAfterCostToCure: number | null;
  costToCure?: {
    items: Array<{
      description: string;
      cost: number;
    }>;
    total: number;
  };
  salesNotes: string;
  adjustmentNotes: string;
  workspace?: {
    selectedListings?: SaleRow[];
    secondaryComparables?: SaleRow[];
    search?: {
      asOfDate?: string;
      periodMonths?: 12 | 24 | 36;
      comparableSearchProfile?: string;
      includeUnmatchedSales?: boolean;
      sameNeighborhoodOnly?: boolean;
      outlierScoreThreshold?: number;
    };
    appliedGroupedAdjustments?: Record<string, unknown>;
    appliedConditionQualityAdjustments?: Record<string, unknown>;
    conditionQualityRatings?: Record<string, {
      condition: string;
      quality: string;
    }>;
    qualitativeAnalysis?: QualitativeAnalysisResponse | null;
    ctcNotes?: string;
  };
};

const STORAGE_PREFIX = "homenode-appraisal-report:";

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

export function saveAppraisalReportDraft(
  draft: AppraisalReportSalesDraft,
  session?: BrowserDraftSession | null,
): void {
  const accountId = normalizedAccountId(draft.accountId);
  const assignmentFileId = normalizedAssignmentFileId(draft.assignmentFileId);
  const identityKey = browserDraftIdentityKey(session);
  if (typeof window === "undefined" || !accountId || !assignmentFileId || !identityKey) return;
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
    // The printable report still has an automatic recommendation fallback.
  }
}

export function removeAppraisalReportDraft(
  accountId: string,
  assignmentFileId?: number | null,
  session?: BrowserDraftSession | null,
): void {
  const normalizedId = normalizedAssignmentFileId(assignmentFileId);
  const identityKey = browserDraftIdentityKey(session);
  if (
    typeof window === "undefined" ||
    !normalizedAccountId(accountId) ||
    !normalizedId ||
    !identityKey
  ) return;
  try {
    window.localStorage.removeItem(storageKey(accountId, normalizedId, identityKey));
  } catch {
    // Scoped cleanup is best-effort after the database copy succeeds.
  }
}

export function readAppraisalReportDraft(
  accountId: string,
  assignmentFileId?: number | null,
  session?: BrowserDraftSession | null,
): AppraisalReportSalesDraft | null {
  const normalizedId = normalizedAssignmentFileId(assignmentFileId);
  const normalizedAccount = normalizedAccountId(accountId);
  const identityKey = browserDraftIdentityKey(session);
  if (typeof window === "undefined" || !normalizedAccount || !normalizedId || !identityKey) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(normalizedAccount, normalizedId, identityKey));
    if (!raw) return null;
    const stored = JSON.parse(raw) as {
      storageVersion?: number;
      identityKey?: string;
      draft?: AppraisalReportSalesDraft;
    };
    const parsed = stored.draft;
    if (
      stored.storageVersion !== 1 ||
      stored.identityKey !== identityKey ||
      ![1, 2, 3].includes(Number(parsed?.version)) ||
      normalizedAccountId(parsed?.accountId || "") !== normalizedAccount ||
      normalizedAssignmentFileId(parsed?.assignmentFileId) !== normalizedId ||
      !Array.isArray(parsed?.comparables)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
