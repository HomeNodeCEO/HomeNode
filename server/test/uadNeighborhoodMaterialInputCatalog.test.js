import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as actualModule from '../src/modules/uad/neighborhoodMaterialInputCatalog.js';
import { UAD_PHASE_ONE_FIELDS } from '../src/modules/uad/fieldCatalog.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { assertNeighborhoodJsonbStorage } from '../src/services/neighborhoodAssessment/jsonbStorage.js';

// Independent literals transcribed from the frozen 38-template contract before
// any execution. These are templates, not expanded observations or readiness.
const EXPECTED = Object.freeze([
  ['dwelling', '0300.0011', 'dwelling'],
  ['dwelling', '0300.0012', 'dwelling'],
  ['dwelling', '0300.0034', 'dwelling'],
  ['dwelling', '0300.0035', 'dwelling'],
  ['dwelling', '0300.0063', 'dwelling'],
  ['site', '1500.0020', null],
  ['site', '1500.0021', null],
  ['site', '1500.0093', null],
  ['site', '1500.0094', null],
  ['site', '1500.0095', null],
  ['site_parcel', '1500.0022', 'site_parcel'],
  ['site_parcel', '1500.0023', 'site_parcel'],
  ['site_parcel', '1500.0024', 'site_parcel'],
  ['site_parcel', '1500.0027', 'site_parcel'],
  ['subject', '0100.0019', null],
  ['subject', '0100.0020', null],
  ['subject', '0100.0021', null],
  ['subject', '0100.0022', null],
  ['subject', '0100.0047', null],
  ['subject', '0300.0010', null],
  ['subject', '0300.0066', null],
  ['subject', '2500.0168', null],
  ['subject_address', '0100.0007', null],
  ['subject_address', '0100.0008', null],
  ['subject_address', '0100.0009', null],
  ['subject_address', '0100.0011', null],
  ['subject_address', '0100.0012', null],
  ['subject_address', '1200.0052', null],
  ['subject_legal', '0100.0067', null],
  ['unit', '0700.0089', 'unit'],
  ['unit', '0700.0140', 'unit'],
  ['unit', '0700.0141', 'unit'],
  ['unit', '0700.0142', 'unit'],
  ['unit', '0700.0143', 'unit'],
  ['unit', '0700.0144', 'unit'],
  ['unit', '1800.0398', 'unit'],
  ['unit_area_data_source', '0700.0125', 'unit_area_data_source'],
  ['unit_area_data_source', '0700.0126', 'unit_area_data_source'],
].map(tuple => Object.freeze(tuple)));
const ROSTERS = Object.freeze(['dwelling', 'outbuilding', 'property', 'site_parcel', 'unit', 'unit_area_data_source']);
const RELEASE = 'uad-3.6-2026-08-13-h1.5';
const PREFIX = 'uad_neighborhood_material_catalog:';
const sourceUrl = new URL('../src/modules/uad/neighborhoodMaterialInputCatalog.js', import.meta.url);
const getCatalog = actualModule.getUadNeighborhoodMaterialCatalogV1;

// Capture values, child identities, descriptor flags and freeze states before
// invoking the getter. A shallow frozen top-level catalog does not protect its
// shared nested options/conditions from an accidental deep-freeze regression.
function snapshotGraph(root) {
  const entries = new Map();
  function visit(value) {
    if (value === null || typeof value !== 'object' || entries.has(value)) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    entries.set(value, {
      descriptors, keys: Reflect.ownKeys(value), prototype: Object.getPrototypeOf(value),
      frozen: Object.isFrozen(value), extensible: Object.isExtensible(value),
    });
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (Object.hasOwn(descriptor, 'value')) visit(descriptor.value);
    }
  }
  visit(root);
  return entries;
}
const originalGraph = snapshotGraph(UAD_PHASE_ONE_FIELDS);
function unchanged(graph) {
  for (const [object, before] of graph) {
    assert.deepEqual(Reflect.ownKeys(object), before.keys);
    assert.equal(Object.getPrototypeOf(object), before.prototype);
    assert.equal(Object.isFrozen(object), before.frozen);
    assert.equal(Object.isExtensible(object), before.extensible);
    for (const key of before.keys) {
      const now = Object.getOwnPropertyDescriptor(object, key);
      const prior = before.descriptors[key];
      assert.deepEqual(Reflect.ownKeys(now), Reflect.ownKeys(prior));
      for (const flag of Reflect.ownKeys(prior)) assert.equal(now[flag], prior[flag]);
    }
  }
}
afterEach(() => unchanged(originalGraph));

