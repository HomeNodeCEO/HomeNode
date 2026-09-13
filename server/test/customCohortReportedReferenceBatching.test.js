import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomCohortReportedAssessment as build, buildCustomCohortReportedAssessmentBatched as batched }
  from '../src/services/neighborhoodAssessment/customCohortReportedAssessment.js';
import { assessmentEvidenceDigest as digest } from '../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortIndexedObservationPreview as preview, customCohortIndexedObservationPreviewBatches as previewBatches,
  customCohortObservationMembers } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortSelectionCatalog, customCohortSelectionCatalogBatches } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { customCohortObservationRecordLimit } from '../src/services/neighborhoodAssessment/customCohortObservationMapping.js';
import { customCohortReportedSharedSalesBatches } from '../src/services/neighborhoodAssessment/customCohortReportedSharedSales.js';
import { recommendationFixture } from './fixtures/customCohortDenseRecommendationFixture.js';
import { customCohortReportedAssessmentFixture } from './fixtures/customCohortReportedAssessmentFixture.js';

// Pre-change synchronous full-result hashes and cooperative check counts from
// 111c08a. These are original fixed baselines, not another edited implementation.
const BASELINES = {
  normal: {
    0: [92, 'ce12cd4dc53b25f74a2922627b3d89419eb5db694a99c82562f6f0c36f075bcf'],
    124: [110, '761f98ed8d334d56c236f1bb61f57beb10f14fe9dd60cae28cd9e7b2a75f85d6'],
    125: [126, 'd1f24e45d4148339d5042409de5f3f9ea7a1e25a444b779e6fd3d35c3e2d47eb'],
    126: [134, '826d2e40111701c99e95ec85422bb0019cf8c46ddec78b07f46b5ea3c9cfe73c'],
    250: [158, 'da68eaa5fba7596257aa0d5dafb09d7bf1dca7abb846c2e5146a77f4e9f1d08a'],
    251: [166, 'd96e5a3f0542ece4da5850700bb9e69bd142257b307e8aac30d61b95591ad320'],
  },
  dense: {
    0: [92, '7b872e1c56bf818b3e1ceaeb5bc264e3502a9c84756e6dab9731e59d0d98a289'],
    124: [110, '745a329a37e7be87c27b86929c62f75c01b4a5b28e772128bdcdc0c2c8465a66'],
    125: [126, '10e99a33472afa904051914a7b965e7a0d2c438963116d7b6a944ed311690db0'],
    126: [134, '354eb918b066137b1bb7bb150ed566abdb292ab85804b2bcf70f65be392b84c3'],
    250: [158, '1983fb0edad500475cc33e03b4d304e8e094aee2a07b95677be75f935fc33ede'],
    251: [166, '942053cb7dac3e2221e91a89936a980cbbd04b7265daec9949afe5af7c0ed0d6'],
  },
};
const cadMembers = result => result.publication_bundle.members.filter(row => row.population_id === 'selected-cad-accounts');
const capturedSubject = (await customCohortReportedAssessmentFixture({ effectiveDate: '2026-09-06' })).input;

