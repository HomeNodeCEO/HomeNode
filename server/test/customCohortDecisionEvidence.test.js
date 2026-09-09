import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortDecisionEvidenceResolver as create } from '../src/services/neighborhoodAssessment/customCohortDecisionEvidence.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';

const base = decisionEvidenceFixture();
const invalid = reason => error => error.code === 'CUSTOM_COHORT_DECISION_EVIDENCE_INVALID' && error.reason === reason;
function commandFor(resolver, fixture) {
  const ref = resolver.deriveEvidenceRef(fixture.sourceRef, fixture.recordId);
  return { version: 1, operation_id: '50000000-0000-4000-8000-000000000001',
    target_ref: resolver.binding.target_ref, expected_context: resolver.binding.context_ref,
    study_ref: resolver.binding.study_ref, expected_generation: '0', expected_predecessor: null,
    subject_ref: { kind: 'capture_candidate', key: fixture.recordId },
    claim: { kind: 'closing_date', qualifier: { basis: 'event' }, state: 'known',
      value: { date: '2024-03-01', event_evidence_refs: [ref] }, unknown_reason: null, decision_refs: [] },
    evidence_refs: [ref], rationale: 'Compare the exact retained stored source and canonical dates.' };
}
async function setup(options) {
  const f = options ? await decisionEvidenceFixture(options) : await base;
  const resolver = create(f.input);
  return { f, resolver, command: structuredClone(commandFor(resolver, f)) };
}
const bind = (resolver, command) => resolver.bindCommand(JSON.stringify(command));

test('exact seven-part references resolve original complete retained rows, not a normalized-only fact', async () => {
  const { f, resolver } = await setup();
  const ref = resolver.deriveEvidenceRef(f.sourceRef, f.recordId);
  const source = f.input.retained_inputs.acquisition.capture_result.source_capture.sources.find(s => s.id === f.sourceRef);
  const original = source.payload.records.find(r => r.record_id === f.recordId);
  assert.deepEqual(ref, { capture_id: source.payload.metadata.id, capture_revision: source.payload.metadata.revision,
    manifest_sha256: JSON.parse(f.input.context_header_json).selection_input.content_sha256,
    chunk_id: source.id, chunk_sha256: createHash('sha256').update(json(source.payload)).digest('hex'),
    record_key: original.record_id, record_content_sha256: createHash('sha256').update(json(original)).digest('hex') });
  const resolved = resolver.resolveEvidenceRef(JSON.stringify(ref));
  assert.equal(resolved.role, 'transactions');
  assert.deepEqual(resolved.record, original); assert.notEqual(resolved.record, original);
  assert.equal(resolved.record.data.raw_projection.source_current_price, '275000');
  assert.equal(resolved.record.data.raw_projection.source_garage_yn, false);
  assert.equal(resolved.record.data.raw_projection.source_days_on_market, 0);
  assert.ok(Object.isFrozen(resolved.record.data.raw_projection));
  assert.deepEqual(resolver.binding.study_ref, { study_id: resolver.binding.context_ref.context_id,
    definition_revision: '1', definition_sha256: JSON.parse(f.input.context_header_json).study_input.content_sha256 });
});

test('matching closing-date command stays binding-only, immutable, and write-free', async () => {
  const { f, resolver, command } = await setup(), before = JSON.stringify(command);
  const output = bind(resolver, command);
  assert.equal(output.status, 'bound'); assert.equal(output.validation_scope, 'retained_evidence_binding_only');
  assert.deepEqual(output.command, command); assert.notEqual(output.command, command);
  assert.deepEqual(output.claim_observation, { status: 'matched', reason: null, claimed_date: '2024-03-01',
    observed_date: '2024-03-01', candidate_cited: true, canonical_transaction_id: '20', evaluated_record_count: 1,
    observed_field_count: 2, missing_field_count: 0, invalid_field_count: 0, conflicting_observations: false,
    comparison_basis: 'captured_stored_canonical_and_source_date_columns', source_meaning: 'not_established',
    transaction_equivalence: 'not_established' });
  assert.equal(output.authority, 'not_established'); assert.equal(output.assessment, null);
  assert.equal(output.apply.status, 'blocked');
  assert.ok(Object.values(output.runtime_requirements).every(value => value === 'not_checked'));
  assert.ok(Object.isFrozen(output.command.claim.value));
  assert.equal(f.f.state.calls.length, 0); assert.equal(JSON.stringify(command), before);
});

