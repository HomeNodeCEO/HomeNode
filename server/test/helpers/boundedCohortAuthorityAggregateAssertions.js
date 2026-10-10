import assert from 'node:assert/strict';

// Independent golden shapes for the ONLY two aggregates allowed in this owner.
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

export function assertBoundedCohortAuthorityAggregates(calls, { actorUserId, organizationId, assignmentFileId }) {
  let actors = 0, sections = 0;
  for (const { text, values } of calls) {
    assert.doesNotMatch(text, /ST_DWithin|job-typed:/, 'catalog must not use spatial/job-typed population paths');
    if (!/\b(?:array_agg|jsonb_agg)\s*\(/i.test(text)) continue;
    const sql = normalize(text);
    if (sql === ACTOR_SQL) {
      assert.deepEqual(values, [actorUserId, organizationId], 'exact current actor and organization only');
      actors++;
    } else if (sql === SECTIONS_SQL) {
      assert.deepEqual(values, [assignmentFileId, SECTION_KEYS, 1_500_000],
        'only the three fixed material sections for the exact assignment, with the existing byte cap');
      sections++;
    } else {
      assert.fail(`unexpected catalog aggregate SQL: ${sql.slice(0, 180)}`);
    }
  }
  assert.ok(actors >= 2, 'both-end current actor role reads remain mandatory');
  assert.ok(sections >= 2, 'both-end current bounded subject-section reads remain mandatory');
}
