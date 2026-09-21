import type { SaleRow } from './api';
import { monthsBeforeDate } from './comparableSalesPresentation';

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
