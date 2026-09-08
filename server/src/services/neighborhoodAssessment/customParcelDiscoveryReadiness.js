// Maintenance-only: pass a caller-owned, pinned PostgreSQL connection.
// No schema creation, repairs, geography casts of parcel data, or transaction control.
const CATALOG_SQL = `
WITH parcels AS (
  SELECT oid, relkind FROM pg_catalog.pg_class
  WHERE oid = pg_catalog.to_regclass('gis.dcad_parcels')
), runs AS (
  SELECT oid, relkind FROM pg_catalog.pg_class
  WHERE oid = pg_catalog.to_regclass('gis.source_sync_runs')
), geometry_type AS (
  SELECT t.oid FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_depend d ON d.objid = t.oid
    AND d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND d.deptype = 'e'
  JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
    AND d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
  WHERE e.extname = 'postgis' AND t.typname = 'geometry'
)
SELECT
  (SELECT oid::text FROM parcels) AS table_oid,
  (SELECT relkind::text FROM parcels) AS table_kind,
  COALESCE((SELECT pg_catalog.row_security_active(oid) FROM parcels), false) AS parcel_rls_active,
  (SELECT oid::text FROM runs) AS sync_table_oid,
  (SELECT relkind::text FROM runs) AS sync_table_kind,
  COALESCE((SELECT pg_catalog.row_security_active(oid) FROM runs), false) AS sync_rls_active,
  EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN parcels p ON p.oid = a.attrelid
    WHERE a.attname = 'geom' AND a.attnum > 0 AND NOT a.attisdropped
      AND a.atttypid IN (SELECT oid FROM geometry_type)) AS geom_ok,
  EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN parcels p ON p.oid = a.attrelid
    WHERE a.attname = 'account_id' AND a.attnum > 0 AND NOT a.attisdropped
      AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype) AS account_id_ok,
  EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN parcels p ON p.oid = a.attrelid
    WHERE a.attname = 'source_record_hash' AND a.attnum > 0 AND NOT a.attisdropped
      AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype) AS source_record_hash_ok,
  EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN parcels p ON p.oid = a.attrelid
    WHERE a.attname = 'sync_run_id' AND a.attnum > 0 AND NOT a.attisdropped
      AND a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype) AS sync_run_id_ok,
  EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN runs r ON r.oid = a.attrelid
    WHERE a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped
      AND a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype) AS sync_id_ok
`;

const COUNTS_SQL = `
SELECT
  'gis.dcad_parcels'::pg_catalog.regclass::oid::text AS table_oid,
  'gis.source_sync_runs'::pg_catalog.regclass::oid::text AS sync_table_oid,
  count(*)::text AS total_rows,
  count(*) FILTER (WHERE p.geom IS NULL)::text AS null_geometry,
  count(*) FILTER (WHERE ST_IsEmpty(p.geom))::text AS empty_geometry,
  count(*) FILTER (WHERE ST_IsValid(p.geom) IS FALSE)::text AS invalid_geometry,
  count(*) FILTER (WHERE p.geom IS NOT NULL AND ST_GeometryType(p.geom) <> 'ST_MultiPolygon')::text AS wrong_type,
  count(*) FILTER (WHERE p.geom IS NOT NULL AND ST_SRID(p.geom) <> 4326)::text AS wrong_srid,
  count(*) FILTER (WHERE coordinates.nonfinite)::text AS nonfinite_geometry,
  count(*) FILTER (WHERE coordinates.outside_wgs84)::text AS outside_wgs84_geometry,
  count(*) FILTER (WHERE p.account_id IS NULL OR p.account_id !~ '[^[:space:]]')::text AS unlinked_or_blank_accounts,
  count(*) FILTER (WHERE p.source_record_hash IS NULL OR p.source_record_hash !~ '[^[:space:]]')::text AS absent_source_hashes,
  count(*) FILTER (WHERE p.sync_run_id IS NULL)::text AS null_sync_run_links,
  count(*) FILTER (WHERE p.sync_run_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM gis.source_sync_runs r WHERE r.id = p.sync_run_id))::text AS dangling_sync_run_links,
  count(*) FILTER (WHERE p.sync_run_id IS NULL OR NOT EXISTS
    (SELECT 1 FROM gis.source_sync_runs r WHERE r.id = p.sync_run_id))::text AS absent_sync_run_linkage
FROM gis.dcad_parcels p
CROSS JOIN LATERAL (
  SELECT
    COALESCE(bool_or(
      ST_X(dp.geom) IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
      OR ST_Y(dp.geom) IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
      OR ST_Z(dp.geom) IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
      OR ST_M(dp.geom) IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
    ), false) AS nonfinite,
    COALESCE(bool_or(
      (ST_X(dp.geom) NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
        AND (ST_X(dp.geom) < -180 OR ST_X(dp.geom) > 180))
      OR (ST_Y(dp.geom) NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
        AND (ST_Y(dp.geom) < -90 OR ST_Y(dp.geom) > 90))
    ), false) AS outside_wgs84
  FROM ST_DumpPoints(p.geom) dp
) coordinates
`;

