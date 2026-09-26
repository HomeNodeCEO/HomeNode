import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomCohortPreparedSecondaryMap, readCustomCohortPreparedSecondaryFacts }
  from '../src/services/neighborhoodAssessment/customCohortPreparedSecondaryMap.js';
import { buildCustomCohortPocketRecommendationPresentation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';

const CAPTURE = '2026-09-25T23:00:00.000Z', OBSERVED = '2026-09-25T21:03:19.000Z';
const HASH = 'a'.repeat(64), GENERATION = '6d971f59-90a1-4410-bd63-a16bfdbc774e';
function retained(effective = '2026-09-25') {
  return { subject: { effective_date: effective }, spatial: { account_ids: ['A', 'B', 'C'] }, acquisition: { capture_result: {
    captured_at: CAPTURE, source_capture: { sources: [{ payload: { projection: { definition: { role: 'parcels' } },
      records: ['A', 'B', 'C'].map((account_id, index) => ({ data: { raw_projection: {
        object_id: String(index + 1), account_id, source_record_hash: HASH } } })) } }] },
  } } };
}
const fact = (id, account_id, extra = {}) => ({ object_id: String(id), account_id, source_record_hash: HASH,
  bedroom_count: '3', bath_count: null, garage_area_sqft: '300', outbuilding_area_sqft: null, pool: null,
  generation_id: GENERATION, source_observed_at: OBSERVED, ...extra });

test('prepared facts require exact retained parcel revisions and never turn unknown into absence', async () => {
  const rows = [fact(1, 'A'), fact(2, 'B', { bedroom_count: '4', outbuilding_area_sqft: '1200' }),
    fact(3, 'C', { source_record_hash: 'b'.repeat(64) })];
  const query = async (sql, values) => {
    assert.match(sql, /generation\.source_observed_at <= \$2::timestamptz/);
    assert.deepEqual(values, [['1', '2', '3'], CAPTURE]); return { rows };
  };
  const result = await readCustomCohortPreparedSecondaryFacts(query, retained());
  assert.equal(result.accounts.size, 2);
  assert.equal(result.accounts.get('A').bedroom_count, '3');
  assert.equal(result.accounts.get('A').bath_count, null);
  assert.equal(result.accounts.get('B').outbuilding_area_sqft, '1200');
  assert.equal(result.accounts.has('C'), false);
  assert.equal(result.source_observed_at, OBSERVED);
});

test('retrospective report never reads the current prepared snapshot', async () => {
  let called = false;
  const result = await readCustomCohortPreparedSecondaryFacts(() => { called = true; }, retained('2026-08-31'));
  assert.equal(result, null); assert.equal(called, false);
});

test('secondary group means use actual member scores and preserve the established recommendation', () => {
  const recommendation = { subject: { account_id: 'A' }, properties: [
    { account_id: 'A', recorded_group_id: 'g1', similarity: { lower: 70, upper: 90 } },
    { account_id: 'B', recorded_group_id: 'g1', similarity: { lower: 70, upper: 90 } },
    { account_id: 'C', recorded_group_id: 'g2', similarity: { lower: 30, upper: 80 } },
  ], pockets: [{ id: 'g1', result: { similarity: { lower: 70, upper: 90 } } },
    { id: 'g2', result: { similarity: { lower: 30, upper: 80 } } }] };
  const before = structuredClone(recommendation);
  const facts = { generation_id: GENERATION, source_observed_at: OBSERVED, retained_capture_at: CAPTURE,
    accounts: new Map([['A', { bedroom_count: '3', outbuilding_area_sqft: '100' }],
      ['B', { bedroom_count: '5', outbuilding_area_sqft: '2000' }]]) };
  const result = buildCustomCohortPreparedSecondaryMap(recommendation, facts);
  assert.equal(result.groups[0].member_count, 2);
  assert.equal(result.groups[0].supported_member_count, 2);
  assert.ok(result.groups[0].lower < 70 && result.groups[0].lower > 65);
  assert.deepEqual(result.groups[1], { id: 'g2', member_count: 1, supported_member_count: 0, lower: 30, upper: 80 });
  assert.deepEqual(recommendation, before);
  assert.equal(buildCustomCohortPreparedSecondaryMap(recommendation, { ...facts, accounts: new Map() }), null);
});

test('optional live map overlay leaves the established public recommendation unchanged', async () => {
  const fixture = await decisionEvidenceFixture();
  const retained_inputs = fixture.input.retained_inputs, context_ref = fixture.input.expected.context_ref;
  const selection = { revision: 7, pockets: [] }, expected = { context_ref, selection_revision: 7 };
  const preview = buildCustomCohortObservationPreview({ context_ref, retained_inputs, selection });
  const catalog = presentCustomCohortPocketCatalog({ catalog: { ...fixture.catalog,
    binding: { context_ref, selection_revision: 7 } }, preview, expected });
  const args = { catalog, expected, retained_inputs };
  const original = buildCustomCohortPocketRecommendationPresentation(args);
  const facts = { generation_id: GENERATION, source_observed_at: OBSERVED, retained_capture_at: CAPTURE,
    accounts: new Map(fixture.accountIds.map((id, index) => [id, { bedroom_count: index === 0 ? '3' : '4' }])) };
  const extended = buildCustomCohortPocketRecommendationPresentation({ ...args, prepared_secondary_facts: facts });
  assert.ok(extended.prepared_secondary_map);
  const { prepared_secondary_map: _overlay, ...stable } = extended;
  assert.deepEqual(stable, original);
  assert.equal(extended.prepared_secondary_map.groups.reduce((n, row) => n + row.member_count, 0), original.all.member_count);
});
