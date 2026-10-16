/** Fixed native stock prefix. Counts admit whole accounts BEFORE either payload
 * pass encodes originals; the first oversized account refuses rather than
 * disappearing as EMPTY. Every included original still crosses the full replay.
 * At most8 accounts share250 originals and ALL existing byte/query/deadline caps.
 * This read-only source primitive issues no receipt, continuation or authority. */
export const NEIGHBORHOOD_STOCK_WHOLE_ACCOUNT_BATCH_V2_SQL=`/* neighborhood-stock-whole-account-batch-originals-v2 */
WITH candidates AS MATERIALIZED (
  SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
  WHERE operation_id=$1::uuid AND account_id>$4::text COLLATE "C" ORDER BY account_id LIMIT 8
), candidate_counts AS MATERIALIZED (
  SELECT a.account_id,k.kind,(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
    LIMIT ($5::integer+1)) bounded) AS n
  FROM candidates a CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind)
), account_sizes AS MATERIALIZED (
  SELECT a.account_id,a.parcel_count,sum(c.n)::integer AS original_count,
    jsonb_object_agg(c.kind,c.n) AS original_counts
  FROM candidates a JOIN candidate_counts c ON c.account_id=a.account_id GROUP BY a.account_id,a.parcel_count
), ranked AS MATERIALIZED (
  SELECT *,row_number() OVER(ORDER BY account_id COLLATE "C") AS ordinal,
    sum(original_count) OVER(ORDER BY account_id COLLATE "C" ROWS UNBOUNDED PRECEDING) AS prefix_original_count
  FROM account_sizes
), count_admitted AS MATERIALIZED (
  SELECT * FROM ranked WHERE prefix_original_count<=$5::integer OR ordinal=1
), raw_sizes AS MATERIALIZED (
  SELECT a.account_id,octet_length(o.payload::text) AS original_bytes,octet_length(t.typed::text) AS typed_bytes
  FROM count_admitted a CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.payload
    FROM app.neighborhood_frozen_source_rows o WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
      AND (SELECT sum(original_count) FROM count_admitted)<=$5::integer OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.typed FROM app.neighborhood_frozen_typed_v2_rows t
    WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3
      AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
), account_bytes AS MATERIALIZED (
  SELECT a.*,b.* FROM count_admitted a CROSS JOIN LATERAL (
    SELECT coalesce(sum(original_bytes::bigint+coalesce(typed_bytes,0)+1),0) AS raw_bytes,
      coalesce(sum(2::bigint*coalesce(typed_bytes,0)+1024),0) AS output_bytes,
      coalesce(bool_or(original_bytes>$8::integer OR original_bytes::bigint+coalesce(typed_bytes,0)>$7::integer),false) AS oversize
    FROM raw_sizes r WHERE r.account_id=a.account_id
  ) b
), byte_ranked AS MATERIALIZED (
  SELECT *,sum(raw_bytes) OVER(ORDER BY account_id COLLATE "C" ROWS UNBOUNDED PRECEDING) AS prefix_raw_bytes,
    sum(output_bytes) OVER(ORDER BY account_id COLLATE "C" ROWS UNBOUNDED PRECEDING) AS prefix_output_bytes,
    sum(oversize::integer) OVER(ORDER BY account_id COLLATE "C" ROWS UNBOUNDED PRECEDING) AS prefix_oversize
  FROM account_bytes
), chosen AS MATERIALIZED (
  SELECT * FROM byte_ranked WHERE ordinal=1 OR prefix_raw_bytes+2<=$6::integer
    AND prefix_output_bytes+2<=$9::integer AND prefix_oversize=0
), totals AS MATERIALIZED (
  SELECT c.kind,sum(c.n)::integer AS n FROM candidate_counts c JOIN chosen a ON a.account_id=c.account_id GROUP BY c.kind
), raw_gate AS MATERIALIZED (
  SELECT coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(max(original_bytes::bigint+coalesce(typed_bytes,0)),0)>$7::integer
    OR coalesce(sum(original_bytes::bigint+coalesce(typed_bytes,0)+1),0)+2>$6::integer
    OR coalesce(sum(2::bigint*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS oversize
  FROM raw_sizes WHERE account_id IN(SELECT account_id FROM chosen)
), members AS MATERIALIZED (
  SELECT o.account_id,o.kind,o.row_key,t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id
      OR t.source_record_id IS DISTINCT FROM o.source_record_id AS invalid,
    octet_length(o.payload::text) AS original_bytes,octet_length(t.typed::text) AS typed_bytes,
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,
      'source_record_id',o.source_record_id::text,'original_text',o.payload::text,
      'cached_account_id',t.account_id,'cached_source_record_id',t.source_record_id::text,
      'original_payload_sha256',t.original_payload_sha256,'typed',t.typed)::text AS encoded
  FROM chosen a CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.source_record_id,o.payload
    FROM app.neighborhood_frozen_source_rows o WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
      AND (SELECT sum(n) FROM totals)<=$5::integer AND NOT (SELECT oversize FROM raw_gate) OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.source_record_id,t.original_payload_sha256,t.typed
    FROM app.neighborhood_frozen_typed_v2_rows t WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3
      AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
), sized AS MATERIALIZED (SELECT *,octet_length(encoded) AS bytes FROM members)
SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'geographic_parcel_count',parcel_count::text,
    'original_counts',original_counts) ORDER BY account_id COLLATE "C") FROM chosen),'[]'::jsonb) AS accounts,
  coalesce((SELECT sum(n)::integer FROM totals),0) AS original_count,count(*)::integer AS page_count,
  coalesce(sum(CASE WHEN invalid THEN 1 ELSE 0 END),0)::integer AS invalid_count,
  (SELECT oversize FROM raw_gate) OR coalesce(max(bytes),0)>$7::integer OR coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(sum(bytes+1),0)+2>$6::integer OR coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS packet_oversize,
  CASE WHEN NOT (SELECT oversize FROM raw_gate) AND coalesce(max(bytes),0)<=$7::integer AND coalesce(max(original_bytes),0)<=$8::integer
    AND coalesce(sum(bytes+1),0)+2<=$6::integer AND coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2<=$9::integer
    THEN coalesce('['||string_agg(encoded,',' ORDER BY account_id COLLATE "C",kind COLLATE "C",row_key COLLATE "C")||']','[]') ELSE '[]' END AS page_json
FROM sized`;
