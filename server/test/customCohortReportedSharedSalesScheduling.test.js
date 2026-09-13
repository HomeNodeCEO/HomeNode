import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson as canonical } from '../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortReportedSharedSales as legacy,
  buildCustomCohortReportedSharedSalesWitnessV2 as witness,
  customCohortReportedSharedSalesBatches as legacyBatches,
  customCohortReportedSharedSalesWitnessV2Batches as witnessBatches } from '../src/services/neighborhoodAssessment/customCohortReportedSharedSales.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';

const hash = output => createHash('sha256').update(canonical(output), 'utf8').digest('hex');
const payload = (overrides = {}) => ({ MlsStatus: 'Closed', CloseDate: '2024-03-01',
  ClosePrice: '300001.000000000001', ClosePriceCurrency: 'USD', CurrentPrice: '299999', CurrentPriceCurrency: 'USD',
  LivingArea: '180.5', LivingAreaUnits: 'Square Meters', LotSizeArea: '0.25', LotSizeUnits: 'Acres',
  YearBuilt: '1999', DaysOnMarket: '12', ...overrides });
const extra = (number, overrides = {}) => ({ source_record_id: String(10 + number), sale_id: String(20 + number),
  primary_account_id: '0000123456789', sale_account_id: '0000123456789', source_record_hash: 'c'.repeat(64),
  record_type: 'closed_sale', source_close_date: '2024-03-01', sale_closing_date: '2024-03-01',
  source_current_price: '888888', sale_price: '777777', source_living_area: '2222',
  source_year_built: 2002, source_days_on_market: 91, ...overrides });
