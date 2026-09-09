import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortSaleMeaningResolver as create, getCustomSaleMeaningProfile as profile,
  CUSTOM_COHORT_SALE_MEANING_LIMITS } from '../src/services/neighborhoodAssessment/customCohortSaleMeaningResolver.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';

const base = decisionEvidenceFixture();
function resolve(fixture) {
  const resolver = create(fixture.input), ref = resolver.deriveEvidenceRef(fixture.sourceRef, fixture.recordId);
  return { resolver, ref, result: resolver.resolveMeaning(JSON.stringify(ref)) };
}
const withSale = async saleOverrides => resolve(await decisionEvidenceFixture({ saleOverrides }));

test('installed meaning profile is immutable, content-bound, and explicitly local v2 only', () => {
  const descriptor = profile(), definition = JSON.parse(descriptor.definition_blob.canonical_json);
  assert.equal(definition.cached_mapping_version, 2);
  assert.equal(definition.attribution, 'local_stored_observations');
  assert.equal(definition.provider_meaning, 'not_established');
  assert.equal(descriptor.profile_ref.content_sha256,
    createHash('sha256').update(descriptor.definition_blob.canonical_json).digest('hex'));
  assert.equal(descriptor.definition_blob.ref.content_sha256, descriptor.profile_ref.content_sha256);
  assert.ok(Object.isFrozen(descriptor.profile_ref));
  assert.equal(profile(), descriptor);
});

test('actual retained capture resolves values/ref/profile without source queries or fact-authority promotion', async () => {
  const fixture = await base, before = JSON.stringify(fixture.input), { result, ref } = resolve(fixture);
  assert.deepEqual(result.evidence_ref, ref);
  assert.deepEqual(result.binding.context_ref, fixture.input.expected.context_ref);
  assert.deepEqual(result.profile_ref, profile().profile_ref);
  assert.equal(result.fields.source_close_date.value, '2024-03-01');
  assert.equal(result.fields.source_current_price.value, '275000');
  assert.equal(result.fields.source_living_area.value, '1850.125');
  assert.equal(result.fields.source_days_on_market.value, 0);
  assert.equal(result.fields.source_days_on_market.status, 'observed');
  assert.equal(result.fields.source_housing_type.value, 'Single family');
  assert.equal(result.comparisons.date.status, 'agree');
  assert.equal(result.comparisons.price.status, 'agree');
  assert.equal(result.comparisons.account.status, 'agree');
  assert.equal(result.comparisons.price.agreement_is_independent_confirmation, false);
  assert.equal(result.status, 'observations_only'); assert.equal(result.authority, 'not_established');
  assert.equal(result.apply.status, 'blocked'); assert.equal(result.assessment, null);
  assert.equal(result.unavailable.housing_taxonomy, 'not_established');
  assert.equal(result.unavailable.currency, 'not_established');
  assert.equal(result.unavailable.source_area_units, 'not_established');
  assert.equal(result.unavailable.historical_validity, 'not_established');
  assert.equal(result.unavailable.source_mls_status, 'not_retained_by_mapping_v2');
  assert.equal(fixture.f.state.calls.length, 0); assert.equal(JSON.stringify(fixture.input), before);
  assert.ok(Object.isFrozen(result.fields.source_current_price));
  assert.ok(Buffer.byteLength(json(result)) < CUSTOM_COHORT_SALE_MEANING_LIMITS.output_utf8_bytes);
});

test('canonical and source prices compare exactly without rounding away differences', async () => {
  const { result } = await withSale({ sale_price: '9007199254740993.01', source_current_price: '9007199254740993.02' });
  assert.equal(result.fields.sale_price.value, '9007199254740993.01');
  assert.equal(result.fields.source_current_price.exact_decimal, '9007199254740993.02');
  assert.equal(result.comparisons.price.status, 'conflicting');
  assert.equal(result.comparisons.price.agreed_value, null);
});

test('same exact decimal with different scale agrees while original scale is preserved', async () => {
  const { result } = await withSale({ sale_price: '275000.000', source_current_price: '275000.00' });
  assert.equal(result.fields.sale_price.value, '275000.000');
  assert.equal(result.fields.source_current_price.value, '275000.00');
  assert.equal(result.comparisons.price.agreed_value, '275000');
});

test('date conflict remains a conflict and source current price never fills missing canonical price', async () => {
  const { result } = await withSale({ source_close_date: '2024-04-01', sale_price: null });
  assert.equal(result.comparisons.date.status, 'conflicting');
  assert.equal(result.fields.sale_price.status, 'missing');
  assert.equal(result.fields.sale_price.value, null);
  assert.equal(result.fields.source_current_price.status, 'observed');
  assert.equal(result.comparisons.price.status, 'incomplete');
  assert.equal(result.unavailable.consideration_meaning, 'not_established');
});

for (const [value, presence, status] of [[null, 'sql_null', 'missing'], ['', 'blank', 'missing'],
  ['  ', 'blank', 'missing'], ['0', 'present', 'invalid'], [false, 'present', 'invalid'],
  ['1e3', 'present', 'invalid'], ['1,800', 'present', 'invalid'], ['NaN', 'present', 'invalid']]) {
  test(`living-area presence/type remains explicit for ${JSON.stringify(value)}`, async () => {
    const { result } = await withSale({ source_living_area: value });
    assert.equal(result.fields.source_living_area.presence, presence);
    assert.equal(result.fields.source_living_area.status, status);
    assert.equal(result.fields.source_living_area.value, null);
  });
}