function ownedFrozen(root, forbidden = originalGraph) {
  const objects = new Set();
  function visit(value) {
    if (value === null || typeof value !== 'object') return;
    assert.equal(forbidden.has(value), false, 'result must not share source objects');
    assert.equal(objects.has(value), false, 'each result occurrence must be independently owned');
    objects.add(value);
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
    for (const child of Object.values(value)) visit(child);
  }
  visit(root);
  return objects;
}
function definition(result, context, uid) {
  const found = result.field_templates.filter(field => field.context_key === context && field.uid === uid);
  assert.equal(found.length, 1);
  return found[0].catalog_definition;
}
function selectedSource() {
  return EXPECTED.map(([context, uid]) => {
    const matches = UAD_PHASE_ONE_FIELDS.filter(field => field.contextKey === context && field.uid === uid);
    assert.equal(matches.length, 1, `independent source slot ${context}:${uid}`);
    return structuredClone(matches[0]);
  });
}
function rejectsFixed(fn, reason) {
  assert.throws(fn, error => {
    assert.equal(error.constructor, TypeError);
    assert.equal(error.message, PREFIX + reason);
    assert.equal(Object.hasOwn(error, 'code'), false);
    return true;
  });
}
function countNodes(value) {
  if (value === null || typeof value !== 'object') return 1;
  return 1 + Object.values(value).reduce((sum, child) => sum + countNodes(child), 0);
}
function maxDepth(value) {
  if (value === null || typeof value !== 'object' || Object.values(value).length === 0) return 0;
  return 1 + Math.max(...Object.values(value).map(maxDepth));
}
function contentBytes(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value === null || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((sum, [key, child]) => sum +
    (Array.isArray(value) ? 0 : Buffer.byteLength(key, 'utf8')) + contentBytes(child), 0);
}
const canonicalBytes = value => Buffer.byteLength(canonicalAssessmentJson(value), 'utf8');

// Only the four documented import specifiers are replaced. The production
// implementation body, its exports and both shared storage helpers stay real.
// These isolated trusted-source defects are not a public caller-catalog API.
let graphSequence = 0;
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function isolated({ mutate = '', release = RELEASE } = {}) {
  const source = await readFile(sourceUrl, 'utf8');
  const sequence = ++graphSequence;
  const catalogUrl = dataUrl(`let fields = ${JSON.stringify(selectedSource())};\n${mutate}\nexport const UAD_PHASE_ONE_FIELDS = fields;\n// graph ${sequence}`);
  const constantsUrl = dataUrl(`export const CURRENT_UAD_RELEASE_KEY = ${JSON.stringify(release)};\n// graph ${sequence}`);
  const replacements = new Map([
    ["'./fieldCatalog.js'", `'${catalogUrl}'`],
    ["'./constants.js'", `'${constantsUrl}'`],
    ["'../../services/neighborhoodAssessment/contract.js'", `'${new URL('../../services/neighborhoodAssessment/contract.js', sourceUrl).href}'`],
    ["'../../services/neighborhoodAssessment/jsonbStorage.js'", `'${new URL('../../services/neighborhoodAssessment/jsonbStorage.js', sourceUrl).href}'`],
  ]);
  let linked = source;
  for (const [specifier, replacement] of replacements) {
    assert.equal(source.split(specifier).length - 1, 1, `finite import replacement: ${specifier}`);
    linked = linked.replace(specifier, replacement);
  }
  const module = await import(dataUrl(linked + `\n// isolated graph ${sequence}`));
  const catalog = (await import(catalogUrl)).UAD_PHASE_ONE_FIELDS;
  assert.deepEqual(Object.keys(module), ['getUadNeighborhoodMaterialCatalogV1']);
  assert.equal(await readFile(sourceUrl, 'utf8'), source, 'isolated graph must not edit source');
  return { get: module.getUadNeighborhoodMaterialCatalogV1, catalog };
}

