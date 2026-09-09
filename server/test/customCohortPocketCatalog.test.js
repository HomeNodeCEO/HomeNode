import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomCohortPocketCatalog as build, presentCustomCohortPocketCatalog as present,
  CUSTOM_COHORT_POCKET_CATALOG_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { presentCustomCohortPreview } from '../src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { buildCustomCohortObservationPreview as preview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCachedSourceCaptures } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow, mapCachedSaleLinkRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { contextFixture } from './fixtures/customCohortContextFixture.js';

const NOW = '2026-09-06T08:00:00.123Z';
const context_ref = { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'e'.repeat(64) };
const parcel = (id, account = 'A', extra = {}) => ({ object_id: String(id), account_id: account,
  residential_year_built: 2000, residential_area_sqft: '1800.125', parcel_area_sqft: '6000.00', current_market_value: '330000.00', subdivision_name: 'Oak Creek', ...extra });
const sale = (id, account = 'A', extra = {}) => ({ source_record_id: String(id), sale_id: String(id),
  primary_account_id: account, sale_account_id: account, record_type: 'closed_sale', sale_closing_date: '2024-03-01',
  source_close_date: '2024-03-01', sale_price: '330000.00', source_current_price: '335000', source_living_area: '1800.125',
  source_lot_size_area: '.2', source_year_built: 2001, source_days_on_market: 0, ...extra });
const link = (id, source, account, extra = {}) => ({ parcel_link_id: String(id), source_record_id: String(source),
  source_position: 1, parcel_sequence: id, account_id: account, is_resolved: account !== null, match_method: 'exact', ...extra });

// Actual mapping-v2 and source-chunk builders, using the graph shape returned by
// the retained loader. These are observation tests, not claims of SQL/MVCC or
// original-acquisition authority; the numeric consumer has its own real loader round-trip regression.
function fixture({ accounts = ['A', 'B'], parcels = [parcel(1), parcel(2, 'B')], sales = [sale(1)], links = [], pockets, accountRows = accounts.map(account_id => ({ account_id, county: 'Dallas', subdivision: null })),
  start = '2023-07-01', end = '2024-06-30', subjectAccountId = accounts[0] ?? 'A' } = {}) {
  const target = { ...contextFixture().target, account_id: subjectAccountId, assignment_file_id: '17' };
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const wrap = (rows, mapper, prefix) => rows.map(row => {
    const mapped = mapper(row); return { record_id: `${prefix}:${mapped.record_id}`, data: mapped };
  });
  const groups = { selection: accounts.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: wrap(parcels, mapCachedParcelRow, 'parcel'), accounts: wrap(accountRows, mapCachedAccountRow, 'account'),
    transactions: wrap(sales, mapCachedSaleRow, 'sale'), sale_links: wrap(links, mapCachedSaleLinkRow, 'link'), gis_sync: [] };
  const capture = buildCachedSourceCaptures({ scope, captures: Object.entries(groups).map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'fixture-v2', content_sha256: 'a'.repeat(64), captured_at: NOW, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `local-cache-${role}`, provider: 'Synthetic local mirror', revision: 'fixture-v2', valid_from: null, valid_to: null,
      observed_at: NOW, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'fixture-v2', definition: { role }, complete: true,
      input_row_count: records.length, output_record_count: records.length }, records })) });
  assert.equal(capture.status, 'ready');
  return { context_ref, retained_inputs: { subject: { target, effective_date: '2024-06-30' },
    study: { observation_period: { start_date: start, end_date: end } }, spatial: { query_complete: true, account_ids: accounts,
      parcels: parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id })) },
    acquisition: { captured_query_request: { scope, account_ids: accounts },
      capture_result: { query_complete: true, captured_at: NOW, source_capture: capture } } },
  selection: { revision: 1, pockets: pockets ?? [{ id: 'pocket-a', label: 'Appraiser-selected A', account_ids: ['A'] }] } };
}