const INDEXES_SQL = `
WITH geography_type AS (
  SELECT t.oid, n.nspname FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_catalog.pg_depend d ON d.objid = t.oid
    AND d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND d.deptype = 'e'
  JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
    AND d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
  WHERE e.extname = 'postgis' AND t.typname = 'geography'
), facts AS (
  SELECT i.indexrelid AS oid, n.nspname AS schema_name, c.relname AS index_name,
    am.amname AS method, i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live,
    i.indpred IS NOT NULL AS partial, i.indnkeyatts AS key_count, i.indnatts AS attribute_count,
    i.indkey::text = '0' AS single_expression_key,
    pg_catalog.pg_get_expr(i.indexprs, i.indrelid, false) AS expression,
    pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_opclass op JOIN geography_type g ON op.opcintype = g.oid
      JOIN pg_catalog.pg_depend d ON d.objid = op.oid
        AND d.classid = 'pg_catalog.pg_opclass'::pg_catalog.regclass AND d.deptype = 'e'
      JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
        AND d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      WHERE op.oid = i.indclass[0] AND op.opcmethod = am.oid
        AND op.opcname = 'gist_geography_ops' AND e.extname = 'postgis'
    ) AS geography_operator_class,
    EXISTS (
      SELECT 1 FROM geography_type g WHERE pg_catalog.pg_get_expr(i.indexprs, i.indrelid, false)
        IN ('(geom)::geography', '(geom)::' || pg_catalog.quote_ident(g.nspname) || '.geography')
    ) AS exact_expression_match
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_am am ON am.oid = c.relam
  WHERE i.indrelid = pg_catalog.to_regclass('gis.dcad_parcels')
), ranked AS (
  SELECT *, valid AND ready AND live AND NOT partial AND method = 'gist'
    AND key_count = 1 AND attribute_count = 1 AND single_expression_key
    AND geography_operator_class AND exact_expression_match AS qualifies
  FROM facts
), bounded AS (
  SELECT * FROM ranked ORDER BY qualifies DESC, oid LIMIT 32
)
SELECT pg_catalog.to_regclass('gis.dcad_parcels')::oid::text AS table_oid,
  (SELECT count(*)::text FROM facts) AS total_indexes,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'schema', schema_name, 'name', index_name, 'method', method,
    'valid', valid, 'ready', ready, 'live', live, 'partial', partial,
    'keyCount', key_count, 'attributeCount', attribute_count,
    'singleExpressionKey', single_expression_key,
    'geographyOperatorClass', geography_operator_class,
    'exactExpressionMatch', exact_expression_match,
    'expression', left(expression, 1024), 'definition', left(definition, 2048),
    'expressionTruncated', COALESCE(length(expression) > 1024, false),
    'definitionTruncated', length(definition) > 2048
  ) ORDER BY qualifies DESC, oid) FROM bounded), '[]'::jsonb) AS indexes
`;

