import assert from 'node:assert/strict';
import test from 'node:test';
import { readNeighborhoodCoveredCadCacheCoverageV2 as read, NEIGHBORHOOD_NATIVE_CAD_CACHE_COVERAGE_V2_SQL as SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodCoveredCadCacheCoverageV2.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedCadImprovementV1.js';

// Receipt DATA only: native issuance/adoption/lease and all original replay are
// exercised separately by the actual isolated DB owner fixture.
function fixture() {
  const ref = blob('{}'), neutral = { binding: { operation_id: 'operation', generation_id: 'generation' }, root: ref,
    source_reference: ref, graph_reference: ref, geographic_reference: ref, identity_reference: ref, stock_reference: ref };
  const args = { claim: { operation_id: 'operation', claim_token: 'nonce', attempts: 5 },
    scope: { organization_id: 'organization', report_file_id: 'report', assignment_file_id: '7', account_id: 'subject' },
    actorUserId: 'actor', stock: { generation_id: 'generation', population: { account_count: '1' } },
    neutralCoverage: { receipt_reference: ref, receipt_text: json(neutral) }, source: { source_snapshot: 'retained-source' },
    purpose: { kind: 'fixed-purpose-DATA' }, decision: { policy_revision: 'current-policy-DATA' } };
  const before = { after_account: 'A', account_count: 1, original_count: 2, typed_utf8_bytes: '100', done: false };
  const body = { format: 'cohort_CAD_cache_coverage_receipt_v2', binding: neutral.binding, source_reference: ref, root_reference: ref,
    graph_reference: ref, geographic_reference: ref, identity_reference: ref, stock_reference: ref, neutral_reference: ref,
    typed_profile_reference: getNeighborhoodFrozenTypedCadImprovementV1Profile().definition_blob.ref,
    cad_source_metadata: args.source, cad_purpose: args.purpose, cad_decision: args.decision, stock_account_count: '1',
    sequence: 2, previous: ref, before, entry: null, after: { ...before, done: true } };
  const encode = value => ({ transaction_id: '123', sequence: 2, receipt_reference: blob(json(value)), receipt_text: json(value) });
  return { args, body, encode, row: encode(body) };
}

test('covered CAD metadata uses the exact current claim/stock and validates complete receipt DATA without issuing anything', async () => {
  const f = fixture(); let calls = 0;
  const result = await read({ async query(text, values) {
    calls++; assert.equal(text, SQL);
    assert.deepEqual(values.slice(0, 9), ['operation', 'nonce', 5, 'organization', 'report', '7', 'subject', 'actor', 'generation']);
    return { rowCount: 1, rows: [f.row] };
  } }, f.args);
  assert.equal(calls, 1); assert.deepEqual(result.receipt_reference, f.row.receipt_reference); assert.ok(Object.isFrozen(result));
});

test('covered CAD metadata refuses absent/duplicate native rows, corrupt receipt transport and mismatched head', async () => {
  const f = fixture();
  for (const result of [{ rowCount: 0, rows: [] }, { rowCount: 2, rows: [f.row, f.row] },
    { rowCount: 1, rows: [{ ...f.row, receipt_text: f.row.receipt_text + ' ' }] },
    { rowCount: 1, rows: [{ ...f.row, sequence: 3 }] }]) {
    await assert.rejects(read({ async query() { return result; } }, f.args), /coverage_unavailable/);
  }
});

test('covered CAD metadata cannot rebind source, current purpose/decision, neutral parent or complete stock denominator', async () => {
  for (const key of ['cad_source_metadata', 'cad_purpose', 'cad_decision', 'neutral_reference', 'stock_account_count']) {
    const f = fixture(), body = structuredClone(f.body);
    body[key] = key === 'stock_account_count' ? '2' : key === 'neutral_reference' ? blob('[]') : { changed: true };
    await assert.rejects(read({ async query() { return { rowCount: 1, rows: [f.encode(body)] }; } }, f.args), /invalid_receipt/);
  }
  const f = fixture(), partial = { ...f.body, sequence: 1, previous: null,
    before: { after_account: '', account_count: 0, original_count: 0, typed_utf8_bytes: '0', done: false },
    entry: { account_id: 'A', geographic_parcel_count: '1', primary_count: 1, secondary_count: 1 }, after: f.body.before };
  const row = { ...f.encode(partial), sequence: 1 };
  await assert.rejects(read({ async query() { return { rowCount: 1, rows: [row] }; } }, f.args), /coverage_unavailable/);
});
