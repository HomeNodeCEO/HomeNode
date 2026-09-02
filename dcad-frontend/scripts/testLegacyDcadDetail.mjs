import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mapAccountDetailToLegacy } from '../src/lib/legacyDcadDetail.ts';

test('the legacy DCAD mapper preserves valid account, activity, and exemption data', () => {
  const response = mapAccountDetailToLegacy({
    account: {
      latest_tax_year: 2026,
      address: '1909 Snowmass Ln',
      city: 'Garland',
      county: 'Dallas',
      postal_code: '75044',
      neighborhood_code: 'NBHD-1',
      legal_description: 'LOT 1 BLOCK A',
      latest_market_value: '325000',
      latest_land_value: 75000,
    },
    owner_summary: { owner_name: 'CURRENT OWNER', mailing_address: 'PO BOX 1' },
    owner_parties: [
      { owner_name: 'CURRENT OWNER', ownership_pct: 100 },
      null,
      'invalid',
    ],
    primary_improvements: {
      construction_type: 'FRAME',
      living_area_sqft: 1840,
      basement_raw: 'NONE',
      baths_full: 2,
      baths_half: 1,
    },
    housing_profile: { structural_style: 'Ranch', attachment_type: 'Detached' },
    legal_current: { legal_lines: ['LOT 1', 'BLOCK A'], deed_transfer_date: '2025-01-02' },
    exemptions_summary_year: 2026,
    exemptions_summary: [
      { tax_year: 2025, taxing_jurisdiction: 'Dallas County', homestead_exemption: 1 },
      { tax_year: 2026, taxing_jurisdiction: 'Dallas ISD', homestead_exemption: 100000 },
      { tax_year: 2026, taxing_jurisdiction: 'City of Garland', taxable_value: 225000 },
    ],
    homestead_yes: true,
    land_detail: [{ number: 1, area_sqft: 8400 }, null],
    additional_improvements: [{ improvement_type: 'Garage', area_sqft: 440 }, false],
    sales_history: [
      { record_type: 'closed_sale', closing_date: '2024-01-01', sale_price: 250000 },
      { record_type: 'closed_sale', closing_date: '2025-01-01', sale_price: 275000 },
    ],
    property_activity_history: [{
      sale_id: 12,
      listing_id: 'MLS-12',
      record_type: 'listing',
      listing_date: '2025-12-01',
      list_price: 300000,
      requires_additional_review: true,
      data_quality_flags: ['missing_close', 42],
    }],
    census_geography: { tract_code: '190123', tract_geoid: '481130190123', status: 'matched' },
  });

  assert.equal(response.detail.property_location.state, 'TX');
  assert.equal(response.detail.property_location.census_tract, '190123');
  assert.equal(response.detail.owner?.parties.length, 1);
  assert.equal(response.detail.main_improvement.total_living_area, 1840);
  assert.equal(response.detail.main_improvement.basement_raw, 'NONE');
  assert.equal(response.detail.housing_profile?.attachment_type, 'detached');
  assert.equal(response.detail.legal_description.lines[1], 'BLOCK A');
  assert.equal(response.detail.exemptions?.school.homestead_exemption, 100000);
  assert.equal(response.detail.exemptions?.city.taxable_value, 225000);
  assert.equal(response.detail.exemptions?.county, undefined);
  assert.equal(response.detail.land_detail.length, 1);
  assert.equal(response.detail.additional_improvements.length, 1);
  assert.deepEqual(response.detail.sales_history.map((row) => row.sale_price), [275000, 250000]);
  assert.deepEqual(response.detail.property_activity_history[0].data_quality_flags, ['missing_close']);
  assert.equal(response.detail.property_activity_history[0].requires_additional_review, true);
});

test('manual report snapshots override explicit fields but blanks cannot erase source data', () => {
  const response = mapAccountDetailToLegacy({
    account: {
      address: 'CURRENT ADDRESS',
      county: 'Dallas',
      legal_description: 'CURRENT LEGAL',
      latest_market_value: 300000,
    },
    owner_summary: { owner_name: 'CURRENT OWNER', mailing_address: 'CURRENT MAILING' },
    primary_improvements: { building_class: 'CLASS 17', living_area_sqft: 1800 },
    property_activity_history: [{ record_type: 'closed_sale', sale_price: 200000 }],
    report_manual_values: {
      'report.subject_identification': {
        value: {
          property_location: { address: '', city: 'Garland' },
          owner: { owner_name: 'APPRAISER OWNER', mailing_address: ' ' },
          legal_description: { lines: [] },
        },
      },
      'report.property_characteristics': {
        value: {
          main_improvement: { building_class: '', living_area_sqft: 1900 },
          additional_improvements: [],
        },
      },
      'report.appraisal_values': {
        value: { value_summary: { market_value: 310000, land_value: null } },
      },
      'report.sales_history': {
        value: {
          property_activity_history: [
            { record_type: 'listing', list_price: 320000 },
            { record_type: 'closed_sale', sale_price: 315000 },
          ],
        },
      },
      'report.assignment_details': { value: { occupancy: 'Owner' } },
    },
  });

  assert.equal(response.detail.property_location.address, 'CURRENT ADDRESS');
  assert.equal(response.detail.property_location.city, 'Garland');
  assert.equal(response.detail.owner?.owner_name, 'APPRAISER OWNER');
  assert.equal(response.detail.owner?.mailing_address, 'CURRENT MAILING');
  assert.deepEqual(response.detail.legal_description.lines, ['CURRENT LEGAL']);
  assert.equal(response.detail.main_improvement.building_class, 'CLASS 17');
  assert.equal(response.detail.main_improvement.living_area_sqft, 1900);
  assert.equal(response.detail.value_summary.market_value, 310000);
  assert.equal(response.detail.sales_history.length, 1);
  assert.equal(response.detail.sales_history[0].sale_price, 315000);
  assert.equal(response.detail.assignment_details.occupancy, 'Owner');
});

test('malformed API fields are contained at the legacy boundary', () => {
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"account":"bad","owner_parties":{},"primary_improvements":[],"land_detail":[null,1,"bad"],"property_activity_history":[null,{"record_type":7,"data_quality_flags":"bad"}],"exemptions_summary":["bad"],"report_manual_values":{"report.assignment_details":{"value":{"__proto__":{"polluted":true},"occupancy":"Tenant"}}}}');
  const response = mapAccountDetailToLegacy(hostile);

  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(response.detail.property_location.census_tract_status, 'pending');
  assert.deepEqual(response.detail.land_detail, []);
  assert.equal(response.detail.property_activity_history.length, 1);
  assert.equal(response.detail.property_activity_history[0].record_type, undefined);
  assert.deepEqual(response.detail.property_activity_history[0].data_quality_flags, []);
  assert.equal(response.detail.assignment_details.occupancy, 'Tenant');
  assert.equal(Object.hasOwn(response.detail.assignment_details, '__proto__'), false);
});

test('the legacy DCAD boundary has no explicit-any escape or raw health fetch', async () => {
  const [adapter, mapper] = await Promise.all([
    readFile(new URL('../src/lib/dcad.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/legacyDcadDetail.ts', import.meta.url), 'utf8'),
  ]);
  const explicitAny = /\bas any\b|:\s*any\b|<any>|Record<string,\s*any>/;
  assert.doesNotMatch(adapter, explicitAny);
  assert.doesNotMatch(mapper, explicitAny);
  assert.doesNotMatch(adapter, /fetch\(['"]\/health/);
  assert.match(adapter, /health as getApiHealth/);
});
