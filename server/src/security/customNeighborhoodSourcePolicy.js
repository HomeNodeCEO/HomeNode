import { createHash } from 'node:crypto';

export const CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY = 'custom_neighborhood_source_rights';
export const CUSTOM_NEIGHBORHOOD_SOURCE_DATASET = 'integrated_cached_market_dataset';
export const CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE = Object.freeze({
  kind: 'neighborhood_cached_market_data',
  source_classes: Object.freeze(['core.sales_source_records', 'core.sales', 'core.sale_parcels']),
  source_classification: Object.freeze({ 'core.sales_source_records': 'licensed_mls_source_records',
    'core.sales': 'canonical_sales', 'core.sale_parcels': 'transaction_parcel_associations' }),
  transaction_scope: 'transactions_intersecting_selection',
  association_metadata: 'all_transaction_parcel_links',
  event_date_scope: 'all_available_dates_for_seeded_transactions',
  additional_cadastral_accounts: false, private_assignment_overlays: false,
});
const EXPOSURES = ['none', 'report_observation_summary', 'report_observation_members', 'report_observation_catalog'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_POLICY_BYTES = 16_384;
const DENIED = Object.freeze({ allowed: false });
const CONFIG_KEYS = ['policy_version', 'organization_id', 'grant_id', 'dataset', 'purpose_version',
  'purpose_scope', 'rights_basis', 'valid_from', 'expires_at', 'revoked_at', 'retention', 'exposures'];

function exact(value, keys) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value');
    });
}
function text(value, limit = 200) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
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
// Called only on the closed, bounded, shallow shapes validated below.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function providers(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every(item => exact(item, ['provider_id', 'revision']) && text(item.provider_id) && text(item.revision))
    && new Set(value.map(item => item.provider_id)).size === value.length;
}
function providerSet(value) { return [...value].sort((a, b) => a.provider_id < b.provider_id ? -1 : a.provider_id > b.provider_id ? 1 : 0); }
function purposeScope(value) {
  return exact(value, Object.keys(CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE))
    && Array.isArray(value.source_classes) && value.source_classes.length === 3
    && value.source_classes.every((entry, index) => entry === CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE.source_classes[index])
    && exact(value.source_classification, CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE.source_classes)
    && CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE.source_classes.every(key => value.source_classification[key] === CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE.source_classification[key])
    && Object.keys(CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE).filter(key => !['source_classes', 'source_classification'].includes(key))
      .every(key => value[key] === CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE[key]);
}
function purposeOf(value, effectiveDate) {
  if (!exact(value, [...Object.keys(CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE), 'selection_sha256', 'observation_period', 'knowledge_cutoff'])) return false;
  const scope = Object.fromEntries(Object.keys(CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE).map(key => [key, value[key]]));
  return purposeScope(scope) && typeof value.selection_sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.selection_sha256)
    && exact(value.observation_period, ['start_date', 'end_date'])
    && date(value.observation_period.start_date) && date(value.observation_period.end_date)
    && value.observation_period.start_date <= value.observation_period.end_date
    && value.observation_period.end_date <= effectiveDate && value.knowledge_cutoff === null;
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
    && dataset.id === CUSTOM_NEIGHBORHOOD_SOURCE_DATASET && dataset.revision === expected.datasetRevision
    && dataset.coverage === 'entire_integrated_source_mix_including_prior_merged_values'
    && providers(dataset.provider_revisions)
    && canonical(providerSet(dataset.provider_revisions)) === canonical(expected.providerRevisions);
}

/** Server composition only. The caller already owns assignment authorization,
 * transaction isolation/deadline/cancellation and this bounded client. Revisions
 * identify the independently approved ENTIRE source mix, not per-field rights.
 * Neither this factory nor a CSV hash can establish that approval or enforce
 * ingestion provenance. No connection lifecycle, writes, caching or role grant.
 */
export function createCustomNeighborhoodSourcePolicy(options) {
  if (!exact(options, ['datasetRevision', 'providerRevisions']) || !text(options.datasetRevision)
    || !providers(options.providerRevisions)) throw new TypeError('custom_neighborhood_source_policy_profile_required');
  // Never retain mutable caller configuration across asynchronous policy checks.
  const expected = { datasetRevision: options.datasetRevision,
    providerRevisions: providerSet(options.providerRevisions.map(item => ({ ...item }))) };
  return async function authorizeMarketData(client, auth, context, purpose, requested) {
    const organizationId = context?.scope?.organization_id;
    if (typeof client?.query !== 'function' || !text(auth?.userId) || typeof organizationId !== 'string'
      || !UUID.test(organizationId) || context?.target?.workflow_type !== 'custom_appraisal'
      || !date(context?.effective_date) || !purposeOf(purpose, context.effective_date)
      || !exact(requested, ['retention', 'exposure']) || requested.retention !== true
      || !EXPOSURES.includes(requested.exposure)) return DENIED;
    // Read only this namespace, bound on the server before transfer. DB wall time
    // (not transaction-start now()) makes expiry effective during long captures.
    let result;
    try {
      result = await client.query(`/* custom-neighborhood-source-policy:organization */
        SELECT id::text AS organization_id, active,
          CASE WHEN octet_length((metadata -> $2::text)::text) <= $3::integer
            THEN metadata -> $2::text ELSE NULL END AS source_rights,
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS checked_at
        FROM app_auth.organizations WHERE id = $1::uuid`,
      [organizationId, CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY, MAX_POLICY_BYTES]);
    } catch {
      // Driver errors can contain connection strings or query parameters.
      throw Object.assign(new Error('custom_neighborhood_source_policy_unavailable'), { code: 'CUSTOM_NEIGHBORHOOD_SOURCE_POLICY_UNAVAILABLE' });
    }
    if (!Array.isArray(result?.rows) || result.rows.length !== 1) return DENIED;
    const row = result.rows[0], config = row.source_rights;
    if (row.organization_id !== organizationId || row.active !== true
      || !configOf(config, organizationId, expected, row.checked_at)) return DENIED;
    const serialized = canonical(config);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_POLICY_BYTES || config.exposures[requested.exposure] !== true) return DENIED;
    const digest = createHash('sha256').update(serialized).digest('hex');
    // Stable across selections and permitted exposures so exact retained replay
    // is possible; ANY accepted config change changes the policy revision.
    return Object.freeze({ allowed: true, decision_id: `${organizationId}:${config.grant_id}`,
      policy_revision: `custom-neighborhood-source-rights-v1:sha256:${digest}` });
  };
}
