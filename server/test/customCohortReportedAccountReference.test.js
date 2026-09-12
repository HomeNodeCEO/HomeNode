import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { denseReportedAccountReference } from '../src/services/neighborhoodAssessment/customCohortReportedAccountReference.js';

const row = () => ({ account_id: 'SYNTHETIC', parcel_object_ids: ['1', '2'],
  observations: { gla_sqft: { state: 'observed', exact_value: '1800.123456789012', raw_values: ['1800.123456789012'] },
    site_area_sqft: { state: 'conflicting', exact_value: null, raw_values: ['4000', '5000'] },
    year_built: { state: 'missing', exact_value: null, raw_values: [] }, market_value: { state: 'observed', exact_value: '200000' } },
  source_references: [{ source_ref: 'synthetic-chunk', record_id: 'synthetic-record' }] });

test('dense account reference keeps exact used cells and binds every original observation/provenance field', () => {
  const original = row(), before = structuredClone(original), result = denseReportedAccountReference(original);
  assert.equal(result.retained_preview_member_sha256, assessmentEvidenceDigest(original));
  assert.deepEqual(result.observations, { gla_sqft: { state: 'observed', exact_value: '1800.123456789012' },
    site_area_sqft: { state: 'conflicting', exact_value: null }, year_built: { state: 'missing', exact_value: null } });
  assert.deepEqual(original, before); assert.ok(Object.isFrozen(result.observations.gla_sqft));
  for (const mutate of [r => { r.parcel_object_ids[0] = '3'; }, r => { r.source_references[0].record_id = 'other'; },
    r => { r.observations.market_value.exact_value = '1'; }, r => { r.observations.site_area_sqft.raw_values[0] = '3999'; }]) {
    const changed = row(); mutate(changed);
    assert.notEqual(denseReportedAccountReference(changed).retained_preview_member_sha256, result.retained_preview_member_sha256);
  }
});