// Bounded consumer-level originals from the existing real source/mapping
// builders. Mapping4 declares its dense policy at construction, never by
// relabeling retained metadata. Reuse the independently admitted subject and
// geography only after proving exact source scope. These are not new native
// acquisition, authorization, retention or large-area capacity tests.
function fixture(count, dense, parcelChanges = {}) {
  const subject = capturedSubject.retained_inputs.subject;
  const accounts = count ? [subject.target.account_id,
    ...Array.from({ length: count - 1 }, (_, index) => `REFERENCE-${String(index + 1).padStart(4, '0')}`)] : [];
  const f = recommendationFixture({ accounts, subject: subject.target.account_id, mapping4: dense,
    names: Object.fromEntries(accounts.map(id => [id, 'Synthetic reference group'])), ...parcelChanges });
  assert.deepEqual(f.retained_inputs.acquisition.captured_query_request.scope, capturedSubject.target.scope);
  const retained_inputs = { ...f.retained_inputs, subject };
  assert.equal(customCohortObservationRecordLimit(retained_inputs.acquisition) > 100_000, dense);
  const discovery = preview({ context_ref: f.context_ref, retained_inputs, selection: { revision: 1, pockets: [] } });
  const catalog = buildCustomCohortSelectionCatalog({ retained_inputs, preview: discovery, catalog_version: 2 });
  assert.equal(catalog.catalog_complete, true);
  const input = { ...capturedSubject, context_ref: f.context_ref, retained_inputs, catalog_version: 2,
    selection: { revision: 1, included_recorded_group_ids: [...catalog.pockets.map(pocket => pocket.id),
      ...(catalog.unassigned.member_count ? ['discovery:unassigned'] : [])] } };
  return { input, accounts, discovery };
}
function frozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); }
}
function drain(iterator) {
  let checkpoints = 0;
  for (;;) {
    const step = iterator.next();
    if (step.done) return { value: step.value, checkpoints };
    assert.equal(step.value, undefined); checkpoints++;
  }
}
function firstReferenceCheck(input, accounts) {
  const discovery = drain(previewBatches({ context_ref: input.context_ref, retained_inputs: input.retained_inputs,
    selection: { revision: 1, pockets: [] } }));
  const selected = drain(previewBatches({ context_ref: input.context_ref, retained_inputs: input.retained_inputs,
    selection: { revision: 1, pockets: [{ id: 'reported-selected-accounts', label: 'Selected retained accounts', account_ids: accounts }] } }));
  const catalog = drain(customCohortSelectionCatalogBatches({ retained_inputs: input.retained_inputs,
    preview: discovery.value, catalog_version: input.catalog_version }));
  // Actual current wrapper: two seal checks, paired next checks, and one
  // explicit report yields after previews and before selected-preview startup.
  // The independently delegated catalog contributes its actual checkpoints.
  // The next post-check
  // is the first new 125-row reference checkpoint, not a global stage label.
  return 2 + 2 * (discovery.checkpoints + 1 + catalog.checkpoints + 1 + selected.checkpoints + 1 + 1);
}

for (const dense of [false, true]) for (const count of [0, 124, 125, 126, 250, 251]) {
  test(`${dense ? 'dense reference' : 'normal full-row'} ${count} accounts preserve original full report and exact new checkpoint count`, async () => {
    const f = fixture(count, dense), before = JSON.stringify(f.input);
    const expected = build(f.input), [oldChecks, oldHash] = BASELINES[dense ? 'dense' : 'normal'][count];
    assert.equal(expected.status, 'ready'); assert.equal(digest(expected), oldHash);
    let checks = 0;
    const result = await batched(f.input, { check() { checks++; } });
    // The separate shared-sales scheduling change delegates its own existing
    // kernel now, as does the catalog. Account for those exact checkpoints without weakening the
    // original full-result hash or the 125-account reference budget.
    const shared = drain(customCohortReportedSharedSalesBatches({
      retained_inputs: f.input.retained_inputs, selected_account_ids: f.accounts,
    }));
    const catalog = drain(customCohortSelectionCatalogBatches({ retained_inputs: f.input.retained_inputs,
      preview: f.discovery, catalog_version: f.input.catalog_version }));
    assert.equal(checks, oldChecks + 2 * Math.floor(count / 125) + 2 * shared.checkpoints + 2 * (catalog.checkpoints + 1));
    assert.deepEqual(result, expected); assert.equal(digest(result), oldHash); assert.equal(JSON.stringify(f.input), before);
    const members = cadMembers(result), originals = new Map(customCohortObservationMembers(f.discovery, f.discovery.all, 'stock')
      .map(row => [row.account_id, row]));
    assert.equal(members.length, count); assert.deepEqual(members.map(row => row.member_id), [...f.accounts].sort());
    for (const member of members) {
      assert.deepEqual(member.account_ids, [member.member_id]);
      if (dense) {
        const reference = member.member_data.retained_account_observation_reference, original = originals.get(member.member_id);
        assert.equal(reference.representation_version, 1); assert.equal(reference.retained_preview_member_sha256, digest(original));
        assert.equal(Object.hasOwn(member.member_data, 'captured_account_observations'), false);
        for (const name of ['gla_sqft', 'site_area_sqft', 'year_built']) assert.deepEqual(reference.observations[name],
          { state: original.observations[name].state, exact_value: original.observations[name].exact_value });
      } else {
        assert.deepEqual(member.member_data.captured_account_observations, originals.get(member.member_id));
        assert.equal(Object.hasOwn(member.member_data, 'retained_account_observation_reference'), false);
      }
    }
    frozen(result);
  });
}

