import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSalesRetention } from '../src/services/salesRetentionAudit.js';

const AS_OF = { asOfDate: '2026-09-10' };
const DEFAULT_COHORTS = [
  { lane: 'canonical_source_linked', disposition: 'review_before_cutoff', row_count: '2' },
  { lane: 'canonical_source_linked', disposition: 'not_before_cutoff', row_count: '1' },
  { lane: 'canonical_source_linked', disposition: 'excluded_missing_date', row_count: '1' },
  { lane: 'canonical_legacy', disposition: 'review_before_cutoff', row_count: '1' },
  { lane: 'source_only', disposition: 'review_before_cutoff', row_count: '1' },
  { lane: 'source_only', disposition: 'not_before_cutoff', row_count: '1' },
  { lane: 'distinct_sources', disposition: 'review_before_cutoff', row_count: '3' },
];
const SAMPLE_ROWS = [
  { lane: 'canonical_legacy', id: '1', source_record_id: null },
  { lane: 'canonical_source_linked', id: '10', source_record_id: '100' },
  { lane: 'canonical_source_linked', id: '11', source_record_id: '101' },
  { lane: 'source_only', id: '200', source_record_id: '200' },
];

function fixture(overrides = {}) {
  const calls = [];
  const releases = [];
  let connects = 0;
  let definitions;
  let transactionState = Object.hasOwn(overrides, 'transactionState') ? overrides.transactionState : 'I';
  const query = async (config) => {
    assert.equal(typeof config, 'object');
    calls.push(config);
    const text = config.text;
    const marker = text.match(/sales-retention:([a-z-]+)/)?.[1] || text;
    if (overrides.failAt === marker || (overrides.failRollback && marker === 'ROLLBACK')) {
      const error = new Error('postgres://operator:private-password@production.invalid/private-database RAW MLS');
      error.code = overrides.errorCode ?? 'XX000';
      throw error;
    }
    if (marker === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') transactionState = 'T';
    if (marker === 'COMMIT') transactionState = overrides.afterCommitState ?? 'I';
    if (marker === 'ROLLBACK') transactionState = 'I';
    if (marker === 'limits') return { rows: overrides.settings ?? [{ transaction_isolation: 'repeatable read',
      transaction_read_only: 'on', search_path: 'pg_catalog', timezone: 'UTC' }] };
    if (marker === 'schema') {
      definitions = JSON.parse(config.values[0]);
      let rows = definitions.map((definition) => ({ relation: definition.relation,
        installed: true, ordinary_table: true, can_select: true, filtered: false,
        columns_match: true, identity_unique: true }));
      rows = overrides.schema?.(rows) ?? rows;
      return { rows };
    }
    if (marker === 'cohorts') return { rows: overrides.cohorts ?? structuredClone(DEFAULT_COHORTS) };
    if (marker === 'samples') return { rows: overrides.samples ?? structuredClone(SAMPLE_ROWS).slice(0, config.values[1]) };
    if (marker === 'dependencies') {
      const names = [...text.matchAll(/SELECT '([^']+)'::text AS relation/g)].map((match) => match[1]);
      return { rows: overrides.dependencies ?? names.map((relation) => ({ relation, row_count: relation === 'core.sales' ? '2' : '0' })) };
    }
    if (marker === 'foreign-keys') return { rows: overrides.foreignKeys ?? [] };
    if (marker === 'triggers') return { rows: overrides.triggers ?? [] };
    if (marker === 'holds') {
      if (overrides.beforeCommitState) transactionState = overrides.beforeCommitState;
      const names = [...text.matchAll(/SELECT '([^']+)'::text AS relation/g)].map((match) => match[1]);
      return { rows: overrides.holds ?? names.map((relation) => ({ relation, total_rows: '2',
        legal_hold_rows: '1', retention_not_expired_as_of_date_rows: '1', missing_retention_date_rows: '1' })) };
    }
    assert.ok(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'limits', 'COMMIT', 'ROLLBACK'].includes(marker), marker);
    return { rows: [] };
  };
  const client = { query, getTransactionStatus() { return transactionState; }, release(error) {
    releases.push(error);
    if (overrides.failRelease) throw new Error('private release information');
  } };
  if (overrides.missingTransactionStatus) delete client.getTransactionStatus;
  const pool = { async connect() {
    connects += 1;
    if (overrides.failConnect) throw new Error('postgres://private-connection');
    return client;
  }, query() { throw new Error('must never use pool.query'); } };
  return { pool, calls, releases, get connects() { return connects; }, get definitions() { return definitions; } };
}