test('real module exposes only the zero-input catalog API and exact non-authoritative descriptor', () => {
  assert.deepEqual(Object.keys(actualModule), ['getUadNeighborhoodMaterialCatalogV1']);
  const result = getCatalog();
  assert.deepEqual(Object.keys(result).sort(), [
    'accepted_evidence', 'descriptor_version', 'field_templates', 'interpretation',
    'material_limits', 'profile_id', 'profile_revision', 'roster_templates', 'specification_release_key',
  ]);
  assert.equal(result.descriptor_version, 1);
  assert.equal(result.interpretation, 'catalog_only');
  assert.equal(result.profile_id, 'uad-neighborhood-physical-stock-inputs-v1');
  assert.equal(result.profile_revision, '1');
  assert.equal(result.specification_release_key, RELEASE);
  assert.deepEqual(result.field_templates.map(f => [f.context_key, f.uid, f.entity_type]), EXPECTED);
  assert.equal(result.field_templates.filter(f => f.entity_type === null).length, 20);
  assert.deepEqual(result.roster_templates, ROSTERS.map(entity_type => ({ entity_type, data_projection: {} })));
  assert.deepEqual(result.accepted_evidence, []);
  assert.deepEqual(result.material_limits, {
    field_observations: 2048, entity_members: 128,
    consumed_value_utf8_bytes: 32000, source_reference_utf8_bytes: 8192,
    canonical_utf8_bytes: 1500000, nodes: 100000, depth: 35, jsonb_utf8_bytes: 2000000,
  });
  for (const field of result.field_templates) {
    assert.deepEqual(Object.keys(field).sort(), ['catalog_definition', 'context_key', 'entity_type', 'uid']);
    const original = UAD_PHASE_ONE_FIELDS.find(f => f.contextKey === field.context_key && f.uid === field.uid);
    assert.deepEqual(field.catalog_definition, original, 'complete metadata, not a preferred subset');
  }
  ownedFrozen(result);
  assert.ok(canonicalBytes(result) <= 128000);
  assert.ok(countNodes(result) <= 25000);
  assert.ok(maxDepth(result) <= 16);
  assert.ok(assertNeighborhoodJsonbStorage(result) <= 2000000);
});

test('literal source metadata pins retain enums, years, constraints, defaults, sources and conditional units', () => {
  const result = getCatalog();
  const address = definition(result, 'subject_address', '0100.0007');
  assert.equal(address.sourcePath, 'account.address');
  assert.equal(address.maxLength, 100);
  assert.equal(address.required, true);
  assert.deepEqual(definition(result, 'subject', '0100.0020').options, ['Attached', 'Detached']);
  assert.equal(definition(result, 'subject', '0100.0022').fallbackValue, 1);
  assert.equal(definition(result, 'subject', '0100.0022').sourcePath, 'primary_improvements.number_units');
  const year = definition(result, 'dwelling', '0300.0011');
  assert.equal(year.dataType, 'year');
  assert.equal(year.maxLength, 4);
  assert.equal(year.required, true);
  const stories = definition(result, 'dwelling', '0300.0063');
  assert.equal(stories.minimum, 1);
  assert.equal(stories.maximum, 99);
  const area = definition(result, 'site', '1500.0093');
  assert.deepEqual(area.units, ['Acres', 'Hectares', 'SquareFeet', 'SquareMeters']);
  assert.equal(area.minimumExclusive, 0);
  assert.deepEqual(area.requiredWhen, { key: 'subject:0100.0047', equals: false });
  assert.deepEqual(definition(result, 'site', '1500.0020').options, ['BodyOfWater', 'Other', 'OtherParcel', 'Road']);
  assert.deepEqual(definition(result, 'site', '1500.0095').showWhen, { key: 'site:1500.0094', greaterThan: 1 });
  const finished = definition(result, 'unit', '0700.0140');
  assert.deepEqual(finished.units, ['SquareFeet']);
  assert.equal(finished.minimum, 0);
  assert.equal(finished.required, true);
  const sourceOther = definition(result, 'unit_area_data_source', '0700.0126');
  assert.equal(sourceOther.maxLength, 66);
  assert.deepEqual(sourceOther.requiredWhen, { key: 'unit_area_data_source:0700.0125', equals: 'Other' });
});

