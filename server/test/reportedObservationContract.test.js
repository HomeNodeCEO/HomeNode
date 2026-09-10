import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { buildNeighborhoodAssessment as build, buildNeighborhoodAttachment as attach, canonicalAssessmentJson as json,
  assessmentEvidenceDigest, NEIGHBORHOOD_ASSESSMENT_CONTRACT_VERSION, NEIGHBORHOOD_MEASUREMENTS } from '../src/services/neighborhoodAssessment/contract.js';
import { REPORTED_OBSERVATION_PROFILE_ID, REPORTED_OBSERVATION_MEASUREMENTS } from '../src/services/neighborhoodAssessment/reportedObservationContract.js';
import { reportedObservationAssessmentFixture as fixture } from './fixtures/reportedObservationAssessmentFixture.js';
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from './fixtures/neighborhoodAssessmentFixture.js';

const hash = value => createHash('sha256').update(json(value)).digest('hex');
const fresh = () => fixture().input;
const price = input => input.statistics.find(row => row.id === 'reported-price-median');
const account = input => input.populations.find(row => row.id === 'accounts');
const records = input => input.populations.find(row => row.id === 'records');

test('v1 defaults, assessment bytes, input/evidence hashes and both attachment bytes are pinned before the extension', () => {
  assert.equal(NEIGHBORHOOD_ASSESSMENT_CONTRACT_VERSION, 1);
  assert.equal(Object.hasOwn(NEIGHBORHOOD_MEASUREMENTS, 'reported_close_price'), false);
  const a = build(neighborhoodAssessmentFixture());
  assert.equal(hash(a), 'a1a22dd0701ca6d4f3597a5ca185806ca8d49efeca4c72b6f9debd26f07597e9');
  assert.equal(a.input_signature_sha256, '6b5542aaa101a79ec26a147dcf526f2ff58e77d8eb065562df18c9d8d800b7f8');
  assert.equal(a.evidence_digest_sha256, 'ed3270b1be558fee346ecfa2ced5585835b4d2feb09eb0f70ae31557520a591b');
  assert.equal(hash(attach(a, neighborhoodTargetFixture('custom_appraisal'))), '9136d4dfce5aebf3ff7a38754221a34210b9084b06e8ed1e4812e3310a8291e3');
  assert.equal(hash(attach(a, neighborhoodTargetFixture())), 'c9f6749e4dc9159781a1069448ce00d9e3ede5e0e107b316cabe28babf8fe195');
});

test('explicit v2 profile produces an immutable coherent group without economic-property or verified-sale claims', () => {
  const { input, members, target } = fixture(), a = build(input), saved = attach(a, target);
  assert.equal(a.contract_version, 2); assert.equal(a.methodology.configuration.profile_id, REPORTED_OBSERVATION_PROFILE_ID);
  assert.equal(a.application_group.status, 'ready'); assert.equal(a.application_group.policy, 'all_or_nothing');
  assert.equal(saved.workflow_type, 'custom_appraisal'); assert.equal(saved.evidence_digest_sha256, a.evidence_digest_sha256);
  assert.ok(a.populations.every(p => p.provider_coverage === 'not_established'));
  assert.deepEqual(a.populations.map(p => p.member_unit), ['account', 'source_record']);
  assert.equal(Object.hasOwn(a.populations[1], 'unique_property_count'), false);
  assert.equal(Object.hasOwn(a.populations[1], 'property_link_count'), false);
  assert.equal(members.filter(m => m.member_unit === 'source_record')[0].account_ids.length, 2);
  assert.equal(a.populations[1].member_count, 1); assert.equal(a.populations[1].unique_account_count, 2);
  assert.equal(price(a).value, '282500.01'); assert.equal(a.statistics.find(s => s.id === 'reported-dom-median').value, '0');
  assert.equal(a.source_snapshots[0].valid_from, null); assert.equal(a.source_snapshots[0].historical_availability, 'unknown');
  input.populations[0].definition = 'mutated'; assert.notEqual(a.populations[0].definition, 'mutated');
  assert.ok(Object.isFrozen(a.statistics[0])); assert.deepEqual(build(a), a);
});

test('derived identities change with exact source, selection and geometry, not input ordering', () => {
  const input = fresh(), baseline = build(input);
  input.populations.reverse(); input.statistics.reverse(); input.source_snapshots.reverse(); input.required_population_ids.reverse();
  assert.deepEqual(build(input), baseline);
  for (const change of [v => { v.selection.revision = '2'; }, v => { v.source_snapshots[0].content_sha256 = 'e'.repeat(64); },
    v => { v.geographic_neighborhood.cardinal_summaries.north = 'Other manual boundary'; }]) {
    const value = fresh(); change(value); assert.notEqual(build(value).evidence_digest_sha256, baseline.evidence_digest_sha256);
  }
});

