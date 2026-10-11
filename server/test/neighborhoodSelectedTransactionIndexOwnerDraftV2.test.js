import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const name='20261206_custom_cohort_selected_transaction_index_owner_v2.sql',
  sql=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'),
  registered=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8'),
  old=readFileSync(new URL('../migrations/20261205_custom_cohort_selected_transaction_index_v2.sql',import.meta.url),'utf8');

test('partial owner SQL stays unregistered and does not relax an installed head/COMMIT or continuation guard',()=>{
  assert.doesNotMatch(registered,new RegExp(name));
  assert.match(sql,/UNREGISTERED OWNER WORK IN PROGRESS/);
  assert.doesNotMatch(sql,/DROP TRIGGER|DISABLE TRIGGER|ALTER TABLE|GRANT\s|CREATE TRIGGER|CREATE CONSTRAINT TRIGGER|CREATE TABLE/);
  assert.match(old,/RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_owner_unintegrated'/);
  assert.match(sql,/TODO, before registration/);
});

test('draft exact17 recursively joins actual16 and all seven immutable parents without accepting a caller-projected checkpoint',()=>{
  const q=sql.slice(sql.indexOf('CREATE FUNCTION app.neighborhood_selected_transaction_index_v2_checkpoint_matches'),
    sql.indexOf('CREATE FUNCTION app.neighborhood_selected_transaction_index_v2_admission_matches'));
  for(const s of ["jsonb_array_length(cp->'evidence_refs')=17","(cp-'phase'-'evidence_refs')='{}'::jsonb",
    "cp->'evidence_refs'->16=h.receipt_reference","'evidence_refs',(cp->'evidence_refs')-16",
    'h.semantic_reference=s.receipt_reference','h.numeric_reference=s.numeric_reference','h.statistics_reference=s.statistics_reference',
    'h.metrics_reference=s.metrics_reference','h.evidence_reference=s.evidence_reference','h.eligibility_reference=s.eligibility_reference',
    'h.union_reference=s.union_reference','stock.generation_id=h.generation_id',"sb.canonical_utf8::jsonb->'after'->>'done'='true'",
    "b.canonical_utf8::jsonb->>'sequence'=h.sequence::text",'app.neighborhood_selected_semantic_v2_checkpoint_matches(op,org,'])assert.ok(q.includes(s),s);
});

test('draft native NEXT is owned by issued prefix and genuine selected native rows, including a separate fresh EMPTY',()=>{
  const q=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION app.neighborhood_selected_transaction_index_v2_next_keys'),
    sql.indexOf('CREATE OR REPLACE FUNCTION app.neighborhood_selected_transaction_index_v2_next_edges_match'));
  for(const s of ['next_keys(op uuid,org uuid)','m.ordinal=coalesce(h.sequence,0)+1',
    'app.neighborhood_selected_transaction_index_v2_admission_matches(op,org,job.checkpoint)',
    "hb.canonical_utf8::jsonb->'after'->>'done'='false'","hb.canonical_utf8::jsonb->'after'->>'selected_ordinal'=h.sequence::text",
    "coalesce(h.sequence,0)=(ub.canonical_utf8::jsonb->>'after_selected_count')::integer AND m.operation_id IS NULL",
    'r.ordinal=m.ordinal AND n.ordinal=m.ordinal','i.ordinal=m.ordinal AND metric.ordinal=m.ordinal',
    'member.ordinal=m.ordinal AND p.account_id=m.account_id','generation.retirement_started_at IS NULL',
    'stock.actor_user_id=job.actor_user_id','job.lease_expires_at>clock_timestamp()',
    '(SELECT count(*)::integer FROM anchors) AS anchor_count','(SELECT anchor_count FROM gate)<=250',
    'packages.native_key::bigint','packages.native_key END COLLATE "C"','LIMIT 251'])assert.ok(q.includes(s),s);
  assert.doesNotMatch(q,/array_agg|jsonb_agg|OFFSET\s|NOT EXISTS\([^)]*source_v2_keys/);
  assert.ok(q.indexOf('anchors AS MATERIALIZED')<q.indexOf('gate AS MATERIALIZED'));
  assert.ok(q.indexOf('gate AS MATERIALIZED')<q.indexOf('packages AS MATERIALIZED'));
  assert.doesNotMatch(q,/count\(\*\)[^\n]*selected_transaction|count\(\*\)[^\n]*selected_union/,'no population scan to derive prefix or unique-key authority');
});

