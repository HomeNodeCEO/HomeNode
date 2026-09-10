import { types } from 'node:util';

// Operator-only inventory. Nothing in this module decides deletion eligibility.
const DEPENDENCIES = Object.freeze([
  'core.sales', 'core.sale_parcels', 'core.sales_source_media',
  'app.sale_characteristic_reviews', 'app.sale_characteristic_review_history',
  'app.sales_reconciliation_history', 'app.sales_auto_reconciliation_history',
  'app.county_account_identifiers', 'app.trestle_media_queue',
]);
const HOLD_TABLES = Object.freeze(['app.report_file_archives', 'app.inspection_photos']);
const DEFINITIONS = Object.freeze([
  { relation: 'core.sales', columns: { id: 'int8', source_record_id: 'int8', closing_date: 'date' }, identity: true },
  { relation: 'core.sales_source_records', columns: { id: 'int8', close_date: 'date', record_type: 'text' }, identity: true },
  ...DEPENDENCIES.slice(1).map((relation) => ({ relation, columns: { source_record_id: 'int8' }, identity: false })),
  ...HOLD_TABLES.map((relation) => ({ relation, columns: { legal_hold: 'bool', retention_until: 'timestamptz' }, identity: false })),
]);
const LANES = Object.freeze(['canonical_source_linked', 'canonical_legacy', 'source_only']);
const DISPOSITIONS = Object.freeze([
  'review_before_cutoff', 'not_before_cutoff', 'excluded_nonclosed',
  'excluded_missing_date', 'excluded_nonfinite_date', 'excluded_conflicting_date',
  'excluded_missing_source',
]);
const METADATA_LIMIT = 256;
const BIGINT_MAX = 9223372036854775807n;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function optionsOf(value) {
  const invalid = () => { throw failure('sales_retention_audit_invalid_options'); };
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = ['asOfDate', 'sampleLimit', 'statementTimeoutMs', 'lockTimeoutMs'];
  if (Reflect.ownKeys(descriptors).some((key) => !allowed.includes(key)
    || !Object.hasOwn(descriptors[key], 'value'))) invalid();
  const read = (key, fallback) => Object.hasOwn(descriptors, key) ? descriptors[key].value : fallback;
  const asOfDate = read('asOfDate');
  if (typeof asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) invalid();
  const [year, month, day] = asOfDate.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 6 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) invalid();
  const bounded = (key, fallback, minimum, maximum) => {
    const result = read(key, fallback);
    if (!Number.isSafeInteger(result) || result < minimum || result > maximum) invalid();
    return result;
  };
  return {
    asOfDate, cutoffDate: `${String(year - 5).padStart(4, '0')}-01-01`,
    sampleLimit: bounded('sampleLimit', 0, 0, 50),
    statementTimeoutMs: bounded('statementTimeoutMs', 5000, 1, 15000),
    lockTimeoutMs: bounded('lockTimeoutMs', 1000, 1, 3000),
  };
}

function count(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value)
    || BigInt(value) > BIGINT_MAX) throw failure('sales_retention_audit_invalid_result');
  return value;
}

function id(value) {
  if (typeof value !== 'string' || !/^(0|-?[1-9]\d{0,18})$/.test(value)
    || BigInt(value) < -9223372036854775808n || BigInt(value) > BIGINT_MAX) {
    throw failure('sales_retention_audit_invalid_result');
  }
  return value;
}

function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

// All requested relation/column names come from the fixed local definitions, not options.
const SCHEMA_SQL = `/* sales-retention:schema */
WITH wanted AS (
  SELECT * FROM pg_catalog.jsonb_to_recordset($1::jsonb)
    AS w(relation text, columns jsonb, identity boolean)
)
SELECT w.relation, c.oid IS NOT NULL AS installed,
  c.relkind = 'r' AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhparent = c.oid OR i.inhrelid = c.oid
  ) AS ordinary_table,
  CASE WHEN c.oid IS NOT NULL THEN pg_catalog.has_schema_privilege(n.oid, 'USAGE')
    AND pg_catalog.has_table_privilege(c.oid, 'SELECT') ELSE false END AS can_select,
  CASE WHEN c.oid IS NOT NULL THEN pg_catalog.row_security_active(c.oid) ELSE false END AS filtered,
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each_text(w.columns) expected
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = expected.key
      AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
    WHERE a.attnum IS NULL OR tn.nspname <> 'pg_catalog' OR t.typname <> expected.value
  ) AS columns_match,
  NOT w.identity OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_index ix
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id' AND a.attnotnull
    WHERE ix.indrelid = c.oid AND ix.indisunique AND ix.indisvalid AND ix.indisready
      AND ix.indnkeyatts = 1 AND ix.indkey[0] = a.attnum
      AND ix.indpred IS NULL AND ix.indexprs IS NULL
  ) AS identity_unique
FROM wanted w
LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = split_part(w.relation, '.', 1)
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = split_part(w.relation, '.', 2)
ORDER BY w.relation`;

