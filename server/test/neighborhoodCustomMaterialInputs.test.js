import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCustomNeighborhoodMaterialInputs as project, CUSTOM_MATERIAL_PROJECTOR_VERSION,
  CUSTOM_MATERIAL_PROJECTOR_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customMaterialInputs.js';
import { canonicalAssessmentJson as canonical } from '../src/services/neighborhoodAssessment/contract.js';
import { inputs, target, pg, argumentsOf, setSection, setPublic, emptyMaterial, emptyObjectSections,
  present, absent, nullCell, emptyMain, emptyHousing, emptyAccount, richFixture } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';

const run = input => project(...argumentsOf(input));
const bytes = text => Buffer.byteLength(text, 'utf8');
function frozen(value) {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
  }
}
function represented(input, expected) {
  const result = run(input);
  assert.equal(result.status, 'represented', JSON.stringify(result));
  assert.equal(result.reason, null);
  assert.deepEqual(result.material_input, expected);
  assert.deepEqual(Object.keys(result), ['projection_version', 'interpretation', 'status', 'reason', 'material_input', 'usage']);
  assert.deepEqual(Object.keys(result.usage), ['input_utf8_bytes', 'input_value_nodes', 'input_depth',
    'nested_utf8_bytes', 'nested_value_nodes', 'nested_depth', 'numeric_tokens', 'numeric_token_utf8_bytes',
    'index_nodes', 'index_edges', 'index_key_utf8_bytes', 'selected_token_utf8_bytes', 'selected_scalar_count',
    'processed_utf8_bytes', 'processed_value_nodes']);
  frozen(result);
  return result;
}
function refusal(input, reason, status = 'unsupported') {
  const result = Array.isArray(input) ? project(...input) : run(input);
  assert.deepEqual(result, { projection_version: 1, interpretation: 'representation_only', status, reason, material_input: null, usage: null });
  frozen(result);
  assert.ok(bytes(JSON.stringify(result)) <= 512);
  return result;
}
// Independently counts valid plain fixture values; no candidate scanner used.
function nodes(value) { return 1 + (value && typeof value === 'object' ? Object.values(value).reduce((sum, child) => sum + nodes(child), 0) : 0); }
function depth(value) { return value && typeof value === 'object' && Object.values(value).length
  ? 1 + Math.max(...Object.values(value).map(depth)) : 0; }
