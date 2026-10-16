import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as read } from 'node:fs';

test('batch catalog union native guard preserves every original prefix/count/member and deferred protocol',()=>{
  const old=read(new URL('../migrations/20261125_custom_cohort_selected_union_replay_v2.sql',import.meta.url),'utf8').replaceAll('\r\n','\n'),
    candidate=read(new URL('./fixtures/neighborhoodBatchSelectedUnionV3Guard.sql',import.meta.url),'utf8').replaceAll('\r\n','\n'),
    start=old.indexOf('  IF TG_OP=\'INSERT\' THEN',old.indexOf('CREATE FUNCTION app.guard_neighborhood_selected_union_v2_head()')),
    suffix=old.slice(start,old.indexOf('END $$;',start)+8);
  assert.ok(candidate.endsWith(suffix+'\n'),'entire immutable transition, actual native prefix/count/member and terminal catalog-denominator checks survive verbatim');
  for(const marker of ['cohort_recorded_catalog_batch_receipt_v3','cohort_recorded_group_partition_batch_receipt_v3',
    'cohort_stock_traversal_batch_receipt_v3',"jsonb_object_keys(catalog_body))<>22", "catalog_body->'accounts' IS DISTINCT FROM '[]'::jsonb",
    "catalog_body->'entries' IS DISTINCT FROM '[]'::jsonb", "catalog_body->'original_count' IS DISTINCT FROM '0'::jsonb",
    "body->>'format' IS DISTINCT FROM 'cohort_selected_union_receipt_v2'",'jsonb_object_keys(body))<>24']) assert.ok(candidate.includes(marker),marker);
  assert.doesNotMatch(candidate,/DROP TRIGGER|DISABLE TRIGGER|UPDATE app\.|DELETE FROM|attempts=0|infinity/);
  assert.ok(!candidate.includes('CREATE OR REPLACE FUNCTION app.check_neighborhood_selected_union_v2_commit'));
});
