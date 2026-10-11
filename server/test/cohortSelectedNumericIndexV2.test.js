import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const file='20261130_custom_cohort_selected_numeric_index_v2.sql',
  sql=readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8');

test('numeric observation index is an additive structural child of fresh eighth writes, not a backfill or new source capability',()=>{
  const registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(file)>registry.indexOf('20261129_custom_cohort_selected_statistics_v2.sql'));
  for(const text of ['FOREIGN KEY(operation_id,ordinal) REFERENCES app.neighborhood_custom_cohort_selected_statistics_v2_rows',
    'AFTER INSERT','ON app.neighborhood_custom_cohort_selected_statistics_v2_rows','NEW.row_reference',
    'NEW.ordinal<>coalesce(head.sequence,0)+1','NEW.account_id<>member.account_id',
    'NEW.contribution_row_reference IS DISTINCT FROM member.row_reference',
    'neighborhood_selected_statistics_v2_admission_matches','job.claim_token IS NULL',
    'job.lease_expires_at<=clock_timestamp()','job.cancellation_requested_at IS NOT NULL',
    'DEFERRABLE INITIALLY DEFERRED','head.sequence<>NEW.ordinal','neighborhood_selected_numeric_index_v2_orphan_row',
    "body->'selected_entry'->>'account_id' IS DISTINCT FROM NEW.account_id",'no old-operation backfill']){
    assert.ok(sql.toLowerCase().includes(text.toLowerCase()),text);
  }
  assert.doesNotMatch(sql,/CREATE OR REPLACE|ALTER TABLE|DROP |DISABLE TRIGGER|INSERT INTO [^\n]+SELECT|UPDATE app\.|DELETE FROM app\.|SECURITY DEFINER|GRANT /);
});

test('native exact canonical decimal validation precedes unconstrained numeric cast and never rounds or infers currency',()=>{
  const validate=sql.indexOf('IF length(value)>31'),cast=sql.indexOf('RETURN value::numeric;');
  assert.ok(validate>0&&cast>validate);
  for(const text of ["length(replace(value,'.',''))>30","length(split_part(value,'.',2))>12",
    'jsonb_object_keys(cell))<>8',"cell->'exclusion_reasons' IS DISTINCT FROM '[]'::jsonb",
    "'reported_year_built','reported_residential_area','reported_site_area'",'RETURN NULL;',
    "metric='reported_residential_area' AND value=0",'value<1600',"cell->'contribution_exact_value' IS DISTINCT FROM 'null'::jsonb"])
    assert.ok(sql.includes(text),text);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g,''),/numeric\s*\(|double precision|::float|::real|round\s*\(|OFFSET |jsonb_agg|array_agg/i);
  assert.equal((sql.match(/CREATE INDEX neighborhood_selected_numeric_/g)??[]).length,3);
  assert.equal((sql.match(/INCLUDE\(account_id\) WHERE reported_[a-z_]+ IS NOT NULL/g)??[]).length,3);
  for(const metric of ['reported_year_built','reported_residential_area','reported_site_area']){
    assert.ok(sql.includes('(operation_id,'+metric+',ordinal)'));
    assert.ok(sql.includes('NEW.'+metric+' IS DISTINCT FROM app.neighborhood_selected_numeric_index_v2_cell'));
  }
});

test('fresh terminal EMPTY reconciles all selected observations and three eligible totals without population arrays',()=>{
  for(const text of ['count(*),count(reported_year_built),count(reported_residential_area),count(reported_site_area)',
    "row_count IS DISTINCT FROM (body->>'selected_stock_count')::bigint",'neighborhood_selected_numeric_index_v2_incomplete',
    'neighborhood_selected_numeric_index_v2_missing_row','BEFORE INSERT OR UPDATE','BEFORE TRUNCATE',
    'neighborhood_selected_numeric_index_v2_immutable'])assert.ok(sql.includes(text),text);
  const owner=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js',import.meta.url),'utf8'),
    ending=owner.indexOf('if((progressingSelectedStatistics||readingSelectedFrequencySource)&&!same(await statisticsStore.read(),statisticsAnchor))'),
    hook=owner.indexOf('The additive native numeric-index hook',ending),insert=owner.indexOf('statisticsStore.advance(',hook);
  assert.ok(ending>0&&hook>ending&&insert>hook,'numeric child stays downstream of the ACTUAL original owner and all ending fences');
  assert.ok(owner.includes('complete_selected_union_metric_population:false'));
});

test('cloud owner fixture verifies indexed child rollback/real COMMIT/zero/EMPTY and distinguishes tiny native DATA from licensed acceptance',()=>{
  const native=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  for(const text of ['runNeighborhoodSelectedNumericIndexV2DatabaseChecks(pool)','numeric_index:await readNumericIndex()',
    'state.numeric_index.length,ordinal','terminalContributions.numeric_index.length,selectedCount',
    '[native-original-reconciled-numeric-contribution-index-v2]','one_row_per_original_reconciled_selected_account:true',
    'numeric_index_in_ALL_prior_state_rollback_and_lost_REAL_COMMIT_ack_snapshots:true',
    'later_semantic_pass_still_requires_complete_original_reconciliation:true'])assert.ok(native.includes(text),text);
});
