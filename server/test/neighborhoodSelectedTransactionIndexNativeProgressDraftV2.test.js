import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read=name=>readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8').replace(/\r/g,''),
  old=read('20261204_custom_cohort_selected_semantic_owner_v2.sql'),
  draft=read('20261206_custom_cohort_selected_transaction_index_owner_v2.sql');
function fn(sql,name){const start=sql.indexOf('CREATE OR REPLACE FUNCTION app.'+name+'()');
  assert.ok(start>=0,name);const end=sql.indexOf('END $$;',start);assert.ok(end>start);return sql.slice(start,end+7);}
// Exact whole-function preservation proof: undo ONLY these named additive17
// edits and compare every byte with installed61204. No old predicate, human
// bridge, scope, claim, failure history, cancellation or terminal fence is lost.
// These are structure tests; the draft is NOT installed/natively executed.
const edits={
  "jobEdits": [
    {
      "old": "('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2')",
      "next": "('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2')",
      "count": 2
    },
    {
      "old": "        AND NOT app.neighborhood_selected_semantic_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint))",
      "next": "        AND NOT app.neighborhood_selected_semantic_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)\n        AND NOT app.neighborhood_selected_transaction_index_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint))",
      "count": 1
    },
    {
      "old": "      OR (OLD.checkpoint->>'phase'='frozen_selected_semantic_refs_v2' AND NEW.checkpoint->>'phase'<>'frozen_selected_semantic_refs_v2')",
      "next": "      OR (OLD.checkpoint->>'phase'='frozen_selected_semantic_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'))\n      OR (OLD.checkpoint->>'phase'='frozen_selected_transaction_index_refs_v2' AND NEW.checkpoint->>'phase'<>'frozen_selected_transaction_index_refs_v2')\n      OR (NEW.checkpoint->>'phase'='frozen_selected_transaction_index_refs_v2' AND NEW.checkpoint IS DISTINCT FROM OLD.checkpoint\n        AND NOT app.neighborhood_transaction_index_v2_checkpoint_transition_matches(OLD.operation_id,OLD.organization_id,OLD.checkpoint,NEW.checkpoint))",
      "count": 1
    }
  ],
  "contEdits": [
    {
      "old": "  IF NEW.phase='frozen_stock_traversal_refs_v2' THEN",
      "next": "  -- Adding the eleventh pass cannot widen ANY prior phase's finite ceiling.\n  IF NEW.sequence<1\n    OR (NEW.phase='frozen_selected_transaction_index_refs_v2' AND NEW.sequence>22000011)\n    OR (NEW.phase='frozen_selected_semantic_refs_v2' AND NEW.sequence>20000010)\n    OR (NEW.phase='frozen_selected_numeric_refs_v2' AND NEW.sequence>18000009)\n    OR (NEW.phase NOT IN ('frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2') AND NEW.sequence>16000008) THEN\n    RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;\n  IF NEW.phase='frozen_stock_traversal_refs_v2' THEN",
      "count": 1
    },
    {
      "old": "  ELSE RAISE EXCEPTION 'neighborhood_v2_continuation_phase_conflict' USING ERRCODE='55000'; END IF;",
      "next": "  ELSIF NEW.phase='frozen_selected_transaction_index_refs_v2' THEN\n    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence\n      FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;\n    IF job.context_sha256 IS NOT NULL OR NOT app.neighborhood_selected_transaction_index_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN\n      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;\n  ELSE RAISE EXCEPTION 'neighborhood_v2_continuation_phase_conflict' USING ERRCODE='55000'; END IF;",
      "count": 1
    },
    {
      "old": "  IF job.status<>'running' OR job.claim_token IS DISTINCT FROM NEW.issued_claim_token",
      "next": "  -- Consuming a retained continuation above is a later TX. Issuing a NEW\n  -- exact17 continuation here requires the actual head issued in THIS TX.\n  IF NEW.phase='frozen_selected_transaction_index_refs_v2' AND NOT EXISTS(\n    SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h\n    WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.issued_transaction_id=txid_current()) THEN\n    RAISE EXCEPTION 'neighborhood_v2_continuation_claim_conflict' USING ERRCODE='55000'; END IF;\n  IF job.status<>'running' OR job.claim_token IS DISTINCT FROM NEW.issued_claim_token",
      "count": 1
    },
    {
      "old": "'frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2') AND NOT EXISTS(",
      "next": "'frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2') AND NOT EXISTS(",
      "count": 1
    },
    {
      "old": "      OR (OLD.phase='frozen_selected_semantic_refs_v2' AND NEW.phase<>'frozen_selected_semantic_refs_v2')",
      "next": "      OR (OLD.phase='frozen_selected_semantic_refs_v2' AND NEW.phase NOT IN ('frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'))\n      OR (OLD.phase='frozen_selected_transaction_index_refs_v2' AND NEW.phase<>'frozen_selected_transaction_index_refs_v2')\n      OR (NEW.phase='frozen_selected_transaction_index_refs_v2' AND OLD.phase NOT IN ('frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'))\n      OR (OLD.phase='frozen_selected_semantic_refs_v2' AND NEW.phase='frozen_selected_transaction_index_refs_v2'\n        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h\n          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.semantic_reference=OLD.progress_reference)))",
      "count": 1
    }
  ]
};
function restore(sql,changes){for(const {old,next,count} of [...changes].reverse()){
  assert.equal(sql.split(next).length-1,count,next);sql=sql.split(next).join(old);}return sql;}