test('source exact decimal values retain precision beyond Number and do not become price allocations', () => {
  const input = fresh(); price(input).value = '9007199254740993.1234567890125';
  const a = build(input); assert.equal(price(a).value, '9007199254740993.1234567890125');
  assert.equal(records(a).account_link_count, 2); assert.equal(records(a).member_count, 1);
});

test('shared source-record associations are an explicit basis and retain more than five linked accounts', () => {
  const input = fresh(), p = records(input);
  Object.assign(p, { membership_basis: 'retained_source_account_associations', unique_account_count: 1000, account_link_count: 1000 });
  const a = build(input);
  assert.equal(records(a).membership_basis, 'retained_source_account_associations');
  assert.equal(records(a).account_link_count, 1000); assert.equal(records(a).member_count, 1);
  p.membership_basis = 'verified_economic_properties'; assert.throws(() => build(input), /population_basis/);
});

test('CurrentPrice and ClosePrice are distinct observations and DOM zero remains observed', () => {
  const input = fresh(); input.statistics.push({ ...price(input), id: 'current-price-median', measurement: 'reported_current_price', value: '300000' });
  const a = build(input);
  assert.equal(price(a).value, '282500.01'); assert.equal(a.statistics.find(s => s.id === 'current-price-median').value, '300000');
  assert.equal(a.statistics.find(s => s.id === 'reported-dom-median').value, '0');
});

test('optional missing or unknown-unit measures remain null without blocking ready exact counts', () => {
  for (const state of ['incomplete', 'unsupported']) {
    const input = fresh(), p = price(input); Object.assign(p, { value: null, status: state, reason: 'reported_currency_unknown',
      unit: null, observed_count: 0, unsupported_count: 1, estimator: state === 'unsupported' ? 'unsupported' : 'exact_median' });
    const a = build(input); assert.equal(price(a).value, null); assert.equal(a.application_group.status, 'ready');
  }
});

test('area units remain explicit and unconverted in descriptive statistics', () => {
  for (const [measurement, unit] of [['reported_living_area', 'sqm'], ['reported_site_area', 'acre'], ['reported_living_area', 'sqft']]) {
    const input = fresh(); Object.assign(price(input), { measurement, unit, value: '100.25' });
    const a = build(input); assert.equal(price(a).value, '100.25'); assert.equal(price(a).unit, unit);
  }
});

test('empty selected rosters and zero counts stay empty without a default-all or fabricated median', () => {
  const input = fresh(); input.selection.pocket_ids = [];
  for (const p of input.populations) Object.assign(p, { member_count: 0, unique_account_count: 0, account_link_count: 0,
    member_set_sha256: assessmentEvidenceDigest([]), pocket_ids: [] });
  for (const s of input.statistics) {
    s.observed_count = 0; s.denominator_count = 0;
    if (s.estimator === 'count') s.value = 0;
    else Object.assign(s, { value: null, status: 'unsupported', reason: 'empty_observation_population', estimator: 'unsupported' });
  }
  const a = build(input); assert.deepEqual(a.selection.pocket_ids, []); assert.equal(a.populations[0].member_count, 0);
  assert.equal(a.application_group.status, 'ready'); assert.equal(price(a).value, null);
});

test('later observed historical closing records are not rejected or promoted to historical CAD coverage', () => {
  const input = fixture({ effectiveDate: '2024-06-30' }).input;
  input.populations = input.populations.filter(p => p.id === 'records');
  input.statistics = input.statistics.filter(s => s.population_id === 'records');
  input.required_population_ids = ['records']; input.required_statistic_ids = ['record-count'];
  const captured = '2026-09-10T12:00:00.123456789Z';
  input.source_snapshots.forEach(s => { s.observed_at = captured; });
  records(input).captured_at = captured; input.generated_at = '2026-09-10T13:00:00.123456789Z';
  const a = build(input); assert.equal(a.application_group.status, 'ready'); assert.equal(price(a).value, '282500.01');
  assert.equal(records(a).captured_at, captured); assert.equal(a.source_snapshots[0].historical_availability, 'unknown');
});

test('current CAD captured after the effective day cannot leak into retrospective report observations', () => {
  const input = fresh(); input.generated_at = '2026-09-11T13:00:00Z';
  input.source_snapshots.forEach(s => { s.observed_at = '2026-09-11T12:00:00Z'; });
  input.populations.forEach(p => { p.captured_at = '2026-09-11T12:00:00Z'; });
  assert.throws(() => build(input), /historical_stock_evidence_required/);
});

