import type { ContractPriceSupportAnalysis, SaleRow } from './api';
import type { AppliedGroupedAdjustment } from '../components/GroupedAdjustmentAnalysis';
import { monthsBeforeDate } from './comparableSalesPresentation.ts';

export function formatComparableSquareFeet(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  const number = typeof value === 'string' ? Number(String(value).replace(/[^0-9.-]/g, '')) : Number(value);
  if (!isFinite(number) || number <= 0) return '-';
  return `${number.toLocaleString('en-US')} sq. ft`;
}

export function formatComparableCurrency(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const sanitized = typeof value === 'string' ? value.replace(/[^0-9.-]/g, '') : String(value);
  if (!/\d/.test(sanitized)) return String(value);
  const number = Number(sanitized);
  if (!isFinite(number)) return String(value);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(number);
}

export function comparableSaleKey(sale: SaleRow): string {
  return sale.source_record_id != null ? `source-${sale.source_record_id}` : `legacy-${sale.sale_id}`;
}

export function parseComparableSaleNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const sanitized = String(value).replace(/[^0-9.-]/g, '');
  if (!/\d/.test(sanitized)) return null;
  const parsed = Number(sanitized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function signedAdjustment(value: number): string {
  const formatted = formatComparableCurrency(Math.abs(value));
  return value > 0 ? `+${formatted}` : value < 0 ? `−${formatted}` : formatted;
}

export function groupedBreakdownSummary(
  dimensionKey: AppliedGroupedAdjustment['dimensionKey'],
  gridAdjustments: number[],
  appliedStudies: AppliedGroupedAdjustment[],
  selectedSales: Array<SaleRow | null>,
): string {
  const studies = appliedStudies.filter((adjustment) => adjustment.dimensionKey === dimensionKey);
  if (!studies.length) {
    return 'No market adjustment has been applied yet. Run a supported methodology above, enter any desired factor, and apply its result to update the grid.';
  }
  const study = studies[studies.length - 1];
  const isPairedStudy = study.id.startsWith('paired:');
  const unitLabel = dimensionKey === 'bathrooms'
    ? 'full-bath equivalent'
    : dimensionKey === 'garage'
      ? 'garage space'
    : dimensionKey === 'living_area'
        ? 'square foot'
        : dimensionKey === 'site_size'
          ? 'site square foot'
          : dimensionKey === 'age'
            ? 'year of age'
        : 'pool difference';
  const hasLivingAreaFormula =
    (dimensionKey === 'living_area' || dimensionKey === 'site_size') &&
    study.sourcePriceDifference != null &&
    study.sourceLivingAreaDifference != null &&
    Number.isFinite(study.sourcePriceDifference) &&
    Number.isFinite(study.sourceLivingAreaDifference) &&
    study.sourceLivingAreaDifference > 0;
  const appliedText = hasLivingAreaFormula
    ? `${study.marketLabel} — ${study.transitionLabel} ${study.optionLabel}: ` +
      `${signedAdjustment(study.sourcePriceDifference!)} ÷ ` +
      `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(study.sourceLivingAreaDifference!)} SF = ` +
      `${signedAdjustment(study.baseAmount)} per SF; ${study.factorPercent}% factoring = ` +
      `${signedAdjustment(study.amount)} per SF`
    : isPairedStudy
      ? `${study.marketLabel} — ${study.transitionLabel} ${study.optionLabel}: ` +
        `${signedAdjustment(study.baseAmount)} × ${study.factorPercent}% factoring = ` +
        `${signedAdjustment(study.amount)} per ${unitLabel}`
      : `${study.marketLabel} — ${study.transitionLabel} study selected: ` +
        `${signedAdjustment(study.baseAmount)} × ${study.factorPercent}% = ` +
        `${signedAdjustment(study.amount)} per ${unitLabel}`;
  const selectedCount = selectedSales.filter(Boolean).length;
  const affectedCount = gridAdjustments.filter((amount, index) => selectedSales[index] && amount !== 0).length;
  return `${appliedText}. This universal rate currently adjusts ${affectedCount} of ${selectedCount} selected comparable${selectedCount === 1 ? '' : 's'}.`;
}

export function saleDateDisplay(value: string | null): string {
  if (!value) return '';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-US');
}

export function saleDisplayAddress(sale: SaleRow): string {
  if (sale.address?.trim()) return sale.address.trim();
  if (sale.primary_account_id) return `Account ${sale.primary_account_id} (address unavailable)`;
  return `Unmatched sale${sale.source_row_number ? ` ${sale.source_row_number}` : ''}`;
}

export function saleIsOverOneYear(sale: SaleRow, analysisAsOf: string): boolean {
  if (sale.soldOverOneYear != null) return sale.soldOverOneYear;
  if (!sale.closing_date) return false;
  const saleDate = new Date(`${sale.closing_date.slice(0, 10)}T12:00:00Z`);
  const cutoff = new Date(`${monthsBeforeDate(analysisAsOf, 12)}T12:00:00Z`);
  return !Number.isNaN(saleDate.getTime()) && !Number.isNaN(cutoff.getTime()) && saleDate < cutoff;
}

export function housingTypeNeedsReview(sale: SaleRow): boolean {
  return !(sale.structural_style || sale.housing_type || '').trim();
}

export function attachmentNeedsReview(sale: SaleRow): boolean {
  return !housingTypeNeedsReview(sale) &&
    (!sale.attachment_type || sale.attachment_type === 'unknown');
}

export function housingTypeGridValue(sale: SaleRow | null | undefined): string {
  if (!sale) return 'Not available';
  if (housingTypeNeedsReview(sale)) return '⚠ Review';
  return sale.structural_style || sale.housing_type || 'Not available';
}

export function contractSupportLoadNotice(
  analysis: ContractPriceSupportAnalysis | null,
  count: number,
  maximum: number,
): string {
  const kind = analysis?.upper_tier_review
    ? 'contract-support and upper-tier'
    : 'contract-support';
  return `${Math.min(count, maximum)} nearby ${kind} review sales loaded. Re-run adjustments and verify condition and quality.`;
}

export function statisticalOutlierLabel(sale: SaleRow): string {
  if (!sale.statistical_outlier) return '';
  const direction = sale.statistical_outlier_direction === 'low' ? 'low' : 'high';
  return `Statistical outlier · unusually ${direction} price/SF`;
}

export function suggestedAttachmentType(
  housingType: string,
  current: 'detached' | 'attached' | 'mixed' | 'unknown',
): 'detached' | 'attached' | 'mixed' | 'unknown' {
  const normalized = housingType.trim().toLowerCase();
  if (/\bdetached\b/.test(normalized) || normalized === 'single family') return 'detached';
  if (
    /\battached\b/.test(normalized) ||
    normalized.includes('townhome') ||
    normalized.includes('townhouse') ||
    normalized.includes('condo') ||
    normalized.includes('duplex')
  ) return 'attached';
  if (normalized.includes('multi-family') || normalized.includes('multifamily')) return 'mixed';
  return current;
}
