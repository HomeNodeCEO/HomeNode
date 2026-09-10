import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json, buildNeighborhoodAssessment } from '../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortReportPreparation as build, CUSTOM_COHORT_REPORT_PREPARATION_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortReportPreparation.js';
import { buildCustomCohortSupportedInputs } from '../src/services/neighborhoodAssessment/customCohortSupportedInputs.js';
import { buildCachedNeighborhoodInputs } from '../src/services/neighborhoodAssessment/cachedRecords.js';
import { summarizeNeighborhoodPopulations } from '../src/services/neighborhoodAssessment/statistics.js';
import { neighborhoodMemberSetDigest, neighborhoodMemberContentDigest, prepareNeighborhoodPublication } from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { supportedInputsFixture } from './fixtures/customCohortSupportedInputsFixture.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const identity = { assessment_id: 'a0000000-0000-4000-8000-000000000001', assessment_revision: 1,
  attachment_id: 'a0000000-0000-4000-8000-000000000002', attachment_revision: 1 };
function inputFor(f, supported) {
  const subject = f.input.retained_inputs.subject, t = subject.target;
  return { supported_inputs: supported, target: {
    scope: Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(k => [k, t[k]])),
    report_file_id: t.report_file_id, custom_assignment_file_id: 41, editor_revision: 0,
    effective_date: subject.effective_date, data_cutoff: subject.effective_date,
  }, preparation_identity: structuredClone(identity) };
}
async function fixture(options = {}, review = true) {
  const f = await supportedInputsFixture({ ...options, assignmentFileId: '41' });
  if (review) await f.reviewAll();
  const supported = buildCustomCohortSupportedInputs(await f.adapterInput());
  return { f, supported, input: inputFor(f, supported) };
}
let tamperFixture;
const sharedTamperFixture = () => tamperFixture ??= fixture();
function frozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); }
}
const records = (result, predicate) => result.publication_bundle.sources.filter(s => predicate(s.payload))
  .flatMap(s => s.payload.records ?? []);
const computationSources = result => result.publication_bundle.sources.filter(s => s.payload.projection?.definition.report_computation_version === 1);
function restoredStatistics(result) {
  const rows = computationSources(result).flatMap(s => s.payload.records).map(r => r.data);
  const value = structuredClone(rows.find(r => r.kind === 'statistics_header').value);
  value.sales.property_price_members = rows.filter(r => r.kind === 'property_price_member').sort((a, b) => a.ordinal - b.ordinal).map(r => r.value);
  return value;
}
function invalid(input, reason) {
  assert.throws(() => build(input), error => error.code === 'CUSTOM_COHORT_REPORT_PREPARATION_INVALID' && error.reason === reason);
}

test('real retained inputs and current reviews assemble the actual contract, publication bundle and candidate without writes or readiness', async () => {
  const { f, input, supported } = await fixture(); const before = JSON.stringify(supported), calls = f.calls.length;
  const result = build(input);
  assert.equal(f.calls.length, calls); assert.equal(JSON.stringify(supported), before);
  assert.equal(result.status, 'incomplete'); assert.equal(result.authority, 'not_established');
  assert.equal(result.identity_status, 'unpublished_preparation'); assert.equal(result.apply.status, 'blocked');
  assert.equal(result.assessment.id, identity.assessment_id); assert.equal(result.assessment.revision, 1);
  assert.equal(result.assessment.generated_at, supported.binding.derived_at);
  assert.deepEqual(result.assessment, buildNeighborhoodAssessment(result.assessment));
  const bundle = result.publication_bundle;
  assert.deepEqual(bundle, prepareNeighborhoodPublication(bundle.assessment, bundle.members, bundle.sources.map(s => ({ id: s.snapshot.id, payload: s.payload }))));
  assert.equal(result.candidate.status, 'incomplete'); assert.deepEqual(result.candidate.suggestions, []);
  assert.ok(result.candidate.issues.some(i => i.code === 'custom_neighborhood_report_incomplete_assessment'));
  assert.equal(result.assessment.geographic_neighborhood.geometry, null);
  assert.equal(result.assessment.geographic_neighborhood.validation.contains_subject, null);
  assert.deepEqual(result.assessment.geographic_neighborhood.cardinal_summaries, { north: null, east: null, south: null, west: null });
  assert.equal(result.assessment.discovery.complete, null);
  assert.equal(result.assessment.application_group.status, 'incomplete');
  assert.ok(result.assessment.statistics.every(s => s.value === null && ['incomplete', 'unsupported'].includes(s.status)));
  for (const source of result.assessment.source_snapshots) {
    assert.equal(source.valid_from, null); assert.equal(source.valid_to, null); assert.equal(source.historical_availability, 'unknown');
    assert.equal(source.observed_at, supported.binding.derived_at); assert.equal(source.visibility, 'assignment');
  }
  assert.deepEqual(restoredStatistics(result), supported.statistics);
  assert.equal(supported.statistics.sales.recorded_transaction_price.median, 276000);
  frozen(result); assert.ok(Buffer.byteLength(JSON.stringify(result)) < LIMITS.output_utf8_bytes);
});