test('absent optional fields do not become SQL NULL or invented zeros', async () => {
  const { result } = resolve(await base);
  assert.equal(result.fields.source_structural_style.presence, 'absent');
  assert.equal(result.fields.source_structural_style.status, 'missing');
  assert.equal(result.fields.source_lot_size_area.value, null);
});

for (const value of [-1, 1.5, '12', false]) test(`invalid stored DOM ${JSON.stringify(value)} is not coerced`, async () => {
  const { result } = await withSale({ source_days_on_market: value });
  assert.equal(result.fields.source_days_on_market.status, 'invalid');
  assert.equal(result.fields.source_days_on_market.value, null);
});

test('housing labels remain literal, not a verified canonical taxonomy or an active listing classification', async () => {
  const { result } = await withSale({ source_housing_type: 'Condo/Townhome',
    source_structural_style: '<b>Single Detached</b>', source_attachment_type: 'mixed', record_type: 'listing' });
  assert.equal(result.fields.source_housing_type.value, 'Condo/Townhome');
  assert.equal(result.fields.source_structural_style.value, '<b>Single Detached</b>');
  assert.equal(result.fields.source_attachment_type.value, 'mixed');
  assert.equal(result.fields.record_type.value, 'listing');
  assert.equal(result.unavailable.housing_taxonomy, 'not_established');
  assert.equal(result.unavailable.market_eligibility, 'not_established');
  assert.equal(result.unavailable.sale_completion, 'not_established');
  assert.equal(result.fields.source_living_area.unit, null);
});

test('duplicate canonical identities fail whole-capture admission, not a convenient single-row interpretation', async () => {
  const account = (await base).accountIds[0];
  await assert.rejects(decisionEvidenceFixture({ extraTransactions: [{ source_record_id: '11', sale_id: '20',
    primary_account_id: account, sale_account_id: account, source_record_hash: 'c'.repeat(64), record_type: 'closed_sale',
    sale_closing_date: '2024-03-01', source_close_date: '2024-03-02', sale_price: '275000', source_current_price: '276000' }] }), /duplicate_sale_id/);
});

test('different canonical transactions are not pooled, matched by price, or declared equivalent', async () => {
  const account = (await base).accountIds[0];
  const fixture = await decisionEvidenceFixture({ extraTransactions: [{ source_record_id: '11', sale_id: '21',
    primary_account_id: account, sale_account_id: account, source_record_hash: 'c'.repeat(64), record_type: 'closed_sale',
    sale_closing_date: '2024-03-01', source_close_date: '2024-03-02', sale_price: '275000', source_current_price: '276000' }] });
  const { result } = resolve(fixture);
  assert.equal(result.fields.source_current_price.value, '275000', 'requested row remains separately identified');
  assert.equal(result.comparison_scope.evaluated_record_count, 1);
  assert.equal(result.comparisons.date.status, 'agree');
  assert.equal(result.comparisons.price.status, 'agree');
  assert.equal(result.comparisons.price.observed_field_count, 2);
  assert.equal(result.unavailable.transaction_equivalence, 'not_established');
});

test('foreign/forged refs and non-sale roles reject rather than receiving field meaning', async () => {
  const fixture = await base, { resolver, ref } = resolve(fixture);
  for (const key of ['manifest_sha256', 'chunk_sha256', 'record_content_sha256']) {
    assert.throws(() => resolver.resolveMeaning(JSON.stringify({ ...ref, [key]: 'f'.repeat(64) })));
  }
  assert.throws(() => resolver.resolveMeaning(JSON.stringify({ ...ref, record_key: 'foreign' })));
  const source = fixture.input.retained_inputs.acquisition.capture_result.source_capture.sources.find(row => row.payload.projection.definition.role === 'parcels');
  const parcelRef = resolver.deriveEvidenceRef(source.id, source.payload.records[0].record_id);
  assert.throws(() => resolver.resolveMeaning(JSON.stringify(parcelRef)), /transactions_role_required/);
});

test('profile flags, unsupported capture mapping and wrong target cannot enable interpretation', async () => {
  const fixture = await base, { resolver, ref } = resolve(fixture);
  assert.throws(() => create(fixture.input, { verified: true }), /arguments/);
  assert.throws(() => resolver.resolveMeaning(JSON.stringify(ref), { currency: 'USD' }), /arguments/);
  const input = structuredClone(fixture.input);
  input.expected.target.account_id = 'OTHER'; assert.throws(() => create(input));
  const version = structuredClone(fixture.input);
  for (const source of version.retained_inputs.acquisition.capture_result.source_capture.sources) {
    if (source.payload.projection.definition.role === 'transactions') source.payload.records[0].data.data.cached_mapping_version = 3;
  }
  assert.throws(() => create(version), 'version2-only admission never falls back to an unverified v3 record');
});

test('resolver snapshots records and membership and does not react to later caller mutation', async () => {
  const fixture = await base, input = structuredClone(fixture.input);
  const resolver = create(input), ref = resolver.deriveEvidenceRef(fixture.sourceRef, fixture.recordId);
  const before = resolver.resolveMeaning(JSON.stringify(ref));
  input.retained_inputs.acquisition.capture_result.source_capture.sources.length = 0;
  input.expected.context_ref.context_sha256 = 'f'.repeat(64);
  assert.deepEqual(resolver.resolveMeaning(JSON.stringify(ref)), before);
});