test('post-creation mutation cannot change the retained record index or date diagnostic', async () => {
  const f = structuredClone((await base).input), resolver = create(f);
  const original = await base, command = commandFor(resolver, original);
  const source = f.retained_inputs.acquisition.capture_result.source_capture.sources.find(s => s.id === original.sourceRef);
  source.payload.records[0].data.raw_projection.source_close_date = '2025-12-31';
  source.payload.records[0].data.raw_projection.source_current_price = '999999';
  f.expected.context_ref.context_sha256 = 'e'.repeat(64);
  const result = bind(resolver, command);
  assert.equal(result.claim_observation.status, 'matched');
  assert.equal(result.resolved_evidence[0].record.data.raw_projection.source_current_price, '275000');
});

for (const [field, replacement] of [['capture_id', 'another-capture'], ['capture_revision', 'v999'],
  ['manifest_sha256', 'a'.repeat(64)], ['chunk_id', 'another-chunk'], ['chunk_sha256', 'b'.repeat(64)],
  ['record_key', 'source:999'], ['record_content_sha256', 'c'.repeat(64)]]) {
  test(`each evidence identity component is binding: ${field}`, async () => {
    const { resolver, command } = await setup();
    command.evidence_refs[0][field] = replacement;
    command.claim.value.event_evidence_refs[0] = { ...command.evidence_refs[0] };
    assert.throws(() => bind(resolver, command), invalid('evidence_reference_mismatch'));
    assert.throws(() => resolver.resolveEvidenceRef(JSON.stringify(command.evidence_refs[0])), invalid('evidence_reference_mismatch'));
  });
}

for (const [name, mutate, reason] of [
  ['wrong report', c => { c.target_ref.report_file_id = '90000000-0000-4000-8000-000000000001'; }, 'target_mismatch'],
  ['wrong assignment', c => { c.target_ref.workflow_target_id = '11'; }, 'target_mismatch'],
  ['wrong context id', c => { c.expected_context.context_id = '90000000-0000-4000-8000-000000000001'; }, 'context_mismatch'],
  ['wrong context hash', c => { c.expected_context.context_sha256 = 'f'.repeat(64); }, 'context_mismatch'],
  ['wrong context revision', c => { c.expected_context.context_revision = '2'; }, 'context_mismatch'],
  ['wrong study id', c => { c.study_ref.study_id = '90000000-0000-4000-8000-000000000001'; }, 'study_mismatch'],
  ['wrong study revision', c => { c.study_ref.definition_revision = '2'; }, 'study_mismatch'],
  ['wrong study hash', c => { c.study_ref.definition_sha256 = 'f'.repeat(64); }, 'study_mismatch'],
  ['wrong candidate', c => { c.subject_ref.key = 'source:999'; }, 'subject_not_found'],
]) test(`bind rejects ${name}`, async () => {
  const { resolver, command } = await setup(); mutate(command);
  assert.throws(() => bind(resolver, command), invalid(reason));
});

for (const [name, mutate] of [
  ['different account', i => { i.expected.target.account_id = '000000'; }],
  ['different organization', i => { i.expected.target.organization_id = '90000000-0000-4000-8000-000000000001'; }],
  ['changed retained raw bytes', i => { i.retained_inputs.acquisition.capture_result.source_capture.sources.find(s => s.payload.projection.definition.role === 'transactions').payload.records[0].data.raw_projection.source_current_price = '300000'; }],
  ['unmatched retained roster', i => { i.retained_inputs.spatial.account_ids.pop(); }],
  ['client verified flag', i => { i.verified = true; }],
  ['changed study period', i => { i.expected.observation_period.end_date = '2024-06-29'; }],
]) test(`factory reuses complete preparation admission: ${name}`, async () => {
  const input = structuredClone((await base).input); mutate(input);
  assert.throws(() => create(input), invalid('retained_input_invalid'));
});