test('repackaged evidence and statistics recover exactly, retain nanosecond claims and original capture clocks', async () => {
  const { input, supported } = await fixture({ mappingVersion: 3 }); const result = build(input);
  for (const original of supported.derived_source_payloads) {
    const chunks = result.publication_bundle.sources.filter(s => s.payload.upstream?.id === original.id);
    assert.ok(chunks.length);
    const entries = chunks.flatMap(c => c.payload.records.map(r => r.data));
    const rebuilt = { ...chunks[0].payload.projection.definition.original_payload_metadata,
      rows: entries.filter(e => e.kind === 'row').sort((a, b) => a.ordinal - b.ordinal).map(e => e.value),
      evidence: entries.filter(e => e.kind === 'evidence').sort((a, b) => a.ordinal - b.ordinal).map(e => e.value) };
    assert.deepEqual(rebuilt, original.payload); assert.equal(sha(json(rebuilt)), original.content_sha256);
    assert.equal(chunks[0].payload.projection.definition.original_canonical_utf8_bytes, original.canonical_utf8_bytes);
  }
  const computation = computationSources(result)[0].payload.projection.definition;
  assert.equal(computation.original_statistics_sha256, sha(json(supported.statistics)));
  assert.equal(computation.original_statistics_canonical_utf8_bytes, String(Buffer.byteLength(json(supported.statistics))));
  assert.deepEqual(computation.subject_housing, supported.subject_housing);
  assert.ok(JSON.stringify(result.publication_bundle.sources).includes('2026-09-08T12:00:00.123456789Z'));
  assert.equal(result.assessment.observation_period.start_date, supported.statistics.observation_period.start_date);
  assert.equal(result.assessment.observation_period.end_date, supported.statistics.observation_period.end_date);
  assert.notEqual(result.assessment.effective_date, result.assessment.observation_period.end_date);
});

test('full canonical package total appears once and never becomes a property price or PPSF denominator', async () => {
  const { input, supported } = await fixture({ packageSale: true }); const result = build(input);
  const populations = Object.fromEntries(result.assessment.populations.map(p => [p.id, p]));
  assert.equal(populations['reviewed-stock'].member_count, 2);
  assert.equal(populations['reviewed-transactions'].member_count, 3);
  assert.equal(populations['reviewed-transactions'].unique_property_count, 2);
  assert.equal(populations['reviewed-transactions'].property_link_count, 4);
  assert.equal(populations['reviewed-single-property-prices'].member_count, 2);
  const members = result.publication_bundle.members, packageMember = members.find(m => m.account_ids.length === 2);
  assert.equal(packageMember.population_id, 'reviewed-transactions');
  assert.equal(members.filter(m => m.member_id === packageMember.member_id).length, 1);
  assert.equal(packageMember.member_data.computed_input.sale_price, 275000);
  const ppsf = result.assessment.statistics.find(s => s.id === 'reviewed-single-property-prices:ppsf:median');
  assert.equal(ppsf.observed_count, 0); assert.equal(ppsf.missing_count, 2); assert.equal(ppsf.denominator_count, 2);
  const predominant = result.assessment.statistics.find(s => s.id === 'reviewed-transactions:predominant');
  assert.equal(predominant.estimator, 'unsupported'); assert.equal(predominant.value, null);
  assert.deepEqual(restoredStatistics(result), supported.statistics);
  for (const p of result.assessment.populations) {
    const own = members.filter(m => m.population_id === p.id);
    assert.equal(p.member_set_sha256, neighborhoodMemberSetDigest(own.map(m => m.member_id)));
    const capture = result.publication_bundle.sources.find(s => s.payload.population_id === p.id).payload;
    assert.equal(capture.member_content_sha256, neighborhoodMemberContentDigest(own));
  }
});