test('draft current-account edges compare both exact namespaces, keep shared keys, and reject op-only future children without recounting retained population',()=>{
  const q=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION app.neighborhood_selected_transaction_index_v2_next_edges_match'),
    sql.indexOf('CREATE FUNCTION app.guard_neighborhood_selected_transaction_index_v2_head_issued'));
  for(const s of ['r.kind=x.kind AND r.native_key=x.native_key','x.kind=r.kind AND x.native_key=r.native_key',
    'r.organization_id IS DISTINCT FROM org','k.first_selected_ordinal>h.ordinal','k.first_selected_ordinal=h.ordinal',
    "r.kind='source_record' AND r.source_record_id=k.source_record_id","r.kind='legacy_sale' AND r.legacy_sale_key=k.legacy_sale_key",
    'coalesce(h.ordinal,coalesce(i.sequence,0)) AS ordinal','r.ordinal>(SELECT ordinal FROM prefix) LIMIT 1',
    'k.first_selected_ordinal>(SELECT ordinal FROM prefix) LIMIT 1'])assert.ok(q.includes(s),s);
  assert.equal((q.match(/first_selected_ordinal>\(SELECT ordinal FROM prefix\) LIMIT 1/g)||[]).length,2);
  assert.equal((q.match(/r.ordinal>\(SELECT ordinal FROM prefix\) LIMIT 1/g)||[]).length,2);
  assert.doesNotMatch(q,/count\(\*\)|array_agg|jsonb_agg|OFFSET\s/);
  assert.doesNotMatch(q,/h.account_id IS NULL[^\n]*NOT EXISTS/,'EMPTY can retain the already issued nonempty prefix');
});

test('draft head issuance derives its entire compact receipt from actual next identities and bounded first-seen deltas in one native transaction',()=>{
  const q=sql.slice(sql.indexOf('CREATE FUNCTION app.guard_neighborhood_selected_transaction_index_v2_head_issued'),
    sql.indexOf('CREATE FUNCTION app.check_neighborhood_transaction_index_v2_head_commit_issued'));
  for(const s of ['FOR UPDATE','NEW.issued_transaction_id IS DISTINCT FROM txid_current()',
    'OLD.issued_transaction_id=txid_current()','NEW.sequence<>OLD.sequence+1',
    "to_jsonb(NEW)-ARRAY['receipt_reference','sequence','issued_transaction_id']",
    'app.neighborhood_selected_transaction_index_v2_next_edges_match',
    'first_selected_ordinal=k.ordinal','prior_source+new_source>500000000',
    'prior_source+new_source+prior_legacy+new_legacy>coalesce(k.ordinal,NEW.sequence-1)::bigint*250',
    "before_state->'selected_ordinal' IS DISTINCT FROM parent_count",'body IS DISTINCT FROM expected_body',
    "'metric_row_reference',k.metric_row_reference,'contribution_row_reference',k.contribution_row_reference",
    'canonical_utf8_bytes<=4096'])assert.ok(q.includes(s),s);
  assert.equal((q.match(/SELECT count\(\*\)::integer INTO new_/g)||[]).length,2);
  assert.equal((q.match(/WHERE operation_id=NEW.operation_id AND first_selected_ordinal=k.ordinal/g)||[]).length,2,
    'both registry counts use indexed current ordinal, not a population recount');
  for(const key of ['union','eligibility','evidence','metrics','statistics','numeric','semantic'])
    assert.ok(q.includes(`'${key}_reference',NEW.${key}_reference`));
  assert.doesNotMatch(q,/array_agg|jsonb_agg|OFFSET\s|UPDATE app\.|DELETE FROM|ON CONFLICT/);
});

test('draft deferred head and all child functions require same-TX exact17 checkpoint and unconsumed single-use yield with no durable orphan',()=>{
  const q=sql.slice(sql.indexOf('CREATE FUNCTION app.check_neighborhood_transaction_index_v2_head_commit_issued'),
    sql.indexOf('-- Draft job and continuation replacements'));
  assert.equal((q.match(/h.issued_transaction_id IS DISTINCT FROM txid_current\(\)/g)||[]).length,2);
  assert.equal((q.match(/app.neighborhood_selected_transaction_index_v2_checkpoint_matches/g)||[]).length,2);
  for(const s of ['h.receipt_reference IS DISTINCT FROM NEW.receipt_reference','h.sequence IS DISTINCT FROM NEW.sequence',
    'h.sequence IS DISTINCT FROM child_ordinal','child_ordinal:=NEW.first_selected_ordinal','child_ordinal:=NEW.ordinal',
    "c.phase<>'frozen_selected_transaction_index_refs_v2'",'c.progress_reference IS DISTINCT FROM h.receipt_reference',
    'c.issued_attempts IS DISTINCT FROM job.attempts','c.consumed_claim_token IS NOT NULL',"job.status<>'retry'",
    'job.claim_token IS NOT NULL','job.lease_expires_at IS NOT NULL','job.context_sha256 IS NOT NULL',
    'neighborhood_selected_transaction_index_v2_orphan_progress','neighborhood_selected_transaction_index_v2_orphan_child'])assert.ok(q.includes(s),s);
  assert.doesNotMatch(q,/CREATE TRIGGER|CREATE CONSTRAINT TRIGGER|DROP TRIGGER|DISABLE TRIGGER/,
    'functions are not attached until complete actual original owner integration');
});
