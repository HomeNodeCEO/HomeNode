import test from 'node:test';
import assert from 'node:assert/strict';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { buildCustomCohortObservationPreview, buildCustomCohortIndexedObservationPreview,
  buildCustomCohortIndexedObservationPreviewBatched, customCohortObservationMembers as members } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortReportedSharedSales } from '../src/services/neighborhoodAssessment/customCohortReportedSharedSales.js';
import { prepareCustomCohortAssessmentPreparation } from '../src/services/neighborhoodAssessment/customCohortAssessmentPreparation.js';

const argsOf = f => ({ context_ref: f.input.expected.context_ref, retained_inputs: f.input.retained_inputs,
  selection: { revision: f.input.selection.revision, pockets: [] } });
const reported = (f, selected = f.base.accountIds) => buildCustomCohortReportedSharedSales({
  retained_inputs: f.input.retained_inputs, selected_account_ids: selected });
const cell = (output, field) => output.rows[0].data.observations[field];
const sources = f => f.input.retained_inputs.acquisition.capture_result.source_capture.sources;
const row = (f, role) => sources(f).find(source => source.payload.projection.definition.role === role).payload.records[0];
function expandedPopulation(view, population) {
  const result = { ...population };
  for (const kind of ['stock', 'transactions', 'source_reported']) {
    const { member_indices, omitted_indices, ...fields } = population[kind];
    result[kind] = { ...fields, members: members(view, population, kind),
      ...(kind === 'transactions' ? { omitted: members(view, population, 'omitted_transactions') } : {}) };
  }
  return result;
}
let combined;
const fixture = () => combined ??= cadEvidenceFixture({ mappingVersion: 5 });

test('genuine combined capture/reopen reaches observation, catalog and preparation without granting Apply', async () => {
  const f = await fixture(), before = JSON.stringify(f.input);
  assert.deepEqual(f.input.retained_inputs, f.originalRetained);
  assert.equal(JSON.parse(f.input.retained_inputs.acquisition.compact_metadata_json).mapping_version, 5);
  assert.equal(row(f, 'transactions').data.raw_projection.source_raw_witness.witness_version, 2);
  const preparation = prepareCustomCohortAssessmentPreparation(f.input);
  for (const result of [f.preview, f.catalog, preparation]) {
    assert.equal(result.authority, 'not_established');
    assert.equal(result.apply.status, 'blocked');
  }
  assert.equal(preparation.assessment, null); assert.equal(preparation.publication, null);
  assert.ok(Object.values(preparation.runtime_requirements).every(value => value === 'not_checked'));
  assert.equal(JSON.stringify(f.input), before); assert.equal(f.base.f.state.calls.length, 0);
});

test('combined indexed and batched previews exactly match the ordinary full-population consumer', async () => {
  const f = await fixture(), args = argsOf(f);
  args.selection.pockets = [{ id: 'selected-subject-pocket', label: 'Selected subject pocket', account_ids: [f.base.accountIds[0]] }];
  const ordinary = buildCustomCohortObservationPreview(args);
  // These representations intentionally differ; compare the public summary and
  // exact member tables rather than assuming an index is itself an HTTP payload.
  const indexed = buildCustomCohortIndexedObservationPreview(args);
  const batched = await buildCustomCohortIndexedObservationPreviewBatched(args);
  assert.deepEqual(batched, indexed);
  assert.deepEqual(expandedPopulation(indexed, indexed.all), ordinary.all);
  assert.deepEqual(expandedPopulation(indexed, indexed.selected), ordinary.selected);
  assert.equal(ordinary.selected.stock.member_count, 1);
  assert.ok(ordinary.all.stock.member_count > ordinary.selected.stock.member_count);
  assert.deepEqual(indexed.pockets.map(pocket => ({ ...pocket, result: expandedPopulation(indexed, pocket.result) })), ordinary.pockets);
  assert.deepEqual(indexed.observation_period, ordinary.observation_period);
  assert.deepEqual(indexed.unavailable_metrics, ordinary.unavailable_metrics);
});

