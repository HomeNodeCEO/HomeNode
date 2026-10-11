import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const file='20261205_custom_cohort_selected_transaction_index_v2.sql',
  sql=readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'),
  migration=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8'),
  fixture=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
  helper=readFileSync(new URL('./helpers/neighborhoodSelectedTransactionIndexV2DatabaseChecks.js',import.meta.url),'utf8');

test('inactive additive native transaction storage is registered after the actual tenth owner, without phase17 or activation',()=>{
  assert.ok(migration.indexOf(file)>migration.indexOf('20261204_custom_cohort_selected_semantic_owner_v2.sql'));
  assert.equal([...sql.matchAll(/CREATE TABLE app\./g)].length,5);
  assert.doesNotMatch(sql,/GRANT\s|CREATE OR REPLACE|ALTER TABLE|frozen_selected_transaction_index_refs_v2|checkpoint_save|DISABLE TRIGGER|CASCADE/);
  for(const name of ['rows','source_v2_keys','legacy_v2_keys','edges','heads'])assert.ok(sql.includes(name));
  const schemas=sql.slice(0,sql.indexOf('-- Only op/org')).replace(/^\s*--[^\n]*$/gm,'');
  assert.doesNotMatch(schemas,/canonical_utf8\s|payload|price|sale_date|housing|cache|jsonb\[\]/);
  assert.match(schemas,/source_record_id bigint NOT NULL CHECK\(source_record_id>0\)/);
  assert.match(schemas,/legacy_sale_key text COLLATE "C" NOT NULL/);
  assert.match(schemas,/PRIMARY KEY\(operation_id,source_record_id\)/);
  assert.match(schemas,/PRIMARY KEY\(operation_id,legacy_sale_key\)/);
  assert.match(schemas,/PRIMARY KEY\(operation_id,ordinal,kind,native_key\)/);
  assert.match(schemas,/first_selected_ordinal integer NOT NULL/);
  assert.match(schemas,/issued_transaction_id bigint NOT NULL/);
  assert.doesNotMatch(schemas,/REFERENCES app\.(?:source_records|sales)\b/,'dangling originals must reach the actual recompiler, not silently disappear');
});

test('native next keys have only op/org inputs and derive every exact16 member and pinned original prefix before bounded enumeration',()=>{
  const start=sql.indexOf('CREATE FUNCTION app.neighborhood_selected_transaction_index_v2_next_keys'),
    end=sql.indexOf('-- Exact bidirectional',start),query=sql.slice(start,end);
  assert.match(query,/next_keys\(op uuid,org uuid\)/);
  for(const text of ['coalesce(h.sequence,0)+1','h.operation_id IS NULL','neighborhood_selected_semantic_v2_checkpoint_matches(op,org,job.checkpoint)',
    "sb.canonical_utf8::jsonb->'after'->>'done'='true'","ub.canonical_utf8::jsonb->'after'->>'done'='true'",
    'selected_semantic_v2_rows','selected_numeric_v2_rows','selected_numeric_index_v2_rows','selected_statistics_v2_rows',
    'selected_metrics_v2_rows','selected_union_v2_rows','recorded_partition_v2_rows',
    'stock.actor_user_id=job.actor_user_id',"stock.status='complete'",'pin.generation_id=stock.generation_id',
    'generation.retirement_started_at IS NULL',"job.status='running'",'job.lease_expires_at>clock_timestamp()',
    "(VALUES ('source_records'),('sales'),('sale_links'))",'o.account_id=selected.account_id','LIMIT 251',
    '(SELECT count(*)::integer FROM anchors) AS anchor_count','(SELECT anchor_count FROM gate)<=250',
    'GROUP BY source_record_id',"kind='sales' AND source_record_id IS NULL",'packages.native_key::bigint',
    'packages.native_key END COLLATE "C"'])assert.ok(query.includes(text),text);
  assert.ok(query.indexOf('anchors AS MATERIALIZED')<query.indexOf('gate AS MATERIALIZED'));
  assert.ok(query.indexOf('gate AS MATERIALIZED')<query.indexOf('packages AS MATERIALIZED'));
  assert.doesNotMatch(query,/array_agg|jsonb_agg|callback|OFFSET\s+\d/);
});

