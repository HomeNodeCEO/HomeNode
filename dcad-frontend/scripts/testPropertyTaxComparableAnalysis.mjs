import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzePropertyTaxComparables,
  DALLAS_RESIDENTIAL_COMPARABLE_POLICY,
} from '../src/lib/propertyTaxComparableAnalysis.ts';

const subject = {
  accountId: 'SUBJECT-1',
  valuationDate: '2026-01-01',
  districtAppraisedValue: 500_000,
  propertyUse: 'single_family_residential',
  neighborhoodCode: 'NBHD-10',
  buildingClass: 'CLASS-17',
  livingAreaSqft: 2_000,
  siteSizeSqft: 8_000,
  bedroomCount: 3,
  bathCount: 2,
  garageSpaces: 2,
  ageYears: 30,
  pool: false,
};

function candidate(overrides = {}) {
  return {
    saleId: 'SALE-A',
    address: '100 Main Street',
    saleDate: '2025-11-01',
    salePrice: 450_000,
    concessions: 0,
    saleVerified: true,
    armsLength: true,
    propertyUse: 'single_family_residential',
    neighborhoodCode: 'NBHD-10',
    buildingClass: 'CLASS-17',
    livingAreaSqft: 1_900,
    siteSizeSqft: 8_000,
    bedroomCount: 3,
    bathCount: 2,
    garageSpaces: 2,
    ageYears: 31,
    pool: false,
    sourceName: 'Licensed MLS feed',
    sourceReference: 'MLS-1',
    ...overrides,
  };
}

test('Dallas policy requires an objective same-neighborhood eligible universe', () => {
  const result = analyzePropertyTaxComparables({
    subject,
    candidates: [
      candidate(),
      candidate({ saleId: 'SALE-OUTSIDE', address: '200 Low Price Road', salePrice: 250_000, neighborhoodCode: 'NBHD-99' }),
      candidate({ saleId: 'SALE-UNVERIFIED', address: '300 Unknown Lane', salePrice: 300_000, saleVerified: false }),
    ],
  });
  assert.deepEqual(result.selectedComparables.map((item) => item.candidate.saleId), ['SALE-A']);
  assert.deepEqual(
    result.candidateDecisions.find((item) => item.saleId === 'SALE-OUTSIDE')?.exclusionCodes,
    ['different_neighborhood'],
  );
  assert.deepEqual(
    result.candidateDecisions.find((item) => item.saleId === 'SALE-UNVERIFIED')?.exclusionCodes,
    ['unverified_sale'],
  );
  assert.match(result.diagnostics[0], /Only 1 eligible/);
});

test('selection rank is independent of sale price', () => {
  const candidates = [
    candidate({ saleId: 'MOST-SIMILAR', salePrice: 600_000, livingAreaSqft: 1_990, ageYears: 30 }),
    candidate({ saleId: 'SECOND', salePrice: 420_000, livingAreaSqft: 1_850, ageYears: 32 }),
    candidate({ saleId: 'THIRD', salePrice: 390_000, livingAreaSqft: 1_700, ageYears: 35 }),
  ];
  const first = analyzePropertyTaxComparables({ subject, candidates });
  const changedPrices = candidates.map((item, index) => ({
    ...item,
    salePrice: [300_000, 700_000, 900_000][index],
  }));
  const second = analyzePropertyTaxComparables({ subject, candidates: changedPrices });
  assert.deepEqual(
    first.selectedComparables.map((item) => item.candidate.saleId),
    second.selectedComparables.map((item) => item.candidate.saleId),
  );
});

test('the shared adjustment math produces auditable indications and a median', () => {
  const result = analyzePropertyTaxComparables({
    subject,
    candidates: [
      candidate({
        saleId: 'ADJUSTED-A',
        salePrice: 430_000,
        concessions: 5_000,
        livingAreaSqft: 1_800,
        manualAdjustments: [{
          key: 'time',
          label: 'Market conditions',
          amount: 10_000,
          source: { name: 'Neighborhood time study', reference: 'STUDY-1' },
        }],
      }),
      candidate({ saleId: 'ADJUSTED-B', salePrice: 450_000, livingAreaSqft: 2_000 }),
      candidate({ saleId: 'ADJUSTED-C', salePrice: 470_000, livingAreaSqft: 2_000 }),
    ],
    numericRules: [{
      feature: 'living_area_sqft',
      amountPerUnit: 100,
      source: { name: 'Paired-sales GLA study', reference: 'GLA-1' },
    }],
  });
  const adjustedA = result.selectedComparables.find((item) => item.candidate.saleId === 'ADJUSTED-A');
  assert.equal(adjustedA?.indication.netAdjustment, 25_000);
  assert.equal(adjustedA?.indication.grossAdjustment, 35_000);
  assert.equal(adjustedA?.indication.adjustedSalePrice, 455_000);
  assert.equal(adjustedA?.valuePosition, 'supports_lower_value');
  assert.equal(result.indicatedMarketValue, 455_000);
  assert.equal(result.policyVersion, DALLAS_RESIDENTIAL_COMPARABLE_POLICY.version);
});
