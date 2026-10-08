import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createCustomCohortGraphV2AnchorRepository } from '../src/services/neighborhoodAssessment/customCohortGraphV2AnchorRepository.js';

const claim = { operation_id: '11111111-1111-4111-8111-111111111111',
  claim_token: '22222222-2222-4222-8222-222222222222', attempts: 1 };
const scope = { organization_id: '33333333-3333-4333-8333-333333333333',
  report_file_id: '44444444-4444-4444-8444-444444444444', assignment_file_id: '7', account_id: 'SUBJECT' };
const actorUserId = '55555555-5555-4555-8555-555555555555';
const ref = hash => ({ content_sha256: hash.repeat(64), canonical_utf8_bytes: '123' });
const source = ref('a'), root = ref('b');
function fixture({ autocommit = false, lost = false, corrupt = false } = {}) {
  let current = null, transaction = 0; const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes(':transaction')) return { rowCount: 1, rows: [{ transaction_id: autocommit ? String(++transaction) : '12' }] };
    if (sql.includes(':anchor-read')) return lost ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [current
      ?? { source_reference: null, root_reference: null, receipt_reference: null, sequence: null }] };
    if (sql.includes(':anchor-insert')) current = { source_reference: JSON.parse(values[8]), root_reference: JSON.parse(values[9]),
      receipt_reference: JSON.parse(values[10]), sequence: 1 };
    else if (sql.includes(':anchor-advance')) current = { ...current, receipt_reference: JSON.parse(values[8]), sequence: values[9] };
    else throw Error('unexpected_query');
    return { rowCount: 1, rows: [{ sequence: corrupt ? 200000 : current.sequence }] };
  } };
  const repository = createCustomCohortGraphV2AnchorRepository({ client, claim, scope, actorUserId,
    source_reference: source, root_reference: root });
  return { repository, calls, get current() { return current; }, set current(v) { current = v; } };
}

test('scoped live issuance head is independent of checkpoint JSON with atomic CAS and no lease renewal', async () => {
  const f = fixture(); assert.equal(await f.repository.read(), null);
  const first = await f.repository.advance(null, ref('c'));
  assert.deepEqual(first, { source_reference: source, root_reference: root, receipt_reference: ref('c'), sequence: 1 });
  const second = await f.repository.advance(first, ref('d')); assert.equal(second.sequence, 2);
  const update = f.calls.find(c => c.sql.includes(':anchor-advance'));
  assert.deepEqual(update.values.slice(0, 8), [claim.operation_id, claim.claim_token, 1,
    scope.organization_id, scope.report_file_id, '7', 'SUBJECT', actorUserId]);
  assert.match(update.sql, /anchor\.receipt_reference=\$13::jsonb AND anchor\.sequence=\$14::integer/);
  for (const c of f.calls.filter(c => !c.sql.includes(':transaction'))) {
    assert.match(c.sql, /cancellation_requested_at IS NULL/); assert.match(c.sql, /lease_expires_at>clock_timestamp\(\)/);
    assert.doesNotMatch(c.sql, /SET lease_expires_at|SET checkpoint/);
  }
  const before = f.calls.filter(c => /:anchor-insert|:anchor-advance/.test(c.sql)).length;
  await assert.rejects(f.repository.advance(first, ref('e')), /conflict/);
  assert.equal(f.calls.filter(c => /:anchor-insert|:anchor-advance/.test(c.sql)).length, before);
});

test('autocommit, claim loss, wrong source/root and malformed acknowledgments refuse', async () => {
  const auto = fixture({ autocommit: true });
  await assert.rejects(auto.repository.advance(null, ref('c')), /caller_transaction_required/);
  assert.ok(!auto.calls.some(c => c.sql.includes(':anchor-insert')));
  await assert.rejects(fixture({ lost: true }).repository.read(), /claim_lost/);
  await assert.rejects(fixture({ corrupt: true }).repository.advance(null, ref('c')), /corrupt/);
  const f = fixture(); f.current = { source_reference: ref('f'), root_reference: root, receipt_reference: ref('c'), sequence: 1 };
  await assert.rejects(f.repository.read(), /binding_changed/);
  f.current.source_reference = source; f.current.sequence = 0;
  await assert.rejects(f.repository.read(), /corrupt/);
});

test('additive registered database guard anchors heads, follows exact edges/counts and prohibits rewind/delete/truncate', () => {
  const name = '20261112_custom_cohort_source_graph_v2_anchors.sql';
  const registry = readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.ok(registry.indexOf(name) > registry.indexOf('20261111_custom_cohort_prepared_source_seeds.sql'));
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  for (const match of sql.matchAll(/CREATE (?:TABLE|FUNCTION|INDEX|TRIGGER) (?:app\.)?([a-z0-9_]+)/g))
    assert.ok(Buffer.byteLength(match[1]) <= 63, 'PostgreSQL identifier must not truncate');
  for (const proof of ['NEW.sequence<>OLD.sequence+1', "receipt->'previous' IS DISTINCT FROM OLD.receipt_reference",
    "before_state IS DISTINCT FROM old_receipt->'after'", 'neighborhood_graph_v2_anchor_detached_node',
    "receipt->'next_position' IS DISTINCT FROM expected_next", 'neighborhood_graph_v2_anchor_count_conflict',
    "'frozen_source_refs_v2'", "'frozen_verify_refs_v2'", 'BEFORE INSERT OR UPDATE OR DELETE', 'BEFORE TRUNCATE'])
    assert.ok(sql.includes(proof), proof);
  assert.doesNotMatch(sql, /DISABLE TRIGGER|DROP TABLE|DELETE FROM app\.|UPDATE app\.report_files/);
});
