import test from 'node:test';
import assert from 'node:assert/strict';
import { projectUadNeighborhoodMaterialInputsV1 as project } from '../src/modules/uad/neighborhoodMaterialInputs.js';
import { id, IDs, SAMPLES, AREA_SOURCES, STORED_SOURCES, rawWorkflow, fullWorkflow, rawField,
  entity, sortRaw, expectedMaterial } from './fixtures/uadNeighborhoodMaterialInputsFixture.js';

const encode = value => JSON.stringify(value);
const nodes = value => 1 + (value !== null && typeof value === 'object' ? Object.values(value).reduce((n, child) => n + nodes(child), 0) : 0);
function canonical(value) {
  const sorted = item => item !== null && typeof item === 'object'
    ? Array.isArray(item) ? item.map(sorted) : Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return JSON.stringify(sorted(value));
}
function frozen(value) {
  if (value !== null && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
  }
}
function success(raw = rawWorkflow()) {
  const result = project(encode(raw));
  assert.equal(result.status, 'representation_projected', result.reason);
  assert.equal(result.reason, null);
  assert.equal(result.projector_version, 1);
  assert.equal(result.interpretation, 'stored_representation_only');
  assert.deepEqual(Object.keys(result), ['projector_version', 'interpretation', 'status', 'reason', 'material_input', 'usage']);
  assert.equal(result.usage.raw_nodes, nodes(raw));
  assert.equal(result.usage.raw_canonical_utf8_bytes, Buffer.byteLength(canonical(raw)));
  assert.equal(result.usage.material_nodes, nodes(result.material_input));
  assert.equal(result.usage.material_canonical_utf8_bytes, Buffer.byteLength(canonical(result.material_input)));
  assert.ok(Object.values(result.usage).every(number => Number.isSafeInteger(number) && number >= 0));
  frozen(result);
  return result;
}
function failure(raw, status, reason, isText = false) {
  const result = project(isText ? raw : encode(raw));
  assert.deepEqual(result, { projector_version: 1, interpretation: 'stored_representation_only', status, reason,
    material_input: null, usage: null });
  frozen(result);
}
function one(sample = SAMPLES[0], value = sample[4]) {
  const raw = rawWorkflow();
  raw.field_rows = [rawField(sample[0], sample[1], value, sample[2])];
  return raw;
}
function observation(result, sample = SAMPLES[0]) {
  return result.material_input.field_observations.find(row => row.field_ref.context_key === sample[0]
    && row.field_ref.uid === sample[1] && row.field_ref.entity_id === sample[2]);
}
const sample = (context, uid) => SAMPLES.find(item => item[0] === context && item[1] === uid);
const year = sample('dwelling', '0300.0011');
const unitArea = sample('unit', '0700.0140');
const legal = sample('subject_legal', '0100.0067');