test('unselected co-parcels remain full event interests while selected stock stays exact', async () => {
  const { f } = await fixture({ packageSale: true });
  f.input.selection.included_recorded_group_ids = f.catalog.pockets.filter(p => p.account_ids.includes(f.accountIds[0])).map(p => p.id);
  const supported = buildCustomCohortSupportedInputs(await f.adapterInput()); const result = build(inputFor(f, supported));
  assert.equal(result.assessment.populations.find(p => p.id === 'reviewed-stock').member_count, 1);
  assert.deepEqual(result.publication_bundle.members.find(m => m.account_ids.length === 2).account_ids, [...f.accountIds].sort());
  assert.deepEqual(restoredStatistics(result), supported.statistics);
});

test('subject outside selected stock keeps its separate exact housing proof', async () => {
  const { f } = await fixture({ saleCount: 0 });
  f.input.selection.included_recorded_group_ids = f.catalog.pockets.filter(p => p.account_ids.includes(f.accountIds[1])).map(p => p.id);
  const supported = buildCustomCohortSupportedInputs(await f.adapterInput()); const result = build(inputFor(f, supported));
  assert.deepEqual(result.publication_bundle.members.filter(m => m.population_id === 'reviewed-stock').map(m => m.member_id), [f.accountIds[1]]);
  assert.deepEqual(computationSources(result)[0].payload.projection.definition.subject_housing, supported.subject_housing);
  assert.equal(supported.subject_housing.account_id, f.accountIds[0]);
});

for (const saleCount of [0, 1]) test(`computed ${saleCount} sale observations remain ${saleCount}, never fake the required minimum`, async () => {
  const { input, supported } = await fixture({ saleCount }); const result = build(input);
  assert.equal(result.assessment.populations.find(p => p.id === 'reviewed-transactions').member_count, saleCount);
  const median = result.assessment.statistics.find(s => s.id === 'reviewed-transactions:recorded-sale-price:median');
  assert.equal(median.observed_count, saleCount); assert.equal(median.denominator_count, saleCount); assert.equal(median.value, null);
  assert.equal(restoredStatistics(result).sales.recorded_transaction_price.minimum_count, 3);
  assert.deepEqual(restoredStatistics(result), supported.statistics); assert.equal(result.candidate.status, 'incomplete');
});

test('missing subject review returns explicit no-computation without a fake assessment or candidate', async () => {
  const { input } = await fixture({ saleCount: 0 }, false); const result = build(input);
  for (const key of ['assessment', 'publication_bundle', 'candidate']) assert.equal(result[key], null);
  assert.ok(result.issues.some(i => i.code === 'supported_computation_unavailable')); frozen(result);
});

for (const reviewedSales of [0, 1]) test(`subject-only stock and ${reviewedSales} reviewed candidates retain incomplete source audit`, async () => {
  const { f } = await fixture({}, false); await f.housing(f.accountIds[0]);
  if (reviewedSales) await f.reviewCandidate(f.candidates[0]);
  const supported = buildCustomCohortSupportedInputs(await f.adapterInput()); const result = build(inputFor(f, supported));
  assert.equal(supported.status, 'incomplete'); assert.ok(supported.support_gaps.length);
  assert.equal(result.assessment.populations.find(p => p.id === 'reviewed-stock').member_count, 1);
  assert.equal(result.assessment.populations.find(p => p.id === 'reviewed-transactions').member_count, reviewedSales);
  assert.equal(result.candidate.status, 'incomplete'); assert.deepEqual(restoredStatistics(result), supported.statistics);
  const audits = records(result, p => p.projection?.definition.role === 'transactions').map(r => r.data)
    .filter(r => r.kind === 'evidence');
  assert.equal(audits.length, 3); assert.ok(audits.some(e => e.value.status === 'unavailable'));
});

test('latest unknown transaction fact remains in source gaps, not a selected convenient older sale', async () => {
  const { f } = await fixture();
  const original = [...f.current.values()].find(r => r.record.command.claim.kind === 'closing_date').record.command;
  const command = f.command('closing_date', original.subject_ref.key, null, original.evidence_refs);
  command.claim.state = 'unknown'; command.claim.unknown_reason = 'missing_evidence'; await f.append(command);
  const supported = buildCustomCohortSupportedInputs(await f.adapterInput()); const result = build(inputFor(f, supported));
  assert.equal(result.assessment.populations.find(p => p.id === 'reviewed-transactions').member_count, 2);
  const gaps = records(result, p => p.projection?.definition.report_computation_version === 1)
    .map(r => r.data).filter(d => d.kind === 'support_gap').sort((a, b) => a.ordinal - b.ordinal).map(d => d.value);
  assert.deepEqual(gaps, supported.support_gaps); assert.ok(gaps.length);
  assert.deepEqual(restoredStatistics(result), supported.statistics);
});