const modes = [
  { name: 'legacy', useWitness: false, build: legacy, batches: legacyBatches },
  { name: 'witness2', useWitness: true, build: witness, batches: witnessBatches },
];
async function fixture(useWitness, options = {}) {
  const inputs = { effectiveDate: '2026-09-06', ...options };
  return useWitness ? cadEvidenceFixture({ mappingVersion: 5, rawPayload: payload(), ...inputs })
    : decisionEvidenceFixture(inputs);
}
const args = (f, selected = f.input.retained_inputs.spatial.account_ids) => ({
  retained_inputs: f.input.retained_inputs, selected_account_ids: [...selected],
});
function seal(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(seal); Object.freeze(value);
  }
  return value;
}
function frozen(value) {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen);
  }
}
function drain(stages) {
  let yields = 0;
  while (true) {
    const step = stages.next();
    if (step.done) return { result: step.value, yields };
    assert.equal(step.value, undefined, 'Internal checkpoints expose no partial source records or authority');
    yields++;
  }
}
// Test-only owner: the production report owner retains its existing sealing,
// budget, cleanup and final-rights fences. The iterator itself adds no scheduler.
async function consume(stages, { check = () => {}, onYield = () => {} } = {}) {
  let yields = 0;
  try {
    while (true) {
      check(); const step = stages.next(); check();
      if (step.done) return step.value;
      assert.equal(step.value, undefined);
      onYield(++yields);
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { stages.return(); }
}
const captureOf = input => input.retained_inputs.acquisition.capture_result.source_capture;
function traversalCounts(input, useWitness) {
  const capture = captureOf(input), groups = new Map();
  const routeCount = capture.references.reduce((n, route) => n + route.record_sources.length, 0);
  let recordCount = 0;
  for (const source of capture.sources) {
    recordCount += source.payload.records.length;
    if (source.payload.projection.definition.role !== 'transactions') continue;
    for (const row of source.payload.records) {
      const id = row.data.data.source_record_id;
      if (id !== null) groups.set(id, (groups.get(id) ?? 0) + 1);
    }
  }
  // Three fixed stage boundaries, all route/record rows, all groups including
  // exclusions, and every 125 checked witnesses across source boundaries.
  return { routeCount, recordCount, groupCount: groups.size,
    yields: 3 + Math.floor(routeCount / 125) + Math.floor(recordCount / 125) + Math.ceil(groups.size / 125)
      + (useWitness ? Math.floor([...groups.values()].reduce((n, count) => n + count, 0) / 125) : 0) };
}

// Full canonical outputs captured from the unchanged synchronous implementation
// at 111c08a before this refactor, not merely agreement between changed paths.
const goldens = {
  legacy: {
    small: '5fe9fd4a2070649950a23354f9369ae8da89f1d2ae23c7ed3d6520544cc87a8f',
    empty: '15aae1cc06c941834ad8a6fbde812b50b3fe9dd317c22393b448fc97ffd40b81',
    multi: '2fd6e8dbb174542961c04c81db28efaa6778e24a7ba2f5be6bf9918b8be6950b',
  },
  witness2: {
    small: '0ae0945dc42dc6228fbd7b2db4f38afa3fb5485bb2f527d9f9ab3ccc1b9e8106',
    empty: 'ea1040789fda9bf37544047ffb0cdd62fc110ec59539a09ba4afc59e934d3b7c',
    multi: '6796f8307d3821897296bfa7c598554c07bcffc1a7388189e2dafff2808c273b',
  },
};
for (const { name, useWitness, build, batches } of modes) {
  for (const shape of ['small', 'empty', 'multi']) test(`${name} ${shape} preserves pre-change bytes, complete associations and exact metrics`, async () => {
    const options = shape === 'multi' ? { extraTransactions: [extra(1), extra(2, { record_type: 'listing' })],
      ...(useWitness ? { saleWitnessesBySourceId: {
        '11': { rawPayload: payload({ LivingArea: '2000', LivingAreaUnits: 'sq ft', LotSizeArea: '43560', LotSizeUnits: 'sqft' }) },
        '12': { rawPayload: payload({ MlsStatus: 'Pending' }) },
      } } : {}) } : {};
    const f = await fixture(useWitness, options), input = seal(args(f, shape === 'empty' ? [] : undefined));
    const before = JSON.stringify(input), sync = build(input), completed = drain(batches(input));
    assert.equal(hash(sync), goldens[name][shape]); assert.equal(hash(completed.result), goldens[name][shape]);
    assert.deepEqual(completed.result, sync); assert.deepEqual(await consume(batches(input)), sync);
    assert.equal(completed.yields, traversalCounts(input, useWitness).yields);
    frozen(completed.result); assert.equal(JSON.stringify(input), before);
    if (shape !== 'empty') {
      assert.deepEqual(sync.rows[0].accounts, ['0000123456789', 'R-LINKED-ONLY']);
      assert.equal(sync.rows[0].data.unresolved_link_count, 1);
    }
    if (shape === 'multi') {
      assert.equal(sync.rows.length, 2); assert.equal(sync.disposition_counts.nonclosed, 1);
      if (useWitness) {
        assert.equal(sync.metrics.reported_living_area.observed_count, 2);
        assert.equal(sync.metrics.reported_living_area.unit, null);
        assert.equal(sync.metrics.reported_living_area.median, null);
        assert.deepEqual(sync.rows.map(row => row.data.observations.reported_living_area.unit), ['sqm', 'sqft']);
      }
    }
  });

  test(`${name} all excluded sources still yield and accept owner cancellation at every checkpoint`, async () => {
    const options = { extraTransactions: Array.from({ length: 250 }, (_, i) => extra(i + 1)) };
    // The CAD fixture has paginated SQL-result fakes; the older mapping2 base
    // intentionally supplies only a single small source-identity page.
    const f = useWitness ? await fixture(true, options)
      : await cadEvidenceFixture({ mappingVersion: 4, effectiveDate: '2026-09-06', ...options });
    const input = seal(args(f, [])), before = JSON.stringify(input), expected = build(input);
    const completed = drain(batches(input)), counts = traversalCounts(input, useWitness);
    assert.equal(counts.groupCount, 251); assert.equal(expected.disposition_counts.outside_selection, 251);
    assert.deepEqual(expected.rows, []); assert.deepEqual(completed.result, expected);
    assert.equal(completed.yields, counts.yields); assert.ok(completed.yields >= 10);
    for (let stop = 1; stop <= completed.yields; stop++) {
      const stages = batches(input), controller = new AbortController(), cancelled = new Error(`cancel-${name}-${stop}`);
      let lastYield = 0, serviced = false;
      await assert.rejects(consume(stages, {
        check: () => controller.signal.throwIfAborted(),
        onYield(n) {
          lastYield = n;
          if (n === stop) setImmediate(() => { serviced = true; controller.abort(cancelled); });
        },
      }), error => error === cancelled);
      assert.equal(serviced, true); assert.equal(lastYield, stop);
      assert.deepEqual(stages.next(), { done: true, value: undefined }, 'Finally closes the suspended kernel');
    }
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(await consume(batches(input)), expected, 'No partial output is reused by a later invocation');
  });

  test(`${name} non-sale records receive the same route and record checkpoints`, async () => {
    const f = await fixture(useWitness, { parcelCount: 375 }), input = seal(args(f, []));
    const counts = traversalCounts(input, useWitness), completed = drain(batches(input));
    assert.ok(counts.routeCount > 375); assert.ok(counts.recordCount > 375); assert.equal(counts.groupCount, 1);
    assert.equal(completed.yields, counts.yields); assert.ok(completed.yields >= 10);
    assert.deepEqual(completed.result, build(input)); assert.deepEqual(completed.result.rows, []);
  });
}

// Defensive pure-consumer fixtures only. These detached clones do not claim
// valid original hashes, owner admission, or SQL-supported duplicate wrappers.
// Actual acquisition above supplies one canonical wrapper per source identity.
function appendRows(input, role, count, change) {
  const capture = captureOf(input), source = capture.sources.find(s => s.payload.projection.definition.role === role);
  const original = source.payload.records[0];
  const offset = source.payload.records.length;
  const route = capture.references.find(r => r.record_sources.some(ref => ref.source_ref === source.id));
  const rows = [];
  for (let i = 0; i < count; i++) {
    const row = structuredClone(original); row.record_id = `synthetic-scheduling-${role}:${offset + i}`;
    change?.(row, i); source.payload.records.push(row);
    route.record_sources.push({ source_ref: source.id, record_id: row.record_id }); rows.push(row);
  }
  return rows;
}
async function duplicates() {
  const f = await fixture(true), input = structuredClone(args(f));
  const rows = appendRows(input, 'transactions', 250, (row, i) => {
    row.data.data.canonical_transaction_id = String(21 + i); row.data.raw_projection.sale_id = String(21 + i);
  });
  return { input, rows };
}

test('one large duplicate-witness group yields internally without collapsing any wrapper evidence', async () => {
  const { input } = await duplicates(); seal(input);
  const before = JSON.stringify(input), completed = drain(witnessBatches(input)), counts = traversalCounts(input, true);
  assert.equal(counts.groupCount, 1); assert.equal(completed.yields, counts.yields);
  const withoutWitnessChecks = traversalCounts(input, false).yields;
  assert.equal(completed.yields - withoutWitnessChecks, 2, '251 duplicate wrappers yield twice inside the one group');
  assert.equal(completed.result.rows.length, 1);
  assert.equal(completed.result.rows[0].data.canonical_transaction_ids.length, 251);
  assert.equal(completed.result.rows[0].data.retained_source_references.length, 252);
  assert.equal(completed.result.metrics.reported_close_price.observed_count, 1);
  assert.deepEqual(completed.result, witness(input));
  // All routing/record boundaries and the first group boundary precede the
  // two inner duplicate checkpoints; the final output boundary follows them.
  for (const stop of [withoutWitnessChecks, withoutWitnessChecks + 1]) {
    const stages = witnessBatches(input);
    for (let i = 0; i < stop; i++) assert.deepEqual(stages.next(), { done: false, value: undefined });
    const cancelled = new Error(`inside-witness-${stop}`);
    assert.throws(() => stages.throw(cancelled), error => error === cancelled);
    assert.deepEqual(stages.next(), { done: true, value: undefined });
  }
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(await consume(witnessBatches(input)), completed.result);
});

test('short duplicate groups share one invocation-wide witness checkpoint budget', async () => {
  const f = await fixture(true, { extraTransactions: [extra(1)] }), input = structuredClone(args(f, []));
  for (const sourceId of ['10', '11']) appendRows(input, 'transactions', 123, (row, i) => {
    row.data.raw_projection.source_record_id = sourceId; row.data.data.source_record_id = sourceId;
    row.data.raw_projection.sale_id = `${sourceId}${i + 100}`;
    row.data.data.canonical_transaction_id = row.data.raw_projection.sale_id;
  });
  seal(input);
  const before = JSON.stringify(input), counts = traversalCounts(input, true), completed = drain(witnessBatches(input));
  assert.equal(counts.groupCount, 2);
  assert.equal(completed.yields, traversalCounts(input, false).yields + 1,
    '124 + 124 wrappers require a checkpoint although neither group reaches 125');
  assert.equal(completed.result.disposition_counts.outside_selection, 2);
  assert.deepEqual(completed.result.rows, []); assert.deepEqual(completed.result, witness(input));
  // Routing and record checkpoints, the two stage boundaries and the first
  // group boundary precede the shared witness checkpoint. This is after the
  // first complete source and the first witness of the second source.
  const inner = Math.floor(counts.routeCount / 125) + Math.floor(counts.recordCount / 125) + 4;
  const stages = witnessBatches(input);
  for (let i = 0; i < inner; i++) assert.deepEqual(stages.next(), { done: false, value: undefined });
  const cancelled = new Error('cross-source-witness-budget');
  assert.throws(() => stages.throw(cancelled), error => error === cancelled);
  assert.deepEqual(stages.next(), { done: true, value: undefined });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(await consume(witnessBatches(input)), completed.result);
});

test('a late full-witness mismatch still refuses outside selection and after internal checkpoints', async () => {
  const { input, rows } = await duplicates(); input.selected_account_ids = [];
  rows.at(-1).data.raw_projection.source_raw_witness.fields.ListingId = {
    state: 'scalar', json_type: 'string', value_text: 'different-unused-listing', utf8_bytes: Buffer.byteLength('different-unused-listing'),
  };
  // Check the fixture literal's byte count so the failure is unequal complete
  // witnesses, not an earlier malformed witness-cell rejection.
  assert.equal(rows.at(-1).data.raw_projection.source_raw_witness.fields.ListingId.utf8_bytes, 24);
  seal(input);
  assert.throws(() => witness(input), /custom_cohort_reported_shared_sales_source_witness_mismatch/);
  let yields = 0;
  await assert.rejects(consume(witnessBatches(input), { onYield() { yields++; } }),
    /custom_cohort_reported_shared_sales_source_witness_mismatch/);
  assert.equal(yields, traversalCounts(input, true).yields - 1, 'Both duplicate checkpoints occur before the mismatch; final output never occurs');
});

test('all roles and routing are checked before an earlier transaction witness is interpreted', async () => {
  const { input, rows } = await duplicates(); input.selected_account_ids = [];
  rows.at(-1).data.raw_projection.source_raw_witness.witness_version = 1;
  const capture = captureOf(input), missing = capture.references.at(-1).record_sources.pop();
  assert.ok(missing);
  for (const [build, batches] of [[legacy, legacyBatches], [witness, witnessBatches]]) {
    assert.throws(() => build(input), /custom_cohort_reported_shared_sales_source_routing/);
    assert.throws(() => drain(batches(input)), /custom_cohort_reported_shared_sales_source_routing/);
  }
});

test('legacy source-less canonical rows consume checkpoints without fabricating source groups', async () => {
  const f = await fixture(true), input = structuredClone(args(f));
  appendRows(input, 'transactions', 250, row => { row.data.data.source_record_id = null; });
  seal(input);
  for (const { build, batches, useWitness } of modes) {
    const completed = drain(batches(input));
    assert.equal(completed.yields, traversalCounts(input, useWitness).yields);
    assert.equal(completed.result.rows.length, 1);
    assert.equal(completed.result.disposition_counts.legacy_source_record_unavailable, 250);
    assert.deepEqual(completed.result, build(input));
  }
});

for (const { name, useWitness, build, batches } of modes) test(`${name} malformed input and failure order remain synchronous/cooperative identical`, async () => {
  const f = await fixture(useWitness);
  for (const mutate of [
    input => { input.retained_inputs.acquisition.capture_result.query_complete = false; },
    input => { input.retained_inputs.spatial.query_complete = false; },
    input => { input.retained_inputs.acquisition.capture_result.source_capture.scope.account_id = 'foreign'; },
    input => { input.selected_account_ids = ['foreign']; },
    input => { input.selected_account_ids.push(input.selected_account_ids[0]); },
    input => { input.retained_inputs.study.observation_period.end_date = '2027-01-01'; },
    input => { input.retained_inputs.acquisition.capture_result.captured_at = '2026-09-31T00:00:00Z'; },
    input => { captureOf(input).sources[0].payload.projection.definition.role = 'foreign'; },
  ]) {
    const input = structuredClone(args(f)); mutate(input); seal(input);
    let expected;
    assert.throws(() => build(input), error => { expected = error; return true; });
    await assert.rejects(consume(batches(input)), error => error.constructor === expected.constructor
      && error.message === expected.message && error.code === expected.code && error.reason === expected.reason);
  }
  assert.throws(() => drain(batches()), /retained_capture/);
  if (!useWitness) {
    const input = seal(args(f));
    assert.throws(() => witness(input), /mapping5_required/);
    assert.throws(() => drain(witnessBatches(input)), /mapping5_required/);
  }
});
