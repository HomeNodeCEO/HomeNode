import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { getNeighborhoodFrozenCadImprovementProfile } from '../services/neighborhoodAssessment/neighborhoodFrozenCadImprovements.js';

const originalProfile = getNeighborhoodFrozenCadImprovementProfile();
const fields = JSON.parse(originalProfile.definition_blob.canonical_json).fields;
Object.values(fields).forEach(Object.freeze); Object.freeze(fields);
export const CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_RIGHTS_KEY = 'custom_neighborhood_cad_improvement_source_rights_v1';
export const CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_DATASET = 'integrated_retained_CAD_improvement_dataset';
export const CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_PURPOSE = Object.freeze({
  kind: 'neighborhood_retained_CAD_improvement_data',
  source_classes: Object.freeze(['core.primary_improvements', 'core.secondary_improvements']),
  source_classification: Object.freeze({'core.primary_improvements': 'provider_mixed_cadastral_improvement_originals',
    'core.secondary_improvements': 'provider_mixed_cadastral_improvement_originals'}),
  account_scope: 'exact_pinned_job_stock_accounts',
  associated_row_scope: 'all_retained_improvement_rows_for_stock_accounts_without_geometry_clipping',
  acquisition_scope: 'retained_generation_only_no_current_core_or_provider_reads',
  temporal_basis: 'current_CAD_observations_not_retrospective_or_at_sale',
  additional_cadastral_accounts: false, private_assignment_overlays: false,
  source_projection: Object.freeze({...originalProfile.profile_ref, fields}),
});
const PURPOSE = CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_PURPOSE;
const EXPOSURES = ['none', 'report_observation_summary', 'report_observation_members', 'report_observation_catalog'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_POLICY_BYTES = 16_384;
const DENIED = Object.freeze({ allowed: false });
const CONFIG_KEYS = ['policy_version', 'organization_id', 'grant_id', 'dataset', 'purpose_version',
  'purpose_scope', 'rights_basis', 'valid_from', 'expires_at', 'revoked_at', 'retention', 'exposures'];

// Deliberate small duplication preserves both installed legacy evaluators'
// configurations, hashes, SQL arguments and error bytes. This dormant evaluator
// has one fixed additional projection/namespace, never a caller-selected grant.
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
}
function dense(value, maximum) {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}
function text(value, limit = 200) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && value.isWellFormed()
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}
function instant(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === `${value.slice(0, 23)}Z`;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function providers(value) {
  return dense(value, 32) && value.length > 0
    && value.every(item => exact(item, ['provider_id', 'revision']) && text(item.provider_id) && text(item.revision))
    && new Set(value.map(item => item.provider_id)).size === value.length;
}
function providerSet(value) { return [...value].sort((a, b) => a.provider_id < b.provider_id ? -1 : a.provider_id > b.provider_id ? 1 : 0); }
function literalArray(value, expected) {
  return dense(value, expected.length) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}
function purposeScope(value) {
  if (!exact(value, Object.keys(PURPOSE)) || !literalArray(value.source_classes, PURPOSE.source_classes)
    || !exact(value.source_classification, PURPOSE.source_classes)
    || !PURPOSE.source_classes.every(key => value.source_classification[key] === PURPOSE.source_classification[key])
    || !Object.keys(PURPOSE).filter(key => !['source_classes', 'source_classification', 'source_projection'].includes(key))
      .every(key => value[key] === PURPOSE[key])) return false;
  const projection = value.source_projection, expected = PURPOSE.source_projection;
  return exact(projection, ['id', 'revision', 'content_sha256', 'fields'])
    && projection.id === expected.id && projection.revision === expected.revision
    && projection.content_sha256 === expected.content_sha256
    && exact(projection.fields, ['primary', 'secondary'])
    && literalArray(projection.fields.primary, expected.fields.primary)
    && literalArray(projection.fields.secondary, expected.fields.secondary);
}
function requestOf(value) {
  return exact(value, ['selection_sha256', 'generation_id'])
    && typeof value.selection_sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.selection_sha256)
    && typeof value.generation_id === 'string' && UUID.test(value.generation_id);
}
function purposeOf(value) {
  if (!exact(value, [...Object.keys(PURPOSE), 'selection_sha256', 'generation_id'])) return false;
  const scope = Object.fromEntries(Object.keys(PURPOSE).map(key => [key, value[key]]));
  return purposeScope(scope) && requestOf({selection_sha256: value.selection_sha256, generation_id: value.generation_id});
}

/** Installed purpose DATA only, not a grant. The future owner must derive the
 * selection hash and pinned generation, then authorize current rights at both
 * transaction ends before exposing any additional original or derivative. */