const COUNT_NAMES = [
  'total_rows', 'null_geometry', 'empty_geometry', 'invalid_geometry', 'wrong_type',
  'wrong_srid', 'nonfinite_geometry', 'outside_wgs84_geometry', 'unlinked_or_blank_accounts',
  'absent_source_hashes', 'null_sync_run_links', 'dangling_sync_run_links', 'absent_sync_run_linkage',
];
const SCHEMA_FLAGS = [
  'parcel_rls_active', 'sync_rls_active', 'geom_ok', 'account_id_ok',
  'source_record_hash_ok', 'sync_run_id_ok', 'sync_id_ok',
];
const INDEX_FLAGS = [
  'valid', 'ready', 'live', 'partial', 'singleExpressionKey', 'geographyOperatorClass',
  'exactExpressionMatch', 'expressionTruncated', 'definitionTruncated',
];
const REMAINING_PREREQUISITES = Object.freeze([
  'Native PostgreSQL/PostGIS verification of the audit and exact-distance query.',
  'Authoritative source geographic/provider inventory coverage and source-origin admission.',
  'Validated subject-point origin, real whole-parcel producer, and authorized issuer integration.',
]);

function malformed(stage) {
  return new TypeError(`Malformed Custom parcel readiness ${stage} result`);
}

function singleRow(result, stage) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1
    || !result.rows[0] || typeof result.rows[0] !== 'object' || Array.isArray(result.rows[0])) {
    throw malformed(stage);
  }
  return result.rows[0];
}

function exactCount(value, stage) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)
    || BigInt(value) > 9223372036854775807n) throw malformed(stage);
  return value;
}

function oid(value, stage, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value)
    || BigInt(value) > 4294967295n) throw malformed(stage);
  return value;
}

function boolean(value, stage) {
  if (typeof value !== 'boolean') throw malformed(stage);
  return value;
}

function boundedText(value, limit, stage, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || [...value].length > limit) throw malformed(stage);
  return value;
}

function parseIndex(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw malformed('index');
  const fact = {};
  for (const name of ['schema', 'name', 'method']) fact[name] = boundedText(row[name], 63, 'index');
  for (const name of INDEX_FLAGS) fact[name] = boolean(row[name], 'index');
  for (const name of ['keyCount', 'attributeCount']) {
    if (!Number.isInteger(row[name]) || row[name] < 1 || row[name] > 32767) throw malformed('index');
    fact[name] = row[name];
  }
  fact.expression = boundedText(row.expression, 1024, 'index', true);
  fact.definition = boundedText(row.definition, 2048, 'index');
  // The SQL comparison is deliberately narrow; unknown expression forms do not qualify.
  fact.exactIndexEstablished = fact.valid && fact.ready && fact.live && !fact.partial
    && fact.method === 'gist' && fact.keyCount === 1 && fact.attributeCount === 1
    && fact.singleExpressionKey && fact.geographyOperatorClass && fact.exactExpressionMatch
    && !fact.expressionTruncated && fact.expression !== null;
  return fact;
}

/**
 * Read-only aggregate audit; callers own connection lifetime, snapshot/locks and permissions.
 * The caller must use a trusted PostGIS search_path and stable maintenance snapshot.
 * Errors propagate unchanged. This function confers no permission to activate discovery.
 */
