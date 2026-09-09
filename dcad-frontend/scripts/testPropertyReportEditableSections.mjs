import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { editablePropertyReportSectionValue } from '../src/lib/propertyReportEditableSections.ts';

const context = (values = {}) => ({
  detail: null, improvement: undefined, housing: undefined,
  inspectionDetails: {}, additionalImprovements: [], ...values,
});
const read = (section, values) => editablePropertyReportSectionValue('report.' + section, context(values));

test('empty subject and exemptions preserve existing manual-editor defaults', () => {
  assert.deepEqual(read('subject_identification'), {
    property_location: { address: '', neighborhood: '', city: '', state: 'TX', postal_code: '',
      county: '', subdivision: '', census_tract: '' },
    owner: { owner_name: '', mailing_address: '', parties: [] },
    legal_description: { lines: [], deed_transfer_date: '' },
  });
  const exemptions = read('exemptions');
  assert.equal(exemptions.homestead_yes, false);
  assert.deepEqual(Object.keys(exemptions.exemptions), ['city', 'school', 'county', 'college', 'hospital', 'special_district']);
  for (const value of Object.values(exemptions.exemptions)) {
    assert.deepEqual(value, { taxing_jurisdiction: '', homestead_exemption: '', disabled_vet: '', taxable_value: '' });
  }
  assert.notEqual(exemptions.exemptions.city, exemptions.exemptions.school);
});

test('subject projection preserves field selection and original array-cloning boundaries', () => {
  const detail = {
    property_location: { address: '1 Example St', neighborhood: 'Recorded', city: 'Example', state: 'OK',
      postal_code: '00001', county: 'County', subdivision: 'Plat', census_tract: '0012.34', mapsco: 'not projected' },
    owner: { owner_name: 'Owner', mailing_address: 'Mailbox', parties: [{ owner_name: 'Owner', ownership_pct: 0 }] },
    legal_description: { lines: ['Line 1'], deed_transfer_date: '2024-01-01' },
  };
  const value = read('subject_identification', { detail });
  assert.equal(value.property_location.address, '1 Example St');
  assert.equal(value.property_location.state, 'OK');
  assert.equal(Object.hasOwn(value.property_location, 'mapsco'), false);
  assert.deepEqual(value.owner.parties, detail.owner.parties);
  assert.notEqual(value.owner.parties, detail.owner.parties);
  assert.notEqual(value.owner.parties[0], detail.owner.parties[0]);
  assert.equal(value.legal_description.lines, detail.legal_description.lines,
    'Preserve the existing non-cloned legal-lines behavior');
});

test('exemption, land and activity arrays preserve exact values and are detached', () => {
  const detail = {
    homestead_yes: true, exemptions: { city: { taxing_jurisdiction: 'City', homestead_exemption: 0, taxable_value: '100.00' } },
    land_detail: [{ number: 1, area_sqft: 0, unit_price: '1.50' }],
    sales_history: [{ sale_id: '1', sale_price: 123 }], property_activity_history: [{ listing_id: '2', list_price: 456 }],
  };
  const exemption = read('exemptions', { detail });
  assert.equal(exemption.homestead_yes, true);
  assert.deepEqual(exemption.exemptions.city, detail.exemptions.city);
  assert.notEqual(exemption.exemptions.city, detail.exemptions.city);
  const land = read('land_details', { detail }).land_detail;
  assert.deepEqual(land, detail.land_detail); assert.notEqual(land[0], detail.land_detail[0]);
  const activity = read('sales_history', { detail }).property_activity_history;
  assert.deepEqual(activity, detail.property_activity_history);
  assert.notEqual(activity[0], detail.property_activity_history[0]);
  assert.deepEqual(read('sales_history', { detail: { sales_history: detail.sales_history } }).property_activity_history, detail.sales_history);
  assert.deepEqual(read('sales_history', { detail: { ...detail, property_activity_history: [] } }).property_activity_history, []);
});