test('every call returns fresh deeply frozen ownership without freezing or mutating original metadata', () => {
  const first = getCatalog();
  const firstObjects = ownedFrozen(first);
  const second = getCatalog();
  ownedFrozen(second, firstObjects);
  ownedFrozen(second);
  assert.deepEqual(second, first);
  assert.throws(() => { first.field_templates[0].catalog_definition.label = 'changed'; }, TypeError);
  assert.throws(() => { first.roster_templates[0].data_projection.x = 1; }, TypeError);
  assert.throws(() => first.accepted_evidence.push('authority'), TypeError);
  unchanged(originalGraph);
});

test('nonzero arguments fail before reading caller objects, including explicit undefined and callbacks', () => {
  let touches = 0;
  const caller = new Proxy({}, {
    get() { touches++; throw Error('caller secret'); },
    ownKeys() { touches++; throw Error('caller secret'); },
    getPrototypeOf() { touches++; throw Error('caller secret'); },
  });
  for (const value of [undefined, null, false, 0, '', {}, [], caller, () => { touches++; }]) {
    rejectsFixed(() => getCatalog(value), 'invalid_argument');
  }
  rejectsFixed(() => getCatalog(undefined, undefined), 'invalid_argument');
  assert.equal(touches, 0);
});

test('isolated graph uses real helpers and preserves agreement when source order is reversed', async () => {
  const { get } = await isolated({ mutate: 'fields.reverse();' });
  assert.deepEqual(get(), getCatalog());
});

const identityDefects = [
  ['missing template', 'fields.splice(0, 1);'],
  ['duplicate template', 'fields.push(structuredClone(fields[0]));'],
  ['same context/UID duplicate with other entity type', "fields.push({...fields[0],entityType:'unit'});"],
  ['wrong context', "fields[0].contextKey='dwelling ';"],
  ['wrong UID', "fields[0].uid=' 0300.0011';"],
  ['wrong key', "fields[0].key='subject:0300.0011';"],
  ['missing key', 'delete fields[0].key;'],
  ['nonstring UID', 'fields[0].uid=3000011;'],
  ['entity type missing', 'delete fields[0].entityType;'],
  ['entity type null', 'fields[0].entityType=null;'],
  ['entity type undefined', 'fields[0].entityType=undefined;'],
  ['entity type wrong', "fields[0].entityType='unit';"],
  ['root explicit null', "fields.find(f=>f.contextKey==='site').entityType=null;"],
  ['root explicit undefined', "fields.find(f=>f.contextKey==='site').entityType=undefined;"],
  ['nonselected invalid identity', "fields.push({contextKey:'unselected',uid:9,key:'unselected:9'});"],
  ['nonselected missing identity', "fields.push({contextKey:'unselected',uid:'9'});"],
  ['catalog not array', 'fields={...fields};'],
  ['catalog sparse', 'delete fields[0];'],
  ['catalog extra property', 'fields.extra=true;'],
  ['catalog subclass prototype', 'Object.setPrototypeOf(fields, Object.create(Array.prototype));'],
  ['catalog accessor index', "Object.defineProperty(fields,'0',{enumerable:true,get(){throw Error('secret index');}});"],
  ['entry null', 'fields[0]=null;'],
  ['entry nonplain', 'Object.setPrototypeOf(fields[0], null);'],
  ['identity accessor', "Object.defineProperty(fields[0],'uid',{enumerable:true,get(){throw Error('secret UID');}});"],
];
for (const [label, mutate] of identityDefects) {
  test(`catalog mismatch: ${label}`, async () => {
    const { get } = await isolated({ mutate });
    rejectsFixed(get, 'catalog_mismatch');
  });
}
for (const release of ['old-release', '', null, 1, { value: RELEASE }]) {
  test(`release identity is exact (${JSON.stringify(release)})`, async () => {
    const { get } = await isolated({ release });
    rejectsFixed(get, 'release_mismatch');
  });
}