test('current CAD before the effective date is visibly a dated reference, not an effective-date stock assertion', () => {
  const input = fresh(), captured = '2026-09-09T12:00:00Z';
  input.source_snapshots.forEach(s => { s.observed_at = captured; });
  input.populations.forEach(p => { p.captured_at = captured; });
  account(input).observation_period = { start_date: '2026-09-09', end_date: '2026-09-09', date_basis: 'capture_date' };
  const a = build(input); assert.equal(account(a).temporal_basis, 'current_cad_capture_reference');
  assert.equal(account(a).observation_period.end_date, '2026-09-09');
});

test('nanosecond chronology rejects even sub-millisecond future observations and preserves exact equivalent instants', () => {
  const input = fresh(); input.generated_at = '2026-09-10T12:00:00.123456789Z';
  input.source_snapshots[0].observed_at = '2026-09-10T12:00:00.123456790Z';
  assert.throws(() => build(input), /future_source/);
  input.source_snapshots[0].observed_at = input.generated_at;
  input.populations.forEach(p => { p.captured_at = input.generated_at; });
  assert.equal(build(input).generated_at, input.generated_at);
  input.generated_at = '2026-09-10T12:00:01Z';
  assert.equal(build(input).generated_at, input.generated_at);
});

for (const [name, mutate] of [
  ['unknown version', v => { v.contract_version = 3; }],
  ['v1 relabel', v => { v.contract_version = 1; }],
  ['unknown profile', v => { v.methodology.configuration.profile_id = 'unsupported'; }],
  ['v1 property counter', v => { account(v).unique_property_count = 2; }],
  ['v1 member unit', v => { records(v).member_unit = 'canonical_transaction'; }],
  ['v1 population kind', v => { account(v).kind = 'competitive_stock'; }],
  ['verified price name', v => { price(v).measurement = 'recorded_sale_price'; }],
  ['median called predominant', v => { price(v).measurement = 'predominant_sale_price'; }],
  ['COD called reliability', v => { price(v).measurement = 'reliability_score'; }],
  ['allocated sale', v => { price(v).measurement = 'allocated_sale_price'; }],
  ['housing eligibility declaration', v => { v.selection.housing_eligibility = 'verified'; }],
  ['source authority claim', v => { v.diagnostics.authority = 'established'; }],
  ['provider completeness', v => { v.discovery.provider_coverage = 'complete'; }],
  ['source history promotion', v => { v.source_snapshots[0].historical_availability = 'reconstructed'; }],
  ['invented source interval', v => { v.source_snapshots[0].valid_from = '2020-01-01'; }],
  ['future sale period', v => { records(v).observation_period.end_date = '2026-09-11'; }],
  ['outside study period', v => { records(v).observation_period.start_date = '2025-01-01'; }],
  ['fake effective-date CAD', v => { account(v).observation_period.date_basis = 'effective_date'; }],
  ['detached capture instant', v => { account(v).captured_at = '2026-09-10T12:00:00.123457Z'; }],
  ['foreign capture reference', v => { records(v).capture_source_ref = 'missing-source'; }],
  ['missing complete member digest', v => { records(v).member_set_sha256 = null; }],
  ['wrong account link count', v => { account(v).account_link_count++; }],
  ['package clipped to no accounts', v => { records(v).account_link_count = 0; }],
  ['source record more than one thousand associations', v => { records(v).account_link_count = 1001; }],
  ['unique count exceeds links', v => { records(v).unique_account_count = 3; }],
  ['wrong measure population', v => { price(v).population_id = 'accounts'; }],
  ['unknown unit', v => { price(v).unit = 'CAD'; }],
  ['ready currency unknown', v => { price(v).unit = null; }],
  ['Number decimal', v => { price(v).value = 282500.01; }],
  ['missing denominator member', v => { price(v).missing_count = 1; }],
  ['observed count zero', v => { price(v).observed_count = 0; price(v).missing_count = 1; }],
  ['ready false zero', v => { price(v).status = 'unsupported'; price(v).reason = 'unavailable'; price(v).value = '0'; }],
  ['unavailable nonnull value', v => { price(v).status = 'incomplete'; price(v).reason = 'missing'; }],
  ['count as string', v => { v.statistics[0].value = '2'; }],
  ['observed count not population count', v => { v.statistics[0].value = 1; }],
  ['unsupported quantile range', v => { price(v).estimator = 'exact_quantile'; price(v).estimator_parameters = { convention: 'type_7', probability: 0.25 }; }],
  ['row source absent from population', v => { price(v).source_refs = ['members-accounts']; }],
  ['automatic outline', v => { v.geographic_neighborhood.manual_source = 'neighborhood_boundary_automatic_unverified_v1'; }],
  ['legacy manual outline', v => { v.geographic_neighborhood.manual_source = 'appraiser_defined_area_manual_v1'; }],
  ['uncovered subject', v => { v.geographic_neighborhood.validation.covers_recorded_subject_point = false; }],
  ['unverified topology', v => { v.geographic_neighborhood.validation.valid = null; }],
  ['broken boundary sequence', v => { v.geographic_neighborhood.perimeter[0].to_node = 'other-node'; }],
  ['missing cardinal', v => { v.geographic_neighborhood.cardinal_summaries.north = null; }],
  ['target data inside assessment', v => { v.report_file_id = 'forged'; }],
  ['zero selection revision', v => { v.selection.revision = '0'; }],
  ['unsupported timestamp precision', v => { v.generated_at = '2026-09-10T13:00:00.1234567891Z'; }],
  ['calendar rollover', v => { v.generated_at = '2026-09-31T13:00:00Z'; }],
  ['hour rollover', v => { v.generated_at = '2026-09-10T24:00:00Z'; }],
  ['unknown top field', v => { v.supported = true; }],
]) test(`closed reported contract rejects ${name}`, () => { const input = fresh(); mutate(input); assert.throws(() => build(input)); });

