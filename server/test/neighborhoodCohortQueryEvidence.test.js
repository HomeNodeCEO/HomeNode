import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCohortLocalQueryEvidenceV1 as assemble } from '../src/services/neighborhoodAssessment/cohortQueryEvidence.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { createCohortLocalQueryEvidenceFixture, cohortFixtureAuthorizationHash,
  cohortFixtureQueryHash } from './fixtures/neighborhoodCohortLocalQueryEvidenceFixture.js';

const args = fixture => [canonicalAssessmentJson(fixture.metadata), JSON.stringify(fixture.accountIds),
  fixture.bundle.captured_query_selection_sha256];
function accountsIn(bundle) {
  const byHash = new Map(bundle.blobs.map(item => [item.ref.content_sha256, JSON.parse(item.canonical_json)]));
  const preimage = byHash.get(bundle.query_preimage.content_sha256);
  const directory = byHash.get(preimage.ordered_account_roster.manifest.content_sha256);
  return { directory, accounts: directory.pages.flatMap(page => byHash.get(page.page.content_sha256).entries.map(entry => entry.account_id)) };
}
function refusal(result, status, reason) {
  assert.deepEqual(result, { status, reason });
  assert.ok(Object.isFrozen(result));
  assert.equal(Object.hasOwn(result, 'evidence'), false);
}

test('assembles the existing literal bundle without changing either original hash', () => {
  const fixture = createCohortLocalQueryEvidenceFixture(), input = args(fixture);
  const result = assemble(...input);
  assert.equal(result.status, 'syntax_valid');
  assert.equal(result.validation_scope, 'retained_bytes_and_query_hashes_only');
  assert.equal(result.authority, 'not_established');
  assert.deepEqual(result.evidence, fixture.bundle);
  assert.deepEqual(args(fixture), input);
  assert.ok(Object.isFrozen(result.evidence.blobs));
  assert.ok(result.evidence.blobs.every(item => Object.isFrozen(item.ref)));
});

for (const count of [1, 1000, 1001, 2507, 50000]) test(`retains all ${count} accounts across complete pages`, () => {
  const accountIds = Array.from({ length: count }, (_, i) => `A${String(i).padStart(5, '0')}`);
  const fixture = createCohortLocalQueryEvidenceFixture({ accountIds });
  const result = assemble(...args(fixture));
  assert.equal(result.status, 'syntax_valid', JSON.stringify(result));
  assert.deepEqual(result.evidence, fixture.bundle);
  const retained = accountsIn(result.evidence);
  assert.deepEqual(retained.accounts, accountIds);
  assert.equal(retained.directory.entry_count, String(count));
  assert.equal(retained.directory.pages.length, Math.ceil(count / 1000));
  assert.equal(retained.directory.pages.at(-1).entry_count, String((count - 1) % 1000 + 1));
});

test('50001 supplied accounts refuse the whole population without truncation', () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  refusal(assemble(args(fixture)[0], JSON.stringify(Array.from({ length: 50001 }, (_, i) => `A${String(i).padStart(5, '0')}`)), args(fixture)[2]),
    'limit_exceeded', 'account_limit');
});

test('wrong original query hash is refused rather than replaced by a newly computed hash', () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  refusal(assemble(...args(fixture).slice(0, 2), '0'.repeat(64)), 'invalid', 'query_hash_mismatch');
});

test('altered membership is refused even when the new query stream hash is supplied', () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  const accountIds = [...fixture.accountIds, 'zz-neighbor'];
  refusal(assemble(canonicalAssessmentJson(fixture.metadata), JSON.stringify(accountIds), cohortFixtureQueryHash(fixture.metadata, accountIds)),
    'invalid', 'selection_mismatch');
});

test('subject omission is refused even with self-consistent replacement hashes', () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  const accountIds = fixture.accountIds.slice(1), metadata = structuredClone(fixture.metadata);
  metadata.authorization.selection_sha256 = cohortFixtureAuthorizationHash(metadata, accountIds);
  refusal(assemble(canonicalAssessmentJson(metadata), JSON.stringify(accountIds), cohortFixtureQueryHash(metadata, accountIds)),
    'invalid', 'directory_mismatch');
});

test('account order and duplicates are never repaired by the assembler', () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  for (const accountIds of [[], [...fixture.accountIds].reverse(), [...fixture.accountIds, fixture.accountIds.at(-1)]]) {
    refusal(assemble(args(fixture)[0], JSON.stringify(accountIds), args(fixture)[2]), 'invalid', 'directory_mismatch');
  }
});

test('only original canonical metadata and canonical string-array bytes are admitted', () => {
  const fixture = createCohortLocalQueryEvidenceFixture(), input = args(fixture);
  for (const changed of [
    [input[0] + ' ', input[1], input[2]], [input[0], input[1] + '\n', input[2]],
    ['{"reader_version":"local-capture-v3",' + input[0].slice(1), input[1], input[2]],
  ]) refusal(assemble(...changed), 'invalid', 'noncanonical_json');
  refusal(assemble('{', input[1], input[2]), 'invalid', 'invalid_json');
});

test('post-hash capture decoration is not silently stripped into an alleged original', () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  const decorated = { ...fixture.metadata, selection_sha256: args(fixture)[2], selected_account_count: fixture.accountIds.length };
  refusal(assemble(canonicalAssessmentJson(decorated), args(fixture)[1], args(fixture)[2]), 'invalid', 'invalid_shape');
});

test('provider gaps and unavailable source capabilities remain unsupported data', () => {
  const fixture = createCohortLocalQueryEvidenceFixture(), metadata = structuredClone(fixture.metadata);
  metadata.capabilities.sale_links.state = 'absent';
  refusal(assemble(canonicalAssessmentJson(metadata), args(fixture)[1], cohortFixtureQueryHash(metadata, fixture.accountIds)),
    'invalid', 'invalid_value');
});

test('fixed primitive admission never reads supplied object properties', () => {
  const fixture = createCohortLocalQueryEvidenceFixture(), input = args(fixture);
  let reads = 0;
  const hostile = new Proxy({}, { get() { reads++; throw new Error('unexpected getter'); } });
  for (const value of [hostile, new String(input[0]), null, 1, 1n, Symbol('x')]) {
    refusal(assemble(value, input[1], input[2]), 'invalid', 'invalid_input_type');
  }
  refusal(assemble(...input, null), 'invalid', 'invalid_input_type');
  refusal(assemble(...input.slice(0, 2)), 'invalid', 'invalid_input_type');
  assert.equal(reads, 0);
});

test('account type, whitespace, controls and invalid Unicode remain distinct failures', () => {
  const fixture = createCohortLocalQueryEvidenceFixture(), input = args(fixture);
  for (const account of [null, 1, {}, '', ' x', 'x\n', 'a'.repeat(65)]) {
    refusal(assemble(input[0], JSON.stringify([account]), input[2]), 'invalid', 'invalid_value');
  }
  refusal(assemble(input[0], JSON.stringify(['\ud800']), input[2]), 'invalid', 'invalid_unicode');
  refusal(assemble(input[0], '{}', input[2]), 'invalid', 'invalid_shape');
});

test('input budgets fail atomically before an oversized string is parsed', () => {
  const input = args(createCohortLocalQueryEvidenceFixture());
  refusal(assemble(' '.repeat(64001), input[1], input[2]), 'limit_exceeded', 'input_bytes');
  refusal(assemble(input[0], ' '.repeat(1500001), input[2]), 'limit_exceeded', 'input_bytes');
  refusal(assemble('é'.repeat(32001), input[1], input[2]), 'limit_exceeded', 'input_bytes');
});
