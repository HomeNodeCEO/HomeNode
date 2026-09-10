import { createHash } from 'node:crypto';
import { canonicalAssessmentJson } from '../services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortContextReference } from '../services/neighborhoodAssessment/customCohortContextContract.js';
import { customNeighborhoodPrivateSalesPurpose } from './customNeighborhoodPrivateSalesPolicy.js';

export const CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_RIGHTS_KEY = 'custom_neighborhood_report_observation_rights';
export const CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_PURPOSE = 'custom_reported_observations_v2';
const denied = Object.freeze({ allowed: false });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value');
  });
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === `${value.slice(0, 23)}Z`;

/** Additional permission for retaining/displaying/exporting one Custom report
 * group. It is NOT a replacement for the independent shared/private source
 * grants, assignment authorization or signing controls. The owner must require
 * all of them on its bounded transaction. No grant is installed by this code.
 */
export async function authorizeCustomNeighborhoodReportObservations(client, auth, context, purpose, requested) {
  const organizationId = context?.scope?.organization_id;
  if (typeof client?.query !== 'function' || !text(auth?.userId) || !uuid.test(organizationId ?? '')
    || context?.target?.workflow_type !== 'custom_appraisal'
    || !exact(purpose, ['kind', 'context_ref', 'shared_source_purpose', 'private_sales_import'])
    || purpose.kind !== CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_PURPOSE
    || !exact(requested, ['retention', 'exposure']) || requested.retention !== true
    || requested.exposure !== 'custom_report_observations') return denied;
  try {
    prepareCustomCohortContextReference(canonicalAssessmentJson(purpose.context_ref));
    if (purpose.private_sales_import !== null) customNeighborhoodPrivateSalesPurpose(purpose.private_sales_import);
    // The existing source policy owns this nested grammar. Do not interpret an
    // arbitrary source roster as permission here; only bound the owner metadata.
    if (purpose.shared_source_purpose?.kind !== 'neighborhood_cached_market_data'
      || Buffer.byteLength(canonicalAssessmentJson(purpose)) > 16384) return denied;
  } catch { return denied; }
  let result;
  try {
    result = await client.query(`/* custom-neighborhood-report-observation-policy:organization */
      SELECT id::text AS organization_id, active,
        CASE WHEN octet_length((metadata -> $2::text)::text) <= 16384 THEN metadata -> $2::text ELSE NULL END AS source_rights,
        to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS checked_at
      FROM app_auth.organizations WHERE id=$1::uuid`, [organizationId, CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_RIGHTS_KEY]);
  } catch { throw Object.assign(new Error('custom_neighborhood_report_observation_policy_unavailable'),
    { code: 'CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_POLICY_UNAVAILABLE' }); }
  if (!Array.isArray(result?.rows) || result.rows.length !== 1) return denied;
  const row = result.rows[0], grant = row.source_rights;
  if (row.organization_id !== organizationId || row.active !== true || !instant(row.checked_at)
    || !exact(grant, ['policy_version', 'organization_id', 'grant_id', 'purpose', 'rights_basis',
      'valid_from', 'expires_at', 'revoked_at', 'retention', 'exposures'])
    || grant.policy_version !== 1 || grant.organization_id !== organizationId || !text(grant.grant_id, 80)
    || grant.purpose !== CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_PURPOSE || grant.revoked_at !== null
    || grant.retention !== 'immutable_report_group_and_referenced_evidence'
    || !exact(grant.exposures, ['custom_report_observations']) || grant.exposures.custom_report_observations !== true
    || !instant(grant.valid_from) || !instant(grant.expires_at) || grant.valid_from >= grant.expires_at
    || grant.valid_from > row.checked_at || row.checked_at >= grant.expires_at
    || !exact(grant.rights_basis, ['owner_id', 'basis_reference', 'approved_by', 'approved_at'])
    || !text(grant.rights_basis.owner_id) || !text(grant.rights_basis.basis_reference, 1000)
    || !text(grant.rights_basis.approved_by) || !instant(grant.rights_basis.approved_at)
    || grant.rights_basis.approved_at > row.checked_at) return denied;
  let encoded;
  try { encoded = canonicalAssessmentJson(grant); } catch { return denied; }
  if (Buffer.byteLength(encoded) > 16384) return denied;
  return Object.freeze({ allowed: true, decision_id: `${organizationId}:${grant.grant_id}`,
    policy_revision: `custom-report-observation-rights-v1:sha256:${createHash('sha256').update(encoded).digest('hex')}` });
}