const COHORT_CTE = `WITH classified AS MATERIALIZED (
  SELECT CASE WHEN s.source_record_id IS NULL THEN 'canonical_legacy'
    ELSE 'canonical_source_linked' END AS lane, s.id, s.source_record_id,
    CASE
      WHEN s.source_record_id IS NOT NULL AND r.id IS NULL THEN 'excluded_missing_source'
      WHEN s.source_record_id IS NOT NULL AND r.record_type IS DISTINCT FROM 'closed_sale' THEN 'excluded_nonclosed'
      WHEN s.closing_date IS NULL OR (s.source_record_id IS NOT NULL AND r.close_date IS NULL) THEN 'excluded_missing_date'
      WHEN NOT isfinite(s.closing_date) OR (s.source_record_id IS NOT NULL AND NOT isfinite(r.close_date)) THEN 'excluded_nonfinite_date'
      WHEN s.source_record_id IS NOT NULL AND s.closing_date <> r.close_date THEN 'excluded_conflicting_date'
      WHEN s.closing_date < $1::date THEN 'review_before_cutoff'
      ELSE 'not_before_cutoff'
    END AS disposition
  FROM core.sales s LEFT JOIN core.sales_source_records r ON r.id = s.source_record_id
  UNION ALL
  SELECT 'source_only', r.id, r.id,
    CASE WHEN r.record_type IS DISTINCT FROM 'closed_sale' THEN 'excluded_nonclosed'
      WHEN r.close_date IS NULL THEN 'excluded_missing_date'
      WHEN NOT isfinite(r.close_date) THEN 'excluded_nonfinite_date'
      WHEN r.close_date < $1::date THEN 'review_before_cutoff'
      ELSE 'not_before_cutoff' END
  FROM core.sales_source_records r
  WHERE NOT EXISTS (SELECT 1 FROM core.sales s WHERE s.source_record_id = r.id)
), review_sources AS (
  SELECT DISTINCT c.source_record_id FROM classified c
  WHERE c.disposition = 'review_before_cutoff' AND c.source_record_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM classified sibling
      WHERE sibling.source_record_id = c.source_record_id AND sibling.disposition <> 'review_before_cutoff')
)`;

const COHORT_SQL = `/* sales-retention:cohorts */ ${COHORT_CTE}
SELECT lane, disposition, count(*)::text AS row_count FROM classified GROUP BY lane, disposition
UNION ALL SELECT 'distinct_sources', 'review_before_cutoff', count(*)::text FROM review_sources`;
const SAMPLES_SQL = `/* sales-retention:samples */ ${COHORT_CTE}
SELECT lane, id::text, source_record_id::text FROM classified
WHERE disposition = 'review_before_cutoff' ORDER BY lane, classified.id LIMIT $2::integer`;