const metadataDefects = [
  ['undefined', 'undefined'], ['function', '()=>1'], ['symbol', "Symbol('secret')"],
  ['bigint', '1n'], ['NaN', 'NaN'], ['positive infinity', 'Infinity'],
  ['negative infinity', '-Infinity'], ['negative zero', '-0'],
  ['Date', "new Date('2026-01-01T00:00:00Z')"], ['Map', 'new Map()'],
  ['null prototype object', 'Object.create(null)'], ['boxed string', "new String('x')"],
  ['NUL value', "'x\\u0000y'"], ['lone high surrogate', "'x\\ud800'"],
  ['lone low surrogate', "'\\udc00x'"], ['invalid surrogate pair', "'\\ud800x'"],
];
for (const [label, expression] of metadataDefects) {
  test(`definition refuses ${label} without coercion`, async () => {
    const { get } = await isolated({ mutate: `fields[0].test_metadata=${expression};` });
    rejectsFixed(get, 'definition_not_json');
  });
}
const structuralDefects = [
  ['getter', "Object.defineProperty(fields[0],'test_metadata',{enumerable:true,get(){throw Error('secret getter');}});"],
  ['setter', "Object.defineProperty(fields[0],'test_metadata',{enumerable:true,set(v){throw Error('secret setter');}});"],
  ['nonenumerable metadata', "Object.defineProperty(fields[0],'test_metadata',{value:1,enumerable:false});"],
  ['symbol key', "fields[0][Symbol('secret')]=1;"],
  ['NUL key', "fields[0]['x\\u0000y']=1;"],
  ['surrogate key', "fields[0]['x\\ud800']=1;"],
  ['sparse nested array', 'fields[0].test_metadata=[,1];'],
  ['extra nested array property', 'fields[0].test_metadata=[1];fields[0].test_metadata.extra=2;'],
  ['nonenumerable array index', "fields[0].test_metadata=[1];Object.defineProperty(fields[0].test_metadata,'0',{enumerable:false});"],
  ['self cycle', 'fields[0].test_metadata=fields[0];'],
  ['indirect cycle', 'const a={};const b={a};a.b=b;fields[0].test_metadata=a;'],
];
for (const [label, mutate] of structuralDefects) {
  test(`definition refuses ${label} rather than dropping or invoking it`, async () => {
    const { get } = await isolated({ mutate });
    rejectsFixed(get, 'definition_not_json');
  });
}

