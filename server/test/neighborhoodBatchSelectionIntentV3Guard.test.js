import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('V3 development intent guard preserves native claim/workspace/ID/deferred protocol and adds only terminal batch lineage',()=>{
  const old=readFileSync(new URL('../migrations/20261124_custom_cohort_selection_intent_v2.sql',import.meta.url),'utf8').replaceAll('\r\n','\n'),
    start=old.indexOf('CREATE FUNCTION app.guard_neighborhood_cohort_v2_selection_intent()'),
    fn=old.slice(start,old.indexOf('$$;',start)+3).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'),
    candidate=readFileSync(new URL('./fixtures/neighborhoodBatchSelectionIntentV3Guard.sql',import.meta.url),'utf8').replaceAll('\r\n','\n'),
    gate="  IF receipt->>'format' IS DISTINCT FROM 'cohort_recorded_catalog_receipt_v2'",
    suffix=fn.slice(fn.indexOf('  -- Pure ID shape only before current source policy.'));
  assert.ok(candidate.includes(fn.slice(0,fn.indexOf(gate))));assert.ok(candidate.endsWith(suffix+'\n'));
  for(const text of ['cohort_recorded_catalog_batch_receipt_v3','cohort_recorded_group_partition_batch_receipt_v3','cohort_stock_traversal_batch_receipt_v3',
    "receipt->'accounts' IS DISTINCT FROM '[]'::jsonb", "receipt->'entries' IS DISTINCT FROM '[]'::jsonb",
    "receipt->>'sequence' IS DISTINCT FROM head.sequence::text OR receipt->'after'->>'done' IS DISTINCT FROM 'true'"])
    assert.ok(candidate.includes(text),text);
  assert.doesNotMatch(candidate,/DISABLE TRIGGER|DROP TRIGGER|DROP TABLE|UPDATE app\.|DELETE FROM|attempts=0|infinity|OLD\./);
  // The separate deferred command/resume COMMIT guard is deliberately retained,
  // not replaced by this format addition or by any caller-known-ID callback.
  assert.ok(!candidate.includes('CREATE OR REPLACE FUNCTION app.check_neighborhood_cohort_v2_selection_intent_commit'));
});
