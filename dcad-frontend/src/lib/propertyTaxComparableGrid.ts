import type { AssignmentDocument, SaleRow } from './api.ts';
import type {
  PropertyTaxComparableCandidate,
  PropertyTaxComparableSubject,
} from './propertyTaxComparableAnalysis.ts';

export type PropertyTaxComparableSource = 'recommended_sale' | 'district_evidence';
export type PropertyTaxComparableReviewStatus = 'verified' | 'needs_review';

export interface PropertyTaxComparableGridRow {
  id: string;
  source: PropertyTaxComparableSource;
  sourceLabel: string;
  sourceReference: string;
  documentId: number | null;
  documentPage: number | null;
  saleId: string;
  accountId: string;
  address: string;
  saleDate: string;
  salePrice: number | null;
  districtAdjustedValue: number | null;
  concessions: number | null;
  adjustmentAmount: number;
  propertyUse: string;
  neighborhoodCode: string;
  buildingClass: string;
  livingAreaSqft: number | null;
  siteSizeSqft: number | null;
  yearBuilt: number | null;
  bedroomCount: number | null;
  bathCount: number | null;
  garageSpaces: number | null;
  pool: boolean | null;
  reviewStatus: PropertyTaxComparableReviewStatus;
  armsLength: boolean;
}

export interface PropertyTaxComparableGridState {
  version: 1;
  rows: PropertyTaxComparableGridRow[];
  updatedAt: string | null;
  recommendationPolicy: string;
}

const MAX_GRID_ROWS = 40;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximum = 1_000): string {
  if (value == null || typeof value === 'object') return '';
  return String(value).trim().slice(0, maximum);
}

function number(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function boolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  return null;
}

function normalizedRow(value: unknown): PropertyTaxComparableGridRow | null {
  const row = record(value);
  const source = row.source === 'district_evidence' ? 'district_evidence' : 'recommended_sale';
  const id = text(row.id, 300);
  if (!id) return null;
  return {
    id,
    source,
    sourceLabel: text(row.sourceLabel, 300) || (source === 'district_evidence' ? 'Appraisal district evidence' : 'HomeNode recommendation'),
    sourceReference: text(row.sourceReference, 1_000),
    documentId: number(row.documentId),
    documentPage: number(row.documentPage),
    saleId: text(row.saleId, 300) || id,
    accountId: text(row.accountId, 100),
    address: text(row.address, 500),
    saleDate: text(row.saleDate, 20),
    salePrice: number(row.salePrice),
    districtAdjustedValue: number(row.districtAdjustedValue),
    concessions: number(row.concessions),
    adjustmentAmount: number(row.adjustmentAmount) || 0,
    propertyUse: text(row.propertyUse, 200) || 'single_family_residential',
    neighborhoodCode: text(row.neighborhoodCode, 200),
    buildingClass: text(row.buildingClass, 200),
    livingAreaSqft: number(row.livingAreaSqft),
    siteSizeSqft: number(row.siteSizeSqft),
    yearBuilt: number(row.yearBuilt),
    bedroomCount: number(row.bedroomCount),
    bathCount: number(row.bathCount),
    garageSpaces: number(row.garageSpaces),
    pool: boolean(row.pool),
    reviewStatus: row.reviewStatus === 'verified' ? 'verified' : 'needs_review',
    armsLength: row.armsLength === true,
  };
}

export function readPropertyTaxComparableGrid(workfileData: Record<string, unknown> | null | undefined): PropertyTaxComparableGridState {
  const analysis = record(record(workfileData).analysis);
  const grid = record(analysis.comparable_grid);
  const rows = Array.isArray(grid.rows)
    ? grid.rows.map(normalizedRow).filter((row): row is PropertyTaxComparableGridRow => Boolean(row)).slice(0, MAX_GRID_ROWS)
    : [];
  return {
    version: 1,
    rows,
    updatedAt: text(grid.updated_at, 100) || null,
    recommendationPolicy: text(grid.recommendation_policy, 200),
  };
}

export function writePropertyTaxComparableGrid(
  workfileData: Record<string, unknown>,
  rows: PropertyTaxComparableGridRow[],
  recommendationPolicy: string,
): Record<string, unknown> {
  const next = structuredClone(workfileData);
  const analysis = record(next.analysis);
  analysis.comparable_grid = {
    version: 1,
    rows: rows.slice(0, MAX_GRID_ROWS).map(normalizedRow).filter(Boolean),
    updated_at: new Date().toISOString(),
    recommendation_policy: recommendationPolicy,
  };
  next.analysis = analysis;
  return next;
}

export function mergePropertyTaxComparableRows(
  current: PropertyTaxComparableGridRow[],
  incoming: PropertyTaxComparableGridRow[],
): PropertyTaxComparableGridRow[] {
  const rows = [...current];
  const indexById = new Map(rows.map((row, index) => [row.id, index]));
  for (const candidate of incoming) {
    const row = normalizedRow(candidate);
    if (!row) continue;
    const existingIndex = indexById.get(row.id);
    if (existingIndex == null) {
      if (rows.length >= MAX_GRID_ROWS) break;
      indexById.set(row.id, rows.length);
      rows.push(row);
    } else if (rows[existingIndex].reviewStatus !== 'verified') {
      rows[existingIndex] = { ...row, adjustmentAmount: rows[existingIndex].adjustmentAmount };
    }
  }
  return rows;
}