test('property editor uses the supplied resolved characteristics, not a fresh source lookup', () => {
  const improvement = { living_area_sqft: '2000', year_built: 2004, bedroom_count: 0, bath_count: '2',
    pool: false, sprinkler: null, fence_type: 'Wood', unprojected: 'omit' };
  const housing = { structural_style: 'Recorded style', housing_type: 'Recorded housing', attachment_type: '',
    architectural_style: 'Recorded architecture' };
  const inspectionDetails = { notes: 'Existing', nested: { condition: 'Reviewed' } };
  const additionalImprovements = [{ number: 1, improvement_type: 'Shed', area_sqft: 0 }];
  const value = read('property_characteristics', { detail: { main_improvement: { living_area_sqft: '9999' } },
    improvement, housing, inspectionDetails, additionalImprovements });
  assert.equal(value.main_improvement.living_area_sqft, '2000');
  assert.equal(value.main_improvement.year_built, 2004);
  assert.equal(value.main_improvement.bedroom_count, '', 'Retain the existing || default, not a new numeric policy');
  assert.equal(value.main_improvement.pool, false);
  assert.equal(value.main_improvement.sprinkler, '');
  assert.equal(Object.hasOwn(value.main_improvement, 'unprojected'), false);
  assert.deepEqual(value.housing_profile, { ...housing, attachment_type: 'unknown' });
  assert.deepEqual(value.inspection_details, inspectionDetails);
  assert.notEqual(value.inspection_details.nested, inspectionDetails.nested);
  assert.deepEqual(value.additional_improvements, additionalImprovements);
  assert.notEqual(value.additional_improvements[0], additionalImprovements[0]);
  const empty = read('property_characteristics');
  assert.ok(Object.values(empty.main_improvement).every(item => item === ''));
  assert.deepEqual(empty.housing_profile, { structural_style: '', housing_type: '', attachment_type: 'unknown', architectural_style: '' });
});

test('appraisal and assignment projection keep existing defaults, booleans and explicit editor fields', () => {
  assert.deepEqual(read('appraisal_values', { detail: { value_summary: {
    certified_year: 2024, market_value: 0, capped_value: '0', improvement_value: '100', land_value: '20',
  } } }), { value_summary: { certified_year: 2024, market_value: '', capped_value: '0', improvement_value: '100', land_value: '20' } });
  const defaults = read('assignment_details');
  assert.equal(defaults.pud, false); assert.equal(defaults.subject_under_contract, false);
  assert.equal(defaults.contract_arms_length, true); assert.equal(defaults.seller_matches_public_records, null);
  assert.deepEqual(defaults.assignment_types, []);
  const detail = { assignment_details: { pud: true, hoa_dues_amount: '0', occupancy: 'owner',
    assignment_types: ['purchase_transaction'], contract_arms_length: false, seller_matches_public_records: false,
    neighborhood_sale_count: 77, neighborhood_boundary_geometry: { type: 'Polygon' }, client_name: 'not part of this editor' } };
  const value = read('assignment_details', { detail });
  assert.equal(value.pud, true); assert.equal(value.hoa_dues_amount, '0'); assert.equal(value.occupancy, 'owner');
  assert.equal(value.contract_arms_length, false); assert.equal(value.seller_matches_public_records, false);
  assert.deepEqual(value.assignment_types, detail.assignment_details.assignment_types);
  assert.notEqual(value.assignment_types, detail.assignment_details.assignment_types);
  for (const key of ['neighborhood_sale_count', 'neighborhood_boundary_geometry', 'client_name']) {
    assert.equal(Object.hasOwn(value, key), false);
  }
});

test('page delegates only pure manual-editor values and keeps accepted read/hydration guards in place', () => {
  const page = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('../src/lib/propertyReportEditableSections.ts', import.meta.url), 'utf8');
  assert.match(page, /editablePropertyReportSectionValue\(sectionKey, \{\s*detail, improvement, housing, inspectionDetails, additionalImprovements,/);
  assert.match(page, /void loadCustomNeighborhoodAccepted\(accountId, selectedFile.id, neighborhoodSection\)\.then/);
  assert.match(page, /if \(!isCancelled\(\)\) setAcceptedNeighborhood\(restored\)/);
  assert.match(page, /enabled: legacyNeighborhoodAllowed/);
  assert.doesNotMatch(helper, /\b(?:fetch|useEffect|useState|setAssignmentDraft|loadCustomNeighborhoodAccepted|saveCustomAppraisalWorkfileSection)\b/);
});