test('combined raw labels cannot qualify surviving typed prices or area and remain visibly unverified', async () => {
  const f = await cadEvidenceFixture({ mappingVersion: 5,
    rawPayload: { ClosePrice: '888888', CurrentPrice: '999999', Currency: 'USD', PriceCurrency: 'CAD',
      ClosePriceCurrency: 'USD', CurrentPriceCurrency: 'EUR', LivingArea: '2', LivingAreaUnits: 'Square Meters',
      LotSizeArea: '0.5', LotSizeUnits: 'Acres', MlsStatus: 'Closed', CloseDate: '2024-03-01' },
    saleOverrides: { source_current_price: '275000', source_living_area: '1850.125', source_lot_size_area: '6000' } });
  const output = reported(f);
  assert.equal(output.rows[0].data.mapping_version, 5);
  for (const [field, value] of [['reported_current_price', '275000'], ['reported_living_area', '1850.125'],
    ['reported_site_area', '6000']]) {
    assert.equal(cell(output, field).state, 'unsupported'); assert.equal(cell(output, field).exact_value, value);
    assert.equal(cell(output, field).unit, null); assert.equal(output.metrics[field].observed_count, 0);
    assert.equal(output.metrics[field].median, null);
  }
  assert.equal(cell(output, 'reported_close_price').exact_value, null);
  assert.equal(cell(output, 'reported_close_price').reason, 'raw_witness_close_price_not_interpreted_by_this_profile');
  assert.equal(f.preview.all.source_reported.metrics.lot_size_area.label, 'Source-reported lot area; units not verified');
  assert.equal(f.preview.all.source_reported.metrics.lot_size_area.unit, null);
  assert.equal(f.preview.all.source_reported.metrics.lot_size_area.median, 6000);
  assert.equal(f.preview.unavailable_metrics.sale_price_per_square_foot, 'property_sale_price_and_gla_at_sale_not_verified');
});

test('combined ClosePrice absence/null/blank is missing, not a canonical or current-price fallback', async () => {
  for (const rawPayload of [{}, { ClosePrice: null }, { ClosePrice: '  ' }]) {
    const output = reported(await cadEvidenceFixture({ mappingVersion: 5, rawPayload }));
    assert.equal(cell(output, 'reported_close_price').state, 'missing');
    assert.equal(cell(output, 'reported_close_price').reason, 'raw_witness_close_price_missing');
    assert.equal(cell(output, 'reported_close_price').exact_value, null);
  }
  for (const rawPayload of [null, { ClosePrice: [] }, { ClosePrice: 'x'.repeat(513) }]) {
    const output = reported(await cadEvidenceFixture({ mappingVersion: 5, rawPayload }));
    assert.equal(cell(output, 'reported_close_price').state, 'unsupported');
    assert.equal(cell(output, 'reported_close_price').exact_value, null);
  }
});

test('combined selection conserves source-account membership and keeps an explicit empty choice empty', async () => {
  const f = await fixture(), all = reported(f), empty = reported(f, []);
  assert.deepEqual(all.rows[0].accounts, [f.base.accountIds[0], 'R-LINKED-ONLY']);
  assert.equal(empty.rows.length, 0); assert.equal(empty.disposition_counts.outside_selection, 1);
  for (const metric of Object.values(all.metrics)) assert.equal(metric.observed_count + metric.missing_count
    + metric.invalid_count + metric.conflicting_count + metric.unsupported_count, all.rows.length);
  for (const metric of Object.values(empty.metrics)) {
    assert.equal(metric.observed_count + metric.missing_count + metric.invalid_count + metric.conflicting_count
      + metric.unsupported_count, 0); assert.equal(metric.median, null);
  }
});

test('old CAD observations and their statistics remain unchanged alongside an independently acquired combined capture', async () => {
  const old = await cadEvidenceFixture(), before = JSON.stringify(old.input), f = await fixture();
  assert.deepEqual(f.catalog.pockets, old.catalog.pockets);
  const previous = prepareCustomCohortAssessmentPreparation(old.input);
  assert.deepEqual(prepareCustomCohortAssessmentPreparation(f.input).observations, previous.observations);
  assert.deepEqual(f.preview.all.stock.metrics, old.preview.all.stock.metrics);
  assert.deepEqual(f.preview.all.transactions.metrics, old.preview.all.transactions.metrics);
  const oldSales = reported(old), nextSales = reported(f);
  for (const name of Object.keys(oldSales.metrics).filter(name => name !== 'reported_close_price')) {
    assert.deepEqual(nextSales.metrics[name], oldSales.metrics[name]);
  }
  assert.equal(JSON.stringify(old.input), before);
});

for (const [name, mutate] of [
  ['old compact metadata', f => {
    const acquisition = f.input.retained_inputs.acquisition, metadata = JSON.parse(acquisition.compact_metadata_json);
    metadata.mapping_version = 4; acquisition.compact_metadata_json = JSON.stringify(metadata);
  }],
  ['old projection metadata', f => { sources(f).find(source => source.payload.projection.definition.role === 'accounts')
    .payload.projection.definition.mapping_version = 4; }],
  ['old mapped transaction wrapper', f => { row(f, 'transactions').data.data.cached_mapping_version = 4; }],
]) test(`combined consumers refuse ${name} instead of relabeling an old result`, async () => {
  const f = await fixture(), changed = { input: structuredClone(f.input), base: { accountIds: f.base.accountIds } }; mutate(changed);
  assert.throws(() => buildCustomCohortObservationPreview(argsOf(changed)));
  assert.throws(() => reported(changed));
  assert.throws(() => prepareCustomCohortAssessmentPreparation(changed.input));
});