function catalog(options = {}) {
  const input = fixture({ ...options, pockets: options.pockets ?? [] });
  return build({ retained_inputs: input.retained_inputs, preview: preview(input) });
}
function args(options = {}) {
  const input = fixture({ ...options, pockets: options.pockets ?? [] });
  return { retained_inputs: input.retained_inputs, preview: preview(input) };
}

test('actual G mappings produce a review-only recorded-name group with complete member union', () => {
  const result = catalog();
  assert.equal(result.status, 'review_only'); assert.equal(result.catalog_complete, true);
  assert.equal(result.pockets.length, 1); assert.equal(result.pockets[0].label, 'Oak Creek');
  assert.deepEqual(result.pockets[0].account_ids, ['A', 'B']); assert.equal(result.pockets[0].member_count, 2);
  assert.equal(result.coverage.discovery_member_count, 2); assert.equal(result.coverage.assigned_account_count, 2);
  assert.equal(result.coverage.unassigned_account_count, 0); assert.equal(result.coverage.provider_coverage, 'not_established');
  assert.equal(result.pockets[0].disposition, 'needs_review'); assert.equal(result.pockets[0].competitive_eligibility, 'not_established');
  assert.equal(result.subject_membership.assigned_pocket_id, result.pockets[0].id);
  assert.equal(result.subject_membership.recorded_label_match_only, true);
  assert.deepEqual(result.subject_recorded_group_ids, [result.pockets[0].id]);
  assert.equal(result.geography, null); assert.equal(result.apply.status, 'blocked');
});

test('only case/whitespace differences merge; raw label and county variants are retained exactly', () => {
  const result = catalog({ accountRows: [{ account_id: 'A', county: ' DALLAS ', subdivision: ' OAK  CREEK ' },
    { account_id: 'B', county: 'dallas', subdivision: 'oak\tcreek' }],
  parcels: [parcel(1, 'A', { subdivision_name: 'Oak Creek' }), parcel(2, 'B', { subdivision_name: 'oak creek' })] });
  assert.equal(result.pockets.length, 1);
  assert.deepEqual(result.pockets[0].raw_label_variants, [' OAK  CREEK ', 'Oak Creek', 'oak\tcreek', 'oak creek'].sort());
  assert.deepEqual(result.pockets[0].raw_county_variants, [' DALLAS ', 'dallas']);
  assert.equal(result.pockets[0].normalized_label, 'oak creek'); assert.equal(result.pockets[0].normalized_county, 'dallas');
  assert.equal(result.coverage.conflicting_account_count, 0);
});

test('same recorded name in different known counties remains separate', () => {
  const result = catalog({ accountRows: [{ account_id: 'A', county: 'Dallas', subdivision: 'Oak Creek' },
    { account_id: 'B', county: 'Collin', subdivision: 'Oak Creek' }] });
  assert.equal(result.pockets.length, 2);
  assert.deepEqual(result.pockets.map(p => [p.normalized_county, p.account_ids]), [['collin', ['B']], ['dallas', ['A']]]);
  assert.notEqual(result.pockets[0].id, result.pockets[1].id);
});

test('county aliases, punctuation, accents and phase labels are not heuristically merged', () => {
  const accounts = ['A', 'B', 'C', 'D'], names = ['Oaks Phase 1', 'Oaks Phase 2', 'Oáks Phase 1', 'Oaks-Phase 1'];
  const result = catalog({ accounts, accountRows: accounts.map(account_id => ({ account_id, county: 'Dallas', subdivision: null })),
    parcels: accounts.map((id, i) => parcel(i + 1, id, { subdivision_name: names[i] })) });
  assert.equal(result.pockets.length, 4);
  const counties = catalog({ accountRows: [{ account_id: 'A', county: 'Dallas County', subdivision: 'Oak Creek' },
    { account_id: 'B', county: 'Dallas', subdivision: 'Oak Creek' }] });
  assert.equal(counties.pockets.length, 2);
});

