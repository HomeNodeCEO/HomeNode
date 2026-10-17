import { FOURTH_FIRST_SOURCE_CONTEXT_V3_SQL as FOURTH_FIRST } from './completedIndexFirstSourceV3Sql.js';
import { THIRD_FIRST_SOURCE_CONTEXT_V3_SQL as THIRD_FIRST } from './completedIndexFirstSourceV3Sql.js';
import { SECOND_FIRST_SOURCE_CONTEXT_V3_SQL as SECOND_FIRST } from './completedIndexFirstSourceV3Sql.js';
import { COMPLETED_INDEX_FIRST_SOURCE_CONTEXT_V3_SQL as FIRST,
  OWNED_FIRST_SOURCE_CONTEXT_V3_SQL as OWNED_FIRST, RECOVERED_FIRST_SOURCE_CONTEXT_V3_SQL as RECOVERED_FIRST } from './completedIndexFirstSourceV3Sql.js';

// Fixed NEXT after the actual completed-index FIRST. This is a read-only
// selection, never a durable cursor or source grant. Both namespaces retain
// their native ordering: source IDs as BIGINT, then source-less legacy C text.
export const COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL=`
 SELECT h.generation_id,m.account_id,m.ordinal,m.partition_ordinal,m.entry_reference,
  m.metric_row_reference,m.contribution_row_reference,h.receipt_reference AS index_reference,
  h.sequence AS index_sequence,k.kind,k.native_key,k.first_selected_ordinal
 FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN LATERAL (${FIRST}) first_source ON true
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h
  ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
  AND h.generation_id=first_source.generation_id AND h.receipt_reference=first_source.index_reference
  AND h.sequence=first_source.index_sequence
 CROSS JOIN LATERAL (
  (SELECT 'source_record'::text AS kind,source_record_id::text AS native_key,first_selected_ordinal
   FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys
   WHERE operation_id=h.operation_id AND organization_id=h.organization_id AND generation_id=h.generation_id
    AND first_source.kind='source_record' AND source_record_id>first_source.native_key::bigint
   ORDER BY source_record_id LIMIT 1)
  UNION ALL
  (SELECT 'legacy_sale'::text AS kind,legacy_sale_key AS native_key,first_selected_ordinal
   FROM app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys
   WHERE operation_id=h.operation_id AND organization_id=h.organization_id AND generation_id=h.generation_id
    AND (first_source.kind='source_record' OR legacy_sale_key COLLATE "C">first_source.native_key COLLATE "C")
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys remaining
     WHERE remaining.operation_id=h.operation_id AND remaining.organization_id=h.organization_id
      AND remaining.generation_id=h.generation_id AND first_source.kind='source_record'
      AND remaining.source_record_id>first_source.native_key::bigint LIMIT 1)
   ORDER BY legacy_sale_key COLLATE "C" LIMIT 1)
 ) k
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_rows m
  ON m.operation_id=h.operation_id AND m.organization_id=h.organization_id AND m.generation_id=h.generation_id
  AND m.ordinal=k.first_selected_ordinal
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_edges edge
  ON edge.operation_id=m.operation_id AND edge.organization_id=m.organization_id AND edge.generation_id=m.generation_id
  AND edge.ordinal=m.ordinal AND edge.account_id=m.account_id AND edge.kind=k.kind AND edge.native_key=k.native_key
 WHERE job.operation_id=$1::uuid AND h.generation_id=$2::uuid`;

// A separate closed read under the real fresh18 claim. The native owned-FIRST
// functions independently reopen the entire immutable birth17/preclaim18/current
// claim and actual FIRST/member/edge. No18 projection is admitted as a new17,
// and neither the retained first candidate nor a caller key chooses NEXT.
function ownedNext(){
  const sql=COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL;
  if(sql.split(FIRST).length!==2)throw new TypeError('completed_index_owned_next_source_v3_sql_shape');
  return sql.replace(FIRST,OWNED_FIRST);
}
export const OWNED_NEXT_SOURCE_CONTEXT_V3_SQL=ownedNext();

// Independent live recovered5 parent: retain original17, initial owned4, retry4,
// recovery5 and FIRST/member/edge. No initial-claim or17 projection substitutes.
function recoveredNext(){
  const sql=COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL;
  if(sql.split(FIRST).length!==2)throw new TypeError('completed_index_recovered_next_source_v3_sql_shape');
  return sql.replace(FIRST,RECOVERED_FIRST);
}
export const RECOVERED_NEXT_SOURCE_CONTEXT_V3_SQL=recoveredNext();

// Independent actual initial1/failure1/second2 parent. No copied roots.
function secondNext(){
 const sql=COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL;
 if(sql.split(FIRST).length!==2)throw new TypeError('completed_index_second_next_source_v3_sql_shape');
 return sql.replace(FIRST,SECOND_FIRST);
}
export const SECOND_NEXT_SOURCE_CONTEXT_V3_SQL=secondNext();

// Independent actual1/failure1/second2/failure2/third3 parent. No copied roots.
function thirdNext(){
 const sql=COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL;
 if(sql.split(FIRST).length!==2)throw new TypeError('completed_index_third_next_source_v3_sql_shape');
 return sql.replace(FIRST,THIRD_FIRST);
}
export const THIRD_NEXT_SOURCE_CONTEXT_V3_SQL=thirdNext();

// Actual normal-fourth graph; no initial4 recovery or copied roots.
function fourthNext(){
 const sql=COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL;
 if(sql.split(FIRST).length!==2)throw new TypeError('completed_index_fourth_next_source_v3_sql_shape');
 return sql.replace(FIRST,FOURTH_FIRST);
}
export const FOURTH_NEXT_SOURCE_CONTEXT_V3_SQL=fourthNext();
