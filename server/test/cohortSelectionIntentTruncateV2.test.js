import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('joint selection-intent TRUNCATE reaches actual guards with ALL direct command-head FK children including eighth',()=>{
  const fixture=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    sql=fixture.split(/\r?\n/).find(line=>line.includes('TRUNCATE app.neighborhood_custom_cohort_v2_selection_intents,'));
  assert.ok(sql);
  for(const table of ['selected_union','selected_eligibility','selected_evidence','selected_metrics','selected_statistics'])
    assert.ok(sql.includes('app.neighborhood_custom_cohort_'+table+'_v2_heads'),table+' must not block the intended native guard via omitted FK');
  assert.doesNotMatch(sql,/CASCADE|DISABLE|DROP/);
  assert.ok(fixture.includes('/selection_intent_immutable|custom_cohort_context_immutable/'),
    'keep the specific guard assertion; do not accept the early generic foreign-key refusal');
  const eighth=readFileSync(new URL('../migrations/20261129_custom_cohort_selected_statistics_v2.sql',import.meta.url),'utf8');
  assert.match(eighth,/command_id uuid NOT NULL REFERENCES app\.neighborhood_custom_cohort_v2_selection_intents/);
  assert.match(eighth,/BEFORE TRUNCATE ON app\.neighborhood_custom_cohort_selected_statistics_v2_heads/);
});