function numbers(value) {
  if (typeof value === 'number') return [1, String(value).length];
  return value && typeof value === 'object' ? Object.values(value).reduce(([count, size], child) => {
    const [n, b] = numbers(child); return [count + n, size + b];
  }, [0, 0]) : [0, 0];
}
function preimage(input) {
  const s = input.snapshot;
  return { snapshot_evidence_version: 1, snapshot_id: s.id, appraisal_case_id: s.appraisal_case_id,
    snapshot_version: s.snapshot_version, parent_snapshot_id: s.parent_snapshot_id, source_report_file_id: s.source_report_file_id,
    verification_status: s.verification_status, effective_date: s.effective_date, inspection_date: s.inspection_date,
    subject_data: JSON.parse(s.subject_data.pg_text), source_manifest: JSON.parse(s.source_manifest.pg_text), legacy_checksum_sha256: s.checksum_sha256 };
}
// Seeds for this recipe have canonical numeric spellings, no dates and no
// selected manual leaves. Whole unused manual arrays still count fully.
function predictedResult(input, material) {
  const args = argumentsOf(input), outer = args.map(text => JSON.parse(text));
  const manual = input.sections.filter(s => s.row_state === 'present').map(s => s.row.section_value.pg_text);
  const nested = [...manual, input.snapshot.subject_data.pg_text, input.snapshot.source_manifest.pg_text];
  const values = nested.map(text => JSON.parse(text));
  const numeric = [...outer, ...values].reduce(([count, size], value) => {
    const [n, b] = numbers(value); return [count + n, size + b];
  }, [0, 0]);
  const indexNodes = manual.reduce((sum, text) => sum + nodes(JSON.parse(text)), 0);
  const keyBytes = value => value && typeof value === 'object' ? Object.entries(value).reduce((sum, [key, child]) =>
    sum + (Array.isArray(value) ? 0 : bytes(key)) + keyBytes(child), 0) : 0;
  const usage = { input_utf8_bytes: args.reduce((sum, text) => sum + bytes(text), 0),
    input_value_nodes: outer.reduce((sum, value) => sum + nodes(value), 0), input_depth: Math.max(...outer.map(depth)),
    nested_utf8_bytes: nested.reduce((sum, text) => sum + bytes(text), 0),
    nested_value_nodes: values.reduce((sum, value) => sum + nodes(value), 0), nested_depth: Math.max(...values.map(depth)),
    numeric_tokens: numeric[0], numeric_token_utf8_bytes: numeric[1], index_nodes: indexNodes,
    index_edges: indexNodes - manual.length, index_key_utf8_bytes: manual.reduce((sum, text) => sum + keyBytes(JSON.parse(text)), 0),
    selected_token_utf8_bytes: 0, selected_scalar_count: 0, processed_utf8_bytes: 0, processed_value_nodes: 0 };
  const result = { projection_version: 1, interpretation: 'representation_only', status: 'represented',
    reason: null, material_input: material, usage };
  const p = preimage(input);
  const prefixBytes = usage.input_utf8_bytes + usage.nested_utf8_bytes + bytes(canonical(p)) + bytes(canonical(material));
  usage.processed_value_nodes = usage.input_value_nodes + usage.nested_value_nodes + nodes(p) + nodes(material) + nodes(result);
  for (let i = 0; i < 20; i++) {
    const count = prefixBytes + bytes(canonical(result));
    if (usage.processed_utf8_bytes === count) return result;
    usage.processed_utf8_bytes = count;
  }
  throw new Error('fixture byte formula did not converge');
}

