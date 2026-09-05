import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  districtEvidenceGridRows,
  gridRowComparableCandidate,
  mergePropertyTaxComparableRows,
  patchPropertyTaxComparableRow,
  readPropertyTaxComparableGrid,
  recommendedSaleGridRow,
  writePropertyTaxComparableGrid,
} from '../src/lib/propertyTaxComparableGrid.ts';

const componentSource = fs.readFileSync(
  new URL('../src/components/PropertyTaxComparableGrid.tsx', import.meta.url),
  'utf8',
);

test('recommended sales retain source identity and use the protest workflow subject', () => {
  const row = recommendedSaleGridRow({
    sale_id: 10,
    source_record_id: 20,
    listing_id: 'MLS-20',
    address: '100 Main Street',
    closing_date: '2025-06-15',
    sale_price: '425000',
    match_status: 'exact',
    requires_additional_review: false,
    has_unresolved_parcel: false,
    neighborhood_code: 'NBHD-10',
    cad_building_class: '17',
    cad_living_area_sqft: 1950,
    source: 'Licensed MLS feed',
  }, {
    propertyUse: 'single_family_residential',
    neighborhoodCode: 'NBHD-10',
  });
  assert.equal(row?.id, 'recommended:20');
  assert.equal(row?.reviewStatus, 'needs_review');
  assert.equal(row?.armsLength, false);
  assert.equal(row?.sourceReference, 'MLS-20');
});

test('district comparable candidates are staged with document provenance and review required', () => {
  const rows = districtEvidenceGridRows({
    id: 44,
    document_type: 'district_evidence',
    title: 'DCAD evidence packet',
    candidates: [{
      id: 500,
      field_key: 'district_comparable',
      normalized_value: JSON.stringify({
        account_id: '0001',
        address: '200 Oak Street',
        sale_date: '2025-08-20',
        sale_price: 450000,
        adjusted_value: 462000,
        neighborhood_code: 'NBHD-10',
        building_class: '17',
      }),
      raw_value: 'Comparable Sale 1',
      page_number: 3,
      confidence: 0.86,
      evidence_excerpt: 'Comparable Sale 1',
      extraction_method: 'district_comparable_labeled_block',
    }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'district:44:500');
  assert.equal(rows[0].districtAdjustedValue, 462000);
  assert.equal(rows[0].documentPage, 3);
  assert.equal(rows[0].reviewStatus, 'needs_review');
});

test('grid persistence stays under the selected protest workfile and deduplicates repeated extraction', () => {
  const district = districtEvidenceGridRows({
    id: 44,
    document_type: 'district_evidence',
    title: 'DCAD evidence packet',
    candidates: [{
      id: 500,
      field_key: 'district_comparable',
      normalized_value: '{"address":"200 Oak Street","sale_price":450000}',
      raw_value: 'Comparable Sale 1',
      page_number: 3,
      confidence: 0.7,
      evidence_excerpt: null,
      extraction_method: 'district_comparable_labeled_block',
    }],
  });
  const merged = mergePropertyTaxComparableRows(district, district);
  assert.equal(merged.length, 1);
  const saved = writePropertyTaxComparableGrid(
    { protest_case: { district_code: 'tx-dallas-cad' } },
    merged,
    'dcad-residential-comparables-2026.1',
  );
  assert.equal(readPropertyTaxComparableGrid(saved).rows.length, 1);
  assert.deepEqual(saved.protest_case, { district_code: 'tx-dallas-cad' });
  assert.equal('assignment_file_id' in saved, false);
  assert.equal('uad_workfile_id' in saved, false);
});

test('shared analysis candidates use grid-row identity so district and MLS versions cannot collide', () => {
  const subject = {
    accountId: 'SUBJECT',
    valuationDate: '2026-01-01',
    propertyUse: 'single_family_residential',
    neighborhoodCode: 'NBHD-10',
  };
  const base = {
    id: 'district:44:500',
    source: 'district_evidence',
    sourceLabel: 'DCAD evidence',
    sourceReference: 'document:44:candidate:500',
    documentId: 44,
    documentPage: 3,
    saleId: '0001',
    accountId: '0001',
    address: '200 Oak Street',
    saleDate: '2025-08-20',
    salePrice: 450000,
    districtAdjustedValue: 462000,
    concessions: null,
    adjustmentAmount: -5000,
    propertyUse: 'single_family_residential',
    neighborhoodCode: 'NBHD-10',
    buildingClass: '',
    livingAreaSqft: 2000,
    siteSizeSqft: null,
    yearBuilt: 2000,
    bedroomCount: 3,
    bathCount: 2,
    garageSpaces: 2,
    pool: false,
    reviewStatus: 'verified',
    armsLength: true,
  };
  const candidate = gridRowComparableCandidate(base, subject);
  assert.equal(candidate.saleId, 'district:44:500');
  assert.equal(candidate.manualAdjustments?.[0].amount, -5000);
});

test('material edits invalidate verified and arm\'s-length comparable attestations', () => {
  const verified = {
    id: 'district:44:500',
    source: 'district_evidence',
    sourceLabel: 'DCAD evidence',
    sourceReference: 'document:44:candidate:500',
    documentId: 44,
    documentPage: 3,
    saleId: '0001',
    accountId: '0001',
    address: '200 Oak Street',
    saleDate: '2025-08-20',
    salePrice: 450000,
    districtAdjustedValue: 462000,
    concessions: null,
    adjustmentAmount: -5000,
    propertyUse: 'single_family_residential',
    neighborhoodCode: 'NBHD-10',
    buildingClass: '17',
    livingAreaSqft: 2000,
    siteSizeSqft: 7500,
    yearBuilt: 2000,
    bedroomCount: 3,
    bathCount: 2,
    garageSpaces: 2,
    pool: false,
    reviewStatus: 'verified',
    armsLength: true,
  };
  assert.deepEqual(
    patchPropertyTaxComparableRow(verified, { salePrice: 475000 }),
    { ...verified, salePrice: 475000, reviewStatus: 'needs_review', armsLength: false },
  );
  assert.deepEqual(
    patchPropertyTaxComparableRow(verified, { adjustmentAmount: -7500 }),
    { ...verified, adjustmentAmount: -7500, reviewStatus: 'needs_review', armsLength: false },
  );
  assert.equal(patchPropertyTaxComparableRow(verified, { address: verified.address }).reviewStatus, 'verified');
  assert.equal(patchPropertyTaxComparableRow(verified, { armsLength: false }).reviewStatus, 'verified');
});

test('comparable attestation controls are limited to the assigned signing appraiser', () => {
  assert.match(componentSource, /!authenticationRequired \|\| Boolean/);
  assert.match(componentSource, /session\?\.user_id === file\.assigned_appraiser_user_id/);
  assert.match(componentSource, /organization\.permissions\.property_tax_protest\?\.sign/);
  assert.match(componentSource, /disabled=\{!canAttestComparables\}/);
  assert.match(componentSource, /disabled=\{rowAttestationLocked\}/);
  assert.match(componentSource, /patchPropertyTaxComparableRow\(row, patch\)/);
  assert.match(componentSource, /Only the assigned appraiser can verify a sale/);
});