export async function auditCustomParcelDiscoveryReadiness(connection) {
  if (!connection || typeof connection.query !== 'function') {
    throw new TypeError('A caller-owned maintenance connection with query() is required');
  }
  const catalog = singleRow(await connection.query(CATALOG_SQL), 'catalog');
  const schema = {
    table_oid: oid(catalog.table_oid, 'catalog', true),
    table_kind: boundedText(catalog.table_kind, 1, 'catalog', true),
    sync_table_oid: oid(catalog.sync_table_oid, 'catalog', true),
    sync_table_kind: boundedText(catalog.sync_table_kind, 1, 'catalog', true),
  };
  for (const name of SCHEMA_FLAGS) schema[name] = boolean(catalog[name], 'catalog');
  if ((schema.table_oid === null) !== (schema.table_kind === null)
    || (schema.sync_table_oid === null) !== (schema.sync_table_kind === null)) throw malformed('catalog');
  const blockers = [];
  if (!schema.table_oid) blockers.push('missing_parcel_table');
  else if (!['r', 'p'].includes(schema.table_kind)) blockers.push('parcel_relation_is_not_a_table');
  if (!schema.sync_table_oid) blockers.push('missing_sync_run_table');
  else if (!['r', 'p'].includes(schema.sync_table_kind)) blockers.push('sync_relation_is_not_a_table');
  for (const name of SCHEMA_FLAGS) {
    if (name.endsWith('_ok') && !schema[name]) blockers.push(`missing_or_wrong_type_${name.slice(0, -3)}`);
    if (name.endsWith('_active') && schema[name]) blockers.push(name);
  }
  const report = {
    status: 'incomplete', auditComplete: false, cachePrerequisitesSatisfied: false,
    productionReady: false, schema, counts: null, totalIndexes: null, indexes: [],
    indexMetadataTruncated: false, exactGeographyIndexEstablished: false,
    coverage: {
      status: 'not_established',
      scope: 'Only cached geometry, account identifiers, hash presence and existing sync-run linkage are checked; these do not establish authoritative inventory coverage.',
    },
    blockers, remainingPrerequisites: [...REMAINING_PREREQUISITES],
  };
  // A missing dependency is unknown, not a zero-defect audit.
  if (blockers.length) return report;

  const rawCounts = singleRow(await connection.query(COUNTS_SQL), 'counts');
  if (oid(rawCounts.table_oid, 'counts') !== schema.table_oid
    || oid(rawCounts.sync_table_oid, 'counts') !== schema.sync_table_oid) throw malformed('changed relation');
  const counts = Object.fromEntries(COUNT_NAMES.map(name => [name, exactCount(rawCounts[name], 'counts')]));
  const total = BigInt(counts.total_rows);
  if (COUNT_NAMES.some(name => BigInt(counts[name]) > total)
    || BigInt(counts.null_sync_run_links) + BigInt(counts.dangling_sync_run_links)
      !== BigInt(counts.absent_sync_run_linkage)) throw malformed('inconsistent counts');
  report.counts = counts;

  const rawIndexes = singleRow(await connection.query(INDEXES_SQL), 'indexes');
  if (oid(rawIndexes.table_oid, 'indexes') !== schema.table_oid) throw malformed('changed relation');
  report.totalIndexes = exactCount(rawIndexes.total_indexes, 'indexes');
  const indexTotal = BigInt(report.totalIndexes);
  if (!Array.isArray(rawIndexes.indexes) || rawIndexes.indexes.length > 32
    || BigInt(rawIndexes.indexes.length) !== (indexTotal < 32n ? indexTotal : 32n)) throw malformed('indexes');
  report.indexes = rawIndexes.indexes.map(parseIndex);
  report.indexMetadataTruncated = indexTotal > 32n
    || report.indexes.some(index => index.definitionTruncated || index.expressionTruncated);
  report.exactGeographyIndexEstablished = report.indexes.some(index => index.exactIndexEstablished);
  if (total === 0n) blockers.push('empty_parcel_table');
  for (const name of COUNT_NAMES.slice(1)) if (counts[name] !== '0') blockers.push(name);
  if (!report.exactGeographyIndexEstablished) blockers.push('exact_geography_index_not_established');
  report.auditComplete = true;
  report.cachePrerequisitesSatisfied = blockers.length === 0;
  report.status = report.cachePrerequisitesSatisfied ? 'cache_prerequisites_satisfied' : 'blocked';
  return report;
}