test('another genuine capture cannot replay an old reference under its different retained manifest', async () => {
  const first = await setup(), second = await setup({ saleOverrides: { source_current_price: '300000' } });
  assert.notEqual(first.resolver.binding.context_ref.context_sha256, second.resolver.binding.context_ref.context_sha256);
  const oldRef = first.resolver.deriveEvidenceRef(first.f.sourceRef, first.f.recordId);
  assert.throws(() => second.resolver.resolveEvidenceRef(JSON.stringify(oldRef)), invalid('evidence_reference_mismatch'));
});

for (const [name, raw, expected] of [
  ['null', null, { status: 'missing_evidence', missing_field_count: 1, invalid_field_count: 0 }],
  ['explicit blank', '', { status: 'missing_evidence', missing_field_count: 1, invalid_field_count: 0 }],
  ['impossible date', '2024-02-30', { status: 'missing_evidence', missing_field_count: 0, invalid_field_count: 1 }],
  ['different date', '2024-03-02', { status: 'conflicting_evidence', missing_field_count: 0, invalid_field_count: 0 }],
]) test(`closing-date ${name} stays explicit without canonical fallback`, async () => {
  const { resolver, command } = await setup({ saleOverrides: { source_close_date: raw } });
  const result = bind(resolver, command);
  for (const [key, value] of Object.entries(expected)) assert.equal(result.claim_observation[key], value);
  assert.equal(result.resolved_evidence[0].record.data.raw_projection.source_close_date, raw);
  assert.equal(result.apply.status, 'blocked');
});

test('known command without candidate event citation cannot manufacture a supported date', async () => {
  const { resolver, command } = await setup(); command.claim.value.event_evidence_refs = [];
  const result = bind(resolver, command);
  assert.equal(result.claim_observation.status, 'missing_evidence');
  assert.equal(result.claim_observation.candidate_cited, false);
  command.claim.value.date = '2024-03-02'; command.claim.value.event_evidence_refs = command.evidence_refs;
  assert.equal(bind(resolver, command).claim_observation.status, 'claim_mismatch');
});

test('unknown remains unknown; other known claim kinds and references do not become facts', async () => {
  const { resolver, command } = await setup();
  command.claim.state = 'unknown'; command.claim.value = null; command.claim.unknown_reason = 'missing_evidence';
  assert.equal(bind(resolver, command).claim_observation.reason, 'unknown_claim');
  command.claim = { kind: 'sale_completion', qualifier: { basis: 'event' }, state: 'known',
    value: { completed: true, event_evidence_refs: command.evidence_refs }, unknown_reason: null,
    decision_refs: [{ decision_id: '70000000-0000-4000-8000-000000000001', decision_sha256: 'a'.repeat(64) }] };
  command.expected_generation = '9223372036854775807'; command.expected_predecessor = command.claim.decision_refs[0];
  const result = bind(resolver, command);
  assert.equal(result.claim_observation.reason, 'claim_meaning_resolver_unavailable');
  assert.equal(result.runtime_requirements.decision_references, 'not_checked');
  assert.equal(result.command.expected_generation, '9223372036854775807');
});

test('stock subject uses exact captured discovery account, not a linked-only or coerced identity', async () => {
  const { resolver, command, f } = await setup();
  command.subject_ref = { kind: 'stock_member', key: f.accountIds[0] };
  command.claim = { kind: 'housing_at_date', qualifier: { basis: 'evaluated_date', evaluated_on: '2024-06-30' },
    state: 'unknown', value: null, unknown_reason: 'unsupported_temporal_basis', decision_refs: [] };
  assert.equal(bind(resolver, command).status, 'bound');
  command.subject_ref.key = 'R-LINKED-ONLY';
  assert.throws(() => bind(resolver, command), invalid('subject_not_found'));
});

