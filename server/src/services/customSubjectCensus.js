const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = value => boundedText(value, 64)
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

/** Census initialization is optional at startup. Checking the relation before
 * composing the main snapshot keeps an unavailable lookup from breaking document
 * review/export (and avoids an undefined-table error aborting its transaction).
 * The lookup itself still participates in the main statement's snapshot.
 */
export async function customSubjectCensusSql(client) {
  const { rows } = await client.query("SELECT to_regclass('core.account_census_geographies') IS NOT NULL AS census_available");
  if (rows[0]?.census_available !== true) return { join: '', value: 'NULL' };
  return {
    join: 'LEFT JOIN core.account_census_geographies subject_census ON subject_census.account_id = subject.account_id',
    value: `CASE WHEN subject_census.account_id IS NULL THEN NULL ELSE jsonb_build_object(
      'tractCode', subject_census.tract_code, 'status', subject_census.status,
      'geoid', subject_census.tract_geoid, 'vintage', subject_census.vintage,
      'updatedAt', subject_census.updated_at) END`,
  };
}

/** Propose, never write: the caller supplies the canonical account's persisted
 * Census lookup after authorization and uses the normal Subject merge. That
 * merge preserves explicit manual blanks and makes unavailable receipts stale.
 * This is account reference data, not a fact printed in a reviewed PDF, and is
 * intentionally not an export-time fallback for a missing saved Subject leaf.
 */
export function buildCustomSubjectCensus(subjectContext) {
  const unavailable = () => ({ field: null, warnings: ['Census tract: a matched account lookup is unavailable or needs review.'] });
  if (!record(subjectContext) || !boundedText(subjectContext.accountId, 32)) return unavailable();
  const census = subjectContext.censusGeography;
  if (!record(census) || census.status !== 'matched'
    || typeof census.tractCode !== 'string' || !/^\d{6}$/.test(census.tractCode) || census.tractCode === '000000'
    || typeof census.geoid !== 'string' || !/^\d{11}$/.test(census.geoid) || !census.geoid.endsWith(census.tractCode)
    || !boundedText(census.vintage, 128) || !timestamp(census.updatedAt)) return unavailable();

  const whole = Number.parseInt(census.tractCode.slice(0, 4), 10);
  const value = `${whole}.${census.tractCode.slice(4)}`;
  const sourceEvidence = [{ sourceTable: 'core.account_census_geographies', accountId: subjectContext.accountId,
    tractCode: census.tractCode, status: census.status, geoid: census.geoid, vintage: census.vintage, updatedAt: census.updatedAt }];
  return { field: { key: 'census_tract', value,
    provenance: { kind: 'account_reference', sourceField: 'census_tract',
      documentId: null, candidateId: null, documentType: null,
      rule: 'matched_account_census_tract_v1', sourceValue: census.tractCode, sourceEvidence },
    sourceValue: census.tractCode }, warnings: [] };
}