test('preparation is deterministic and exact section revision/identity changes bind the source and member content', async () => {
  const { input } = await fixture(); const first = build(input);
  assert.deepEqual(build(input), first);
  const changed = structuredClone(input); changed.target.editor_revision = 4; changed.preparation_identity.assessment_revision = 2;
  const second = build(changed);
  assert.equal(second.binding.target.editor_revision, 4); assert.equal(second.assessment.revision, 2);
  assert.notEqual(second.publication_bundle.sources[0].snapshot.content_sha256, first.publication_bundle.sources[0].snapshot.content_sha256);
  assert.deepEqual(second.assessment.statistics.map(s => [s.id, s.observed_count, s.missing_count]), first.assessment.statistics.map(s => [s.id, s.observed_count, s.missing_count]));
});

test('earlier valuation cutoff is explicit unavailable and never silently widened to fit stock', async () => {
  const { input } = await fixture(); input.target.data_cutoff = '2024-01-01'; const result = build(input);
  assert.equal(result.assessment, null); assert.equal(result.binding.target.data_cutoff, '2024-01-01');
  assert.ok(result.issues.some(i => i.code === 'stock_effective_date_after_data_cutoff'));
});

test('exhausted actual editor revision remains inspectable with explicit unavailable preparation', async () => {
  const { input } = await fixture(); input.target.editor_revision = 2147483647; const result = build(input);
  assert.equal(result.assessment, null); assert.equal(result.publication_bundle, null); assert.equal(result.candidate, null);
  assert.equal(result.binding.target.editor_revision, 2147483647);
  assert.ok(result.issues.some(i => i.code === 'report_editor_revision_exhausted'));
});

for (const [label, change, reason] of [
  ['cross report', i => { i.target.report_file_id = identity.attachment_id; }, 'target_mismatch'],
  ['cross account', i => { i.target.scope.account_id = 'unrelated'; }, 'target_mismatch'],
  ['cross case', i => { i.target.scope.appraisal_case_id = identity.attachment_id; }, 'computation_scope'],
  ['cross snapshot', i => { i.target.scope.subject_snapshot_id = identity.attachment_id; }, 'computation_scope'],
  ['unsafe assignment', i => { i.target.custom_assignment_file_id = Number.MAX_SAFE_INTEGER + 1; }, 'assignment_identity'],
  ['string assignment', i => { i.target.custom_assignment_file_id = '41'; }, 'assignment_identity'],
  ['negative section revision', i => { i.target.editor_revision = -1; }, 'editor_revision'],
  ['unrecognized authority', i => { i.supported_inputs.authority = 'verified'; }, 'supported_input_profile'],
  ['altered source row', i => { i.supported_inputs.derived_source_payloads[0].payload.rows[0].housing_type = 'other'; }, 'derived_source_digest'],
  ['altered source bytes', i => { i.supported_inputs.derived_source_payloads[0].canonical_utf8_bytes = '1'; }, 'derived_source_digest'],
  ['altered cached source', i => { i.supported_inputs.cached_inputs.source_snapshots[0].id = 'foreign'; }, 'cached_source_binding'],
  ['member count mismatch', i => { i.supported_inputs.statistics.stock.property_count++; }, 'stock_membership'],
  ['price does not match member', i => { i.supported_inputs.statistics.sales.property_price_members[0].sale_price++; }, 'price_member_profile'],
  ['selection account tamper', i => { i.supported_inputs.selection.account_ids.push('foreign'); }, 'selection_binding'],
]) test(`rejects ${label} instead of publishing or falling back`, async () => {
  const { input } = await sharedTamperFixture(); const changed = structuredClone(input); change(changed); invalid(changed, reason);
});

test('closed owner envelope refuses getters and proxies without evaluating them', async () => {
  let called = 0;
  invalid({ get supported_inputs() { called++; throw Error('must not execute'); }, target: {}, preparation_identity: {} }, 'input_shape');
  invalid(new Proxy({}, { getPrototypeOf() { called++; throw Error('must not execute'); } }), 'input_shape');
  const { input } = await fixture(); input.extra_authority = true; invalid(input, 'input_shape'); assert.equal(called, 0);
});