export function recommendedSaleGridRow(
  sale: SaleRow,
  subject: { propertyUse: string; neighborhoodCode: string },
): PropertyTaxComparableGridRow | null {
  const salePrice = number(sale.sale_price);
  const address = text(sale.address);
  const saleId = text(sale.source_record_id ?? sale.sale_id, 300);
  if (!saleId || !salePrice || !address) return null;
  return normalizedRow({
    id: `recommended:${saleId}`,
    source: 'recommended_sale',
    sourceLabel: sale.source || 'HomeNode recommended sale',
    sourceReference: sale.listing_id || sale.source_filename || saleId,
    documentId: null,
    documentPage: null,
    saleId,
    accountId: sale.primary_account_id || '',
    address,
    saleDate: sale.closing_date || '',
    salePrice,
    concessions: number(sale.seller_contributions) || number(sale.concessions),
    adjustmentAmount: 0,
    propertyUse: subject.propertyUse,
    neighborhoodCode: sale.neighborhood_code || subject.neighborhoodCode,
    buildingClass: sale.cad_building_class || '',
    livingAreaSqft: sale.cad_living_area_sqft || number(sale.mls_living_area),
    siteSizeSqft: number(sale.comparableSiteSize) || number(sale.mls_lot_size_area),
    yearBuilt: sale.cad_year_built || sale.mls_year_built,
    bedroomCount: sale.mls_bedrooms_total || sale.cad_bedroom_count,
    bathCount: sale.mls_bathrooms_total_integer || number(sale.cad_bath_count),
    garageSpaces: number(sale.mls_garage_spaces),
    pool: sale.mls_pool_yn ?? sale.cad_pool,
    // A reliable parcel match does not establish the transaction terms. Keep
    // every imported recommendation out of the eligible set until a reviewer
    // confirms the sale details and arm's-length status in this protest file.
    reviewStatus: 'needs_review',
    armsLength: false,
  });
}

export function districtEvidenceGridRows(document: AssignmentDocument): PropertyTaxComparableGridRow[] {
  if (document.document_type !== 'district_evidence') return [];
  return (document.candidates || []).flatMap((candidate) => {
    if (candidate.field_key !== 'district_comparable' || !candidate.normalized_value) return [];
    let extracted: Record<string, unknown>;
    try {
      extracted = record(JSON.parse(candidate.normalized_value));
    } catch {
      return [];
    }
    const candidateId = candidate.id || `${candidate.page_number || 0}-${text(extracted.address)}`;
    const row = normalizedRow({
      id: `district:${document.id}:${candidateId}`,
      source: 'district_evidence',
      sourceLabel: document.title || 'Appraisal district evidence',
      sourceReference: `document:${document.id}:candidate:${candidate.id || 'extracted'}`,
      documentId: document.id,
      documentPage: candidate.page_number,
      saleId: text(extracted.account_id) || `district-${document.id}-${candidateId}`,
      accountId: extracted.account_id,
      address: extracted.address,
      saleDate: extracted.sale_date,
      salePrice: extracted.sale_price,
      districtAdjustedValue: extracted.adjusted_value,
      concessions: null,
      adjustmentAmount: 0,
      propertyUse: 'single_family_residential',
      neighborhoodCode: extracted.neighborhood_code,
      buildingClass: extracted.building_class,
      livingAreaSqft: extracted.living_area_sqft,
      siteSizeSqft: extracted.site_size_sqft,
      yearBuilt: extracted.year_built,
      bedroomCount: extracted.bedroom_count,
      bathCount: extracted.bath_count,
      garageSpaces: extracted.garage_spaces,
      pool: extracted.pool,
      reviewStatus: 'needs_review',
      armsLength: false,
    });
    return row ? [row] : [];
  });
}

export function gridRowComparableCandidate(
  row: PropertyTaxComparableGridRow,
  subject: PropertyTaxComparableSubject,
): PropertyTaxComparableCandidate {
  const valuationYear = Number(subject.valuationDate.slice(0, 4));
  return {
    saleId: row.id,
    address: row.address,
    saleDate: row.saleDate,
    salePrice: row.salePrice || 0,
    concessions: row.concessions,
    saleVerified: row.reviewStatus === 'verified',
    armsLength: row.armsLength,
    propertyUse: row.propertyUse || subject.propertyUse,
    neighborhoodCode: row.neighborhoodCode,
    buildingClass: row.buildingClass,
    livingAreaSqft: row.livingAreaSqft,
    siteSizeSqft: row.siteSizeSqft,
    bedroomCount: row.bedroomCount,
    bathCount: row.bathCount,
    garageSpaces: row.garageSpaces,
    ageYears: row.yearBuilt && Number.isFinite(valuationYear) ? valuationYear - row.yearBuilt : null,
    pool: row.pool,
    manualAdjustments: row.adjustmentAmount ? [{
      key: 'property_tax_current_adjustment',
      label: 'Current Property Tax adjustment',
      amount: row.adjustmentAmount,
      source: {
        name: row.sourceLabel,
        reference: row.sourceReference || row.id,
      },
    }] : [],
    sourceName: row.sourceLabel,
    sourceReference: row.sourceReference,
  };
}
