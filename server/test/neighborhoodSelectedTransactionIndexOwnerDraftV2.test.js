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
  const q=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION app.neighborhood_selected_transaction_index_v2_next_keys'));
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