test('account/parcel disagreements remain visible unassigned candidates, not invented legal membership', () => {
  const result = catalog({ accountRows: [{ account_id: 'A', county: 'Dallas', subdivision: 'Pine Grove' },
    { account_id: 'B', county: 'Dallas', subdivision: 'Oak Creek' }] });
  assert.equal(result.coverage.assigned_account_count, 1); assert.equal(result.coverage.conflicting_account_count, 1);
  assert.deepEqual(result.unassigned.account_ids, ['A']);
  assert.deepEqual(result.unassigned.details[0].raw_label_variants, ['Oak Creek', 'Pine Grove']);
  assert.ok(result.unassigned.details[0].reasons.includes('conflicting_recorded_subdivision_labels'));
  assert.equal(result.unassigned.details[0].candidate_pocket_ids.length, 2);
  assert.equal(result.subject_membership.status, 'conflicting_evidence'); assert.equal(result.subject_membership.assigned_pocket_id, null);
  assert.equal(result.subject_recorded_group_ids.length, 2);
  assert.ok(result.pockets.every(p => p.conflicting_account_count === 1));
  assert.equal(result.pockets.find(p => p.normalized_label === 'pine grove').member_count, 0);
});

test('multiple parcel labels for the same exact account are conflicting, never selected by first/oldest', () => {
  const result = catalog({ parcels: [parcel(1, 'A', { subdivision_name: 'Old Name' }), parcel(2, 'A', { subdivision_name: 'New Name' }), parcel(3, 'B')] });
  assert.deepEqual(result.unassigned.account_ids, ['A']); assert.equal(result.coverage.parcel_source_row_count, 3);
  assert.equal(result.subject_membership.assigned_pocket_id, null);
});

test('missing county never inherits the subject county or the dcad table name', () => {
  const result = catalog({ accountRows: [{ account_id: 'A', county: 'Dallas', subdivision: 'Oak Creek' },
    { account_id: 'B', county: null, subdivision: 'Oak Creek' }] });
  assert.deepEqual(result.pockets[0].account_ids, ['A']); assert.deepEqual(result.unassigned.account_ids, ['B']);
  assert.ok(result.unassigned.details[0].reasons.includes('county_unavailable'));
  assert.deepEqual(result.unassigned.details[0].raw_label_variants, ['Oak Creek']);
  assert.equal(result.coverage.accounts_with_known_county, 1);
});

test('empty account projection and missing labels keep all discovered members explicitly unassigned', () => {
  const noAccounts = catalog({ accountRows: [] });
  assert.equal(noAccounts.coverage.account_source_row_count, 0); assert.equal(noAccounts.coverage.accounts_with_account_row, 0);
  assert.deepEqual(noAccounts.unassigned.account_ids, ['A', 'B']); assert.equal(noAccounts.pockets.length, 0);
  const noNames = catalog({ parcels: [parcel(1, 'A', { subdivision_name: null }), parcel(2, 'B', { subdivision_name: '  ' })] });
  assert.deepEqual(noNames.unassigned.account_ids, ['A', 'B']); assert.equal(noNames.coverage.accounts_with_recorded_label, 0);
  assert.equal(noNames.subject_membership.status, 'unassigned');
});

test('explicit unknown placeholders stay unassigned but a meaningful name containing Unknown is retained', () => {
  const result = catalog({ parcels: [parcel(1, 'A', { subdivision_name: 'UNKNOWN' }), parcel(2, 'B', { subdivision_name: 'Unknown Acres' })] });
  assert.deepEqual(result.unassigned.account_ids, ['A']); assert.deepEqual(result.unassigned.details[0].raw_label_variants, ['UNKNOWN']);
  assert.equal(result.pockets[0].label, 'Unknown Acres'); assert.deepEqual(result.pockets[0].account_ids, ['B']);
});