const ofKind = (f, kind) => f.calls.find((call) => call.text.includes(`sales-retention:${kind}`));
const changeSchema = (relation, fields) => (rows) => rows.map((row) => row.relation === relation ? { ...row, ...fields } : row);
const fk = (fields = {}) => ({ total_count: '1', relation: 'core.sale_parcels', name: 'sale_parcels_source_record_id_fkey',
  referenced_relation: 'core.sales_source_records', columns: ['source_record_id'], referenced_columns: ['id'],
  delete_action: 'c', validated: true, deferrable: false, initially_deferred: false, ...fields });

test('audit owns one read-only repeatable-read client, installs bounded local timeouts, commits then releases', async () => {
  const f = fixture();
  const result = await auditSalesRetention(f.pool, AS_OF);
  assert.equal(f.connects, 1);
  assert.equal(f.calls[0].text, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(ofKind(f, 'limits').values, ['5000ms', '1000ms']);
  assert.match(ofKind(f, 'limits').text, /set_config\('search_path', 'pg_catalog', true\)/);
  assert.match(ofKind(f, 'limits').text, /set_config\('TimeZone', 'UTC', true\)/);
  assert.ok(f.calls.every((call) => call.query_timeout === 6000));
  assert.equal(f.calls.at(-1).text, 'COMMIT');
  assert.deepEqual(f.releases, [undefined]);
  assert.equal(result.mode, 'review_only');
  assert.equal(result.audit_version, 1);
  assert.equal(result.automatic_deletion, false);
  assert.equal(result.as_of_date, '2026-09-10');
  assert.equal(result.cutoff_date, '2021-01-01');
  assert.equal(result.inventory_status, 'complete');
  assert.equal(result.protection.coverage, 'not_established');
  assert.equal(result.holds.status, 'not_established');
  assert.equal(result.reclaimable_bytes, null);
  assert.equal(result.samples.requested_limit, 0);
  assert.equal(result.samples.returned_count, 0);
  assert.equal(result.samples.truncated, true);
  assert.equal(ofKind(f, 'samples'), undefined);
  assert.equal(JSON.stringify(result).includes('safe_to_delete'), false);
  assert.equal(JSON.stringify(result).includes('private-password'), false);
});

for (const transactionState of ['T', 'E', null, undefined, 'unknown']) {
  test(`pre-existing or unknown driver transaction state ${String(transactionState)} cannot reach BEGIN or COMMIT`, async () => {
    const f = fixture({ transactionState });
    await assert.rejects(auditSalesRetention(f.pool, AS_OF), { code: 'sales_retention_audit_transaction_state' });
    assert.deepEqual(f.calls.map((call) => call.text), ['T', 'E'].includes(transactionState) ? ['ROLLBACK'] : []);
    assert.equal(f.releases.length, 1);
    assert.equal(f.releases[0].code, 'sales_retention_audit_transaction_state');
  });
}

test('missing public transaction-status API fails closed without any SQL', async () => {
  const f = fixture({ missingTransactionStatus: true });
  await assert.rejects(auditSalesRetention(f.pool, AS_OF), { code: 'sales_retention_audit_transaction_state' });
  assert.deepEqual(f.calls, []);
  assert.equal(f.releases[0].code, 'sales_retention_audit_transaction_state');
});

test('unexpected idle state before COMMIT cannot publish a result', async () => {
  const f = fixture({ beforeCommitState: 'I' });
  await assert.rejects(auditSalesRetention(f.pool, AS_OF), { code: 'sales_retention_audit_transaction_state' });
  assert.equal(f.calls.some((call) => call.text === 'COMMIT'), false);
  assert.equal(f.calls.at(-1).text, 'ROLLBACK');
});

test('COMMIT must finish with actual driver idle state before returning an audit', async () => {
  const f = fixture({ afterCommitState: 'T' });
  await assert.rejects(auditSalesRetention(f.pool, AS_OF), { code: 'sales_retention_audit_transaction_state' });
  assert.equal(f.calls.at(-2).text, 'COMMIT');
  assert.equal(f.calls.at(-1).text, 'ROLLBACK');
  assert.equal(f.releases[0].code, 'sales_retention_audit_transaction_state');
});

for (const changed of [{ transaction_isolation: 'read committed' }, { transaction_read_only: 'off' },
  { search_path: 'public, pg_catalog' }, { timezone: 'America/Chicago' }]) {
  test(`unexpected transaction/session state ${JSON.stringify(changed)} aborts before inventory`, async () => {
    const f = fixture({ settings: [{ transaction_isolation: 'repeatable read', transaction_read_only: 'on',
      search_path: 'pg_catalog', timezone: 'UTC', ...changed }] });
    await assert.rejects(auditSalesRetention(f.pool, AS_OF), { code: 'sales_retention_audit_transaction_state' });
    assert.equal(ofKind(f, 'schema'), undefined);
    assert.equal(f.calls.at(-1).text, 'ROLLBACK');
    assert.equal(f.calls.some((call) => call.text === 'COMMIT'), false);
    assert.equal(f.releases[0].code, 'sales_retention_audit_transaction_state');
  });
}

for (const [date, cutoff] of [['0006-01-01', '0001-01-01'], ['2027-01-01', '2022-01-01'], ['2000-02-29', '1995-01-01'], ['9999-12-31', '9994-01-01']]) {
  test(`calendar cutoff supports ${date} without host-clock or rolling-day arithmetic`, async () => {
    const f = fixture();
    const result = await auditSalesRetention(f.pool, { asOfDate: date });
    assert.equal(result.cutoff_date, cutoff);
    assert.deepEqual(ofKind(f, 'cohorts').values, [cutoff]);
    assert.deepEqual(ofKind(f, 'holds').values, [date]);
  });
}

const invalidOptions = [undefined, null, [], '', {}, { asOfDate: undefined }, { ...AS_OF, extra: true },
  { asOfDate: '0005-12-31' }, { asOfDate: '0000-01-01' }, { asOfDate: '2026-02-29' }, { asOfDate: '1900-02-29' },
  { asOfDate: '2026-00-01' }, { asOfDate: '2026-13-01' }, { asOfDate: '2026-01-00' }, { asOfDate: '2026-04-31' },
  { asOfDate: '2026-9-10' }, { asOfDate: '2026-09-10T00:00:00Z' }, { asOfDate: '2026-09-10 ' },
  { asOfDate: "2026-01-01'; DELETE FROM core.sales; --" },
  ...[-1, 51, 0.5, '1', null, undefined, NaN, Infinity].map((sampleLimit) => ({ ...AS_OF, sampleLimit })),
  ...[0, 15001, '5000', null].map((statementTimeoutMs) => ({ ...AS_OF, statementTimeoutMs })),
  ...[0, 3001, '1000', null].map((lockTimeoutMs) => ({ ...AS_OF, lockTimeoutMs })),
];
for (const [index, value] of invalidOptions.entries()) {
  test(`closed options reject invalid case ${index + 1} before any pool access`, async () => {
    const f = fixture();
    await assert.rejects(auditSalesRetention(f.pool, value), { code: 'sales_retention_audit_invalid_options' });
    assert.equal(f.connects, 0);
    assert.deepEqual(f.calls, []);
  });
}

test('options do not invoke accessors, proxies, coercion or symbol properties', async () => {
  let touched = 0;
  const accessor = { get asOfDate() { touched += 1; return '2026-09-10'; } };
  const proxy = new Proxy({}, { ownKeys() { touched += 1; throw new Error('must not run'); }, getPrototypeOf() { touched += 1; throw new Error('must not run'); } });
  const coercion = { asOfDate: { toString() { touched += 1; return '2026-09-10'; } } };
  const inherited = Object.create({ asOfDate: '2026-09-10' });
  for (const value of [accessor, proxy, coercion, inherited, { ...AS_OF, [Symbol('extra')]: true }]) {
    const f = fixture();
    await assert.rejects(auditSalesRetention(f.pool, value), { code: 'sales_retention_audit_invalid_options' });
    assert.equal(f.connects, 0);
  }
  assert.equal(touched, 0);
});

test('configured boundary limits remain parameters and maximum 50 samples is a global output bound', async () => {
  const f = fixture();
  const result = await auditSalesRetention(f.pool, { ...AS_OF, sampleLimit: 50, statementTimeoutMs: 15000, lockTimeoutMs: 3000 });
  assert.deepEqual(ofKind(f, 'limits').values, ['15000ms', '3000ms']);
  assert.ok(f.calls.every((call) => call.query_timeout === 16000));
  assert.deepEqual(ofKind(f, 'samples').values, ['2021-01-01', 50]);
  assert.deepEqual(result.samples.rows, SAMPLE_ROWS);
  assert.equal(result.samples.returned_count, 4);
  assert.equal(result.samples.truncated, false);
  const two = fixture();
  const bounded = await auditSalesRetention(two.pool, { ...AS_OF, sampleLimit: 2 });
  assert.equal(bounded.samples.returned_count, 2);
  assert.equal(bounded.samples.truncated, true);
  assert.match(ofKind(two, 'samples').text, /ORDER BY lane, classified.id LIMIT \$2::integer/);
});

test('SQL partitions exact closed date facts; does not substitute import dates, coalesce conflicts, or limit cohorts', async () => {
  const f = fixture();
  await auditSalesRetention(f.pool, AS_OF);
  const sql = ofKind(f, 'cohorts').text;
  assert.match(sql, /s.source_record_id IS NOT NULL AND r.id IS NULL THEN 'excluded_missing_source'/);
  assert.match(sql, /record_type IS DISTINCT FROM 'closed_sale'/);
  assert.match(sql, /s.closing_date IS NULL/);
  assert.match(sql, /r.close_date IS NULL/);
  assert.match(sql, /NOT isfinite\(s.closing_date\)/);
  assert.match(sql, /NOT isfinite\(r.close_date\)/);
  assert.match(sql, /s.closing_date <> r.close_date/);
  assert.match(sql, /s.closing_date < \$1::date/);
  assert.match(sql, /r.close_date < \$1::date/);
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM core.sales s WHERE s.source_record_id = r.id\)/);
  assert.match(sql, /SELECT DISTINCT c.source_record_id/);
  assert.match(sql, /sibling.disposition <> 'review_before_cutoff'/);
  assert.doesNotMatch(sql, /\bLIMIT\b|COALESCE|loaded_at|current_price|raw_payload|now\(/i);
});