test('actual capture rejects duplicate canonical identity; repeat transactions stay separate', async () => {
  const extra = { source_record_id: '11', sale_id: '20', primary_account_id: (await base).accountIds[0],
    sale_account_id: (await base).accountIds[0], source_record_hash: 'd'.repeat(64), record_type: 'closed_sale',
    sale_closing_date: '2024-03-02', source_close_date: '2024-03-02', sale_price: '275000' };
  await assert.rejects(() => setup({ extraTransactions: [extra] }), /duplicate_sale_id/);
  const separate = await setup({ extraTransactions: [{ ...extra, sale_id: '21' }] });
  const matched = bind(separate.resolver, separate.command);
  assert.equal(matched.claim_observation.evaluated_record_count, 1);
  assert.equal(matched.claim_observation.status, 'matched');
});

test('all requested retained records cross source chunks and 30 records without a whole-document canonical ceiling', async () => {
  const account = (await base).accountIds[0], large = 'x'.repeat(60_000);
  const extraTransactions = Array.from({ length: 34 }, (_, i) => ({ source_record_id: String(11 + i), sale_id: String(21 + i),
    primary_account_id: account, sale_account_id: account, source_record_hash: 'd'.repeat(64), record_type: 'closed_sale',
    sale_closing_date: '2024-03-01', source_close_date: '2024-03-01', sale_price: '275000', source_filename: large }));
  const { f, resolver, command } = await setup({ saleOverrides: { source_filename: large }, extraTransactions });
  const sources = f.input.retained_inputs.acquisition.capture_result.source_capture.sources.filter(s => s.payload.projection.definition.role === 'transactions');
  assert.ok(sources.length > 1);
  command.evidence_refs = sources.flatMap(source => source.payload.records.map(row => resolver.deriveEvidenceRef(source.id, row.record_id)));
  assert.equal(command.evidence_refs.length, 35);
  const result = bind(resolver, command);
  assert.equal(result.resolved_evidence.length, 35);
  assert.equal(new Set(result.resolved_evidence.map(row => row.record.record_id)).size, 35);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 2_000_000);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8_388_608);
  assert.equal(result.claim_observation.evaluated_record_count, 1);
});

test('hostile inputs fail without invoking getters, proxies, toJSON or coerced text', async () => {
  const { resolver, command } = await setup(); let calls = 0;
  const hostile = { get context_header_json() { calls++; throw Error('private'); } };
  assert.throws(() => create(hostile), invalid('retained_input_invalid'));
  const proxy = new Proxy({}, { ownKeys() { calls++; throw Error('private'); } });
  assert.throws(() => create(proxy), invalid('retained_input_invalid'));
  assert.throws(() => resolver.bindCommand({ toJSON() { calls++; return command; } }), invalid('command_invalid_input_type'));
  assert.throws(() => resolver.resolveEvidenceRef({ toString() { calls++; return '{}'; } }), invalid('reference_input'));
  assert.throws(() => resolver.deriveEvidenceRef({}, ''), invalid('record_address'));
  assert.equal(calls, 0);
  assert.throws(() => resolver.bindCommand(` ${JSON.stringify(command)}`), invalid('command_noncanonical_json'));
  assert.throws(() => resolver.bindCommand('x'.repeat(64001)), invalid('command_input_bytes'));
  assert.throws(() => resolver.resolveEvidenceRef('x'.repeat(2049)), invalid('reference_input'));
  assert.throws(() => resolver.resolveEvidenceRef('{"__proto__":{}}'), invalid('reference_shape'));
  command.actor_user_id = '90000000-0000-4000-8000-000000000001';
  assert.throws(() => bind(resolver, command), invalid('command_invalid_shape'));
});
