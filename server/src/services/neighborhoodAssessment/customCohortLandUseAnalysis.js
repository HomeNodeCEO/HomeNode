import { classifyBuiltUpBand } from '../neighborhoodLandUse.js';
import { runNeighborhoodProfileOperation, isNeighborhoodProfileBusyError } from '../neighborhoodProfileExecution.js';

export const EXPLORATION_LAND_USE_VERSION = 'selected-parcels-edge-neighbors-v1';
const CATEGORIES = ['one_unit', 'two_to_four_unit', 'multifamily', 'commercial', 'other_vacant'];
const MAX_PARCELS = 100_000;
const fail = reason => { throw Object.assign(new Error(reason), { reason }); };
const number = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value);

// Rook adjacency: a shared edge, not merely a corner, proximity, or recursive
// flood-fill. The && predicate uses the installed GiST geometry index before
// DE-9IM evaluation. Membership comes only from the authorized retained roster.
export const EXPLORATION_LAND_USE_SQL = `
  WITH selected AS MATERIALIZED (
    SELECT parcel.* FROM gis.dcad_parcels parcel
    WHERE parcel.account_id = ANY($1::text[]) AND parcel.use_code IS DISTINCT FROM '3'
      AND parcel.geom IS NOT NULL AND ST_IsValid(parcel.geom) AND NOT ST_IsEmpty(parcel.geom)
    ORDER BY parcel.object_id LIMIT $2
  ), neighbors AS MATERIALIZED (
    SELECT parcel.* FROM gis.dcad_parcels parcel
    WHERE parcel.object_id IN (
      SELECT neighbor.object_id FROM selected
      JOIN gis.dcad_parcels neighbor ON neighbor.geom && selected.geom
        AND CASE WHEN neighbor.use_code IS DISTINCT FROM '3' AND ST_IsValid(neighbor.geom)
          THEN ST_Relate(neighbor.geom, selected.geom, 'F***1****') ELSE false END
      WHERE (SELECT COUNT(*) FROM selected) < $2
    ) AND parcel.use_code IS DISTINCT FROM '3' AND parcel.geom IS NOT NULL
      AND ST_IsValid(parcel.geom) AND NOT ST_IsEmpty(parcel.geom)
      AND NOT EXISTS (SELECT 1 FROM selected WHERE selected.object_id = parcel.object_id)
    ORDER BY parcel.object_id LIMIT $2
  ), population AS MATERIALIZED (
    SELECT *, false AS neighbor FROM selected UNION ALL SELECT *, true FROM neighbors
  ), measured AS MATERIALIZED (
    SELECT * FROM population WHERE (SELECT COUNT(*) FROM population) < $2
  ), areas AS (
    SELECT land_use_category AS category, COUNT(*)::integer AS parcel_count,
      COUNT(*) FILTER (WHERE neighbor)::integer AS neighbor_count,
      COUNT(*) FILTER (WHERE classification_review_reason IS NOT NULL OR classification_confidence IS DISTINCT FROM 'high')::integer AS review_count,
      ST_Area(ST_UnaryUnion(ST_Collect(geom))::geography) AS area_sqm
    FROM measured GROUP BY land_use_category
  )
  SELECT (SELECT COUNT(*) FROM selected)::integer AS selected_parcel_count,
    (SELECT COUNT(DISTINCT account_id) FROM selected)::integer AS selected_mapped_account_count,
    (SELECT COUNT(*) FROM neighbors)::integer AS neighbor_parcel_count,
    (SELECT COUNT(*) FROM population)::integer AS parcel_count,
    (SELECT ST_Area(ST_UnaryUnion(ST_Collect(geom))::geography) FROM measured) AS area_sqm,
    (SELECT ST_Area(ST_UnaryUnion(ST_Collect(geom))::geography) FROM measured WHERE built_up) AS built_up_sqm,
    (SELECT MAX(source_updated_at)::text FROM population) AS source_updated_at,
    COALESCE((SELECT JSONB_AGG(TO_JSONB(areas) ORDER BY category) FROM areas), '[]'::jsonb) AS categories
`;

