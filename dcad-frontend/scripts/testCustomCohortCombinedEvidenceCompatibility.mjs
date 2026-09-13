import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { checkCustomCohortPocketCatalog as checkCatalog } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { checkCustomCohortCadEvidence as checkCad } from '../src/features/neighborhood/customCohortCadEvidence.ts';
import { cadEvidenceFixture } from '../../server/test/fixtures/customCohortCadEvidenceFixture.js';
import { buildCustomCohortPocketRecommendation as build } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation as present } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { presentCustomCohortCadEvidence } from '../../server/src/services/neighborhoodAssessment/customCohortCadEvidencePresentation.js';

const fixtures = new Map(), clone = value => structuredClone(value);
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(mappingVersion) {
  if (!fixtures.has(mappingVersion)) fixtures.set(mappingVersion, (async () => {
    // Genuine original capture/persist/reopen under the requested reader; no
    // existing capture is relabelled. SQL results are bounded synthetic fakes.
    const f = await cadEvidenceFixture({ mappingVersion, parcelOverrides: { class_code: 'A11',
      class_description: null, use_description: null, structure_type: null, built_up: null },
    ...(mappingVersion === 5 ? { rawPayload: { CurrentPrice: '999999', ClosePrice: '888888', Currency: 'USD',
      PriceCurrency: 'CAD', CurrentPriceCurrency: 'EUR', ClosePriceCurrency: '  ', LivingArea: '2',
      LivingAreaUnits: 'Square Meters', LotSizeArea: '3', LotSizeUnits: 'Acres', MlsStatus: 'Active',
      CloseDate: '2030-01-01', PropertySubType: 'Condominium' } } : {}) });
    assert.equal(JSON.parse(f.input.retained_inputs.acquisition.compact_metadata_json).mapping_version, mappingVersion);
    const original = JSON.stringify(f.input), context_ref = f.input.expected.context_ref;
    const expected = { context_ref, selection_revision: 7 };
    const catalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
    const kernel = build({ context_ref, retained_inputs: f.input.retained_inputs,
      selection: { revision: 7, included_recorded_group_ids: [] } });
    const recommendation = present({ recommendation: kernel, catalog, expected });
    const input = { accountId: f.input.expected.target.account_id, assignmentFileId: f.input.expected.target.assignment_file_id,
      contextRef: context_ref, selection: { revision: 7, pockets: [] } };
    const response = { status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
      context_ref, selection_revision: 7, subject_freshness: 'matched', catalog, recommendation, apply: { status: 'blocked' } };
    const checked = checkCatalog(response, input);
    assert.equal(JSON.stringify(f.input), original, 'original retained evidence remains unchanged');
    return { f, input, response, kernel, checked };
  })());
  return fixtures.get(mappingVersion);
}

test('legacy mapping4 browser result retains its exact pre-compatibility bytes', async () => {
  const f = await fixture(4);
  assert.equal(sha(f.checked.recommendation), '87eaf8d98d24926305a814caebf19bba9e0de86c2da99db9db5b6945f39f4b9e');
});

test('original mapping5 capture -> server producer -> browser preserves actual CAD/housing versions and unchanged calculations', async () => {
  const old = await fixture(4), f = await fixture(5), r = f.checked.recommendation;
  const retainedSale = f.f.input.retained_inputs.acquisition.capture_result.source_capture.sources
    .find(source => source.payload.projection.definition.role === 'transactions').payload.records[0].data.raw_projection;
  assert.equal(retainedSale.source_raw_witness.fields.PriceCurrency.value_text, 'CAD');
  assert.equal(retainedSale.source_raw_witness.fields.ClosePriceCurrency.value_text, '  ');
  assert.notEqual(retainedSale.source_current_price, retainedSale.source_raw_witness.fields.CurrentPrice.value_text);
  assert.equal(r.cad_recorded_evidence.mapping_version, 5);
  assert.equal(r.recorded_housing.mapping_version, 5);
  assert.equal(r.recorded_housing.profile.id, 'custom-recorded-housing-v2');
  assert.equal(r.recorded_housing.profile.revision, 2);
  assert.deepEqual(r.recorded_housing.profile, f.kernel.recorded_housing.profile);
  assert.notEqual(r.recorded_housing.profile.content_sha256, old.checked.recommendation.recorded_housing.profile.content_sha256);
  for (const key of ['all', 'pockets', 'policy', 'subject', 'recommended_recorded_group_ids', 'evidence_mode']) {
    assert.deepEqual(r[key], old.checked.recommendation[key], key);
  }
  assert.deepEqual(r.recorded_housing.coverage, old.checked.recommendation.recorded_housing.coverage);
  assert.deepEqual(r.recorded_housing.subject, old.checked.recommendation.recorded_housing.subject);
  assert.equal(r.recorded_housing.authority, 'not_established');
  assert.equal(f.response.recommendation.apply.status, 'blocked');
  for (const forbidden of ['raw_projection', 'source_raw_witness', 'PriceCurrency', 'retained_inputs']) {
    assert.equal(JSON.stringify(r).includes(`"${forbidden}"`), false);
  }
  const raw = clone(f.response), before = JSON.stringify(raw), checked = checkCatalog(raw, f.input);
  assert.equal(JSON.stringify(raw), before);
  assert.notEqual(checked.recommendation.recorded_housing.profile, raw.recommendation.recorded_housing.profile);
  assert.ok(Object.isFrozen(checked.recommendation.recorded_housing.profile));
  assert.ok(Object.isFrozen(checked.recommendation.cad_recorded_evidence.all.fields.class_code));
});