test('draft job17 additions preserve the ENTIRE installed selection-wait/job guard byte-for-byte outside exact17 additions',()=>{
  const name='guard_neighborhood_cohort_v2_selection_wait',body=fn(draft,name);
  assert.equal(restore(body,edits.jobEdits),fn(old,name));
  for(const text of ["NEW.checkpoint IS DISTINCT FROM OLD.checkpoint",
    'app.neighborhood_transaction_index_v2_checkpoint_transition_matches(OLD.operation_id,OLD.organization_id,OLD.checkpoint,NEW.checkpoint)',
    "OLD.checkpoint->>'phase'='frozen_selected_transaction_index_refs_v2' AND NEW.checkpoint->>'phase'<>'frozen_selected_transaction_index_refs_v2'",
    'NEW.attempts<OLD.attempts',"NEW.status IN ('succeeded','awaiting_selection')"])assert.ok(body.includes(text),text);
});

test('draft continuation17 additions preserve the ENTIRE installed native continuation guard and admit ONLY16->17->17, no new failure attempt',()=>{
  const name='guard_neighborhood_cohort_v2_continuation',body=fn(draft,name);
  assert.equal(restore(body,edits.contEdits),fn(old,name));
  for(const text of ["NEW.phase='frozen_selected_transaction_index_refs_v2' AND OLD.phase NOT IN ('frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2')",
    "OLD.phase='frozen_selected_transaction_index_refs_v2' AND NEW.phase<>'frozen_selected_transaction_index_refs_v2'",
    'h.semantic_reference=OLD.progress_reference','h.issued_transaction_id=txid_current()',
    'NEW.issued_attempts<OLD.issued_attempts','NEW.issued_claim_token<>OLD.consumed_claim_token',
    'NEW.progress_reference=OLD.progress_reference','job.context_sha256 IS NOT NULL'])assert.ok(body.includes(text),text);
  assert.ok(body.indexOf('RETURN NEW;',body.indexOf('AND OLD.consumed_claim_token IS NULL'))<body.indexOf('h.issued_transaction_id=txid_current()'),
    'later native consume is allowed; only new issuance requires the new head in same TX');
  for(const [phase,max] of [['transaction_index',22000011],['semantic',20000010],['numeric',18000009]])
    assert.ok(body.includes("NEW.phase='frozen_selected_"+phase+"_refs_v2' AND NEW.sequence>"+max));
  assert.ok(body.includes('AND NEW.sequence>16000008'));
});

test('installed native child identity/first-seen guard and deferred job/continuation pair remain unchanged and every draft name fits PostgreSQL',()=>{
  const child=read('20261205_custom_cohort_selected_transaction_index_v2.sql'),pair=read('20261120_custom_cohort_issued_continuations_v2.sql');
  for(const text of ["TG_OP<>'INSERT'",'NEW.first_selected_ordinal IS DISTINCT FROM member.ordinal',
    'app.neighborhood_selected_transaction_index_v2_next_keys(NEW.operation_id,NEW.organization_id)',
    'k.kind=native_kind AND k.native_key=native_value'])assert.ok(child.includes(text),text);
  assert.ok(!draft.includes('CREATE OR REPLACE FUNCTION app.guard_neighborhood_selected_transaction_index_v2_child'));
  for(const text of ['NEW.attempts<OLD.attempts','c.consumed_claim_token IS NULL','job.attempts<>c.issued_attempts',
    "job.checkpoint->'evidence_refs'->-1 IS DISTINCT FROM c.progress_reference",'DEFERRABLE INITIALLY DEFERRED'])assert.ok(pair.includes(text),text);
  assert.doesNotMatch(draft,/ALTER TABLE|CREATE (?:CONSTRAINT )?TRIGGER|DROP TRIGGER|DISABLE TRIGGER|GRANT\s/);
  for(const m of draft.matchAll(/CREATE (?:OR REPLACE )?FUNCTION app\.([a-z0-9_]+)/g))assert.ok(Buffer.byteLength(m[1])<=63,m[1]);
});
