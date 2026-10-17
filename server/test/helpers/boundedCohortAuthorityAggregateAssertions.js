import assert from 'node:assert/strict';

// Independent golden shapes for the two authority aggregates and the bounded
// whole-original transport for ONE server-chosen account allowed in this owner.
// Checking the whole SQL and its bound values prevents a comment/tag alone from
// exempting a population aggregate. This is a test assertion, not authorization.
const normalize = sql => sql.replace(/\s+/g, ' ').trim();
const ACTOR_SQL = normalize(`/* custom-cohort-job:current-actor */
  SELECT users.id::text AS user_id, memberships.organization_id::text AS organization_id,
    array_remove(array_agg(DISTINCT roles.role_code ORDER BY roles.role_code), NULL) AS roles
  FROM app_auth.users users
  JOIN app_auth.organization_memberships memberships
    ON memberships.user_id=users.id AND memberships.organization_id=$2::uuid
     AND memberships.status='active'
  JOIN app_auth.organizations organizations
    ON organizations.id=memberships.organization_id AND organizations.active=true
  LEFT JOIN app_auth.membership_roles roles
    ON roles.organization_id=memberships.organization_id AND roles.user_id=users.id
  WHERE users.id=$1::uuid AND users.active=true
  GROUP BY users.id, memberships.organization_id`);
const SECTIONS_SQL = normalize(`/* custom-cohort-subject:sections */
  WITH held AS (SELECT assignment_file_id::text, section_key,
    jsonb_build_object('state', CASE WHEN section_value IS NULL THEN 'sql_null'
      WHEN section_value='null'::jsonb THEN 'json_null' ELSE 'present' END, 'pg_text', section_value::text) AS section_value,
    revision, last_applied_session_id, last_applied_by_user_id, created_at::text, updated_at::text
    FROM app.custom_appraisal_sections WHERE assignment_file_id=$1::bigint AND section_key=ANY($2::text[])
    ORDER BY section_key COLLATE "C" FOR SHARE NOWAIT),
  encoded AS (SELECT jsonb_agg(jsonb_build_object('section_key', k, 'row_state',
    CASE WHEN held.section_key IS NULL THEN 'absent' ELSE 'present' END, 'row', to_jsonb(held)) ORDER BY ord)::text AS value
    FROM unnest($2::text[]) WITH ORDINALITY AS keys(k,ord) LEFT JOIN held ON held.section_key=k)
  SELECT CASE WHEN octet_length(value)<=$3 THEN value ELSE NULL END AS original_json FROM encoded`);
const SECTION_KEYS = ['report.land_details', 'report.property_characteristics', 'report.subject_identification'];
const ORIGINAL_ACCOUNT_SQL = normalize(`/* neighborhood-stock-account-original-package-v2 */
WITH chosen AS MATERIALIZED (
  SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
  WHERE operation_id=$1::uuid AND account_id>$4::text COLLATE "C" ORDER BY account_id LIMIT 1
), totals AS MATERIALIZED (
  SELECT kind,(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=(SELECT account_id FROM chosen)
    LIMIT ($5::integer+1)) bounded) AS n FROM (VALUES ('parcels'),('accounts')) k(kind)
), members AS MATERIALIZED (
  SELECT o.kind,o.row_key,t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id
      OR t.source_record_id IS DISTINCT FROM o.source_record_id AS invalid,
    octet_length(o.payload::text) AS original_bytes,octet_length(t.typed::text) AS typed_bytes,
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,
      'source_record_id',o.source_record_id::text,'original_text',o.payload::text,
      'cached_account_id',t.account_id,'cached_source_record_id',t.source_record_id::text,
      'original_payload_sha256',t.original_payload_sha256,'typed',t.typed)::text AS encoded
  FROM chosen a CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.source_record_id,o.payload
    FROM app.neighborhood_frozen_source_rows o WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
      AND (SELECT sum(n) FROM totals)<=$5::integer OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.source_record_id,t.original_payload_sha256,t.typed
    FROM app.neighborhood_frozen_typed_v2_rows t WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3
      AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
), sized AS MATERIALIZED (SELECT *,octet_length(encoded) AS bytes FROM members)
SELECT (SELECT account_id FROM chosen) AS account_id,(SELECT parcel_count::text FROM chosen) AS geographic_parcel_count,
  (SELECT jsonb_object_agg(kind,n) FROM totals) AS original_counts,count(*)::integer AS page_count,
  coalesce(sum(CASE WHEN invalid THEN 1 ELSE 0 END),0)::integer AS invalid_count,
  coalesce(max(bytes),0)>$7::integer OR coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(sum(bytes+1),0)+2>$6::integer OR coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS packet_oversize,
  CASE WHEN coalesce(max(bytes),0)<=$7::integer AND coalesce(max(original_bytes),0)<=$8::integer
    AND coalesce(sum(bytes+1),0)+2<=$6::integer AND coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2<=$9::integer
    THEN coalesce('['||string_agg(encoded,',' ORDER BY kind COLLATE "C",row_key COLLATE "C")||']','[]') ELSE '[]' END AS page_json
FROM sized`);

function validateShapes(calls, { actorUserId, organizationId, assignmentFileId, originals }) {
  let actors = 0, sections = 0;
  for (const { text, values } of calls) {
    assert.doesNotMatch(text, /ST_DWithin|job-typed:/, 'catalog must not use spatial/job-typed population paths');
    if (!/\b(?:array_agg|jsonb?_agg|jsonb?_object_agg|string_agg|xmlagg)\s*\(|\bARRAY\s*\(\s*SELECT\b/i.test(text)) continue;
    const sql = normalize(text);
    if (sql === ACTOR_SQL) {
      assert.deepEqual(values, [actorUserId, organizationId], 'exact current actor and organization only');
      actors++;
    } else if (sql === SECTIONS_SQL) {
      assert.deepEqual(values, [assignmentFileId, SECTION_KEYS, 1_500_000],
        'only the three fixed material sections for the exact assignment, with the existing byte cap');
      sections++;
    } else if (sql === ORIGINAL_ACCOUNT_SQL) {
      assert.ok(originals, 'whole-original packet requires the exact retained stock scope');
      const afterAccount = values?.[3];
      assert.ok(typeof afterAccount === 'string' && afterAccount.length <= 64 && Buffer.byteLength(afterAccount) <= 256
        && afterAccount === afterAccount.trim() && !/[\u0000-\u001f\u007f]/.test(afterAccount), 'bounded original account cursor only');
      assert.deepEqual(values, [originals.operationId, originals.generationId, originals.profileSha256, afterAccount,
        250, 8_000_000, 2_100_000, 1_000_000, 2_100_000], 'exact original stock, generation, profile and existing row/byte caps only');
    } else {
      assert.fail(`unexpected catalog aggregate SQL: ${sql.slice(0, 180)}`);
    }
  }
  return { actors, sections };
}

// A rejected owner can stop before the ending subject/role reads. Validate
// EVERY aggregate and parameter in that failed call without claiming delivery.
export function assertBoundedCohortAuthorityAggregateShapes(calls, scope) {
  validateShapes(calls, scope);
}

export function assertBoundedCohortAuthorityAggregates(calls, scope) {
  const { actors, sections } = validateShapes(calls, scope);
  assert.ok(actors >= 2, 'both-end current actor role reads remain mandatory');
  assert.ok(sections >= 2, 'both-end current bounded subject-section reads remain mandatory');
}
