import type { QualitativeAnalysisResponse, SaleRow } from "./api";

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
  version: 1 | 2;
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

function storageKey(accountId: string): string {
  return `${STORAGE_PREFIX}${accountId.trim()}`;
}

export function saveAppraisalReportDraft(draft: AppraisalReportSalesDraft): void {
  if (typeof window === "undefined" || !draft.accountId.trim()) return;
  try {
    window.localStorage.setItem(storageKey(draft.accountId), JSON.stringify(draft));
  } catch {
    // The printable report still has an automatic recommendation fallback.
  }
}

export function removeAppraisalReportDraft(accountId: string): void {
  if (typeof window === "undefined" || !accountId.trim()) return;
  try {
    window.localStorage.removeItem(storageKey(accountId));
  } catch {
    // Legacy cleanup is best-effort after the database copy succeeds.
  }
}

export function readAppraisalReportDraft(
  accountId: string,
): AppraisalReportSalesDraft | null {
  if (typeof window === "undefined" || !accountId.trim()) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(accountId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppraisalReportSalesDraft;
    if (
      ![1, 2].includes(parsed?.version) ||
      parsed?.accountId !== accountId.trim() ||
      !Array.isArray(parsed?.comparables)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