test('complete literal absent material, all 38 slots and six rosters', () => {
  const result = success();
  assert.deepEqual(result.material_input, expectedMaterial());
  assert.equal(result.usage.material_nodes, 354);
  assert.equal(result.usage.material_depth, 5);
  assert.equal(result.usage.embedded_jsonb_cells, 5);
  assert.equal(result.usage.embedded_decoded_nodes, 5);
  assert.equal(result.usage.consumed_value_cells, 0);
});
test('all nine actual types match literal complete material and usage', () => {
  const raw = fullWorkflow();
  const original = encode(raw);
  const result = success(raw);
  assert.equal(SAMPLES.length, 38);
  assert.equal(new Set(SAMPLES.map(item => item[3])).size, 9);
  assert.deepEqual(result.material_input, expectedMaterial('present'));
  assert.equal(result.usage.embedded_jsonb_cells, 43);
  assert.equal(result.usage.embedded_decoded_nodes, 59);
  assert.equal(result.usage.embedded_decoded_depth, 1);
  assert.equal(result.usage.embedded_numeric_tokens, 13);
  assert.equal(result.usage.embedded_numeric_token_utf8_bytes, 22);
  assert.equal(result.usage.consumed_value_cells, 38);
  assert.equal(result.usage.consumed_timestamp_cells, 0);
  assert.equal(result.usage.material_nodes, 522);
  assert.equal(encode(raw), original);
  assert.equal(Object.isFrozen(SAMPLES[17][4]), false);
});
test('JSON null is complete with provenance and is not row absence', () => {
  const raw = fullWorkflow();
  for (const row of raw.field_rows) row.value = { state: 'json_null', pg_text: 'null' };
  const result = success(raw);
  assert.deepEqual(result.material_input, expectedMaterial('json_null'));
  assert.equal(result.usage.embedded_decoded_nodes, 43);
  assert.equal(result.usage.material_nodes, 506);
  assert.notDeepEqual(result.material_input, success().material_input);
});
for (const entry of SAMPLES) {
  test(`array and SQL NULL never become valid missing values: ${entry[0]}:${entry[1]}`, () => {
    failure(one(entry, []), 'unsupported', 'unsupported_stored_value');
    const raw = one(entry);
    raw.field_rows[0].value = { state: 'sql_null', pg_text: null };
    failure(raw, 'unsupported', 'unsupported_stored_value');
  });
}
test('zero, false and empty ordinary strings remain present without readiness claims', () => {
  for (const entry of SAMPLES.filter(item => ['string', 'text'].includes(item[3]))) {
    for (const value of ['', '  ']) assert.equal(observation(success(one(entry, value)), entry).value, value);
  }
  for (const entry of SAMPLES.filter(item => item[3] === 'boolean')) {
    assert.equal(observation(success(one(entry, false)), entry).value, false);
    for (const value of [0, 1, 'false']) failure(one(entry, value), 'unsupported', 'unsupported_stored_value');
  }
  for (const entry of SAMPLES.filter(item => ['enum', 'year', 'state', 'postal_code'].includes(item[3]))) {
    for (const value of ['', ' ', entry[4] + '\n']) failure(one(entry, value), 'unsupported', 'unsupported_stored_value');
  }
});
test('exact string lengths are UTF-16, not silently trimmed or UTF-8 counts', () => {
  const bounds = [['subject_address', '0100.0007', 100], ['subject_address', '0100.0008', 12],
    ['subject_address', '0100.0009', 50], ['site', '1500.0021', 33], ['dwelling', '0300.0035', 33],
    ['unit_area_data_source', '0700.0126', 66], ['site_parcel', '1500.0027', 60],
    ['site_parcel', '1500.0024', 60], ['subject_legal', '0100.0067', 15000]];
  for (const [context, uid, maximum] of bounds) {
    const entry = sample(context, uid);
    success(one(entry, 'x'.repeat(maximum)));
    failure(one(entry, 'x'.repeat(maximum + 1)), 'unsupported', 'unsupported_stored_value');
  }
  success(one(SAMPLES[0], '😀'.repeat(50)));
  failure(one(SAMPLES[0], '😀'.repeat(51)), 'unsupported', 'unsupported_stored_value');
});
test('catalog pattern admission does not infer geography or actual-year eligibility', () => {
  for (const value of ['0000', '1599', '9999']) assert.equal(observation(success(one(year, value)), year).value, value);
  for (const value of [1998, '199', '１９９８', '1998 ']) failure(one(year, value), 'unsupported', 'unsupported_stored_value');
  const state = sample('subject_address', '0100.0012');
  success(one(state, 'ZZ'));
  failure(one(state, 'tx'), 'unsupported', 'unsupported_stored_value');
  const postal = sample('subject_address', '0100.0011');
  success(one(postal, '00000'));
  failure(one(postal, 75044), 'unsupported', 'unsupported_stored_value');
});
test('integer bounds use only declared catalog constraints', () => {
  for (const entry of [sample('site', '1500.0094'), sample('dwelling', '0300.0063')]) {
    for (const value of [1, 99]) success(one(entry, value));
    for (const value of [0, 100, 1.5, '1']) failure(one(entry, value), 'unsupported', 'unsupported_stored_value');
  }
  for (const uid of ['0100.0019', '0100.0021', '0100.0022']) {
    for (const value of [-1, 0, 100, 9007199254740992]) success(one(sample('subject', uid), value));
  }
});
test('measurement exact shape, units and catalog bounds remain separate from 082f', () => {
  for (const value of [{ amount: '1', unit: 'SquareFeet' }, { amount: null, unit: 'SquareFeet' },
    { amount: true, unit: 'SquareFeet' }, { amount: 1 }, { unit: 'SquareFeet' },
    { amount: 1, unit: 'SquareFeet', extra: true }, { amount: 1, unit: 'squarefeet' },
    { amount: 1, unit: ' SquareFeet' }, { amount: -1, unit: 'SquareFeet' }]) {
    failure(one(unitArea, value), 'unsupported', 'unsupported_stored_value');
  }
  for (const value of [0, 1000001, 1e100]) success(one(unitArea, { amount: value, unit: 'SquareFeet' }));
  for (const entry of [sample('site', '1500.0093'), sample('site_parcel', '1500.0022')]) {
    for (const unit of ['Acres', 'Hectares', 'SquareFeet', 'SquareMeters']) {
      assert.deepEqual(observation(success(one(entry, { amount: 1e10, unit })), entry).value, { amount: 1e10, unit });
    }
    failure(one(entry, { amount: 0, unit: 'SquareFeet' }), 'unsupported', 'unsupported_stored_value');
  }
});
test('all literal area source enums and canonical provenance source types survive exactly', () => {
  const entry = sample('unit_area_data_source', '0700.0125');
  for (const source of AREA_SOURCES) success(one(entry, source));
  for (const source of ['physicalmeasurement', 'Unknown', ' MLS']) failure(one(entry, source), 'unsupported', 'unsupported_stored_value');
  for (const source of STORED_SOURCES) {
    const raw = one(); raw.field_rows[0].source_type = source;
    assert.equal(observation(success(raw)).provenance.source_type, source);
  }
});
test('consumed provenance, exact microseconds and null observed time are material', () => {
  const raw = one(year);
  raw.field_rows[0].source_reference = '  unchanged Reference  ';
  raw.field_rows[0].source_observed_at = '2026-09-06 10:11:12.123456+00';
  raw.field_rows[0].is_appraiser_confirmed = true;
  const result = success(raw);
  assert.deepEqual(observation(result, year).provenance, { source_type: 'appraiser', source_reference: '  unchanged Reference  ',
    source_observed_at: '2026-09-06T10:11:12.123456Z', is_appraiser_confirmed: true });
  assert.equal(result.usage.consumed_timestamp_cells, 1);
  raw.field_rows[0].source_observed_at = null;
  assert.notDeepEqual(success(raw).material_input, result.material_input);
  for (const value of ['infinity', '2026-02-30 10:00:00+00', '2026-09-06 10:11:12.1234567+00']) {
    raw.field_rows[0].source_observed_at = value;
    failure(raw, 'unsupported', 'unsupported_provenance');
  }
});
test('display-only and unsupported unconsumed audit text do not become material', () => {
  const raw = fullWorkflow();
  const expected = success(raw).material_input;
  for (const row of raw.field_rows) {
    row.id = id(1000 + raw.field_rows.indexOf(row)); row.created_at = 'infinity'; row.updated_at = 'BCE source text';
    row.confidence = '0.123456789012345678901'; row.updated_by_user_id = id(9999);
    row.is_override = true; row.override_reason = ''; row.report_field_id = 'original label';
  }
  for (const row of raw.entity_rows) { row.ordinal = 3; row.label = 'different label'; row.entity_identifier += '-changed'; }
  raw.workfile_state.current_revision = 900;
  assert.deepEqual(success(sortRaw(raw)).material_input, expected);
});
test('extra/outbuilding units and six-roster topology remain visible without eligibility flags', () => {
  const raw = rawWorkflow();
  raw.entity_rows.push(entity('outbuilding', id(90), IDs.property), entity('unit', id(91), id(90)));
  const result = success(sortRaw(raw));
  assert.equal(result.material_input.field_observations.length, 45);
  assert.equal(result.material_input.entity_rosters[1].members[0].entity_id, id(90));
  assert.equal(result.material_input.entity_rosters[4].members[1].parent_entity_id, id(90));
  for (const key of ['ready', 'supported', 'applicable', 'equal', 'digest']) assert.equal(Object.hasOwn(result, key), false);
  for (const row of raw.entity_rows.filter(item => ['dwelling', 'site_parcel'].includes(item.entity_type))) row.parent_entity_id = null;
  assert.notDeepEqual(success(raw).material_input, result.material_input);
});
test('outside-roster types and arbitrary unconsumed JSONB are not hidden physical inputs', () => {
  const expected = success().material_input;
  for (const type of ['adu', 'manufactured_home', '__proto__', 'unknown future type']) {
    const raw = rawWorkflow(); raw.entity_rows.push(entity(type, id(80)));
    assert.deepEqual(success(sortRaw(raw)).material_input, expected);
  }
  for (const pg_text of ['false', '0', '""', '[]', '{"__proto__":{"polluted":true}}', '1e999999', '9007199254740993', '-0']) {
    const raw = rawWorkflow(); raw.entity_rows[0].data.pg_text = pg_text;
    assert.deepEqual(success(raw).material_input, expected);
  }
  assert.equal(Object.prototype.polluted, undefined);
});
test('malformed omitted JSONB fails complete admission, including decoded duplicates/Unicode', () => {
  for (const pg_text of ['[0,]', '{"a":0,"\\u0061":1}', '"\\u0000"', '"\\ud800"', '01', '1\u2028']) {
    const raw = rawWorkflow(); raw.entity_rows[0].data.pg_text = pg_text;
    failure(raw, 'invalid_input', 'invalid_raw_workflow');
  }
});
test('numeric refusal stages do not collapse outer input and selected stored values', () => {
  for (const token of ['9007199254740993', '-0', '2e308', '1e-324']) {
    const raw = one(year); raw.field_rows[0].value.pg_text = token;
    failure(raw, 'unsupported', 'unsupported_stored_value');
    failure(encode(rawWorkflow()).replace('"raw_workflow_version":1', `"raw_workflow_version":${token}`), 'invalid_input', 'invalid_raw_workflow', true);
  }
  for (const token of ['1e999999', '1'.repeat(257)]) {
    const raw = one(year); raw.field_rows[0].value.pg_text = token;
    failure(raw, 'limit_exceeded', 'decoded_limit');
    failure(encode(rawWorkflow()).replace('"raw_workflow_version":1', `"raw_workflow_version":${token}`), 'limit_exceeded', 'raw_limit', true);
  }
  const raw = one(sample('subject', '0100.0022'));
  raw.field_rows[0].value.pg_text = '1.000';
  assert.equal(observation(success(raw), sample('subject', '0100.0022')).value, 1);
});
test('malformed cells, SQL-null entities and wrong roots have precise fixed failures', () => {
  for (const cell of [{ state: 'present', pg_text: 'null' }, { state: 'present', pg_text: ' \tnull\n' },
    { state: 'json_null', pg_text: ' null' }, { state: 'sql_null', pg_text: 'null' },
    { state: 'present', pg_text: false }, { state: 'present', pg_text: '1', extra: 0 }]) {
    const raw = one(); raw.field_rows[0].value = cell;
    failure(raw, 'invalid_input', 'storage_state_mismatch');
  }
  const raw = rawWorkflow(); raw.entity_rows[0].data = { state: 'sql_null', pg_text: null };
  failure(raw, 'invalid_input', 'storage_state_mismatch');
  raw.entity_rows[0].data = { state: 'json_null', pg_text: 'null' };
  success(raw);
  for (const text of ['null', 'false', '0', '[]', '{}', '{"a":0,"a":1}']) failure(text, 'invalid_input', 'invalid_raw_workflow', true);
});
test('every closed raw key and row column is required, never silently discarded', () => {
  const value = one();
  for (const path of [[], ['source_basis'], ['extractor_ref'], ['target'], ['workfile_state'], ['field_rows', 0], ['entity_rows', 0]]) {
    for (const key of Object.keys(path.reduce((part, segment) => part[segment], value))) {
      const raw = structuredClone(value);
      const part = path.reduce((item, segment) => item[segment], raw);
      delete part[key];
      failure(raw, 'invalid_input', 'invalid_raw_workflow');
    }
    const raw = structuredClone(value); path.reduce((part, segment) => part[segment], raw).unexpected = true;
    failure(raw, 'invalid_input', 'invalid_raw_workflow');
  }
});
test('same-workfile, duplicate identity, ordering and parent closure never choose a winner', () => {
  const variants = [raw => raw.field_rows.push({ ...raw.field_rows[0] }),
    raw => raw.field_rows.push({ ...raw.field_rows[0], id: id(201) }),
    raw => { raw.field_rows[0].workfile_id = id(999); }, raw => { raw.field_rows[0].entity_id = IDs.unit; },
    raw => { raw.entity_rows[0].workfile_id = id(999); },
    raw => raw.entity_rows.push({ ...raw.entity_rows[0], id: id(301) }),
    raw => { raw.entity_rows[0].parent_entity_id = id(999); },
    raw => { raw.entity_rows[0].parent_entity_id = raw.entity_rows[0].id; },
    raw => { raw.entity_rows.find(row => row.entity_type === 'unit').parent_entity_id = IDs.parcel; },
    raw => raw.entity_rows.reverse()];
  for (const change of variants) { const raw = one(); change(raw); failure(raw, 'unsupported', 'scope_or_integrity'); }
  const raw = rawWorkflow(); raw.entity_rows.push(entity('unknown', id(81), id(82)), entity('unknown', id(82), id(81)));
  failure(sortRaw(raw), 'unsupported', 'scope_or_integrity');
  const wrongRoot = one(year); wrongRoot.field_rows[0].entity_id = null;
  failure(wrongRoot, 'unsupported', 'scope_or_integrity');
  const backwards = fullWorkflow(); backwards.field_rows.reverse();
  failure(backwards, 'unsupported', 'scope_or_integrity');
});
test('account ID retains the existing exact 100 UTF-16 target rule', () => {
  for (const value of ['a'.repeat(64), 'a'.repeat(65), 'a'.repeat(100), '😀'.repeat(50), 'R-ABC Mixed Case']) {
    const raw = rawWorkflow(); raw.target.account_id = value;
    assert.equal(success(raw).material_input.account_id, value);
  }
  for (const value of ['', ' a', 'a ', 'a\u007f', 'a'.repeat(101), '😀'.repeat(51), 123]) {
    const raw = rawWorkflow(); raw.target.account_id = value;
    failure(raw, 'invalid_input', 'invalid_raw_workflow');
  }
});
test('capture label is exact real Utc6; source identity spelling supplies no authority', () => {
  for (const value of ['2026-09-06T09:00:00.123Z', '2026-02-30T09:00:00.123456Z', '2026-09-06 09:00:00.123456+00',
    '0000-01-01T00:00:00.000000Z', '2026-09-06T24:00:00.000000Z']) {
    const raw = rawWorkflow(); raw.captured_at = value;
    failure(raw, 'invalid_input', 'invalid_raw_workflow');
  }
  const raw = rawWorkflow(); raw.extractor_ref.id = ' '; raw.extractor_ref.revision = 'é'.repeat(100);
  success(raw);
  raw.extractor_ref.revision += 'x'; failure(raw, 'invalid_input', 'invalid_raw_workflow');
  const release = rawWorkflow(); release.workfile_state.specification_release_key = 'future';
  failure(release, 'unsupported', 'unsupported_catalog');
});
test('raw value and provenance exact UTF-8 byte bounds, not trimmed prefix acceptance', () => {
  success(one(legal, '€'.repeat(10666))); // Quoted original: 31,998 + 2 = 32,000.
  failure(one(legal, '€'.repeat(10666) + 'x'), 'limit_exceeded', 'projection_limit');
  const raw = one(year); raw.field_rows[0].value.pg_text = ' '.repeat(31994) + '"1998"';
  success(raw); raw.field_rows[0].value.pg_text += ' ';
  failure(raw, 'limit_exceeded', 'projection_limit');
  const source = one(); source.field_rows[0].source_reference = 'x'.repeat(8192);
  success(source); source.field_rows[0].source_reference += 'x';
  failure(source, 'limit_exceeded', 'projection_limit');
});
test('complete 2,048-row bound and 128-member bound never truncate or filter the roster', () => {
  const raw = rawWorkflow(); raw.field_rows = Array.from({ length: 2048 }, (_, index) => rawField('zz_unused', String(index).padStart(4, '0'), 0, null, 1000 + index));
  assert.equal(success(raw).usage.embedded_jsonb_cells, 2053);
  raw.field_rows.push(rawField('zz_unused', '2048', 0, null, 3048));
  failure(raw, 'limit_exceeded', 'raw_limit');
  const members = rawWorkflow(); members.field_rows = [];
  members.entity_rows = [entity('property', IDs.property), entity('dwelling', IDs.dwelling, IDs.property),
    ...Array.from({ length: 126 }, (_, index) => entity('unit', id(1000 + index), IDs.dwelling))];
  const result = success(sortRaw(members));
  assert.equal(result.material_input.field_observations.length, 907);
  assert.equal(result.material_input.entity_rosters[4].members.length, 126);
  members.entity_rows.push(entity('unit', id(2000), IDs.dwelling));
  failure(sortRaw(members), 'limit_exceeded', 'raw_limit');
  // With <=128 raw entities, expanded observations never reach 2,048: at most
  // 20 + 7*128 = 916 even before required structural parents. No fake boundary.
});
test('aggregate embedded nodes include omitted content and every repeated occurrence', () => {
  const raw = rawWorkflow(); raw.entity_rows = []; raw.field_rows = [rawField('zz_unused', 'x', [], null)];
  const count = 100000 - nodes(raw) - 2; // Outer + array root + leaves + captured_at.
  raw.field_rows[0].value.pg_text = '[' + Array(count).fill('0').join(',') + ']';
  const result = success(raw);
  assert.equal(result.usage.raw_nodes + result.usage.embedded_decoded_nodes + 1, 100000);
  assert.equal(result.usage.embedded_numeric_tokens, count);
  raw.field_rows[0].value.pg_text = raw.field_rows[0].value.pg_text.slice(0, -1) + ',0]';
  failure(raw, 'limit_exceeded', 'decoded_limit');
  const repeated = rawWorkflow(); repeated.field_rows = [rawField('zz_unused', 'a', [1, 2]), rawField('zz_unused', 'b', [1, 2], null, 101)];
  assert.equal(success(repeated).usage.embedded_decoded_nodes, 11); // 3+3 plus five entities.
});
test('composed embedded depth 35 succeeds, next step fails below scanner-only ceiling', () => {
  const raw = rawWorkflow(); raw.entity_rows[0].data.pg_text = '['.repeat(31) + '0' + ']'.repeat(31);
  assert.equal(success(raw).usage.embedded_decoded_depth, 31);
  raw.entity_rows[0].data.pg_text = '[' + raw.entity_rows[0].data.pg_text + ']';
  failure(raw, 'limit_exceeded', 'decoded_limit');
});
test('exact original input bytes and smaller full-decoder wrapper guards are retained', () => {
  const body = encode(rawWorkflow());
  const text = ' '.repeat(1500000 - Buffer.byteLength(body)) + body;
  assert.equal(project(text).status, 'representation_projected');
  failure(text + ' ', 'limit_exceeded', 'input_limit', true);
  const raw = rawWorkflow(); raw.entity_rows[0].label = '';
  raw.entity_rows[0].label = 'a'.repeat(1500000 - Buffer.byteLength(encode(raw)));
  assert.equal(Buffer.byteLength(encode(raw)), 1500000);
  failure(raw, 'limit_exceeded', 'raw_limit'); // Existing decoder result framing wins.
});
test('fresh frozen ownership and bad primitives/arity have no caller traps or secret leakage', () => {
  const first = success(); const second = success();
  assert.notEqual(first.material_input, second.material_input);
  assert.notEqual(first.material_input.field_observations, second.material_input.field_observations);
  assert.throws(() => { first.material_input.field_observations[0].state = 'present'; }, TypeError);
  let touched = 0;
  const hostile = new Proxy({}, { get() { touched++; throw new Error('private secret'); }, ownKeys() { touched++; return []; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [null, undefined, 0, false, Symbol('secret'), 1n, new String('{}'), hostile, revoked.proxy]) {
    assert.deepEqual(project(value), { projector_version: 1, interpretation: 'stored_representation_only',
      status: 'invalid_input', reason: 'invalid_argument', material_input: null, usage: null });
  }
  assert.equal(project().reason, 'invalid_argument');
  assert.equal(project(encode(rawWorkflow()), hostile).reason, 'invalid_argument');
  assert.equal(touched, 0);
});