test('native edge completeness is both-direction exact sets, retains registry namespaces, and never reaggregates the population',()=>{
  const start=sql.indexOf('CREATE FUNCTION app.neighborhood_selected_transaction_index_v2_next_edges_match'),
    end=sql.indexOf('CREATE FUNCTION app.guard_',start),guard=sql.slice(start,end);
  assert.ok(guard.includes('NOT EXISTS(SELECT 1 FROM expected x WHERE x.kind IS NOT NULL AND NOT EXISTS(SELECT 1 FROM retained r WHERE r.kind=x.kind AND r.native_key=x.native_key))'));
  assert.ok(guard.includes('NOT EXISTS(SELECT 1 FROM retained r WHERE NOT EXISTS(SELECT 1 FROM expected x WHERE x.kind=r.kind AND x.native_key=r.native_key))'));
  for(const text of ['h.anchor_count<=250','r.entry_reference=h.entry_reference','r.contribution_row_reference=h.contribution_row_reference',
    'r.organization_id IS DISTINCT FROM org','r.generation_id IS DISTINCT FROM h.generation_id','r.account_id IS DISTINCT FROM h.account_id',
    "r.kind='source_record' AND r.source_record_id=k.source_record_id","r.kind='legacy_sale' AND r.legacy_sale_key=k.legacy_sale_key",
    'k.first_selected_ordinal=coalesce(h.ordinal,1)','k.first_selected_ordinal>h.ordinal'])assert.ok(guard.includes(text),text);
  assert.doesNotMatch(guard,/count\(|array_agg|jsonb_agg|content_sha256/);
});

test('all provisional children are immutable and real commits and head issuance are fail-closed until the actual owner is integrated',()=>{
  for(const text of ["IF TG_OP<>'INSERT'",'FOR UPDATE','NEW.generation_id IS DISTINCT FROM expected.generation_id',
    'NEW.first_selected_ordinal IS DISTINCT FROM member.ordinal','k.kind=native_kind AND k.native_key=native_value',
    "RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_owner_unintegrated'",'BEFORE INSERT OR UPDATE OR DELETE',
    'BEFORE TRUNCATE','DEFERRABLE INITIALLY DEFERRED','reject_neighborhood_selected_transaction_index_v2_unintegrated()'])assert.ok(sql.includes(text),text);
  assert.equal([...sql.matchAll(/CREATE CONSTRAINT TRIGGER/g)].length,2,'one literal head and one loop for all four child commit guards');
  for(const text of ["'member'","'source'","'legacy'","'edge'"])assert.ok(sql.includes(text),text);
  for(const text of ['assert.equal(await matched(client),false)','assert.equal(await matched(client),true)',
    'ON CONFLICT DO NOTHING',"refusal('SET CONSTRAINTS ALL IMMEDIATE'",'withCustomCohortJobTransaction(pool,async transaction=>',
    'error.outcome_unknown===true','fresh read proves no provisional child survived the refused COMMIT',
    'actual_eleventh_owner:false','phase17:false','global_selected_native_deduplication:false'])assert.ok(helper.includes(text),text);
  assert.ok(fixture.includes('runNeighborhoodSelectedTransactionIndexV2DatabaseChecks(pool,refsOperation,organization,value)'));
  assert.ok(fixture.includes('[native-selected-transaction-index-storage-foundation-v2]'));
  const nativeBlock=fixture.slice(fixture.indexOf('// New READ-ONLY first transaction-source seam.'));
  assert.ok(nativeBlock.indexOf('if(!positiveIndexedSourceFixture)')<nativeBlock.indexOf('const transactionStorage='));
  assert.match(nativeBlock,/const transactionStorage=[\s\S]*?await semanticUnchanged\(before\)/);
});