test('fixed API/version/capacities do not accept caller policy', () => {
  assert.equal(CUSTOM_MATERIAL_PROJECTOR_VERSION, 1);
  assert.deepEqual(LIMITS, { target_bytes: 4096, target_nodes: 128, target_depth: 4,
    section_reads_bytes: 1500000, snapshot_row_bytes: 1500000, outer_nodes: 100000, outer_depth: 35,
    total_input_bytes: 3004096, nested_text_bytes: 1500000, nested_nodes: 100000, nested_depth: 35,
    cumulative_bytes: 8000000, cumulative_nodes: 500000, cumulative_index_nodes: 300000,
    cumulative_index_edges: 299997, cumulative_index_key_bytes: 1500000, selected_token_bytes: 1500000,
    text_cell_bytes: 8192, legal_payload_bytes: 32000, array_entries: 128, array_occurrences: 512,
    material_bytes: 128000, material_nodes: 25000, material_depth: 16,
    output_bytes: 128000, output_nodes: 25000, output_depth: 16, output_jsonb_bytes: 2000000, failure_bytes: 512 });
  assert.ok(Object.isFrozen(LIMITS));
  assert.throws(() => { LIMITS.output_bytes = Infinity; }, TypeError);
});
test('minimal complete material and exact self-inclusive accounting have independent expected values', () => {
  const input = inputs(), material = emptyMaterial();
  assert.deepEqual(represented(input, material), predictedResult(input, material));
});
test('literal rich original projects every3+6 branch and keeps both sources without selection authority', () => {
  const { input, material } = richFixture();
  const result = represented(input, material);
  assert.equal(result.usage.selected_scalar_count, 39);
  assert.equal(result.usage.numeric_tokens, 27);
  assert.equal(result.usage.numeric_token_utf8_bytes, 58);
  assert.deepEqual(result.material_input.accepted_evidence, []);
});
test('returned values are detached, frozen and independent of later calls and fixture mutations', () => {
  const { input, material } = richFixture(), before = JSON.stringify(input);
  const result = represented(input, material), second = represented(input, material);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(result.material_input, second.material_input);
  assert.throws(() => { result.material_input.retained_public.land.entries.push({}); }, TypeError);
  input.snapshot.subject_data.pg_text = '{}';
  assert.deepEqual(result.material_input, material);
});
test('extra broad manual values stay original while all material branches remain complete', () => {
  const a = inputs(), b = inputs();
  for (let i = 0; i < 3; i++) { setSection(a, i, '{}'); setSection(b, i, '{"ignored":1e999999,"__proto__":{"x":9007199254740993}}'); }
  const expected = emptyObjectSections();
  represented(a, expected); represented(b, expected);
});
for (const [text, reason] of [['{}', 'public_snapshot_missing'], ['{"custom_property_snapshot":null}', 'public_snapshot_json_null'],
  ['{"custom_property_snapshot":[]}', 'public_snapshot_root_type'], ['{"custom_property_snapshot":false}', 'public_snapshot_root_type']]) {
  test(`public root refuses ${reason} for ${text}`, () => { const i = inputs(); i.snapshot.subject_data = pg(text); refusal(i, reason); });
}
for (const [state, text, reason] of [['sql_null', null, 'section_sql_null'], ['json_null', 'null', 'section_json_null'],
  ['present', '[]', 'section_root_type'], ['present', 'false', 'section_root_type']]) {
  test(`manual source distinguishes ${reason}`, () => { const i = setSection(inputs(), 1, '{}');
    i.sections[1].row.section_value = { state, pg_text: text }; refusal(i, reason); });
}
for (const key of ['subject_data', 'source_manifest']) for (const [state, text, reason] of [
  ['sql_null', null, 'snapshot_sql_null'], ['json_null', 'null', 'snapshot_json_null'], ['present', '[]', 'snapshot_root_type']]) {
  test(`${key} retains unsupported ${state}/${text}`, () => { const i = inputs(); i.snapshot[key] = { state, pg_text: text }; refusal(i, reason); });
}
test('PgJsonbCell contradictions are never normalized into consistent null', () => {
  for (const cell of [{ state: 'present', pg_text: null }, { state: 'present', pg_text: 'null' },
    { state: 'present', pg_text: ' null ' }, { state: 'json_null', pg_text: ' null ' },
    { state: 'sql_null', pg_text: 'null' }, { state: 'other', pg_text: '{}' }]) {
    const i = setSection(inputs(), 0, '{}'); i.sections[0].row.section_value = cell;
    refusal(i, 'storage_state_mismatch', 'invalid_input');
  }
});
test('manual null ancestors and empty arrays are preserved without descendant fallbacks', () => {
  const i = inputs(); setSection(i, 1, '{"main_improvement":null,"housing_profile":null,"additional_improvements":[]}');
  setPublic(i, { improvement: { living_area_sqft: 2000 }, housing_profile: { housing_type: 'public' } });
  const expected = emptyMaterial(); expected.assignment_sections.property_characteristics = { storage_state: 'object', projection: {
    main_improvement: nullCell(), housing_profile: nullCell(), additional_improvements: { state: 'present', entries: [] } } };
  expected.retained_public.improvement = present({ ...emptyMain(), living_area_sqft: present(2000) });
  expected.retained_public.housing_profile = present({ ...emptyHousing(), housing_type: present('public') });
  const result = represented(i, expected); assert.equal(result.usage.selected_scalar_count, 0);
});
test('manual scalar null/zero/text-zero versus deletion remain material transitions', () => {
  const materials = [];
  for (const value of ['null', '0', '"0"', '""']) {
    const i = setSection(inputs(), 1, '{"main_improvement":{"living_area_sqft":' + value + '}}');
    const r = run(i); assert.equal(r.status, 'represented'); materials.push(canonical(r.material_input));
    assert.equal(r.usage.selected_scalar_count, 1);
  }
  const absent = run(setSection(inputs(), 1, '{"main_improvement":{}}'));
  assert.equal(absent.status, 'represented'); materials.push(canonical(absent.material_input));
  assert.equal(new Set(materials).size, 5);
});
test('numeric scale can compare equally without making JSON text equal to a number', () => {
  const f = token => run(setSection(inputs(), 1, '{"main_improvement":{"year_built":' + token + '}}'));
  const a = f('1990.0'), b = f('1990'), c = f('"1990"');
  assert.equal(a.status, 'represented'); assert.equal(b.status, 'represented'); assert.equal(c.status, 'represented');
  assert.deepEqual(a.material_input, b.material_input); assert.notDeepEqual(a.material_input, c.material_input);
  assert.equal(a.usage.selected_token_utf8_bytes, 6); assert.equal(b.usage.selected_token_utf8_bytes, 4);
});
for (const [token, reason, status] of [['9007199254740993', 'inexact_numeric', 'unsupported'],
  ['-0', 'negative_zero', 'unsupported'], ['1e-324', 'numeric_underflow', 'unsupported'],
  ['1e999999', 'numeric_exponent_limit', 'limit_exceeded'], ['1'.repeat(257), 'numeric_token_limit', 'limit_exceeded']]) {
  test(`selected numeric refuses ${reason}, excluded numeric stays original`, () => {
    refusal(setSection(inputs(), 1, '{"main_improvement":{"year_built":' + token + '}}'), reason, status);
    const i = setSection(inputs(), 1, '{"unconsumed":' + token + '}');
    assert.equal(run(i).status, 'represented');
  });
}
test('same unconsumed inexact number anywhere in either complete snapshot cell refuses', () => {
  for (const key of ['subject_data', 'source_manifest']) {
    const i = inputs(); i.snapshot[key] = pg('{"custom_property_snapshot":{},"unused":9007199254740993}');
    refusal(i, 'inexact_numeric');
  }
});
for (const [text, reason] of [['{"ignored":[1,]}', 'invalid_json'], ['{"ignored":0,"ignored":1}', 'duplicate_json_key'],
  ['{"ignored":"\\ud800"}', 'invalid_unicode'], ['{"ignored":"\\u0000"}', 'invalid_unicode']]) {
  test(`excluded manual content is fully validated: ${reason}`, () => refusal(setSection(inputs(), 0, text), reason));
}
test('prototype-sensitive and numeric object keys cannot impersonate selected paths or array indexes', () => {
  const i = setSection(inputs(), 1, '{"__proto__":{"main_improvement":{"year_built":1990}},"constructor":{},"0":[]}');
  const expected = emptyMaterial(); expected.assignment_sections.property_characteristics = emptyObjectSections().assignment_sections.property_characteristics;
  represented(i, expected);
  refusal(setSection(inputs(), 0, '{"land_detail":{"0":{"area_sqft":1}}}'), 'selected_value_type');
});
for (const text of ['{"main_improvement":[]}', '{"main_improvement":false}', '{"main_improvement":{"year_built":false}}',
  '{"housing_profile":{"housing_type":1}}', '{"additional_improvements":[null]}']) {
  test(`selected wrong type refuses ${text}`, () => refusal(setSection(inputs(), 1, text), 'selected_value_type'));
}
test('LegalNode structural null is not a selected scalar; real Cell/line null is', () => {
  const cases = [
    ['{"legal_description":null}', 0, 0], ['{"legal_description":""}', 1, 2],
    ['{"legal_description":{"legal_description":null}}', 1, 4],
    ['{"legal_description":{"lines":[null]}}', 1, 4],
    ['{"legal_description":{"lines":null}}', 0, 0], ['{}', 0, 0],
  ];
  for (const [text, count, size] of cases) {
    const r = run(setSection(inputs(), 2, text)); assert.equal(r.status, 'represented');
    assert.equal(r.usage.selected_scalar_count, count); assert.equal(r.usage.selected_token_utf8_bytes, size);
  }
  refusal(setSection(inputs(), 2, '{"legal_description":{"lines":[{"text":"line"}]}}'), 'selected_value_type');
});
test('actual primitive legal lines preserve duplicates, empty values and contiguous ordinals', () => {
  const r = run(setSection(inputs(), 2, '{"legal_description":{"lines":["x",null,"x",""]}}'));
  assert.equal(r.status, 'represented');
  assert.deepEqual(r.material_input.assignment_sections.subject_identification.projection.legal_description.object.lines,
    { state: 'present', entries: ['x', null, 'x', ''].map((v, i) => ({ ordinal: String(i), fields: { text: v === null ? nullCell() : present(v) } })) });
});
test('whole-array occurrences preserve duplicate rows and distinct number spellings', () => {
  const { input, material } = richFixture(); represented(input, material);
  const rows = material.assignment_sections.land_details.projection.land_detail.entries;
  assert.deepEqual(rows[0].fields, rows[1].fields); assert.notEqual(rows[0].ordinal, rows[1].ordinal);
  assert.equal(rows[0].fields.number.value, 0); assert.equal(rows[0].fields.line_number.value, '0');
});
test('legal32K includes both public candidates and charges equal text repeatedly', () => {
  const i = setSection(inputs(), 2, JSON.stringify({ legal_description: { legal_description: 'x'.repeat(8000), lines: ['x'.repeat(8000)] } }));
  setPublic(i, { legal: { legal_description: 'x'.repeat(8000) }, account: { legal_description: 'x'.repeat(8000) } });
  assert.equal(run(i).status, 'represented');
  setPublic(i, { legal: { legal_description: 'x'.repeat(8001) }, account: { legal_description: 'x'.repeat(8000) } });
  refusal(i, 'legal_limit', 'limit_exceeded');
});
test('8192-byte individual text bound and decoded UTF-8 charging are independent', () => {
  for (const value of ['x'.repeat(8192), 'é'.repeat(4096)]) {
    const i = setSection(inputs(), 2, JSON.stringify({ legal_description: value }));
    assert.equal(run(i).status, 'represented');
    setSection(i, 2, JSON.stringify({ legal_description: value + 'x' })); refusal(i, 'text_limit', 'limit_exceeded');
  }
});
test('128 array occurrences are retained; the129th is never truncated', () => {
  const i = setSection(inputs(), 0, JSON.stringify({ land_detail: Array(128).fill({}) }));
  const r = run(i); assert.equal(r.status, 'represented');
  assert.equal(r.material_input.assignment_sections.land_details.projection.land_detail.entries.length, 128);
  setSection(i, 0, JSON.stringify({ land_detail: Array(129).fill({}) })); refusal(i, 'array_limit', 'limit_exceeded');
});
test('aggregate512 occurrences is independent of each per-array128 bound', () => {
  const i = inputs(); setSection(i, 0, JSON.stringify({ land_detail: Array(128).fill({}) }));
  setSection(i, 1, JSON.stringify({ additional_improvements: Array(128).fill({}) }));
  setPublic(i, { land: Array(128).fill({}), additional_improvements: Array(128).fill({}) });
  assert.equal(run(i).status, 'represented');
  setSection(i, 2, '{"legal_description":{"lines":[""]}}'); refusal(i, 'array_limit', 'limit_exceeded');
});
test('copied target, section row and snapshot bindings refuse complete but foreign originals', () => {
  const mutations = [i => { i.snapshot.id = target.report_file_id; }, i => { i.snapshot.appraisal_case_id = target.report_file_id; },
    i => { i.snapshot.snapshot_version = 2; }, i => { setSection(i, 0, '{}'); i.sections[0].row.assignment_file_id = '1'; },
    i => { setSection(i, 0, '{}'); i.sections[0].row.section_key = 'report.subject_identification'; },
    i => { setPublic(i, { account: { account_id: 'different' } }); }];
  for (const change of mutations) { const i = inputs(); change(i); refusal(i, 'target_mismatch', 'invalid_input'); }
});
test('nullable original source-report lineage is not a new current-report binding', () => {
  const i = inputs(); i.snapshot.source_report_file_id = target.organization_id;
  i.snapshot.verification_status = 'superseded'; represented(i, emptyMaterial());
});
test('same UUIDs normalize case while source account text is never trimmed', () => {
  const i = inputs(); i.target.organization_id = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
  i.target.report_file_id = 'ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDE1';
  const expected = emptyMaterial(); expected.report_file_id = i.target.report_file_id.toLowerCase(); represented(i, expected);
  setPublic(i, { account: { account_id: ' ' + target.account_id } }); refusal(i, 'target_mismatch', 'invalid_input');
});
test('exact closed wrappers, fixed roster and identifier grammar refuse silent dropping', () => {
  for (const mutation of [i => { i.target.extra = true; }, i => { delete i.snapshot.created_at; },
    i => { i.snapshot.subject_data.extra = true; }, i => { i.sections[0].row = {}; },
    i => { setSection(i, 0, '{}'); i.sections[0].row.created_at = null; }]) {
    const i = inputs(); mutation(i); refusal(i, 'invalid_shape', 'invalid_input');
  }
  for (const mutation of [i => { i.sections.reverse(); }, i => { i.sections.pop(); },
    i => { i.sections[1] = structuredClone(i.sections[0]); }]) {
    const i = inputs(); mutation(i); refusal(i, 'invalid_section_roster', 'invalid_input');
  }
  for (const value of ['01', '0', '9223372036854775808', 1]) {
    const i = inputs(); i.target.assignment_file_id = value; refusal(i, 'invalid_identifier', 'invalid_input');
  }
});
test('outer duplicate keys and unpaired Unicode are refused before schema filtering', () => {
  const args = argumentsOf(inputs());
  refusal(['{"workflow_type":"custom_appraisal",' + args[0].slice(1), ...args.slice(1)], 'duplicate_json_key');
  refusal([args[0], args[1], args[2].slice(0, -1) + ',"ignored":"\\ud800"}'], 'invalid_unicode');
});
test('argument count/primitives cannot trigger getters or coercion', () => {
  let calls = 0;
  const hostile = new Proxy({}, { get() { calls++; throw new Error('private'); }, ownKeys() { calls++; throw new Error('private'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); const args = argumentsOf(inputs());
  for (const value of [null, 1, 1n, Symbol('x'), new String(args[0]), hostile, revoked.proxy]) refusal([value, args[1], args[2]], 'invalid_argument', 'invalid_input');
  refusal(args.slice(0, 2), 'invalid_argument', 'invalid_input'); refusal([...args, {}], 'invalid_argument', 'invalid_input');
  assert.equal(calls, 0);
});
test('unconsumed audit dates and prose change originals but not complete material', () => {
  const a = setSection(inputs(), 1, '{"note":"a"}'), b = setSection(inputs(), 1, '{"note":"b"}');
  b.sections[1].row.revision = 10; b.sections[1].row.updated_at = 'infinity';
  b.sections[1].row.last_applied_session_id = target.organization_id;
  assert.deepEqual(run(a).material_input, run(b).material_input);
  assert.equal(run(b).status, 'represented');
});
test('snapshot finite dates validate without inventing case fallback or capture time', () => {
  const i = inputs(); i.snapshot.effective_date = '2024-02-29'; represented(i, emptyMaterial());
  i.snapshot.effective_date = '2023-02-29'; refusal(i, 'invalid_date_text');
  i.snapshot.effective_date = 'infinity'; refusal(i, 'invalid_date_text');
});
test('whole original target bytes4096 accepts whitespace;4097 refuses before parse', () => {
  const args = argumentsOf(inputs()); args[0] += ' '.repeat(4096 - bytes(args[0]));
  assert.equal(project(...args).status, 'represented');
  args[0] += ' '; refusal(args, 'input_bytes', 'limit_exceeded');
});
test('whole supplied section wrapper1.5MB accepts whitespace; its next byte refuses', () => {
  const args = argumentsOf(inputs()); args[1] += ' '.repeat(1500000 - bytes(args[1]));
  assert.equal(project(...args).status, 'represented');
  args[1] += ' '; refusal(args, 'input_bytes', 'limit_exceeded');
});
test('manual original100000-node index is admitted even when projection is empty', () => {
  const i = setSection(inputs(), 0, '{"unused":[' + Array(99998).fill('0').join(',') + ']}');
  const r = run(i); assert.equal(r.status, 'represented'); assert.equal(r.usage.index_nodes, 100000); assert.equal(r.usage.index_edges, 99999);
  setSection(i, 0, '{"unused":[' + Array(99999).fill('0').join(',') + ']}'); refusal(i, 'input_nodes', 'limit_exceeded');
});
test('manual unused subtree depth is bounded independently of tiny projected output', () => {
  const i = setSection(inputs(), 0, '{"unused":' + '['.repeat(34) + '0' + ']'.repeat(34) + '}');
  assert.equal(run(i).status, 'represented');
  setSection(i, 0, '{"unused":' + '['.repeat(35) + '0' + ']'.repeat(35) + '}'); refusal(i, 'input_depth', 'limit_exceeded');
});
test('combined complete snapshot preimage cannot evade the original node bound through two cells', () => {
  const i = inputs();
  i.snapshot.subject_data = pg('{"custom_property_snapshot":{},"unused":[' + Array(60000).fill('0').join(',') + ']}');
  i.snapshot.source_manifest = pg('{"unused":[' + Array(40000).fill('0').join(',') + ']}');
  refusal(i, 'snapshot_limit', 'limit_exceeded');
});
test('material body limit refuses untrimmed legal-independent retained strings', () => {
  const i = inputs(); const housing = Object.fromEntries(['structural_style', 'housing_type', 'attachment_type', 'architectural_style',
    'profile_source', 'source_name', 'source_url', 'source_record_reference', 'observed_at', 'confidence'].map(k => [k, 'x'.repeat(8192)]));
  setSection(i, 1, JSON.stringify({ housing_profile: housing })); setPublic(i, { housing_profile: housing });
  refusal(i, 'material_limit', 'limit_exceeded');
});

test('full-result128000 boundary includes usage and framing, while material independently fits', () => {
  function fixture(size) {
    const i = inputs(), expected = emptyMaterial(), housing = {}, account = {};
    expected.retained_public.housing_profile = present(emptyHousing());
    expected.retained_public.account = present(emptyAccount());
    expected.retained_public.improvement = present({ ...emptyMain(), year_built: present('p'.repeat(size)) });
    for (const key of ['structural_style', 'housing_type', 'attachment_type', 'architectural_style', 'profile_source',
      'source_name', 'source_url', 'source_record_reference', 'observed_at', 'confidence']) {
      housing[key] = 'h'.repeat(8192); expected.retained_public.housing_profile.value[key] = present(housing[key]);
    }
    for (const key of ['address', 'city', 'state', 'postal_code', 'county']) {
      account[key] = 'a'.repeat(8192); expected.retained_public.account.value[key] = present(account[key]);
    }
    setPublic(i, { housing_profile: housing, account, improvement: { year_built: 'p'.repeat(size) } });
    return { input: i, expected, result: predictedResult(i, expected) };
  }
  // Search only the independent literal expected-result recipe, not the API.
  let low = 0, high = 8192, best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2), size = bytes(canonical(fixture(mid).result));
    if (size <= 128000) { best = mid; low = mid + 1; } else high = mid - 1;
  }
  assert.ok(best >= 0 && best < 8192);
  const at = fixture(best), over = fixture(best + 1);
  assert.equal(bytes(canonical(at.result)), 128000);
  assert.equal(bytes(canonical(over.result)), 128001);
  assert.ok(bytes(canonical(over.expected)) < 128000);
  assert.deepEqual(represented(at.input, at.expected), at.result);
  refusal(over.input, 'output_limit', 'limit_exceeded');
});
test('cumulative500000 nodes includes complete originals and result, not just projected fields', () => {
  function fixture(count, extra = 0) {
    const i = inputs(), list = Array(99996).fill(0);
    for (let n = 0; n < 3; n++) {
      const value = { unused: list };
      if (n === 0) for (let k = 0; k < extra; k++) value['extra' + k] = 0;
      setSection(i, n, JSON.stringify(value));
    }
    setPublic(i, {}, { unused: Array(count).fill(0) });
    return { input: i, expected: emptyObjectSections() };
  }
  const start = fixture(0), fixed = predictedResult(start.input, start.expected).usage.processed_value_nodes;
  const extra = (500000 - fixed) % 2, count = (500000 - fixed - extra) / 2;
  assert.ok(Number.isInteger(count) && count > 0 && count < 99980);
  const at = fixture(count, extra), expected = predictedResult(at.input, at.expected);
  assert.equal(expected.usage.processed_value_nodes, 500000);
  assert.deepEqual(represented(at.input, at.expected), expected);
  const over = fixture(count, extra + 1), predicted = predictedResult(over.input, over.expected);
  assert.equal(predicted.usage.processed_value_nodes, 500001);
  refusal(over.input, 'cumulative_limit', 'limit_exceeded');
});
for (const length of [64, 65, 100]) test(`generic Custom target account length${length} is retained exactly`, () => {
  const i = inputs(); i.target.account_id = 'a'.repeat(length);
  setPublic(i, { account: { account_id: i.target.account_id } });
  const expected = emptyMaterial(); expected.account_id = i.target.account_id;
  expected.retained_public.account = present({ ...emptyAccount(), account_id: present(i.target.account_id) });
  represented(i, expected);
});
test('generic Custom target account101 refuses; the catalog64 ceiling is not imported', () => {
  const i = inputs(); i.target.account_id = 'a'.repeat(101); refusal(i, 'invalid_identifier', 'invalid_input');
});

test('canonical assignment identifiers reject trailing line terminators in targets and section rows', () => {
  for (const suffix of ['\n', '\r', '\u2028', '\u2029', ' ']) {
    const targetInput = inputs();
    targetInput.target.assignment_file_id = '1' + suffix;
    refusal(targetInput, 'invalid_identifier', 'invalid_input');

    const rowInput = setSection(inputs(), 0, '{}');
    rowInput.target.assignment_file_id = '1';
    rowInput.sections[0].row.assignment_file_id = '1' + suffix;
    refusal(rowInput, 'invalid_identifier', 'invalid_input');
  }
  const valid = setSection(inputs(), 0, '{}');
  valid.target.assignment_file_id = '1';
  valid.sections[0].row.assignment_file_id = '1';
  assert.equal(run(valid).status, 'represented');
});

test('snapshot checksums require exactly64 hex characters without trailing line terminators', () => {
  for (const suffix of ['\n', '\r', '\u2028', '\u2029', ' ']) {
    const i = inputs();
    i.snapshot.checksum_sha256 = 'a'.repeat(64) + suffix;
    refusal(i, 'invalid_identifier', 'invalid_input');
  }
  const valid = inputs();
  valid.snapshot.checksum_sha256 = 'a'.repeat(64);
  represented(valid, emptyMaterial());
});