// This capacity fixture is NOT a reviewed capture or an authority/admission test.
// It expands a real normalized example into many synthetic canonical rows, then
// uses the actual cached-input/statistics functions to establish exact numbers.
// This exercises the report consumer above the 1.5MB per-document limit without
// pretending thousands of synthetic review commands were retained by the ledger.
function scaledComputation(base, n) {
  const supported = structuredClone(base), scope = supported.cached_inputs.scope;
  const roles = new Map(supported.derived_source_payloads.map(e => [e.payload.role, e]));
  const transaction = roles.get('transactions').payload.rows[0], link = roles.get('sale_links').payload.rows[0];
  roles.get('transactions').payload.rows = Array.from({ length: n }, (_, index) => ({ ...transaction,
    canonical_transaction_id: `synthetic-scale:${String(index).padStart(6, '0')}`, sale_price: 275000 + index }));
  roles.get('sale_links').payload.rows = Array.from({ length: n }, (_, index) => ({ ...link,
    canonical_transaction_id: `synthetic-scale:${String(index).padStart(6, '0')}` }));
  roles.get('transactions').payload.evidence = [];
  const sources = {};
  for (const envelope of supported.derived_source_payloads) {
    const { payload } = envelope, parts = ['{'];
    Object.keys(payload).sort().forEach((key, index) => {
      if (index) parts.push(','); parts.push(`${JSON.stringify(key)}:`);
      parts.push(['rows', 'evidence'].includes(key) ? `[${payload[key].map(v => json(v)).join(',')}]` : json(payload[key]));
    }); parts.push('}'); const exact = parts.join('');
    envelope.content_sha256 = sha(exact); envelope.canonical_utf8_bytes = String(Buffer.byteLength(exact));
    envelope.id = `reviewed-input:${payload.role}:${envelope.content_sha256}`;
    sources[payload.role] = { id: envelope.id, state: payload.rows.length ? 'populated' : 'present_empty', complete: true,
      revision: '1', content_sha256: envelope.content_sha256, captured_at: supported.binding.derived_at, visibility: 'assignment_private', scope, rows: payload.rows };
  }
  const previous = supported.cached_inputs.statistics_input;
  supported.cached_inputs = buildCachedNeighborhoodInputs({ scope, population_id: previous.population_id, effective_date: previous.effective_date,
    observation_period: previous.observation_period, selection: { account_ids: supported.selection.account_ids,
      eligible_housing_types: [supported.subject_housing.code], subject_subdivision_key: null }, sources });
  supported.statistics = summarizeNeighborhoodPopulations(supported.cached_inputs.statistics_input);
  return supported;
}

test('broad synthetic computation uses bounded chunks and exact row routing rather than a 30-sale or generic-document cutoff', async () => {
  const { f, supported } = await fixture({ saleCount: 1 }); const large = scaledComputation(supported, 4000);
  assert.ok(Buffer.byteLength(JSON.stringify(large.statistics)) > 1500000);
  const result = build(inputFor(f, large)); assert.ok(result.assessment, JSON.stringify(result.issues));
  assert.equal(result.assessment.populations.find(p => p.id === 'reviewed-transactions').member_count, 4000);
  assert.equal(result.assessment.populations.find(p => p.id === 'reviewed-single-property-prices').member_count, 4000);
  assert.deepEqual(restoredStatistics(result), large.statistics);
  const sourceChunks = result.publication_bundle.sources.filter(s => s.payload.projection?.definition.role === 'transactions');
  assert.ok(sourceChunks.length > 1); assert.ok(computationSources(result).length > 1);
  const sales = result.publication_bundle.members.filter(m => m.population_id === 'reviewed-transactions');
  const byRef = new Map(result.publication_bundle.sources.map(s => [s.snapshot.id, s.payload]));
  for (const member of sales) {
    assert.ok(member.member_data.source_refs.length <= 2);
    for (const ref of member.member_data.source_refs) assert.ok(byRef.get(ref).records.some(r => r.data.value.canonical_transaction_id === member.member_id));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < LIMITS.output_utf8_bytes);
});

test('oversize bounded record returns explicit whole-preparation capacity refusal, not partial members', async () => {
  const { input } = await fixture(); const changed = structuredClone(input);
  changed.supported_inputs.support_gaps = [{ reason: 'x'.repeat(1600000) }];
  const result = build(changed);
  assert.equal(result.assessment, null); assert.equal(result.publication_bundle, null); assert.equal(result.candidate, null);
  assert.ok(result.issues.some(i => i.code === 'report_preparation_capacity_exceeded'));
});
