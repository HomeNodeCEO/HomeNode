import { scoreNeighborhoodSecondarySimilarity } from './neighborhoodSecondarySimilarity.js';
import { customCohortCurrentStockSupport } from './customCohortTemporalSupport.js';

const MAX_PARCELS = 100_000;
const SECONDARY_FIELDS = ['bedroom_count', 'bath_count', 'garage_area_sqft', 'outbuilding_area_sqft', 'pool'];
const SOURCE = 'prepared_current_cad_snapshot_diagnostic_only';

/** Read only facts for exact CAD parcel revisions already retained by this
 * authorized capture. A newer prepared generation cannot be borrowed by an
 * older capture, and multiple/missing parcel revisions make an account unknown.
 * Improvement observations describe the prepared snapshot, not a historical
 * effective date or a verified condition at sale.
 */
export async function readCustomCohortPreparedSecondaryFacts(query, retainedInputs) {
  const captureAt = retainedInputs?.acquisition?.capture_result?.captured_at;
  if (customCohortCurrentStockSupport({ effective_date: retainedInputs?.subject?.effective_date,
    retained_capture_at: captureAt }).status === 'historical_stock_evidence_required') return null;
  const capture = retainedInputs.acquisition.capture_result.source_capture;
  const roster = new Set(retainedInputs.spatial.account_ids);
  const retained = new Map(), expected = new Map();
  for (const source of capture.sources) {
    if (source.payload?.projection?.definition?.role !== 'parcels') continue;
    for (const record of source.payload.records) {
      const raw = record.data?.raw_projection;
      const objectId = String(raw?.object_id ?? '');
      const accountId = raw?.account_id;
      if (!/^\d+$/.test(objectId) || typeof accountId !== 'string' || !roster.has(accountId)
        || typeof raw?.source_record_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.source_record_hash)
        || retained.has(objectId)) return null;
      retained.set(objectId, { accountId, hash: raw.source_record_hash });
      expected.set(accountId, (expected.get(accountId) ?? 0) + 1);
      if (retained.size > MAX_PARCELS) return null;
    }
  }
  if (!retained.size) return null;
  const result = await query(`/* custom-cohort:prepared-secondary-map */
    SELECT fact.object_id::text AS object_id, fact.account_id,
      fact.source_record_hash, fact.bedroom_count, fact.bath_count,
      fact.garage_area_sqft, fact.outbuilding_area_sqft, fact.pool,
      generation.generation_id, generation.source_observed_at
    FROM app.neighborhood_group_active active
    JOIN app.neighborhood_group_generations generation ON generation.generation_id=active.generation_id
      AND generation.status='complete' AND generation.source_observed_at <= $2::timestamptz
    JOIN app.neighborhood_group_parcel_facts fact ON fact.generation_id=active.generation_id
    WHERE active.id=true AND fact.object_id=ANY($1::bigint[])`, [[...retained.keys()], captureAt]);
  const rows = result.rows ?? [];
  const matched = new Map();
  for (const row of rows) {
    const original = retained.get(String(row.object_id));
    if (!original || row.account_id !== original.accountId || row.source_record_hash !== original.hash) continue;
    if (!matched.has(row.account_id)) matched.set(row.account_id, []);
    matched.get(row.account_id).push(row);
  }
  const accounts = new Map();
  for (const [id, parcels] of matched) {
    if (parcels.length !== expected.get(id)) continue;
    const facts = Object.fromEntries(SECONDARY_FIELDS.map(key => {
      const values = parcels.map(row => row[key]);
      const first = values[0];
      return [key, first === null || first === undefined || values.some(value => String(value) !== String(first))
        ? null : first];
    }));
    accounts.set(id, facts);
  }
  const first = rows[0];
  if (!first) return null;
  return { generation_id: first.generation_id,
    source_observed_at: new Date(first.source_observed_at).toISOString(),
    retained_capture_at: captureAt, accounts };
}

const rounded = value => Math.round(value * 10000) / 10000;

/** Optional map-color support only. Keep the established six-factor ranking,
 * suggestions, selected statistics and report-Apply payload byte-for-byte.
 * Each group's mean is formed from its actual member scores, never from a
 * median of precomputed subdivision medians or an unbound current lookup.
 */
export function buildCustomCohortPreparedSecondaryMap(recommendation, facts) {
  if (!facts || !facts.accounts?.has(recommendation.subject.account_id)) return null;
  const subject = facts.accounts.get(recommendation.subject.account_id);
  const byGroup = new Map();
  for (const property of recommendation.properties) {
    const candidate = facts.accounts.get(property.account_id) ?? {};
    const lower = scoreNeighborhoodSecondarySimilarity({ baseScore: property.similarity.lower, subject, candidate });
    const upper = scoreNeighborhoodSecondarySimilarity({ baseScore: property.similarity.upper, subject, candidate });
    const id = property.recorded_group_id;
    if (!byGroup.has(id)) byGroup.set(id, []);
    byGroup.get(id).push({ lower: lower.score, upper: upper.score,
      supported: lower.available_weight_percent > 0 });
  }
  const groups = recommendation.pockets.map(pocket => {
    const members = byGroup.get(pocket.id) ?? [];
    const supported = members.filter(member => member.supported).length;
    return { id: pocket.id, member_count: members.length, supported_member_count: supported,
      lower: !supported ? pocket.result.similarity.lower
        : rounded(members.reduce((sum, row) => sum + row.lower, 0) / members.length),
      upper: !supported ? pocket.result.similarity.upper
        : rounded(members.reduce((sum, row) => sum + row.upper, 0) / members.length) };
  });
  if (!groups.some(group => group.supported_member_count)) return null;
  return { version: 1, basis: SOURCE, authority: 'not_established',
    generation_id: facts.generation_id, source_observed_at: facts.source_observed_at,
    retained_capture_at: facts.retained_capture_at, groups };
}