test('complete copying preserves own __proto__, false, zero, null, empty and Unicode values safely', async () => {
  const { get, catalog } = await isolated({ mutate: `
    fields[0].test_metadata={falseValue:false,zero:0,nil:null,empty:'',array:[null,false,0,'','é😀'],emptyObject:{},emptyArray:[]};
    Object.defineProperty(fields[0].test_metadata,'__proto__',{enumerable:true,value:{marker:'own data'}});
  ` });
  const before = snapshotGraph(catalog);
  const result = get();
  const copied = result.field_templates[0].catalog_definition.test_metadata;
  assert.deepEqual(copied, catalog[0].test_metadata);
  assert.equal(Object.hasOwn(copied, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(copied), Object.prototype);
  assert.deepEqual(copied.__proto__, { marker: 'own data' });
  assert.equal(Object.prototype.marker, undefined);
  ownedFrozen(result, before);
  unchanged(before);
});

test('legitimate shared metadata is independently copied per occurrence, not rejected as cyclic', async () => {
  const { get, catalog } = await isolated({ mutate: `
    const shared={nested:['same',false,0,null]};
    fields[0].test_a=shared;fields[0].test_b=shared;fields[1].test_a=shared;
  ` });
  const before = snapshotGraph(catalog);
  const result = get();
  const a = result.field_templates[0].catalog_definition;
  const b = result.field_templates[1].catalog_definition;
  assert.deepEqual(a.test_a, a.test_b);
  assert.deepEqual(a.test_a, b.test_a);
  assert.notEqual(a.test_a, a.test_b);
  assert.notEqual(a.test_a.nested, b.test_a.nested);
  ownedFrozen(result, before);
  unchanged(before);
});

test('recomputation sees stub-source changes and does not cache a mutation-blind first result', async () => {
  const { get, catalog } = await isolated();
  const first = get();
  const oldLabel = first.field_templates[0].catalog_definition.label;
  catalog[0].label = 'changed test-only source';
  const second = get();
  assert.equal(second.field_templates[0].catalog_definition.label, 'changed test-only source');
  assert.equal(first.field_templates[0].catalog_definition.label, oldLabel);
  ownedFrozen(first);
  ownedFrozen(second, snapshotGraph(catalog));
  catalog[0].key = 'invalid-after-first-success';
  rejectsFixed(get, 'catalog_mismatch');
});

for (const thrown of [
  "new TypeError('uad_neighborhood_material_catalog:catalog_mismatch')",
  "Object.assign(new Error('private source path and secret'),{code:'definition_not_json',reason:'limit_exceeded'})",
  'null', 'undefined', "'uad_neighborhood_material_catalog:limit_exceeded'",
]) {
  test(`unexpected source exception cannot spoof a private refusal (${thrown})`, async () => {
    const { get } = await isolated({ mutate: `fields[0]=new Proxy(fields[0],{getPrototypeOf(){throw ${thrown};}});` });
    rejectsFixed(get, 'failed');
  });
}

test('full catalog accepts 4096 normal entries but rejects 4097 before selected copying', async () => {
  const filler = "while(fields.length < SIZE)fields.push({contextKey:'unselected',uid:'extra',key:'unselected:extra'});";
  const exact = await isolated({ mutate: filler.replace('SIZE', '4096') });
  assert.deepEqual(exact.get(), getCatalog());
  const over = await isolated({ mutate: filler.replace('SIZE', '4097') });
  rejectsFixed(over.get, 'limit_exceeded');
});

test('whole descriptor root-zero depth 16 passes and depth 17 fails', async () => {
  for (const [wrappers, expectedDepth] of [[12, 16], [13, 17]]) {
    const { get } = await isolated({ mutate: `let deep=null;for(let i=0;i<${wrappers};i++)deep={v:deep};fields[0].test_depth=deep;` });
    if (expectedDepth === 16) assert.equal(maxDepth(get()), 16);
    else rejectsFixed(get, 'limit_exceeded');
  }
});

test('whole descriptor 25000 value-node boundary counts containers/scalars, not keys', async () => {
  const baseline = (await isolated()).get();
  const length = 25000 - countNodes(baseline) - 1;
  assert.ok(length > 0);
  const { get } = await isolated({ mutate: `fields[0].test_nodes=Array(${length}).fill(0);` });
  const result = get();
  assert.equal(countNodes(result), 25000);
  assert.ok(canonicalBytes(result) < 128000);
  const over = await isolated({ mutate: `fields[0].test_nodes=Array(${length + 1}).fill(0);` });
  rejectsFixed(over.get, 'limit_exceeded');
});

test('exact final full-result canonical 128000 bytes passes; one more byte fails', async () => {
  const baseline = (await isolated({ mutate: "fields[0].test_text='';" })).get();
  const length = 128000 - canonicalBytes(baseline);
  assert.ok(length > 0);
  const { get } = await isolated({ mutate: `fields[0].test_text='x'.repeat(${length});` });
  const result = get();
  assert.equal(canonicalBytes(result), 128000);
  assert.ok(contentBytes(result) < 128000, 'final serialization, not aggregate text, is the binding limit');
  const over = await isolated({ mutate: `fields[0].test_text='x'.repeat(${length + 1});` });
  rejectsFixed(over.get, 'limit_exceeded');
});

test('escaped Unicode control text is charged at final serialized size, not merely UTF-8 payload', async () => {
  const baseline = (await isolated({ mutate: "fields[0].test_text='';" })).get();
  const available = 128000 - canonicalBytes(baseline);
  const escaped = Math.floor(available / 6);
  const tail = available % 6;
  const mutate = `fields[0].test_text='\\u0001'.repeat(${escaped})+'x'.repeat(${tail});`;
  const { get } = await isolated({ mutate });
  const result = get();
  assert.equal(canonicalBytes(result), 128000);
  assert.ok(contentBytes(result) < 128000);
  const over = await isolated({ mutate: mutate + "fields[0].test_text+='x';" });
  rejectsFixed(over.get, 'limit_exceeded');
});

for (const mutate of [
  "fields[0].test_text='x'.repeat(128001);",
  "fields[0].test_text='é'.repeat(64001);",
  "fields[0]['x'.repeat(128001)]=null;",
  "const shared={text:'x'.repeat(30000)};fields[0].test_repeated=[shared,shared,shared,shared,shared];",
]) {
  test(`bounded string/key/repeated-content copying (${mutate.slice(0, 55)})`, async () => {
    const { get } = await isolated({ mutate });
    rejectsFixed(get, 'limit_exceeded');
  });
}

test('independent real JSONB guard reaches exactly 2MB and refuses +1 despite compact descriptor fitting', async () => {
  // 1e308 is finite source-authored metadata. Its compact spelling fits the
  // descriptor but the real guard counts a 309-character PostgreSQL number.
  // This is storage-guard evidence, not a native PostgreSQL execution claim.
  const baseline = (await isolated({ mutate: "fields[0].test_expansion=[];fields[0].test_padding='';" })).get();
  const baselineBytes = assertNeighborhoodJsonbStorage(baseline);
  const numbers = Math.floor((2000000 - baselineBytes + 2) / 311);
  const padding = 2000000 - (baselineBytes + numbers * 311 - 2);
  assert.ok(numbers > 0 && padding >= 0 && padding < 311);
  const mutate = `fields[0].test_expansion=Array(${numbers}).fill(1e308);fields[0].test_padding='x'.repeat(${padding});`;
  const { get } = await isolated({ mutate });
  const result = get();
  assert.equal(assertNeighborhoodJsonbStorage(result), 2000000);
  assert.ok(canonicalBytes(result) < 128000);
  assert.ok(countNodes(result) < 25000);
  assert.ok(maxDepth(result) <= 16);
  const independentlyOver = structuredClone(result);
  independentlyOver.field_templates[0].catalog_definition.test_padding += 'x';
  assert.ok(canonicalBytes(independentlyOver) < 128000);
  assert.throws(() => assertNeighborhoodJsonbStorage(independentlyOver), { message: 'neighborhood_jsonb_storage_limit:bytes' });
  const over = await isolated({ mutate: mutate + "fields[0].test_padding+='x';" });
  rejectsFixed(over.get, 'limit_exceeded');
});