export function describeNeighborhoodCadImprovementPurpose(request) {
  if (!requestOf(request)) throw new TypeError('custom_neighborhood_cad_improvement_purpose_required');
  return Object.freeze({...PURPOSE, selection_sha256: request.selection_sha256, generation_id: request.generation_id});
}
function configOf(value, organizationId, expected, now) {
  if (!exact(value, CONFIG_KEYS) || value.policy_version !== 1 || value.purpose_version !== 1
    || value.organization_id !== organizationId || !text(value.grant_id, 80)
    || !purposeScope(value.purpose_scope) || value.revoked_at !== null
    || value.retention !== 'immutable_originals_without_automated_deletion'
    || !exact(value.exposures, EXPOSURES) || value.exposures.none !== true
    || !EXPOSURES.every(key => typeof value.exposures[key] === 'boolean')
    || !instant(now) || !instant(value.valid_from) || !instant(value.expires_at)
    || value.valid_from > now || now >= value.expires_at || value.valid_from >= value.expires_at) return false;
  const basis = value.rights_basis;
  if (!exact(basis, ['owner_id', 'basis_reference', 'approved_by', 'approved_at'])
    || !text(basis.owner_id) || !text(basis.basis_reference, 1000) || !text(basis.approved_by)
    || !instant(basis.approved_at) || basis.approved_at > now) return false;
  const dataset = value.dataset;
  return exact(dataset, ['id', 'revision', 'coverage', 'provider_revisions'])
    && dataset.id === CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_DATASET && dataset.revision === expected.datasetRevision
    && dataset.coverage === 'entire_integrated_source_mix_including_prior_merged_values'
    && providers(dataset.provider_revisions)
    && canonical(providerSet(dataset.provider_revisions)) === canonical(expected.providerRevisions);
}

/** Parallel, dormant server-only policy. Approval must independently cover the
 * entire integrated provider mix plus the exact CAD companion projection.
 * This does not provision metadata, authenticate an assignment, grant a role,
 * interpret field meanings, or alter the existing owner/composition defaults.
 */
export function createCustomNeighborhoodCadImprovementSourcePolicy(options) {
  if (!exact(options, ['datasetRevision', 'providerRevisions']) || !text(options.datasetRevision)
    || !providers(options.providerRevisions)) throw new TypeError('custom_neighborhood_cad_improvement_source_policy_profile_required');
  const expected = { datasetRevision: options.datasetRevision,
    providerRevisions: providerSet(options.providerRevisions.map(item => ({ ...item }))) };
  return async function authorizeMarketData(client, auth, context, purpose, requested) {
    const organizationId = context?.scope?.organization_id;
    if (typeof client?.query !== 'function' || !text(auth?.userId) || typeof organizationId !== 'string'
      || !UUID.test(organizationId) || context?.target?.workflow_type !== 'custom_appraisal'
      || !date(context?.effective_date) || !purposeOf(purpose)
      || !exact(requested, ['retention', 'exposure']) || requested.retention !== true
      || !EXPOSURES.includes(requested.exposure)) return DENIED;
    const exposure = requested.exposure;
    let result;
    try {
      result = await client.query(`/* custom-neighborhood-cad-improvement-source-policy:organization */
        SELECT id::text AS organization_id, active,
          CASE WHEN octet_length((metadata -> $2::text)::text) <= $3::integer
            THEN metadata -> $2::text ELSE NULL END AS source_rights,
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS checked_at
        FROM app_auth.organizations WHERE id = $1::uuid`,
      [organizationId, CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_RIGHTS_KEY, MAX_POLICY_BYTES]);
    } catch {
      throw Object.assign(new Error('custom_neighborhood_cad_improvement_source_policy_unavailable'), {
        code: 'CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_POLICY_UNAVAILABLE',
      });
    }
    if (!Array.isArray(result?.rows) || result.rows.length !== 1) return DENIED;
    const row = result.rows[0];
    if (!exact(row, ['organization_id', 'active', 'source_rights', 'checked_at'])
      || row.organization_id !== organizationId || row.active !== true
      || !configOf(row.source_rights, organizationId, expected, row.checked_at)) return DENIED;
    const config = row.source_rights, serialized = canonical(config);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_POLICY_BYTES || config.exposures[exposure] !== true) return DENIED;
    const digest = createHash('sha256').update(serialized).digest('hex');
    return Object.freeze({ allowed: true, decision_id: `${organizationId}:${config.grant_id}`,
      policy_revision: `custom-neighborhood-cad-improvement-source-rights-v1:sha256:${digest}` });
  };
}


