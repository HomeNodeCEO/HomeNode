import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from '../../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortIndexedObservationPreview, customCohortObservationMembers } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortSelectionCatalog } from '../../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { prepareCustomCohortReportGeography, completeCustomCohortReportGeography } from '../../src/services/neighborhoodAssessment/customCohortReportGeography.js';
import { buildCustomCohortReportedAssessmentBatched } from '../../src/services/neighborhoodAssessment/customCohortReportedAssessment.js';

/** Only called after the native fixture's local database identity, retained
 * hashes and complete source graph have been checked. No report writes. */
export async function checkDenseReportedPreparation({ retained, query }) {
  const captured = retained.acquisition.capture_result.captured_at;
  assert.equal(retained.subject.effective_date, captured.slice(0, 10), 'Requires a newly captured current-date fixture');
  assert.equal(retained.spatial.account_ids.length, 38_106);
  const records = retained.acquisition.capture_result.source_capture.sources.reduce((n, s) => n + s.payload.records.length, 0);
  assert.ok(records > 100_000, 'Exercise the dense retained graph, not only many group names');
  const context_ref = { context_id: randomUUID(), context_revision: '1', context_sha256: 'a'.repeat(64) };
  const preview = buildCustomCohortIndexedObservationPreview({ context_ref, retained_inputs: retained,
    selection: { revision: 1, pockets: [] } });
  const catalog = buildCustomCohortSelectionCatalog({ retained_inputs: retained, preview, catalog_version: 2 });
  assert.equal(catalog.catalog_complete, true); assert.equal(catalog.pockets.length, 887);
  const subject = retained.subject.target;
  const target = { scope: Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(k => [k, subject[k]])),
    report_file_id: subject.report_file_id, custom_assignment_file_id: Number(subject.assignment_file_id), editor_revision: 0,
    effective_date: retained.subject.effective_date, data_cutoff: retained.subject.effective_date };
  const saved = { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
    neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [[[-97, 32], [-96, 32], [-96, 34], [-97, 34], [-97, 32]]] },
    ...Object.fromEntries(['north', 'east', 'south', 'west'].map(side => [`neighborhood_boundary_${side}`, `Synthetic ${side} outline`])) };
  const projected = JSON.stringify(saved), derived_at = new Date((await query("SELECT clock_timestamp() AS value")).rows[0].value).toISOString();
  const admission = prepareCustomCohortReportGeography({ target: { organization_id: subject.organization_id,
    report_file_id: subject.report_file_id, assignment_file_id: subject.assignment_file_id, account_id: subject.account_id },
    assignment_revision: 1, captured_at: derived_at, retained_subject: retained.subject,
    projection: { details_type: 'object', projected_utf8_bytes: Buffer.byteLength(projected),
      projected_sha256: createHash('sha256').update(projected).digest('hex'), projected_json: projected } });
  assert.equal(admission.status, 'awaiting_topology');
  const point = admission.subject_point_for_validation;
  const oracle = (await query(`WITH supplied AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb),4326) AS geom,
    ST_SetSRID(ST_MakePoint($2::double precision,$3::double precision),4326) AS point)
    SELECT ST_IsValid(geom) AS is_valid, ST_IsValidReason(geom) AS validation_reason,
      postgis_lib_version() AS postgis_version, ST_GeometryType(geom) AS geometry_type,
      ST_IsEmpty(geom) AS is_empty, ST_NumGeometries(geom) AS component_count,
      ST_Covers(geom,point) AS covers_recorded_subject_point, ST_Contains(geom,point) AS contains_recorded_subject_point
    FROM supplied`, [json(admission.geometry_for_validation), ...point.coordinates])).rows[0];
  assert.equal(oracle.is_valid, true); assert.equal(oracle.covers_recorded_subject_point, true);
  const geography = completeCustomCohortReportGeography(admission, oracle);
  const selection = { revision: 1, included_recorded_group_ids: catalog.pockets.map(p => p.id) };
  if (catalog.unassigned.member_count) selection.included_recorded_group_ids.push('discovery:unassigned');
  const result = await buildCustomCohortReportedAssessmentBatched({ context_ref, retained_inputs: retained, selection, target,
    preparation_identity: { assessment_id: randomUUID(), assessment_revision: 1, attachment_id: randomUUID(), attachment_revision: 1 },
    report_geography: geography, derived_at, catalog_version: 2 });
  assert.equal(result.status, 'ready', JSON.stringify(result.issues));
  assert.deepEqual(result.assessment.geographic_neighborhood.geometry, saved.neighborhood_boundary_geometry);
  assert.equal(result.assessment.selection.pocket_ids.length, 887);
  const cad = result.assessment.populations.find(p => p.id === 'selected-cad-accounts');
  const sales = result.assessment.populations.find(p => p.id === 'selected-shared-source-records');
  assert.equal(cad.member_count, 38_106); assert.equal(sales.member_count, 1_030);
  assert.equal(result.publication_bundle.members.length, 39_136);
  assert.ok(result.assessment.statistics.filter(s => s.population_id === cad.id).every(s => s.denominator_count === cad.member_count));
  assert.ok(result.assessment.statistics.filter(s => s.population_id === sales.id).every(s => s.denominator_count === sales.member_count));
  const originalRows = new Map(customCohortObservationMembers(preview, preview.all, 'stock').map(row => [row.account_id, row]));
  for (const member of result.publication_bundle.members.filter(m => m.population_id === cad.id)) {
    const original = originalRows.get(member.member_id), reference = member.member_data.retained_account_observation_reference;
    assert.ok(original); assert.equal(reference.retained_preview_member_sha256, assessmentEvidenceDigest(original));
    assert.equal(reference.representation_version, 1);
    for (const key of ['gla_sqft', 'site_area_sqft', 'year_built']) {
      assert.deepEqual(reference.observations[key], { state: original.observations[key].state,
        exact_value: original.observations[key].exact_value });
    }
  }
  return { groups: 887, accounts: cad.member_count, source_records: sales.member_count, retained_records: records,
    publication_members: result.publication_bundle.members.length, verified_account_references: originalRows.size,
    candidate: result.candidate.status, writes: 0 };
}
