import { createHash } from 'node:crypto';

// Separate from integrated-cache rights: a shared MLS grant must not silently
// cover arbitrary private uploads. Installation records an independently
// approved purpose, not a role grant or a claim that a CSV proves licensing.
export const CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_RIGHTS_KEY = 'custom_neighborhood_private_sales_rights';
export const CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_PURPOSE = 'assignment_private_sales_observations_v1';
const EXPOSURES = ['none', 'report_observation_summary', 'report_observation_members', 'report_observation_catalog'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DENIED = Object.freeze({ allowed: false });
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value');
  });
const text = (value, maximum = 200) => typeof value === 'string' && value.length > 0
  && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === `${value.slice(0, 23)}Z`;
const canonical = value => value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);

export function customNeighborhoodPrivateSalesPurpose(reference) {
  if (!exact(reference, ['batch_id', 'expected_review_revision']) || !UUID.test(reference.batch_id)
    || !Number.isInteger(reference.expected_review_revision) || reference.expected_review_revision < 1
    || reference.expected_review_revision > 2147483647) throw new TypeError('private_sales_reference_invalid');
  return Object.freeze({ kind: CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_PURPOSE,
    batch_id: reference.batch_id, expected_review_revision: reference.expected_review_revision });
}

/** Already-authorized assignment transaction only. No pool, writes, remote
 * calls, inferred provider permissions, or access to original CSV cells. */
export async function authorizeCustomNeighborhoodPrivateSales(client, auth, context, purpose, requested) {
  const organizationId = context?.scope?.organization_id;
  if (typeof client?.query !== 'function' || !text(auth?.userId) || !UUID.test(organizationId ?? '')
    || context?.target?.workflow_type !== 'custom_appraisal'
    || !exact(purpose, ['kind', 'batch_id', 'expected_review_revision'])
    || purpose.kind !== CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_PURPOSE
    || !exact(requested, ['retention', 'exposure']) || requested.retention !== true
    || !EXPOSURES.includes(requested.exposure)) return DENIED;
  try { customNeighborhoodPrivateSalesPurpose({ batch_id: purpose.batch_id, expected_review_revision: purpose.expected_review_revision }); }
  catch { return DENIED; }
  let result;
  try {
    result = await client.query(`/* custom-neighborhood-private-sales-policy:organization */
      SELECT id::text AS organization_id, active,
        CASE WHEN octet_length((metadata -> $2::text)::text) <= 16384
          THEN metadata -> $2::text ELSE NULL END AS source_rights,
        to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS checked_at
      FROM app_auth.organizations WHERE id=$1::uuid`, [organizationId, CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_RIGHTS_KEY]);
  } catch { throw Object.assign(new Error('custom_neighborhood_private_sales_policy_unavailable'),
    { code: 'CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_POLICY_UNAVAILABLE' }); }
  if (!Array.isArray(result?.rows) || result.rows.length !== 1) return DENIED;
  const row = result.rows[0], grant = row.source_rights;
  if (row.organization_id !== organizationId || row.active !== true || !instant(row.checked_at)
    || !exact(grant, ['policy_version', 'organization_id', 'grant_id', 'purpose', 'rights_basis',
      'valid_from', 'expires_at', 'revoked_at', 'retention', 'exposures'])
    || grant.policy_version !== 1 || grant.organization_id !== organizationId || !text(grant.grant_id, 80)
    || grant.purpose !== CUSTOM_NEIGHBORHOOD_PRIVATE_SALES_PURPOSE || grant.revoked_at !== null
    || grant.retention !== 'immutable_originals_without_automated_deletion'
    || !instant(grant.valid_from) || !instant(grant.expires_at)
    || grant.valid_from > row.checked_at || row.checked_at >= grant.expires_at || grant.valid_from >= grant.expires_at
    || !exact(grant.exposures, EXPOSURES) || grant.exposures.none !== true
    || !EXPOSURES.every(key => typeof grant.exposures[key] === 'boolean') || grant.exposures[requested.exposure] !== true
    || !exact(grant.rights_basis, ['owner_id', 'basis_reference', 'approved_by', 'approved_at'])
    || !text(grant.rights_basis.owner_id) || !text(grant.rights_basis.basis_reference, 1000)
    || !text(grant.rights_basis.approved_by) || !instant(grant.rights_basis.approved_at)
    || grant.rights_basis.approved_at > row.checked_at) return DENIED;
  const encoded = canonical(grant);
  if (Buffer.byteLength(encoded, 'utf8') > 16384) return DENIED;
  return Object.freeze({ allowed: true, decision_id: `${organizationId}:${grant.grant_id}`,
    policy_revision: `custom-private-sales-rights-v1:sha256:${createHash('sha256').update(encoded).digest('hex')}` });
}
