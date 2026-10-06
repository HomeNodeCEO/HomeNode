const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(reason) {
  throw new TypeError(`custom_cohort_job_actor_${reason}`);
}

/** A resumed capture must not reuse request-time role claims. Read only the
 * current active user, organization membership and roles for the original
 * actor. The capture coordinator must still recheck assignment access and
 * independent market-source rights in its own transaction before publishing.
 */
export async function loadCurrentCustomCohortJobActor(client, actorUserId, organizationId) {
  if (typeof client?.query !== 'function' || typeof actorUserId !== 'string'
    || !UUID.test(actorUserId) || typeof organizationId !== 'string'
    || !UUID.test(organizationId)) fail('invalid_input');
  const result = await client.query(`/* custom-cohort-job:current-actor */
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
    GROUP BY users.id, memberships.organization_id`, [actorUserId, organizationId]);
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1)
    fail('access_revoked');
  const row = result.rows[0];
  if (row.user_id?.toLowerCase() !== actorUserId.toLowerCase()
    || row.organization_id?.toLowerCase() !== organizationId.toLowerCase()
    || !Array.isArray(row.roles) || !row.roles.length
    || row.roles.length > 32 || row.roles.some(role => typeof role !== 'string'
      || !/^[a-z][a-z_]{0,63}$/.test(role))) fail('access_revoked');
  return Object.freeze({ userId: row.user_id, organizations: Object.freeze([
    Object.freeze({ organizationId: row.organization_id, roles: Object.freeze([...row.roles]) }),
  ]) });
}