for (const dense of [false, true]) test(`${dense ? 'dense' : 'normal'} cancellation occurs at each new reference checkpoint with no partial result or changed retry`, async () => {
  const f = fixture(251, dense), expected = build(f.input), originalBytes = JSON.stringify(f.input);
  const first = firstReferenceCheck(f.input, f.accounts);
  for (const stop of [first, first + 2]) {
    const controller = new AbortController(), failure = new Error(`synthetic reference cancellation ${stop}`);
    let checks = 0, serviced = false, completed = false;
    await assert.rejects(batched(f.input, { check() {
      checks++; controller.signal.throwIfAborted();
      if (checks === stop) setImmediate(() => { serviced = true; controller.abort(failure); });
    } }).then(value => { completed = true; return value; }), error => error === failure);
    assert.equal(serviced, true); assert.equal(completed, false); assert.equal(checks, stop + 1);
    assert.equal(JSON.stringify(f.input), originalBytes);
  }
  assert.deepEqual(await batched(f.input), expected);
});

test('dense reference batches retain duplicate parcels and conflict/missing cells while hashing unused original facts and provenance', async () => {
  const subject = capturedSubject.retained_inputs.subject.target.account_id;
  const parcels = [
    { account_id: subject, residential_year_built: null, residential_area_sqft: '1800.123456789012', parcel_area_sqft: '4000',
      current_market_value: '330000', source_record_hash: 'a'.repeat(64) },
    { account_id: subject, residential_year_built: null, residential_area_sqft: '1800.123456789012', parcel_area_sqft: '5000',
      current_market_value: '330000', source_record_hash: 'a'.repeat(64) },
  ];
  const f = fixture(1, true, { parcels }), expected = build(f.input), original = customCohortObservationMembers(f.discovery, f.discovery.all, 'stock')[0];
  assert.equal(original.parcel_object_ids.length, 2);
  const reference = cadMembers(await batched(f.input))[0].member_data.retained_account_observation_reference;
  assert.equal(reference.retained_preview_member_sha256, digest(original));
  assert.equal(reference.observations.site_area_sqft.state, 'conflicting');
  assert.equal(reference.observations.year_built.state, 'missing');
  assert.equal(reference.observations.gla_sqft.exact_value, '1800.123456789012');
  for (const change of [{ current_market_value: '440000' }, { source_record_hash: 'b'.repeat(64) }]) {
    const changed = fixture(1, true, { parcels: parcels.map(row => ({ ...row, ...change })) });
    const changedResult = await batched(changed.input), changedReference = cadMembers(changedResult)[0].member_data.retained_account_observation_reference;
    assert.deepEqual(changedReference.observations, reference.observations);
    assert.notEqual(changedReference.retained_preview_member_sha256, reference.retained_preview_member_sha256);
    assert.notEqual(digest(changedResult), digest(expected));
  }
});

test('existing original-capture private-sales report remains byte-identical through the unchanged synchronous and async APIs', async () => {
  const { input } = await customCohortReportedAssessmentFixture({ privateRows: [{ ClosePrice: '123456.789' }] });
  const expectedHash = '0527067c558f600ac2c3445e24c50cc691468862e49f7a4c1523dc8756aab726';
  assert.equal(digest(build(input)), expectedHash); assert.equal(digest(await batched(input)), expectedHash);
});