// Traverse actual inbound foreign keys, including unknown and transitive dependents.
// Their identifiers are inventory data only: they never become executable SQL.
const GRAPH_CTE = `WITH RECURSIVE affected(oid) AS (
  SELECT c.oid FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'core' AND c.relname IN ('sales', 'sales_source_records')
  UNION SELECT fk.conrelid FROM pg_catalog.pg_constraint fk
    JOIN affected a ON a.oid = fk.confrelid WHERE fk.contype = 'f'
)`;
const FOREIGN_KEYS_SQL = `/* sales-retention:foreign-keys */ ${GRAPH_CTE}
SELECT count(*) OVER ()::text AS total_count, fk.conname AS name,
  ns.nspname || '.' || c.relname AS relation, rn.nspname || '.' || rc.relname AS referenced_relation,
  fk.confdeltype AS delete_action, fk.convalidated AS validated,
  fk.condeferrable AS deferrable, fk.condeferred AS initially_deferred,
  CASE WHEN cardinality(fk.conkey) <= 16 THEN ARRAY(
    SELECT a.attname::text FROM unnest(fk.conkey) WITH ORDINALITY k(num, position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = fk.conrelid AND a.attnum = k.num ORDER BY k.position
  ) ELSE NULL END AS columns,
  CASE WHEN cardinality(fk.confkey) <= 16 THEN ARRAY(
    SELECT a.attname::text FROM unnest(fk.confkey) WITH ORDINALITY k(num, position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = fk.confrelid AND a.attnum = k.num ORDER BY k.position
  ) ELSE NULL END AS referenced_columns
FROM pg_catalog.pg_constraint fk JOIN affected a ON a.oid = fk.confrelid
JOIN pg_catalog.pg_class c ON c.oid = fk.conrelid JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
JOIN pg_catalog.pg_class rc ON rc.oid = fk.confrelid JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
WHERE fk.contype = 'f' ORDER BY ns.nspname, c.relname, fk.conname LIMIT $1::integer`;
const TRIGGERS_SQL = `/* sales-retention:triggers */ ${GRAPH_CTE}
SELECT count(*) OVER ()::text AS total_count, n.nspname || '.' || c.relname AS relation,
  t.tgname AS name, t.tgenabled AS enabled, t.tgtype::integer AS type_bits
FROM pg_catalog.pg_trigger t JOIN affected a ON a.oid = t.tgrelid
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal ORDER BY n.nspname, c.relname, t.tgname LIMIT $1::integer`;

function schemaInventory(rows) {
  if (!Array.isArray(rows) || rows.length !== DEFINITIONS.length) throw failure('sales_retention_audit_invalid_result');
  const byName = new Map();
  for (const row of rows) {
    if (!DEFINITIONS.some((d) => d.relation === row.relation) || byName.has(row.relation)
      || typeof row.installed !== 'boolean') throw failure('sales_retention_audit_invalid_result');
    let reason = null;
    if (!row.installed) reason = 'not_installed';
    else {
      for (const field of ['ordinary_table', 'can_select', 'filtered', 'columns_match', 'identity_unique']) {
        if (typeof row[field] !== 'boolean') throw failure('sales_retention_audit_invalid_result');
      }
      if (!row.ordinary_table) reason = 'unsupported_relation_kind_or_inheritance';
      else if (!row.can_select) reason = 'permission_denied';
      else if (row.filtered) reason = 'row_security_active';
      else if (!row.columns_match || !row.identity_unique) reason = 'incompatible_schema';
    }
    byName.set(row.relation, { relation: row.relation, status: reason ? 'unavailable' : 'available', reason });
  }
  return DEFINITIONS.map((d) => byName.get(d.relation));
}