for (const value of ['1e6', 'NaN', '-1', '-0', '01', '1.0', '1.', '.5', '0.00000000000001', '9'.repeat(32)]) {
  test(`reported decimal rejects noncanonical or unbounded ${value}`, () => {
    const input = fresh(); price(input).value = value; assert.throws(() => build(input), /decimal_value/);
  });
}

test('missing complete roster, discovery or geography keeps the ENTIRE application group incomplete', () => {
  for (const change of [v => { v.discovery.complete = false; },
    v => { account(v).completeness = 'incomplete'; account(v).reasons = ['retained_roster_unavailable'];
      Object.assign(v.statistics[0], { status: 'incomplete', value: null, reason: 'incomplete_population' }); },
    v => { v.geographic_neighborhood.status = 'incomplete'; v.geographic_neighborhood.reasons = ['outline_missing']; }]) {
    const input = fresh(); change(input); const a = build(input); assert.equal(a.application_group.status, 'incomplete');
    assert.equal(a.application_group.application_mode, 'atomic');
  }
});

test('derived fields cannot be carried across different revisions or tampered after building', () => {
  const output = build(fresh());
  for (const change of [v => { v.revision++; }, v => { v.application_group.status = 'incomplete'; },
    v => { v.evidence_digest_sha256 = 'f'.repeat(64); }]) {
    const value = structuredClone(output); change(value); assert.throws(() => build(value), /changed_derived_value/);
  }
});

test('v2 cannot attach to UAD; same Custom target remains exactly scope/date bound', () => {
  const f = fixture(), a = build(f.input);
  assert.throws(() => attach(a, { ...f.target, workflow_type: 'uad_3_6', custom_assignment_file_id: null,
    uad_workfile_id: '70000000-0000-4000-8000-000000000001' }), /custom_only/);
  assert.throws(() => attach(a, { ...f.target, scope: { ...f.target.scope, account_id: 'other' } }), /scope_mismatch/);
  assert.throws(() => attach(a, { ...f.target, effective_date: '2026-09-09' }), /date_mismatch/);
});

test('closed plain-data admission rejects getters/proxies/sparse arrays and cycles without executing callbacks', () => {
  let called = 0;
  for (const mutate of [v => Object.defineProperty(v, 'contract_version', { get() { called++; return 2; }, enumerable: true }),
    v => Object.defineProperty(price(v), 'value', { get() { called++; return '1'; }, enumerable: true }),
    v => { v.statistics = new Proxy(v.statistics, { ownKeys() { called++; return []; } }); },
    v => { v.statistics.length++; }, v => { v.diagnostics.recursive = v; }]) {
    const input = fresh(); mutate(input); assert.throws(() => build(input));
  }
  assert.throws(() => build(new Proxy(fresh(), { getPrototypeOf() { called++; return Object.prototype; } })));
  assert.equal(called, 0);
});

test('invalid raw text and byte limits fail instead of truncating or leaking newly added payload data', () => {
  for (const text of ['bad\0value', '\ud800', 'x'.repeat(1500001)]) {
    const input = fresh(); input.diagnostics.limitations = [text]; assert.throws(() => build(input));
  }
  assert.ok(Object.isFrozen(REPORTED_OBSERVATION_MEASUREMENTS.reported_close_price.units));
});