for (const version of [4, 5]) {
  test(`mapping${version} still admits an absent optional CAD addon without inventing one`, async () => {
    const f = await fixture(version), raw = clone(f.response);
    delete raw.recommendation.cad_recorded_evidence;
    const checked = checkCatalog(raw, f.input).recommendation;
    assert.equal(Object.hasOwn(checked, 'cad_recorded_evidence'), false);
    assert.equal(checked.recorded_housing.mapping_version, version);
    const { cad_recorded_evidence, ...expected } = f.checked.recommendation;
    assert.ok(cad_recorded_evidence);
    assert.deepEqual(checked, expected);
  });

  test(`mapping${version} whole CAD omission preserves its actual version and complete denominator`, async () => {
    const f = await fixture(version), cad = f.response.recommendation.cad_recorded_evidence;
    const omitted = presentCustomCohortCadEvidence({ evidence: f.kernel.cad_recorded_evidence, expected: cad.binding,
      pockets: cad.pockets.map(p => ({ id: p.id, member_count: p.member_count })), member_count: cad.all.member_count,
      in_discovery: cad.subject.in_discovery, maximumBytes: 1200 });
    assert.equal(omitted.status, 'details_unavailable');
    const checked = checkCad(omitted, f.checked);
    assert.equal(checked.mapping_version, version);
    assert.equal(checked.member_count, f.checked.coverage.discovery_member_count);
    const response = clone(f.response); response.recommendation.cad_recorded_evidence = omitted;
    assert.equal(checkCatalog(response, f.input).recommendation.cad_recorded_evidence.mapping_version, version);
    assert.throws(() => checkCad({ ...omitted, member_count: 0 }, f.checked));
  });

  for (const field of ['id', 'revision', 'content_sha256']) {
    test(`mapping${version} rejects the other housing profile's ${field}`, async () => {
      const f = await fixture(version), other = await fixture(version === 4 ? 5 : 4), raw = clone(f.response);
      raw.recommendation.recorded_housing.profile[field] = other.response.recommendation.recorded_housing.profile[field];
      assert.throws(() => checkCatalog(raw, f.input), /Invalid pocket recommendation/);
    });
  }

  test(`mapping${version} refuses a crossed full housing profile or version and mixed CAD/housing addons`, async () => {
    const f = await fixture(version), other = await fixture(version === 4 ? 5 : 4);
    for (const mutate of [
      r => { r.recorded_housing.profile = clone(other.response.recommendation.recorded_housing.profile); },
      r => { r.recorded_housing.mapping_version = version === 4 ? 5 : 4; },
      r => { r.cad_recorded_evidence.mapping_version = version === 4 ? 5 : 4; },
    ]) {
      const raw = clone(f.response); mutate(raw.recommendation);
      assert.throws(() => checkCatalog(raw, f.input), /Invalid pocket recommendation/);
    }
  });
}

for (const version of [null, 2, 3, 6, '5']) {
  test(`combined frontend refuses unknown mapping discriminator ${JSON.stringify(version)}`, async () => {
    const f = await fixture(5);
    for (const field of ['cad_recorded_evidence', 'recorded_housing']) {
      const raw = clone(f.response); raw.recommendation[field].mapping_version = version;
      assert.throws(() => checkCatalog(raw, f.input));
    }
  });
}

test('combined housing profile accessors are rejected without execution or partial admission', async () => {
  const f = await fixture(5); let calls = 0;
  for (const field of ['id', 'revision', 'content_sha256']) {
    const raw = clone(f.response);
    Object.defineProperty(raw.recommendation.recorded_housing.profile, field,
      { enumerable: true, get() { calls++; throw new Error('must not execute'); } });
    assert.throws(() => checkCatalog(raw, f.input), /Invalid pocket recommendation/);
  }
  assert.equal(calls, 0);
});