function cohortsOf(rows) {
  const lanes = Object.fromEntries(LANES.map((lane) => [lane,
    Object.fromEntries(['total', ...DISPOSITIONS].map((key) => [key, '0']))]));
  let distinct = null;
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.lane}:${row.disposition}`;
    if (seen.has(key)) throw failure('sales_retention_audit_invalid_result');
    seen.add(key);
    const value = count(row.row_count);
    if (row.lane === 'distinct_sources' && row.disposition === 'review_before_cutoff') distinct = value;
    else {
      if (!LANES.includes(row.lane) || !DISPOSITIONS.includes(row.disposition)) throw failure('sales_retention_audit_invalid_result');
      lanes[row.lane][row.disposition] = value;
      lanes[row.lane].total = count(String(BigInt(lanes[row.lane].total) + BigInt(value)));
    }
  }
  if (distinct === null || BigInt(distinct) > BigInt(lanes.canonical_source_linked.review_before_cutoff)
    + BigInt(lanes.source_only.review_before_cutoff)) throw failure('sales_retention_audit_invalid_result');
  return { status: 'complete', lanes, distinct_review_source_records: distinct };
}

function metadataName(value, relation = false) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > (relation ? 127 : 63)) {
    throw failure('sales_retention_audit_invalid_result');
  }
  return value;
}

function metadataRows(rows, kind) {
  if (!Array.isArray(rows) || rows.length > METADATA_LIMIT + 1) throw failure('sales_retention_audit_invalid_result');
  const total = rows.length ? count(rows[0].total_count) : '0';
  if (BigInt(total) < BigInt(rows.length) || rows.some((row) => row.total_count !== total)
    || (BigInt(total) <= BigInt(METADATA_LIMIT) && BigInt(total) !== BigInt(rows.length))) {
    throw failure('sales_retention_audit_invalid_result');
  }
  const projected = rows.slice(0, METADATA_LIMIT).map((row) => {
    const base = { relation: metadataName(row.relation, true), name: metadataName(row.name) };
    if (kind === 'triggers') {
      if (!['O', 'D', 'R', 'A'].includes(row.enabled) || !Number.isSafeInteger(row.type_bits)
        || row.type_bits < 0 || row.type_bits > 32767) throw failure('sales_retention_audit_invalid_result');
      return { ...base, enabled: row.enabled, type_bits: row.type_bits };
    }
    const actions = { a: 'no_action', r: 'restrict', c: 'cascade', n: 'set_null', d: 'set_default' };
    if (!Object.hasOwn(actions, row.delete_action)
      || ['validated', 'deferrable', 'initially_deferred'].some((key) => typeof row[key] !== 'boolean')) {
      throw failure('sales_retention_audit_invalid_result');
    }
    const columns = (value) => {
      if (value === null) return null;
      if (!Array.isArray(value) || !value.length || value.length > 16) throw failure('sales_retention_audit_invalid_result');
      return value.map((name) => metadataName(name));
    };
    const result = { ...base, referenced_relation: metadataName(row.referenced_relation, true),
      columns: columns(row.columns), referenced_columns: columns(row.referenced_columns),
      delete_action: actions[row.delete_action], validated: row.validated,
      deferrable: row.deferrable, initially_deferred: row.initially_deferred };
    result.allowlisted_direct_source_dependency = DEPENDENCIES.includes(result.relation)
      && result.referenced_relation === 'core.sales_source_records'
      && JSON.stringify(result.columns) === '["source_record_id"]'
      && JSON.stringify(result.referenced_columns) === '["id"]';
    return result;
  });
  return { total_count: total, truncated: BigInt(total) > BigInt(METADATA_LIMIT), rows: projected };
}

/**
 * A bounded operator inventory on one owned RR/RO connection. Per-statement server
 * and driver timeouts do not configure the supplied pool's connection deadline.
 * Missing optional storage is an explicit gap; runtime query failures return no audit.
 */
export async function auditSalesRetention(pool, options) {
  const config = optionsOf(options);
  let client;
  let begun = false;
  let discarded = false;
  let result;
  let problem;
  const query = (text, values = []) => client.query({ text, values, query_timeout: config.statementTimeoutMs + 1000 });
  const transactionStatus = () => typeof client.getTransactionStatus === 'function' ? client.getTransactionStatus() : null;
  try {
    client = await pool.connect();
    // BEGIN options can change a pre-existing transaction's mode. Require the
    // driver's public ReadyForQuery state before BEGIN, not just SQL settings after it.
    const initialStatus = transactionStatus();
    if (initialStatus !== 'I') {
      begun = initialStatus === 'T' || initialStatus === 'E';
      throw failure('sales_retention_audit_transaction_state');
    }
    begun = true;
    await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const settings = (await query(`/* sales-retention:limits */ SELECT
      pg_catalog.set_config('statement_timeout', $1, true), pg_catalog.set_config('lock_timeout', $2, true),
      pg_catalog.set_config('search_path', 'pg_catalog', true) AS search_path,
      pg_catalog.set_config('TimeZone', 'UTC', true) AS timezone,
      pg_catalog.current_setting('transaction_isolation') AS transaction_isolation,
      pg_catalog.current_setting('transaction_read_only') AS transaction_read_only`,
    [`${config.statementTimeoutMs}ms`, `${config.lockTimeoutMs}ms`])).rows;
    if (settings.length !== 1 || settings[0].transaction_isolation !== 'repeatable read'
      || settings[0].transaction_read_only !== 'on' || settings[0].search_path !== 'pg_catalog'
      || settings[0].timezone !== 'UTC') throw failure('sales_retention_audit_transaction_state');
    const schema = schemaInventory((await query(SCHEMA_SQL, [JSON.stringify(DEFINITIONS)])).rows);
    const available = (relation) => schema.find((row) => row.relation === relation).status === 'available';
    const issues = schema.filter((row) => row.status !== 'available').map((row) => ({ code: row.reason, relation: row.relation }));
    const canCount = available('core.sales') && available('core.sales_source_records');
    const cohorts = canCount ? cohortsOf((await query(COHORT_SQL, [config.cutoffDate])).rows)
      : { status: 'unavailable', lanes: null, distinct_review_source_records: null };
    const samples = { status: canCount ? 'complete' : 'unavailable', requested_limit: config.sampleLimit,
      returned_count: 0, truncated: null, rows: [] };
    if (canCount) {
      const total = LANES.reduce((sum, lane) => sum + BigInt(cohorts.lanes[lane].review_before_cutoff), 0n);
      if (config.sampleLimit > 0) {
        const rows = (await query(SAMPLES_SQL, [config.cutoffDate, config.sampleLimit])).rows;
        if (rows.length !== Number(total < BigInt(config.sampleLimit) ? total : BigInt(config.sampleLimit))) {
          throw failure('sales_retention_audit_invalid_result');
        }
        const seen = new Set();
        samples.rows = rows.map((row) => {
          if (!LANES.includes(row.lane)) throw failure('sales_retention_audit_invalid_result');
          const item = { lane: row.lane, id: id(row.id), source_record_id: row.source_record_id === null ? null : id(row.source_record_id) };
          if ((item.lane === 'canonical_legacy') !== (item.source_record_id === null)
            || (item.lane === 'source_only' && item.id !== item.source_record_id)
            || seen.has(`${item.lane}:${item.id}`)) throw failure('sales_retention_audit_invalid_result');
          seen.add(`${item.lane}:${item.id}`);
          return item;
        });
      }
      samples.returned_count = samples.rows.length;
      samples.truncated = total > BigInt(samples.rows.length);
    }
    const dependencies = DEPENDENCIES.map((relation) => ({ relation,
      status: canCount && available(relation) ? 'complete' : 'unavailable',
      reason: !available(relation) ? schema.find((row) => row.relation === relation).reason : canCount ? null : 'cohort_unavailable',
      review_source_row_count: null }));
    const measured = dependencies.filter((row) => row.status === 'complete');
    if (measured.length) {
      // Only fixed allowlist literals above may be interpolated as identifiers.
      const sql = measured.map(({ relation }) => `SELECT '${relation}'::text AS relation, count(*)::text AS row_count
        FROM ${relation} d WHERE EXISTS (SELECT 1 FROM review_sources r WHERE r.source_record_id = d.source_record_id)`).join(' UNION ALL ');
      const rows = (await query(`/* sales-retention:dependencies */ ${COHORT_CTE} ${sql}`, [config.cutoffDate])).rows;
      const seen = new Set();
      for (const row of rows) {
        const target = measured.find((entry) => entry.relation === row.relation);
        if (!target || seen.has(row.relation)) throw failure('sales_retention_audit_invalid_result');
        seen.add(row.relation);
        target.review_source_row_count = count(row.row_count);
      }
      if (seen.size !== measured.length) throw failure('sales_retention_audit_invalid_result');
    }
    const foreignKeys = metadataRows((await query(FOREIGN_KEYS_SQL, [METADATA_LIMIT + 1])).rows, 'foreign_keys');
    const triggers = metadataRows((await query(TRIGGERS_SQL, [METADATA_LIMIT + 1])).rows, 'triggers');
    if (foreignKeys.truncated || triggers.truncated) issues.push({ code: 'metadata_row_limit' });
    if (foreignKeys.rows.some((row) => !row.allowlisted_direct_source_dependency)) issues.push({ code: 'unmeasured_foreign_key_dependency' });
    if (foreignKeys.rows.some((row) => row.columns === null || row.referenced_columns === null)) issues.push({ code: 'metadata_column_limit' });
    if (triggers.total_count !== '0') issues.push({ code: 'trigger_effects_not_evaluated' });
    const holdInventories = HOLD_TABLES.map((relation) => ({ relation,
      status: available(relation) ? 'complete' : 'unavailable',
      reason: schema.find((row) => row.relation === relation).reason,
      total_rows: null, legal_hold_rows: null, retention_not_expired_as_of_date_rows: null, missing_retention_date_rows: null }));
    const measuredHolds = holdInventories.filter((row) => row.status === 'complete');
    if (measuredHolds.length) {
      const sql = measuredHolds.map(({ relation }) => `SELECT '${relation}'::text AS relation,
        count(*)::text AS total_rows, count(*) FILTER (WHERE legal_hold IS TRUE)::text AS legal_hold_rows,
        count(*) FILTER (WHERE retention_until >= ($1::date::timestamp AT TIME ZONE 'UTC'))::text AS retention_not_expired_as_of_date_rows,
        count(*) FILTER (WHERE retention_until IS NULL)::text AS missing_retention_date_rows FROM ${relation}`).join(' UNION ALL ');
      const rows = (await query(`/* sales-retention:holds */ ${sql}`, [config.asOfDate])).rows;
      const seen = new Set();
      for (const row of rows) {
        const target = measuredHolds.find((entry) => entry.relation === row.relation);
        if (!target || seen.has(row.relation)) throw failure('sales_retention_audit_invalid_result');
        seen.add(row.relation);
        for (const key of ['total_rows', 'legal_hold_rows', 'retention_not_expired_as_of_date_rows', 'missing_retention_date_rows']) target[key] = count(row[key]);
        if (['legal_hold_rows', 'retention_not_expired_as_of_date_rows', 'missing_retention_date_rows'].some((key) => BigInt(target[key]) > BigInt(target.total_rows))) {
          throw failure('sales_retention_audit_invalid_result');
        }
      }
      if (seen.size !== measuredHolds.length) throw failure('sales_retention_audit_invalid_result');
    }
    result = frozen({
      audit_version: 1, mode: 'review_only', automatic_deletion: false,
      as_of_date: config.asOfDate, cutoff_date: config.cutoffDate,
      inventory_status: issues.length ? 'incomplete' : 'complete',
      cohorts, samples, schema_inventory: schema, dependencies,
      metadata: { status: foreignKeys.truncated || triggers.truncated || foreignKeys.rows.some((row) => row.columns === null || row.referenced_columns === null) ? 'incomplete' : 'complete',
        per_kind_limit: METADATA_LIMIT, foreign_keys: foreignKeys, triggers },
      holds: { status: 'not_established', scope: 'global_inventory_not_candidate_protection', inventories: holdInventories },
      protection: { coverage: 'not_established', legal_hold_review_required_before_deletion: true,
        unresolved: ['retained_neighborhood_evidence', 'review_commands_and_history', 'accepted_workfile_sections_and_history',
          'signed_snapshots_and_artifacts', 'report_and_photo_holds', 'historical_upload_assignment_association',
          'unstructured_sale_references', 'account_housing_profile_and_enrichment_fallbacks'],
        source_reference_count_scope: 'allowlisted_source_record_id_columns_only' },
      reclaimable_bytes: null, issues,
    });
    if (transactionStatus() !== 'T') throw failure('sales_retention_audit_transaction_state');
    await query('COMMIT');
    if (transactionStatus() !== 'I') throw failure('sales_retention_audit_transaction_state');
    begun = false;
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    problem = failure(['sales_retention_audit_invalid_result', 'sales_retention_audit_transaction_state'].includes(code) ? code
      : code === '42501' ? 'sales_retention_audit_permission_denied'
        : code === '57014' || code === '55P03' ? 'sales_retention_audit_timeout' : 'sales_retention_audit_failed');
    discarded = true;
    if (client && begun) {
      try { await query('ROLLBACK'); } catch { /* Discard this connection; never expose a partial audit. */ }
    }
  } finally {
    if (client) {
      try { client.release(discarded ? problem : undefined); }
      catch { problem = failure('sales_retention_audit_failed'); }
    }
  }
  if (problem) throw problem;
  return result;
}