export async function buildExplorationLandUse(pool, accountIds) {
  if (!Array.isArray(accountIds) || !accountIds.length || accountIds.length > 50_000) fail('invalid_selection');
  // One read-only snapshot and a server-side deadline; a cancelled browser must
  // not leave an unbounded geometry calculation holding the shared pool.
  const client = await pool.connect();
  let rows;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='50000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
    ({ rows } = await client.query(EXPLORATION_LAND_USE_SQL, [accountIds, MAX_PARCELS + 1]));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {}); throw error;
  } finally { client.release(); }
  const row = rows[0];
  if (!row || !Number(row.selected_parcel_count) || !(number(row.area_sqm) > 0)) fail('source_incomplete');
  if (Number(row.parcel_count) > MAX_PARCELS) fail('source_incomplete');
  const areas = Array.isArray(row.categories) ? row.categories : [];
  const total = number(row.area_sqm);
  const categoryTotal = areas.reduce((sum, item) => sum + (number(item.area_sqm) || 0), 0);
  // Separate overlapping categories cannot support additive percentages. Do
  // not normalize away that ambiguity or fill unknown uses into "Other".
  if (Math.abs(categoryTotal - total) > Math.max(1, total * 0.001)) fail('source_incomplete');
  const percent = area => Math.round((Number(area || 0) / total) * 10000) / 100;
  const missing = accountIds.length - Number(row.selected_mapped_account_count);
  const unknownArea = areas.filter(item => !CATEGORIES.includes(item.category)).reduce((sum, item) => sum + Number(item.area_sqm || 0), 0);
  const reviewCount = areas.reduce((sum, item) => sum + Number(item.review_count || 0), 0);
  return { methodology_version: EXPLORATION_LAND_USE_VERSION, analyzed_at: new Date().toISOString(),
    source: 'stored_dcad_parcels', source_updated_at: row.source_updated_at,
    selected_parcel_count: Number(row.selected_parcel_count), neighbor_parcel_count: Number(row.neighbor_parcel_count),
    parcel_count: Number(row.parcel_count), missing_selected_accounts: Math.max(0, missing), review_required_count: reviewCount,
    area_acres: Math.round(total / 4046.8564224 * 100) / 100,
    built_up_percent: percent(row.built_up_sqm), built_up_band: classifyBuiltUpBand(percent(row.built_up_sqm)).key,
    unknown_percent: percent(unknownArea),
    categories: CATEGORIES.map(key => { const category = areas.find(item => item.category === key);
      return { key, percent: percent(category?.area_sqm), parcel_count: Number(category?.parcel_count || 0) }; }),
    denominator_note: 'Percentages use dissolved parcel acreage: selected parcels plus one ring of edge-sharing neighbors. Roads and non-parcel gaps are excluded. Sale studies retain their original selected membership.',
    warnings: [...(missing > 0 ? [`${missing} selected accounts have no valid stored land parcel.`] : []),
      ...(unknownArea > 0 ? ['Some parcel land use is unclassified; it is not relabeled as Other.'] : []),
      ...(reviewCount > 0 ? ['Some stored CAD land-use classifications require review.'] : []),
      'Current stored CAD land use is not verified historical land use.'],
  };
}

export function createCustomCohortLandUseAnalysis({ pool, cohortService, build = buildExplorationLandUse, run = runNeighborhoodProfileOperation }) {
  return async (identity, body, options) => {
    if (typeof body.selection_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.selection_sha256)) fail('invalid_input');
    const input = { ...identity, contextRef: body.context_ref, selection: body.selection };
    const checked = await cohortService.authorizeMarketSelection(input, options);
    if (checked.binding?.selection_sha256 !== body.selection_sha256) fail('operation_conflict');
    if (options.signal.aborted) fail('cancelled');
    try {
      const result = await run(JSON.stringify({ operation: EXPLORATION_LAND_USE_VERSION, target: checked.target, binding: checked.binding }),
        () => build(pool, checked.accountIds));
      if (options.signal.aborted) fail('cancelled');
      const latest = await cohortService.authorizeMarketSelection(input, options);
      const same = latest.binding && ['selection_revision', 'selection_sha256'].every(key => latest.binding[key] === checked.binding[key])
        && ['context_id', 'context_revision', 'context_sha256'].every(key => latest.binding.context_ref?.[key] === checked.binding.context_ref?.[key]);
      if (!same) fail('operation_conflict');
      return { ...result, exploration_binding: checked.binding };
    } catch (error) {
      if (isNeighborhoodProfileBusyError(error.message)) error.code = 'custom_cohort_execution_busy';
      throw error;
    }
  };
}