test('known parcel label with absent account label is usable only as a partially observed recorded match', () => {
  const result = catalog();
  assert.equal(result.coverage.partially_observed_account_count, 2);
  assert.equal(result.pockets[0].partially_observed_account_count, 2);
  assert.equal(result.pockets[0].recorded_label_match_only, true);
});

test('case-sensitive, punctuated and leading-zero account IDs remain distinct and unchanged', () => {
  const accounts = ['0001', '1', 'R-001', 'r-001'];
  const result = catalog({ accounts, accountRows: accounts.map(account_id => ({ account_id, county: 'Collin', subdivision: 'Oak Creek' })),
    parcels: accounts.map((id, i) => parcel(i + 1, id)) });
  assert.deepEqual(result.pockets[0].account_ids, [...accounts].sort()); assert.equal(result.pockets[0].member_count, 4);
});

test('catalog coverage is broad discovery stock, never the selected pocket union', () => {
  const all = catalog(), selected = catalog({ pockets: [{ id: 'B-only', label: 'Manual B', account_ids: ['B'] }] });
  assert.deepEqual(all.coverage, selected.coverage); assert.deepEqual(all.pockets, selected.pockets);
  assert.equal(selected.coverage.stock_member_count, 2);
});

test('group identifiers are stable county/name keys independent of capture row order', () => {
  const first = catalog(), second = catalog({ parcels: [parcel(2, 'B'), parcel(1)] });
  assert.deepEqual(first.pockets, second.pockets);
});

test('member accounts form an exact disjoint union of assigned groups and unassigned discovery stock', () => {
  const accounts = ['A', 'B', 'C', 'D'];
  const result = catalog({ accounts, accountRows: accounts.map(account_id => ({ account_id, county: account_id === 'D' ? null : 'Dallas', subdivision: null })),
    parcels: [parcel(1), parcel(2, 'B', { subdivision_name: 'Pine Grove' }), parcel(3, 'C', { subdivision_name: null }), parcel(4, 'D')] });
  const union = [...result.pockets.flatMap(p => p.account_ids), ...result.unassigned.account_ids];
  assert.equal(new Set(union).size, accounts.length); assert.deepEqual(union.sort(), accounts);
  assert.equal(result.coverage.assigned_account_count + result.coverage.unassigned_account_count, accounts.length);
});

test('129 recorded groups return incomplete with the entire roster, not 128 clipped suggestions', () => {
  const accounts = Array.from({ length: 129 }, (_, i) => `A-${i}`);
  const result = catalog({ accounts, accountRows: accounts.map(account_id => ({ account_id, county: 'Dallas', subdivision: null })),
    parcels: accounts.map((id, i) => parcel(i + 1, id, { subdivision_name: `Recorded group ${i}` })) });
  assert.equal(result.status, 'incomplete'); assert.equal(result.catalog_complete, false);
  assert.deepEqual(result.reasons, ['pocket_count_limit']); assert.deepEqual(result.pockets, []);
  assert.deepEqual(result.unassigned.account_ids, accounts.sort()); assert.equal(result.unassigned.member_count, 129);
  assert.equal(result.unresolved_membership.roster_location, 'unassigned.account_ids');
  assert.equal(result.coverage.conflicting_account_count, null); assert.equal(result.unassigned.details_complete, false);
  assert.equal(result.subject_membership.status, 'catalog_incomplete');
});

test('overlong retained labels produce explicit incomplete whole-roster coverage without clipped names', () => {
  const result = catalog({ parcels: [parcel(1, 'A', { subdivision_name: 'x'.repeat(LIMITS.label_utf8_bytes + 1) }), parcel(2, 'B')] });
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.reasons, ['recorded_label_text_limit']);
  assert.deepEqual(result.pockets, []); assert.deepEqual(result.unassigned.account_ids, ['A', 'B']);
});

