import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPropertyTaxPacketReadiness,
  calculateDistrictEvidenceDueDate,
  DALLAS_RESIDENTIAL_2026,
  readPropertyTaxCase,
} from '../src/lib/propertyTaxCase.ts';

test('Dallas residential configuration is explicit and versioned', () => {
  assert.equal(DALLAS_RESIDENTIAL_2026.version, 'dcad-residential-2026.1');
  assert.equal(DALLAS_RESIDENTIAL_2026.valuationDate, '2026-01-01');
  assert.equal(DALLAS_RESIDENTIAL_2026.publishedRealPropertyProtestDeadline, '2026-05-15');
  assert.equal(DALLAS_RESIDENTIAL_2026.evidenceDeliveryDaysBeforeHearing, 14);
  assert.equal(DALLAS_RESIDENTIAL_2026.ufile.maximumBytesPerFile, 8 * 1024 * 1024);
  assert.ok(DALLAS_RESIDENTIAL_2026.prohibitedFilingMethods.includes('email'));
});

test('evidence due date is fourteen calendar days before the recorded hearing', () => {
  assert.equal(calculateDistrictEvidenceDueDate('2026-07-06'), '2026-06-22');
  assert.equal(calculateDistrictEvidenceDueDate('2026-03-10'), '2026-02-24');
  assert.equal(calculateDistrictEvidenceDueDate('not-a-date'), null);
});

test('case parsing and packet readiness use only the protest workfile', () => {
  const workfileData = {
    protest_case: {
      district_code: 'tx-dallas-cad',
      property_use: 'single_family_residential',
      notice_date: '2026-04-14',
      protest_deadline: '2026-05-20',
      market_value_ground: 'yes',
      protest_status: 'filed',
      filing_method: 'ufile',
      protest_filed_at: '2026-05-01',
      filing_receipt_reference: 'DCAD-RECEIPT-1',
      hearing_date: '2026-07-06',
      evidence_request_status: 'sent',
      evidence_request_sent_at: '2026-05-02',
      evidence_request_method: 'mail',
      evidence_request_proof_reference: 'USPS-TRACKING-1',
    },
    subject: {
      district_neighborhood_code: '12345.001',
      district_building_class: '17',
    },
  };
  const parsed = readPropertyTaxCase(workfileData);
  assert.equal(parsed.marketValueGround, true);
  assert.equal(parsed.neighborhoodCode, '12345.001');

  const readiness = buildPropertyTaxPacketReadiness({
    workfileData,
    taxYear: 2026,
    hasCanonicalFile: true,
  });
  assert.equal(readiness.districtConfiguration?.districtCode, 'tx-dallas-cad');
  assert.equal(readiness.effectiveProtestDeadline, '2026-05-20');
  assert.equal(readiness.districtEvidenceDueDate, '2026-06-22');
  assert.equal(readiness.milestones.find((item) => item.key === 'case_setup')?.status, 'complete');
  assert.equal(readiness.milestones.find((item) => item.key === 'protest_filing')?.status, 'complete');
  assert.equal(readiness.milestones.find((item) => item.key === 'evidence_request')?.status, 'complete');
  assert.match(readiness.warnings[0], /notice-specific protest deadline differs/);
});

test('an unloaded file remains not started and never implies a filing', () => {
  const readiness = buildPropertyTaxPacketReadiness({
    workfileData: null,
    taxYear: null,
    hasCanonicalFile: false,
  });
  assert.equal(readiness.milestones[0].status, 'not_started');
  assert.equal(readiness.milestones[1].status, 'not_started');
  assert.equal(readiness.districtEvidenceDueDate, null);
});

test('the latest database neighborhood can satisfy case context without a workfile save', () => {
  const readiness = buildPropertyTaxPacketReadiness({
    workfileData: {
      protest_case: {
        district_code: 'tx-dallas-cad',
        property_use: 'single_family_residential',
      },
    },
    taxYear: 2026,
    neighborhoodCode: 'DB-NBHD-10',
    hasCanonicalFile: true,
  });
  const setup = readiness.milestones.find((item) => item.key === 'case_setup');
  assert.equal(setup?.status, 'complete');
  assert.match(setup?.detail || '', /DB-NBHD-10/);
});