test('cohort counts are complete bigint strings, including zeros and values above JS safe integer', async () => {
  const f = fixture({ cohorts: [
    { lane: 'canonical_legacy', disposition: 'review_before_cutoff', row_count: '9007199254740993' },
    { lane: 'distinct_sources', disposition: 'review_before_cutoff', row_count: '0' },
  ] });
  const result = await auditSalesRetention(f.pool, AS_OF);
  assert.equal(result.cohorts.lanes.canonical_legacy.total, '9007199254740993');
  assert.equal(result.cohorts.lanes.source_only.total, '0');
  assert.equal(result.cohorts.lanes.canonical_legacy.excluded_nonclosed, '0');
  assert.equal(result.cohorts.distinct_review_source_records, '0');
  assert.equal(result.samples.truncated, true);
});

for (const [name, fields] of [
  ['missing', { installed: false }], ['permission', { can_select: false }], ['RLS', { filtered: true }],
  ['type/column mismatch', { columns_match: false }], ['unconstrained id', { identity_unique: false }],
  ['partition/inheritance', { ordinary_table: false }],
]) {
  test(`required ${name} schema cannot yield false zero cohort or dependency counts`, async () => {
    const f = fixture({ schema: changeSchema('core.sales_source_records', fields) });
    const result = await auditSalesRetention(f.pool, { ...AS_OF, sampleLimit: 2 });
    assert.equal(result.inventory_status, 'incomplete');
    assert.deepEqual(result.cohorts, { status: 'unavailable', lanes: null, distinct_review_source_records: null });
    assert.equal(result.samples.status, 'unavailable');
    assert.equal(result.samples.truncated, null);
    assert.ok(result.dependencies.every((row) => row.review_source_row_count === null));
    assert.equal(ofKind(f, 'cohorts'), undefined);
    assert.equal(ofKind(f, 'samples'), undefined);
    assert.equal(ofKind(f, 'dependencies'), undefined);
    assert.equal(f.calls.at(-1).text, 'COMMIT');
  });
}