test('128 recorded groups are complete and the 129th alone causes whole-catalog refusal', () => {
  const accounts = Array.from({ length: 128 }, (_, i) => `A-${i}`);
  const result = catalog({ accounts, accountRows: accounts.map(account_id => ({ account_id, county: 'Dallas', subdivision: null })),
    parcels: accounts.map((id, i) => parcel(i + 1, id, { subdivision_name: `Recorded group ${i}` })) });
  assert.equal(result.status, 'review_only'); assert.equal(result.pockets.length, 128);
  assert.equal(result.coverage.assigned_account_count, 128); assert.equal(result.unassigned.member_count, 0);
});

test('excess raw case variants are incomplete, not a silently clipped variant list', () => {
  const names = Array.from({ length: 4096 }, (_, bits) => [...'abcdefghijkl']
    .map((letter, bit) => bits & (1 << bit) ? letter.toUpperCase() : letter).join(''));
  const result = catalog({ parcels: names.map((subdivision_name, index) => parcel(index + 1, 'A', { subdivision_name })) });
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.reasons, ['recorded_label_variant_limit']);
  assert.deepEqual(result.unassigned.account_ids, ['A', 'B']); assert.deepEqual(result.pockets, []);
});

test('empty discovery has an actual zero denominator, no unknown-to-zero conversion or invented subject group', () => {
  const result = catalog({ accounts: [], accountRows: [], parcels: [], sales: [] });
  assert.equal(result.status, 'review_only'); assert.equal(result.coverage.discovery_member_count, 0);
  assert.equal(result.coverage.assigned_account_count, 0); assert.equal(result.coverage.unassigned_account_count, 0);
  assert.deepEqual(result.pockets, []); assert.equal(result.subject_membership.status, 'not_in_discovery');
});

test('hostile or non-string source values do not become executable markup, strings by coercion, or zero', () => {
  const result = catalog({ accountRows: [{ account_id: 'A', county: 'Dallas', subdivision: { toString: 'NOT A LABEL' } },
    { account_id: 'B', county: 'Dallas', subdivision: '<script>alert(1)</script>' }],
  parcels: [parcel(1, 'A', { subdivision_name: null }), parcel(2, 'B', { subdivision_name: '<script>alert(1)</script>' })] });
  assert.deepEqual(result.unassigned.account_ids, ['A']); assert.ok(result.unassigned.details[0].reasons.includes('invalid_recorded_subdivision_label'));
  assert.equal(result.pockets[0].label, '<script>alert(1)</script>', 'plain recorded label; render as escaped text');
  assert.equal(result.coverage.conflicting_account_count, 0); assert.equal(result.coverage.invalid_account_count, 1);
});

test('sales, source names, legal descriptions, neighborhood codes and source keys are never label fallbacks or browser output', () => {
  const result = catalog({ accountRows: [{ account_id: 'A', county: 'Dallas', subdivision: null, legal_description: 'PRIVATE_DEED', neighborhood_code: 'PRIVATE_CODE' },
    { account_id: 'B', county: 'Dallas', subdivision: null }],
  parcels: [parcel(1, 'A', { subdivision_name: null }), parcel(2, 'B', { subdivision_name: null })],
  sales: [sale(1, 'A', { source_name: 'PRIVATE_MLS', source_housing_type: 'PRIVATE_GROUP', sale_closing_date: '1900-01-01' })] });
  assert.equal(result.pockets.length, 0);
  const encoded = JSON.stringify(result);
  for (const forbidden of ['PRIVATE_', '"source_ref":', '"source_record_id":', '"raw_projection":', '"coordinates":', '"geometry_sha256":']) {
    assert.ok(!encoded.includes(forbidden), forbidden);
  }
});

test('subject outside discovery gets no fabricated recorded-group identity', () => {
  const result = catalog({ subjectAccountId: 'SUBJECT-OUTSIDE' });
  assert.equal(result.subject_membership.status, 'not_in_discovery');
  assert.equal(result.subject_membership.assigned_pocket_id, null); assert.deepEqual(result.subject_recorded_group_ids, []);
});

