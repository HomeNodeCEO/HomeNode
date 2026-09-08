import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CUSTOM_MATERIAL_INPUT_PROFILE, projectCustomNeighborhoodMaterialInputs } from '../src/services/neighborhoodAssessment/customMaterialInputs.js';
import { getCustomNeighborhoodMaterialProfile } from '../src/services/neighborhoodAssessment/customMaterialProfile.js';
import { inputs, argumentsOf } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';

test('installed profile exposes exact canonical bytes and its content reference', () => {
  const profile = getCustomNeighborhoodMaterialProfile(), text = profile.definition_blob.canonical_json;
  assert.deepEqual(JSON.parse(text), CUSTOM_MATERIAL_INPUT_PROFILE);
  assert.equal(profile.profile_ref.id, 'custom-neighborhood-physical-stock-inputs-v1');
  assert.equal(profile.profile_ref.revision, '1');
  assert.equal(profile.profile_ref.content_sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(profile.definition_blob.ref.canonical_utf8_bytes, String(Buffer.byteLength(text)));
  assert.equal(profile.definition_blob.ref.content_sha256, profile.profile_ref.content_sha256);
  assert.strictEqual(getCustomNeighborhoodMaterialProfile(), profile);
});

test('callers cannot mutate installed fields, types, rosters or limits', () => {
  const p = CUSTOM_MATERIAL_INPUT_PROFILE;
  assert.throws(() => { p.assignment_sections.property_characteristics.objects.main_improvement.year_built.push('object'); }, TypeError);
  assert.throws(() => { p.section_roster.reverse(); }, TypeError);
  assert.throws(() => { p.limits.array_entries = 999; }, TypeError);
  assert.throws(() => { getCustomNeighborhoodMaterialProfile().profile_ref.revision = '2'; }, TypeError);
});

test('projector keeps its existing identity and representation semantics', () => {
  const projected = projectCustomNeighborhoodMaterialInputs(...argumentsOf(inputs()));
  assert.equal(projected.status, 'represented');
  assert.equal(projected.material_input.profile_id, CUSTOM_MATERIAL_INPUT_PROFILE.id);
  assert.equal(projected.material_input.profile_revision, CUSTOM_MATERIAL_INPUT_PROFILE.revision);
  assert.deepEqual(projected.material_input.accepted_evidence, []);
  assert.equal(CUSTOM_MATERIAL_INPUT_PROFILE.values.authority, 'not_established');
  assert.equal(CUSTOM_MATERIAL_INPUT_PROFILE.values.manual_snapshot_precedence, 'none');
  assert.deepEqual(CUSTOM_MATERIAL_INPUT_PROFILE.retained_public.objects.improvement,
    CUSTOM_MATERIAL_INPUT_PROFILE.assignment_sections.property_characteristics.objects.main_improvement);
});