test('actual-schema query checks built-in types, NOT NULL unique IDs, privileges, RLS and ordinary-table inheritance', async () => {
  const f = fixture();
  await auditSalesRetention(f.pool, AS_OF);
  const sql = ofKind(f, 'schema').text;
  assert.match(sql, /ix.indisunique AND ix.indisvalid AND ix.indisready/);
  assert.match(sql, /ix.indnkeyatts = 1 AND ix.indkey\[0\] = a.attnum/);
  assert.match(sql, /ix.indpred IS NULL AND ix.indexprs IS NULL/);
  assert.match(sql, /a.attname = 'id' AND a.attnotnull/);
  assert.match(sql, /tn.nspname <> 'pg_catalog' OR t.typname <> expected.value/);
  assert.match(sql, /has_schema_privilege/);
  assert.match(sql, /has_table_privilege/);
  assert.match(sql, /row_security_active/);
  assert.match(sql, /pg_inherits/);
  assert.deepEqual(f.definitions[0].columns, { id: 'int8', source_record_id: 'int8', closing_date: 'date' });
  assert.deepEqual(f.definitions[1].columns, { id: 'int8', close_date: 'date', record_type: 'text' });
});

test('optional dependency absent/denied is unavailable rather than zero; other measurements remain useful', async () => {
  const f = fixture({ schema: (rows) => rows.map((row) => row.relation === 'app.trestle_media_queue' ? { ...row, installed: false }
    : row.relation === 'app.sale_characteristic_review_history' ? { ...row, can_select: false } : row) });
  const result = await auditSalesRetention(f.pool, AS_OF);
  assert.equal(result.cohorts.status, 'complete');
  for (const [relation, reason] of [['app.trestle_media_queue', 'not_installed'], ['app.sale_characteristic_review_history', 'permission_denied']]) {
    assert.deepEqual(result.dependencies.find((row) => row.relation === relation), { relation,
      status: 'unavailable', reason, review_source_row_count: null });
    assert.equal(ofKind(f, 'dependencies').text.includes(`FROM ${relation} d`), false);
  }
  assert.equal(result.dependencies.find((row) => row.relation === 'core.sale_parcels').review_source_row_count, '0');
  assert.equal(result.dependencies.find((row) => row.relation === 'core.sales').review_source_row_count, '2');
  assert.match(ofKind(f, 'dependencies').text, /WHERE EXISTS \(SELECT 1 FROM review_sources/);
});

for (const [action, expected] of [['a', 'no_action'], ['r', 'restrict'], ['c', 'cascade'], ['n', 'set_null'], ['d', 'set_default']]) {
  test(`FK inventory retains actual ${expected} action and exact validation/deferral properties`, async () => {
    const f = fixture({ foreignKeys: [fk({ delete_action: action, validated: false, deferrable: true, initially_deferred: true })] });
    const result = await auditSalesRetention(f.pool, AS_OF);
    const edge = result.metadata.foreign_keys.rows[0];
    assert.equal(edge.delete_action, expected);
    assert.equal(edge.validated, false);
    assert.equal(edge.deferrable, true);
    assert.equal(edge.initially_deferred, true);
    assert.equal(edge.allowlisted_direct_source_dependency, true);
    assert.match(ofKind(f, 'foreign-keys').text, /WITH RECURSIVE affected/);
  });
}

test('unknown/transitive FK and noninternal trigger are metadata-only incomplete dependencies, never executable identifiers', async () => {
  const malicious = "tenant.strange'--name";
  const f = fixture({ foreignKeys: [fk({ relation: malicious, referenced_relation: 'core.sale_parcels' })],
    triggers: [{ total_count: '1', relation: 'core.sales', name: 'user_delete_trigger', enabled: 'O', type_bits: 9 }] });
  const result = await auditSalesRetention(f.pool, AS_OF);
  assert.equal(result.metadata.foreign_keys.rows[0].relation, malicious);
  assert.equal(result.metadata.foreign_keys.rows[0].allowlisted_direct_source_dependency, false);
  assert.equal(result.inventory_status, 'incomplete');
  assert.ok(result.issues.some((issue) => issue.code === 'unmeasured_foreign_key_dependency'));
  assert.ok(result.issues.some((issue) => issue.code === 'trigger_effects_not_evaluated'));
  assert.ok(f.calls.every((call) => !call.text.includes(malicious)));
  assert.match(ofKind(f, 'triggers').text, /WHERE NOT t.tgisinternal/);
  assert.equal(result.metadata.triggers.rows[0].enabled, 'O');
});

test('FK/trigger row limits are explicit and never imply a clipped graph is complete', async () => {
  const f = fixture({ foreignKeys: Array.from({ length: 257 }, (_, index) => fk({ total_count: '999999', name: `f_${index}` })),
    triggers: Array.from({ length: 257 }, (_, index) => ({ total_count: '257', relation: 'core.sales', name: `t_${index}`, enabled: 'D', type_bits: 9 })) });
  const result = await auditSalesRetention(f.pool, AS_OF);
  for (const key of ['foreign_keys', 'triggers']) {
    assert.equal(result.metadata[key].rows.length, 256);
    assert.equal(result.metadata[key].truncated, true);
  }
  assert.equal(result.metadata.foreign_keys.total_count, '999999');
  assert.equal(result.metadata.status, 'incomplete');
  assert.deepEqual(ofKind(f, 'foreign-keys').values, [257]);
  assert.deepEqual(ofKind(f, 'triggers').values, [257]);
});

test('large composite FK omits columns explicitly without claiming complete metadata', async () => {
  const f = fixture({ foreignKeys: [fk({ columns: null, referenced_columns: null })] });
  const result = await auditSalesRetention(f.pool, AS_OF);
  assert.equal(result.metadata.status, 'incomplete');
  assert.equal(result.metadata.foreign_keys.rows[0].columns, null);
  assert.ok(result.issues.some((issue) => issue.code === 'metadata_column_limit'));
  assert.match(ofKind(f, 'foreign-keys').text, /cardinality\(fk.conkey\) <= 16/);
});

test('hold inventory is global, with UTC as-of comparison, no protected-candidate or reclaimable-byte inference', async () => {
  const f = fixture({ schema: changeSchema('app.inspection_photos', { installed: false }) });
  const result = await auditSalesRetention(f.pool, AS_OF);
  assert.equal(result.holds.scope, 'global_inventory_not_candidate_protection');
  assert.equal(result.holds.status, 'not_established');
  const archive = result.holds.inventories.find((row) => row.relation === 'app.report_file_archives');
  assert.equal(archive.total_rows, '2');
  assert.equal(archive.legal_hold_rows, '1');
  const photos = result.holds.inventories.find((row) => row.relation === 'app.inspection_photos');
  assert.equal(photos.status, 'unavailable');
  assert.equal(photos.total_rows, null);
  assert.match(ofKind(f, 'holds').text, /\$1::date::timestamp AT TIME ZONE 'UTC'/);
  assert.doesNotMatch(ofKind(f, 'holds').text, /review_sources|core.sales/);
  assert.equal(result.reclaimable_bytes, null);
});

test('result is deeply frozen and excludes unknown source fields returned by a driver', async () => {
  const rows = SAMPLE_ROWS.map((row) => ({ ...row, raw_payload: 'private MLS', media_url: 'https://private.invalid' }));
  const f = fixture({ samples: rows, foreignKeys: [fk({ definition: 'private body' })] });
  const result = await auditSalesRetention(f.pool, { ...AS_OF, sampleLimit: 50 });
  const visit = (value) => { if (value && typeof value === 'object') { assert.equal(Object.isFrozen(value), true); Object.values(value).forEach(visit); } };
  visit(result);
  assert.doesNotMatch(JSON.stringify(result), /private MLS|private.invalid|private body|raw_payload|media_url/);
});

test('full int64 and negative historical identifiers remain exact strings in samples', async () => {
  const f = fixture({ samples: [{ lane: 'canonical_legacy', id: '-9223372036854775808', source_record_id: null },
    { lane: 'canonical_source_linked', id: '9223372036854775807', source_record_id: '9007199254740993' }] });
  const result = await auditSalesRetention(f.pool, { ...AS_OF, sampleLimit: 2 });
  assert.equal(result.samples.rows[0].id, '-9223372036854775808');
  assert.equal(result.samples.rows[1].source_record_id, '9007199254740993');
});

const invalidResults = [
  { cohorts: [{ lane: 'distinct_sources', disposition: 'review_before_cutoff', row_count: 0 }] },
  { cohorts: [{ lane: 'distinct_sources', disposition: 'review_before_cutoff', row_count: '-1' }] },
  { cohorts: [{ lane: 'distinct_sources', disposition: 'review_before_cutoff', row_count: '00' }] },
  { cohorts: [{ lane: 'distinct_sources', disposition: 'review_before_cutoff', row_count: '9223372036854775808' }] },
  { cohorts: [] },
  { cohorts: [DEFAULT_COHORTS[0], DEFAULT_COHORTS[0]] },
  { cohorts: [{ lane: 'different_lane', disposition: 'review_before_cutoff', row_count: '0' }] },
  { cohorts: [{ lane: 'distinct_sources', disposition: 'review_before_cutoff', row_count: '1' }] },
  { dependencies: [] },
  { dependencies: [{ relation: 'evil.records', row_count: '0' }] },
  { holds: [] },
  { holds: [{ relation: 'app.report_file_archives', total_rows: '0', legal_hold_rows: '1', retention_not_expired_as_of_date_rows: '0', missing_retention_date_rows: '0' }] },
  { foreignKeys: [fk({ total_count: '2' })] },
  { foreignKeys: [fk({ delete_action: 'x' })] },
  { foreignKeys: [fk({ validated: 'true' })] },
  { triggers: [{ total_count: '1', relation: 'core.sales', name: 'trigger', enabled: 'X', type_bits: 1 }] },
  { schema: (rows) => rows.slice(1) },
  { schema: (rows) => rows.map((row, index) => index === 0 ? rows[1] : row) },
];
for (const [index, config] of invalidResults.entries()) {
  test(`invalid/incomplete database result ${index + 1} rolls back instead of publishing a partial audit`, async () => {
    const f = fixture(config);
    await assert.rejects(auditSalesRetention(f.pool, AS_OF), { code: 'sales_retention_audit_invalid_result' });
    assert.equal(f.calls.at(-1).text, 'ROLLBACK');
    assert.equal(f.calls.some((call) => call.text === 'COMMIT'), false);
    assert.equal(f.releases.length, 1);
    assert.equal(f.releases[0].code, 'sales_retention_audit_invalid_result');
  });
}

for (const samples of [[], [SAMPLE_ROWS[0], SAMPLE_ROWS[0]], [SAMPLE_ROWS[0], { lane: 'source_only', id: '1', source_record_id: '2' }],
  [SAMPLE_ROWS[0], { lane: 'canonical_source_linked', id: 9007199254740992, source_record_id: '1' }],
  [SAMPLE_ROWS[0], { lane: 'canonical_source_linked', id: '9223372036854775808', source_record_id: '1' }]]) {
  test(`incomplete/invalid sample rows fail closed: ${JSON.stringify(samples)}`, async () => {
    const f = fixture({ samples });
    await assert.rejects(auditSalesRetention(f.pool, { ...AS_OF, sampleLimit: 2 }), { code: 'sales_retention_audit_invalid_result' });
    assert.equal(f.calls.at(-1).text, 'ROLLBACK');
  });
}

for (const stage of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'limits', 'schema', 'cohorts', 'samples', 'dependencies', 'foreign-keys', 'triggers', 'holds', 'COMMIT']) {
  test(`${stage} failure is sanitized, rolls back, discards and releases exactly once`, async () => {
    const f = fixture({ failAt: stage });
    await assert.rejects(auditSalesRetention(f.pool, { ...AS_OF, sampleLimit: 2 }), (error) => {
      assert.equal(error.message, 'sales_retention_audit_failed');
      assert.equal(error.code, 'sales_retention_audit_failed');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
    assert.equal(f.calls.at(-1).text, 'ROLLBACK');
    assert.equal(f.releases.length, 1);
    assert.equal(f.releases[0].code, 'sales_retention_audit_failed');
  });
}

for (const [errorCode, expected] of [['42501', 'sales_retention_audit_permission_denied'], ['57014', 'sales_retention_audit_timeout'], ['55P03', 'sales_retention_audit_timeout']]) {
  test(`runtime ${errorCode} retains only bounded actionable error code`, async () => {
    const f = fixture({ failAt: 'cohorts', errorCode });
    await assert.rejects(auditSalesRetention(f.pool, AS_OF), { code: expected, message: expected });
    assert.equal(f.releases[0].message, expected);
  });
}

test('rollback failure still discards/releases and exposes no partial successful audit', async () => {
  const f = fixture({ failAt: 'cohorts', failRollback: true });
  await assert.rejects(auditSalesRetention(f.pool, AS_OF), { code: 'sales_retention_audit_failed' });
  assert.equal(f.releases.length, 1);
  assert.ok(f.releases[0] instanceof Error);
});

test('pool acquisition and release failures do not leak URLs or return a result', async () => {
  for (const config of [{ failConnect: true }, { failRelease: true }]) {
    const f = fixture(config);
    await assert.rejects(auditSalesRetention(f.pool, AS_OF), { code: 'sales_retention_audit_failed', message: 'sales_retention_audit_failed' });
    assert.equal(f.releases.length, config.failConnect ? 0 : 1);
  }
});

test('audit never invokes initializer, DDL, mutation, scheduler, large source fields or size-reclaim estimates', async () => {
  const f = fixture();
  await auditSalesRetention(f.pool, { ...AS_OF, sampleLimit: 2 });
  for (const call of f.calls) {
    const withoutComments = call.text.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(withoutComments, /\b(DELETE|TRUNCATE|INSERT|UPDATE|CREATE|ALTER|DROP|VACUUM|ANALYZE)\b/i);
    assert.doesNotMatch(call.text, /raw_payload|source_filename|source_sha256|media_url|canonical_utf8|pg_relation_size|pg_total_relation_size/);
  }
});