for (const [name, change, pattern] of [
  ['different assignment', i => { i.preview.target.assignment_file_id = '999'; }, /target_mismatch/],
  ['different numeric source capture', i => { i.preview.source_snapshots[0].content_sha256 = 'f'.repeat(64); }, /preview_capture_mismatch/],
  ['different effective date', i => { i.preview.effective_date = '2024-01-01'; }, /preview_capture_mismatch/],
  ['filtered stock denominator', i => { i.preview.all.stock.members.pop(); i.preview.all.stock.member_count--; }, /stock_roster_mismatch/],
  ['unknown mapping version', i => { const source = i.retained_inputs.acquisition.capture_result.source_capture.sources.find(s => s.payload.projection.definition.role === 'parcels');
    source.payload.records[0].data.data.cached_mapping_version = 99; }, /mapping_v2_required/],
]) test(`rejects ${name} rather than combining different observations`, () => {
  const input = structuredClone(args()); change(input); assert.throws(() => build(input), pattern);
});

test('catalog is pure/frozen and produces no persistence, policy grant or statistical recommendation', () => {
  const input = args(), original = JSON.stringify(input), result = build(input);
  assert.equal(JSON.stringify(input), original); assert.ok(Object.isFrozen(result.pockets[0].account_ids));
  assert.equal(result.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
  assert.ok(result.limitations.includes('no_builder_hoa_phase_or_development_identity_inferred'));
});

function presentationArgs(options) {
  const input = args(options);
  return { catalog: build(input), preview: input.preview,
    expected: { context_ref: input.preview.context_ref, selection_revision: input.preview.selection_revision } };
}

test('compact actual catalog retains exact member union, counts and subject scope without raw variants or source details', () => {
  const input = presentationArgs({ accountRows: [
    { account_id: 'A', county: ' DALLAS ', subdivision: ' OAK  CREEK ' },
    { account_id: 'B', county: 'Dallas', subdivision: 'Conflicting recorded label' },
  ] });
  const original = JSON.stringify(input), result = present(input);
  assert.deepEqual(result.coverage, input.catalog.coverage);
  assert.deepEqual(result.subject_membership, input.catalog.subject_membership);
  assert.deepEqual(result.pockets.map(p => p.account_ids), input.catalog.pockets.map(p => p.account_ids));
  assert.deepEqual(result.unassigned.account_ids, input.catalog.unassigned.account_ids);
  assert.deepEqual(result.unassigned.reason_counts, input.catalog.unassigned.reason_counts);
  assert.deepEqual(result.presentation, { raw_variants_omitted: true, unassigned_details_omitted: true, membership_complete: true });
  assert.equal(result.unassigned.details_complete, false);
  const encoded = JSON.stringify(result);
  for (const key of ['raw_label_variants', 'raw_county_variants', 'normalized_label', 'normalized_county', 'raw_projection',
    'source_record_id', 'record_id', 'source_ref', 'market_decision', 'details']) assert.ok(!encoded.includes(`"${key}":`), key);
  assert.ok(Buffer.byteLength(encoded) < LIMITS.public_output_utf8_bytes);
  assert.equal(JSON.stringify(input), original); assert.ok(Object.isFrozen(result.pockets[0].account_ids));
});

test('compact catalog and numeric summary carry the identical context/selection fingerprint', () => {
  const input = presentationArgs({ pockets: [
    { id: 'z', label: 'Selected z', account_ids: ['B', 'A'] },
    { id: 'a', label: 'Selected a', account_ids: [] },
  ] });
  const result = present(input), summary = presentCustomCohortPreview(input);
  assert.deepEqual(result.binding, summary.binding);
  assert.notEqual(result.binding.selection_sha256, present(presentationArgs()).binding.selection_sha256);
  const changed = structuredClone(input); changed.expected.selection_revision++;
  assert.throws(() => present(changed), /selection_mismatch/);
  changed.expected.selection_revision--; changed.expected.context_ref.context_sha256 = 'a'.repeat(64);
  assert.throws(() => present(changed), /context_mismatch/);
});

test('compact catalog keeps full recorded 512-byte labels and exact empty/unknown coverage', () => {
  const label = 'é'.repeat(256);
  const result = present(presentationArgs({ parcels: [parcel(1, 'A', { subdivision_name: label }), parcel(2, 'B')] }));
  assert.ok(result.pockets.some(p => p.label === label));
  const empty = present(presentationArgs({ accounts: [], accountRows: [], parcels: [], sales: [] }));
  assert.equal(empty.coverage.discovery_member_count, 0); assert.equal(empty.unassigned.member_count, 0);
  assert.equal(empty.coverage.provider_coverage, 'not_established');
  const incomplete = present(presentationArgs({ parcels: [parcel(1, 'A', { subdivision_name: 'x'.repeat(513) }), parcel(2, 'B')] }));
  assert.equal(incomplete.status, 'incomplete'); assert.equal(incomplete.coverage.conflicting_account_count, null);
  assert.deepEqual(incomplete.unassigned.account_ids, ['A', 'B']);
  assert.deepEqual(incomplete.unresolved_membership, { roster_location: 'unassigned.account_ids', member_count: 2, reason: 'recorded_label_text_limit' });
});

test('compact projection whitelists internal records rather than forwarding private extension fields', () => {
  const input = structuredClone(presentationArgs());
  input.catalog.source_ref = 'PRIVATE'; input.catalog.coverage.source_token = 'PRIVATE';
  input.catalog.pockets[0].provider_record_key = 'PRIVATE'; input.catalog.subject_membership.source_id = 'PRIVATE';
  assert.ok(!JSON.stringify(present(input)).includes('PRIVATE'));
});

// Capacity-only projection fixtures use the actual builder output shape as a
// template. They do not claim native capture/retention of 37,500 CAD accounts.
function capacityPresentation(memberCount) {
  const input = structuredClone(presentationArgs());
  const template = input.catalog.pockets[0];
  const roster = Array.from({ length: memberCount }, (_, i) => `${String(i).padStart(6, '0')}${'a'.repeat(94)}`);
  input.catalog.pockets = Array.from({ length: 128 }, (_, i) => {
    const account_ids = roster.filter((_id, index) => index % 128 === i);
    return { ...template, id: `recorded-cad:${String(i).padStart(64, '0')}`, label: 'L'.repeat(512), county: 'C'.repeat(512),
      account_ids, member_count: account_ids.length };
  });
  input.catalog.coverage.discovery_member_count = memberCount;
  input.catalog.coverage.stock_member_count = memberCount;
  input.catalog.coverage.assigned_account_count = memberCount;
  input.catalog.discovered_group_count = 128;
  input.catalog.subject_membership.account_id = roster[0];
  return { input, roster };
}

test('public byte overflow returns the whole unresolved roster, not clipped groups', () => {
  const { input, roster } = capacityPresentation(37500);
  const result = present(input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.catalog_complete, false);
  assert.deepEqual(result.reasons, ['catalog_response_byte_limit']); assert.deepEqual(result.pockets, []);
  assert.deepEqual(result.unassigned.account_ids, roster); assert.equal(result.unassigned.member_count, 37500);
  assert.equal(result.subject_membership.assigned_pocket_id, null); assert.equal(result.subject_membership.status, 'catalog_incomplete');
  assert.equal(result.presentation.membership_complete, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.public_output_utf8_bytes);
});

test('an unresolved roster larger than the public ceiling is an explicit limit error, never partial success', () => {
  const { input } = capacityPresentation(40000);
  assert.throws(() => present(input), error => error.code === 'CUSTOM_COHORT_POCKET_CATALOG_LIMIT'
    && error.reason === 'catalog_transport_limit');
});
