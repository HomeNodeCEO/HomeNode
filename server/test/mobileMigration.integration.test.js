import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import {
  createInspectionSession,
  createReportFile,
  listReportFiles,
} from "../src/modules/mobile/reportFiles.js";
import {
  completeInspectionSession,
  getInspectionCompletionReadiness,
} from "../src/modules/mobile/completion.js";
import {
  getCustomAppraisalReview,
  refreshCustomAppraisalProposals,
  reviewCustomAppraisalProposal,
} from "../src/modules/mobile/customAppraisal.js";
import {
  getTargetFieldReview,
  refreshTargetFieldProposals,
  reviewTargetFieldProposal,
} from "../src/modules/mobile/targetFields.js";
import {
  createMobileUadEntityProposal,
  getMobileUadEntityReview,
  reviewMobileUadEntityProposal,
} from "../src/modules/mobile/uadEntities.js";
import { getMobileProperty, searchMobileProperties } from "../src/modules/mobile/properties.js";
import {
  createPhotoUploadBatch,
  listInspectionPhotos,
  removeInspectionPhoto,
  updateInspectionPhoto,
  verifyInspectionPhoto,
} from "../src/modules/mobile/photos.js";
import { getInspectionSketch, saveInspectionSketch } from "../src/modules/mobile/sketches.js";
import {
  getInspectionSnapshot,
  syncInspectionOperations,
  syncPayloadSha256,
} from "../src/modules/mobile/sync.js";

const databaseUrl = process.env.DATABASE_URL;

function syncOperation(operationKind, baseSessionRevision, payload, clientOperationId = randomUUID()) {
  return {
    client_operation_id: clientOperationId,
    operation_kind: operationKind,
    base_session_revision: baseSessionRevision,
    payload_sha256: syncPayloadSha256(payload),
    payload,
  };
}

test("mobile report files preserve prior versions and allocate separate workflow sequences", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const accountId = `mobile-${randomUUID()}`;
  const auth = {
    userId,
    organizations: [{ organizationId, roles: ["appraiser"] }],
  };
  try {
    await pool.query(
      `INSERT INTO app_auth.organizations (id, legal_name, display_name)
       VALUES ($1, 'HomeNode Mobile Test', 'HomeNode Mobile Test')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO app_auth.users (id, email, display_name)
       VALUES ($1, $2, 'Mobile Test Appraiser')`,
      [userId, `${userId}@example.test`],
    );
    await pool.query(
      `INSERT INTO app_auth.organization_memberships (organization_id, user_id, status)
       VALUES ($1, $2, 'active')`,
      [organizationId, userId],
    );
    await pool.query(
      `INSERT INTO app_auth.membership_roles (organization_id, user_id, role_code)
       VALUES ($1, $2, 'appraiser')`,
      [organizationId, userId],
    );
    await pool.query(
      `INSERT INTO core.accounts (account_id, address, city, postal_code)
       VALUES ($1, '100 Test Street', 'Dallas', '75201')`,
      [accountId],
    );
    const legacyAssignment = await pool.query(
      `INSERT INTO app.assignment_files (account_id, file_number, assignment_details)
       VALUES ($1, $2, '{"client_name":"Legacy preserved client"}'::jsonb)
       RETURNING id`,
      [accountId, `LEGACY-${userId.slice(0, 8)}`],
    );
    const legacyReportFileId = randomUUID();
    await pool.query(
      `INSERT INTO app.report_files (
         id, account_id, workflow_type, file_number, custom_assignment_file_id, is_current
       ) VALUES ($1, $2, 'custom_appraisal', $3, $4, true)`,
      [legacyReportFileId, accountId, `LEGACY-${userId.slice(0, 8)}`, legacyAssignment.rows[0].id],
    );

    const firstCustomRequest = randomUUID();
    const firstCustom = await createReportFile(pool, auth, {
      organization_id: organizationId,
      account_id: accountId,
      workflow_type: "custom_appraisal",
      client_request_id: firstCustomRequest,
    });
    assert.equal(firstCustom.created, true);
    assert.match(firstCustom.reportFile.file_number, /^HN-CA-\d{4}-000001$/);
    assert.equal(firstCustom.reportFile.previous_report_file_id, legacyReportFileId);

    const retried = await createReportFile(pool, auth, {
      organization_id: organizationId,
      account_id: accountId,
      workflow_type: "custom_appraisal",
      client_request_id: firstCustomRequest,
    });
    assert.equal(retried.created, false);
    assert.equal(retried.reportFile.id, firstCustom.reportFile.id);

    await pool.query(
      `UPDATE app.assignment_files
          SET assignment_details = '{"client_name":"Preserved client"}'::jsonb,
              revision = 2,
              updated_at = now()
        WHERE id = $1`,
      [firstCustom.reportFile.target_id],
    );

    const secondCustom = await createReportFile(pool, auth, {
      organization_id: organizationId,
      account_id: accountId,
      workflow_type: "custom_appraisal",
      client_request_id: randomUUID(),
      previous_report_file_id: firstCustom.reportFile.id,
    });
    assert.match(secondCustom.reportFile.file_number, /^HN-CA-\d{4}-000002$/);
    assert.equal(secondCustom.reportFile.previous_report_file_id, firstCustom.reportFile.id);

    const uad = await createReportFile(pool, auth, {
      organization_id: organizationId,
      account_id: accountId,
      workflow_type: "uad_3_6",
      client_request_id: randomUUID(),
    });
    const tax = await createReportFile(pool, auth, {
      organization_id: organizationId,
      account_id: accountId,
      workflow_type: "property_tax_protest",
      client_request_id: randomUUID(),
    });
    assert.match(uad.reportFile.file_number, /^HN-UAD-\d{4}-000001$/);
    assert.match(tax.reportFile.file_number, /^HN-PTP-\d{4}-000001$/);

    const uadFoundation = await pool.query(
      `SELECT
         (SELECT count(*) FROM appraisal.uad_subject_snapshots WHERE workfile_id = $1) AS snapshots,
         (SELECT count(*) FROM appraisal.uad_entities WHERE workfile_id = $1) AS entities,
         (SELECT count(*) FROM appraisal.uad_revisions WHERE workfile_id = $1) AS revisions,
         (SELECT count(*) FROM appraisal.uad_audit_events WHERE workfile_id = $1) AS events`,
      [uad.reportFile.target_id],
    );
    assert.equal(Number(uadFoundation.rows[0].snapshots), 1);
    assert.ok(Number(uadFoundation.rows[0].entities) >= 4);
    assert.equal(Number(uadFoundation.rows[0].revisions), 1);
    assert.ok(Number(uadFoundation.rows[0].events) >= 1);

    const uadSession = await createInspectionSession(pool, auth, {
      report_file_id: uad.reportFile.id,
    });
    const uadTargetReview = await getTargetFieldReview(pool, auth, uadSession.session.id);
    assert.ok(uadTargetReview.catalog.length > 100);
    assert.ok(uadTargetReview.entities.length >= 4);
    assert.match(uadTargetReview.target.specification_release_key, /^uad-3\.6-/);

    const initialEntityReview = await getMobileUadEntityReview(pool, auth, uadSession.session.id);
    const unitEntity = initialEntityReview.entities.find((entity) => entity.entity_type === "unit");
    assert.ok(unitEntity);
    const createRoomOperationId = randomUUID();
    const roomProposalInput = {
      client_operation_id: createRoomOperationId,
      action: "create",
      entity_type: "unit_room",
      parent_entity_id: unitEntity.id,
      label: "Kitchen",
      data: {},
      base_target_revision: initialEntityReview.target.revision,
    };
    const roomProposal = await createMobileUadEntityProposal(
      pool, auth, uadSession.session.id, roomProposalInput,
    );
    assert.equal(roomProposal.created, true);
    const retriedRoomProposal = await createMobileUadEntityProposal(
      pool, auth, uadSession.session.id, roomProposalInput,
    );
    assert.equal(retriedRoomProposal.created, false);
    assert.equal(retriedRoomProposal.proposal.id, roomProposal.proposal.id);
    const acceptedRoom = await reviewMobileUadEntityProposal(
      pool,
      auth,
      uadSession.session.id,
      roomProposal.proposal.id,
      { client_operation_id: randomUUID(), decision: "accept" },
    );
    assert.equal(acceptedRoom.proposal.status, "accepted");
    assert.equal(acceptedRoom.proposal.applied_target_revision, 2);
    const entityReviewWithRoom = await getMobileUadEntityReview(pool, auth, uadSession.session.id);
    const roomEntity = entityReviewWithRoom.entities.find((entity) => entity.id === acceptedRoom.proposal.applied_entity_id);
    assert.equal(roomEntity?.label, "Kitchen");

    const deleteRoom = await createMobileUadEntityProposal(pool, auth, uadSession.session.id, {
      client_operation_id: randomUUID(),
      action: "delete",
      entity_type: "unit_room",
      target_entity_id: roomEntity.id,
      base_target_revision: entityReviewWithRoom.target.revision,
      base_entity: roomEntity,
    });
    await pool.query(
      "UPDATE appraisal.uad_entities SET label = 'Kitchen changed elsewhere', updated_at = now() WHERE id = $1",
      [roomEntity.id],
    );
    const conflictedDelete = await reviewMobileUadEntityProposal(
      pool,
      auth,
      uadSession.session.id,
      deleteRoom.proposal.id,
      { client_operation_id: randomUUID(), decision: "accept" },
    );
    assert.equal(conflictedDelete.proposal.status, "conflict");
    const rejectedDelete = await reviewMobileUadEntityProposal(
      pool,
      auth,
      uadSession.session.id,
      deleteRoom.proposal.id,
      { client_operation_id: randomUUID(), decision: "reject" },
    );
    assert.equal(rejectedDelete.proposal.status, "rejected");

    const taxSession = await createInspectionSession(pool, auth, {
      report_file_id: tax.reportFile.id,
    });
    const taxTargetReview = await getTargetFieldReview(pool, auth, taxSession.session.id);
    const conditionPath = "property_tax_protest.subject.condition_rating";
    assert.equal(taxTargetReview.catalog.length, 18);
    assert.deepEqual(taxTargetReview.values[conditionPath], { exists: false });

    const taxPayload = {
      field_path: conditionPath,
      base: { exists: false },
      target_base: taxTargetReview.values[conditionPath],
      target_base_revision: taxTargetReview.target.revision,
      value: "C4",
      source_type: "appraiser",
      appraiser_confirmed: true,
    };
    await syncInspectionOperations(pool, auth, taxSession.session.id, {
      operations: [syncOperation("field.upsert", taxSession.session.revision, taxPayload)],
    });
    const refreshedTax = await refreshTargetFieldProposals(pool, auth, taxSession.session.id);
    assert.equal(refreshedTax.created.length, 1);
    assert.equal(refreshedTax.created[0].base_target_revision, 1);
    const acceptedTax = await reviewTargetFieldProposal(
      pool,
      auth,
      taxSession.session.id,
      refreshedTax.created[0].id,
      { client_operation_id: randomUUID(), decision: "accept" },
    );
    assert.equal(acceptedTax.proposal.status, "accepted");
    assert.equal(acceptedTax.proposal.applied_target_revision, 2);
    const acceptedTaxReview = await getTargetFieldReview(pool, auth, taxSession.session.id);
    assert.deepEqual(acceptedTaxReview.values[conditionPath], { exists: true, value: "C4" });
    const persistedTax = await pool.query(
      "SELECT revision, workfile_data #> '{subject,condition_rating}' AS condition_rating FROM app.tax_protest_files WHERE id = $1",
      [tax.reportFile.target_id],
    );
    assert.equal(Number(persistedTax.rows[0].revision), 2);
    assert.equal(persistedTax.rows[0].condition_rating, "C4");

    const staleTaxPayload = {
      field_path: conditionPath,
      base: { exists: true, value: "C4" },
      target_base: acceptedTaxReview.values[conditionPath],
      target_base_revision: acceptedTaxReview.target.revision,
      value: "C3",
      source_type: "appraiser",
      appraiser_confirmed: true,
    };
    await syncInspectionOperations(pool, auth, taxSession.session.id, {
      operations: [syncOperation("field.upsert", acceptedTaxReview.session.revision, staleTaxPayload)],
    });
    const staleTax = await refreshTargetFieldProposals(pool, auth, taxSession.session.id);
    assert.equal(staleTax.created.length, 1);
    await pool.query(
      `UPDATE app.tax_protest_files
          SET workfile_data = jsonb_set(workfile_data, '{subject,condition_rating}', '"C5"'::jsonb),
              revision = revision + 1,
              updated_at = now()
        WHERE id = $1`,
      [tax.reportFile.target_id],
    );
    const conflictedTax = await reviewTargetFieldProposal(
      pool,
      auth,
      taxSession.session.id,
      staleTax.created[0].id,
      { client_operation_id: randomUUID(), decision: "accept" },
    );
    assert.equal(conflictedTax.proposal.status, "conflict");
    const reviewRequired = await pool.query(
      "SELECT status FROM app.inspection_sessions WHERE id = $1",
      [taxSession.session.id],
    );
    assert.equal(reviewRequired.rows[0].status, "review_required");

    const rejectedConflict = await reviewTargetFieldProposal(
      pool,
      auth,
      taxSession.session.id,
      staleTax.created[0].id,
      { client_operation_id: randomUUID(), decision: "reject" },
    );
    assert.equal(rejectedConflict.proposal.status, "rejected");
    const resolvedSession = await pool.query(
      "SELECT status FROM app.inspection_sessions WHERE id = $1",
      [taxSession.session.id],
    );
    assert.equal(resolvedSession.rows[0].status, "synchronized");
    const conflictPreservedCanonical = await pool.query(
      "SELECT revision, workfile_data #> '{subject,condition_rating}' AS condition_rating FROM app.tax_protest_files WHERE id = $1",
      [tax.reportFile.target_id],
    );
    assert.equal(Number(conflictPreservedCanonical.rows[0].revision), 3);

    const discovery = await listReportFiles(pool, auth, { accountId });
    assert.equal(discovery.files.length, 5);
    assert.equal(discovery.recentlyCreated, true);
    assert.ok(discovery.files.some((file) => file.id === firstCustom.reportFile.id && !file.is_current));
    assert.ok(discovery.files.some((file) => file.id === secondCustom.reportFile.id && file.is_current));

    const search = await searchMobileProperties(pool, auth, { query: "100 Test" });
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].account_id, accountId);
    assert.equal(search.results[0].workflows.custom_appraisal.count, 3);
    assert.equal(search.results[0].workflows.uad_3_6.count, 1);
    assert.equal(search.results[0].workflows.property_tax_protest.count, 1);

    const selected = await getMobileProperty(pool, auth, accountId);
    assert.equal(selected.property.address, "100 Test Street");
    assert.equal(selected.files.length, 5);

    const session = await createInspectionSession(pool, auth, {
      report_file_id: secondCustom.reportFile.id,
    });
    const retriedSession = await createInspectionSession(pool, auth, {
      report_file_id: secondCustom.reportFile.id,
    });
    assert.equal(session.created, true);
    assert.equal(retriedSession.created, false);
    assert.equal(retriedSession.session.id, session.session.id);

    const sketchAreaId = randomUUID();
    const sketchRoomId = randomUUID();
    const sketchOperationId = randomUUID();
    const sketchRequest = {
      client_operation_id: sketchOperationId,
      client_sketch_id: randomUUID(),
      base_revision: 0,
      sketch: {
        measurement_standard: "ansi_z765_2021",
        measurement_method: "exterior",
        review_status: "appraiser_confirmed",
        review_notes: "Exterior dimensions reviewed on site.",
        areas: [{
          id: sketchAreaId,
          label: "First floor",
          level_label: "Level 1",
          classification: "above_grade_finished",
          vertices: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 40, y: 30 },
            { x: 0, y: 30 },
            { x: 0, y: 0 },
          ],
        }],
        rooms: [{
          id: sketchRoomId,
          area_id: sketchAreaId,
          label: "Kitchen",
          room_type: "kitchen",
          anchor: { x: 20, y: 15 },
        }],
      },
    };
    const savedSketch = await saveInspectionSketch(pool, auth, session.session.id, sketchRequest);
    assert.equal(savedSketch.sketch.revision, 1);
    assert.equal(savedSketch.sketch.summary.above_grade_finished_sqft, 1200);
    assert.equal(savedSketch.sketch.rooms[0].photo_count, 0);
    const retriedSketch = await saveInspectionSketch(pool, auth, session.session.id, sketchRequest);
    assert.deepEqual(retriedSketch, savedSketch);
    const loadedSketch = await getInspectionSketch(pool, auth, session.session.id);
    assert.equal(loadedSketch.sketch.review_status, "appraiser_confirmed");
    await assert.rejects(
      () => saveInspectionSketch(pool, auth, session.session.id, {
        ...sketchRequest,
        client_operation_id: randomUUID(),
      }),
      /sketch_revision_conflict/,
    );

    const photoClientId = randomUUID();
    const photoStorage = {
      configured: true,
      provider: "r2",
      bucket: "mobile-photo-test",
      createUploadUrl({ objectKey, contentType }) {
        return {
          method: "PUT",
          url: `https://uploads.example.test/${encodeURIComponent(objectKey)}`,
          headers: { "content-type": contentType },
          expires_in_seconds: 900,
        };
      },
      async inspectObject({ objectKey }) {
        const original = objectKey.includes("/original/");
        return {
          byte_size: original ? 4_000 : 1_200,
          etag: original ? "original-etag" : "display-etag",
          content_type: "image/jpeg",
        };
      },
    };
    const photoRequest = {
      photos: [{
        client_photo_id: photoClientId,
        category: "Kitchen",
        category_source: "sketch_room",
        room_ref: `sketch-room:${sketchRoomId}`,
        room_label: "Kitchen",
        source: "camera",
        captured_at: "2026-08-23T12:00:00.000Z",
        capture_metadata: { orientation: "portrait", source_device: "integration-test" },
        objects: [
          {
            client_object_id: randomUUID(),
            variant: "original",
            file_name: "kitchen.jpg",
            content_type: "image/jpeg",
            byte_size: 4_000,
            width: 3000,
            height: 2000,
          },
          {
            client_object_id: randomUUID(),
            variant: "display",
            file_name: "kitchen-display.jpg",
            content_type: "image/jpeg",
            byte_size: 1_200,
            width: 2048,
            height: 1365,
          },
        ],
      }],
    };
    const uploadBatch = await createPhotoUploadBatch(
      pool,
      photoStorage,
      auth,
      session.session.id,
      photoRequest,
    );
    assert.equal(uploadBatch.photos.length, 1);
    assert.equal(uploadBatch.photos[0].uploads.length, 2);
    assert.equal(uploadBatch.photos[0].photo.caption, "Kitchen");
    const retriedPhotoBatch = await createPhotoUploadBatch(
      pool,
      photoStorage,
      auth,
      session.session.id,
      photoRequest,
    );
    assert.equal(retriedPhotoBatch.photos[0].photo.id, uploadBatch.photos[0].photo.id);

    const verifiedPhoto = await verifyInspectionPhoto(
      pool,
      photoStorage,
      auth,
      session.session.id,
      uploadBatch.photos[0].photo.id,
    );
    assert.equal(verifiedPhoto.status, "verified");
    assert.equal(verifiedPhoto.required_retention_years, 5);
    assert.ok(verifiedPhoto.retention_until);
    assert.ok(verifiedPhoto.objects.every((object) => object.status === "verified"));

    const captionOperationId = randomUUID();
    const updatedPhoto = await updateInspectionPhoto(
      pool,
      auth,
      session.session.id,
      verifiedPhoto.id,
      {
        client_operation_id: captionOperationId,
        base_revision: verifiedPhoto.revision,
        caption: "Updated kitchen with quartz countertops",
      },
    );
    assert.equal(updatedPhoto.caption, "Updated kitchen with quartz countertops");
    assert.equal(updatedPhoto.caption_source, "manual");
    const retriedUpdate = await updateInspectionPhoto(
      pool,
      auth,
      session.session.id,
      verifiedPhoto.id,
      {
        client_operation_id: captionOperationId,
        base_revision: verifiedPhoto.revision,
        caption: "Updated kitchen with quartz countertops",
      },
    );
    assert.equal(retriedUpdate.revision, updatedPhoto.revision);

    const removedPhoto = await removeInspectionPhoto(
      pool,
      auth,
      session.session.id,
      updatedPhoto.id,
      {
        client_operation_id: randomUUID(),
        base_revision: updatedPhoto.revision,
      },
    );
    assert.equal(removedPhoto.disposition, "excluded_retained");
    assert.equal(removedPhoto.photo.status, "excluded");
    assert.ok(removedPhoto.photo.retention_until);
    const listedPhotos = await listInspectionPhotos(pool, auth, session.session.id);
    assert.equal(listedPhotos.photos.length, 1);
    assert.equal(listedPhotos.photos[0].status, "excluded");

    const firstPayload = {
      field_path: "inspection.general.appraiser_comments",
      base: { exists: false },
      value: "Observed on site",
      source_type: "appraiser",
      appraiser_confirmed: true,
    };
    const firstOperation = syncOperation("field.upsert", 1, firstPayload);
    const firstSync = await syncInspectionOperations(pool, auth, session.session.id, {
      operations: [firstOperation],
    });
    assert.equal(firstSync.session.revision, 2);
    assert.equal(firstSync.operations[0].status, "applied");
    const retriedSync = await syncInspectionOperations(pool, auth, session.session.id, {
      operations: [firstOperation],
    });
    assert.equal(retriedSync.session.revision, 2);
    assert.equal(retriedSync.operations[0].status, "applied");

    const conflictingPayload = {
      ...firstPayload,
      value: "Different offline observation",
    };
    const conflictingOperation = syncOperation("field.upsert", 1, conflictingPayload);
    const conflicted = await syncInspectionOperations(pool, auth, session.session.id, {
      operations: [conflictingOperation],
    });
    assert.equal(conflicted.session.revision, 3);
    assert.equal(conflicted.session.status, "review_required");
    assert.equal(conflicted.operations[0].status, "conflict");

    const conflictSnapshot = await getInspectionSnapshot(pool, auth, session.session.id);
    assert.equal(conflictSnapshot.fields[0].state.value, "Observed on site");
    assert.equal(conflictSnapshot.conflicts.length, 1);

    const resolutionPayload = {
      conflict_client_operation_id: conflictingOperation.client_operation_id,
      resolution: "apply_mobile",
    };
    const resolved = await syncInspectionOperations(pool, auth, session.session.id, {
      operations: [syncOperation("conflict.resolve", 3, resolutionPayload)],
    });
    assert.equal(resolved.session.revision, 4);
    assert.equal(resolved.session.status, "synchronized");
    const resolvedSnapshot = await getInspectionSnapshot(pool, auth, session.session.id);
    assert.equal(resolvedSnapshot.fields[0].state.value, "Different offline observation");
    assert.equal(resolvedSnapshot.conflicts.length, 0);

    const customFieldSync = await syncInspectionOperations(pool, auth, session.session.id, {
      operations: [
        syncOperation("field.upsert", 4, {
          field_path: "custom_appraisal.property_characteristics.main_improvement.foundation",
          base: { exists: false },
          value: "Slab",
          source_type: "appraiser",
          appraiser_confirmed: true,
        }),
        syncOperation("field.upsert", 4, {
          field_path: "custom_appraisal.assignment_details.subject_condition_rating",
          base: { exists: false },
          value: "C3",
          source_type: "appraiser",
          appraiser_confirmed: true,
        }),
      ],
    });
    assert.equal(customFieldSync.session.revision, 6);
    const refreshedProposals = await refreshCustomAppraisalProposals(pool, auth, session.session.id);
    assert.ok(refreshedProposals.created.length >= 3);
    const customReview = await getCustomAppraisalReview(pool, auth, session.session.id);
    const foundationProposal = customReview.proposals.find((proposal) => (
      proposal.field_path === "custom_appraisal.property_characteristics.main_improvement.foundation"
      && proposal.status === "pending"
    ));
    const conditionProposal = customReview.proposals.find((proposal) => (
      proposal.field_path === "custom_appraisal.assignment_details.subject_condition_rating"
      && proposal.status === "pending"
    ));
    assert.ok(foundationProposal);
    assert.ok(conditionProposal);
    assert.equal(customReview.photos.verified_count, 0);

    const foundationReviewOperationId = randomUUID();
    const acceptedFoundation = await reviewCustomAppraisalProposal(
      pool,
      auth,
      session.session.id,
      foundationProposal.id,
      { client_operation_id: foundationReviewOperationId, decision: "accept" },
    );
    assert.equal(acceptedFoundation.proposal.status, "accepted");
    const retriedFoundation = await reviewCustomAppraisalProposal(
      pool,
      auth,
      session.session.id,
      foundationProposal.id,
      { client_operation_id: foundationReviewOperationId, decision: "accept" },
    );
    assert.deepEqual(retriedFoundation, acceptedFoundation);
    const acceptedCondition = await reviewCustomAppraisalProposal(
      pool,
      auth,
      session.session.id,
      conditionProposal.id,
      { client_operation_id: randomUUID(), decision: "accept" },
    );
    assert.equal(acceptedCondition.proposal.status, "accepted");

    const acceptedTargets = await pool.query(
      `SELECT section.section_value, assignment.assignment_details
         FROM app.report_files report_file
         JOIN app.assignment_files assignment ON assignment.id = report_file.custom_assignment_file_id
         JOIN app.custom_appraisal_sections section
           ON section.assignment_file_id = assignment.id
          AND section.section_key = 'report.property_characteristics'
        WHERE report_file.id = $1`,
      [secondCustom.reportFile.id],
    );
    assert.equal(acceptedTargets.rows[0].section_value.main_improvement.foundation, "Slab");
    assert.equal(acceptedTargets.rows[0].assignment_details.subject_condition_rating, "C3");
    const manualTable = await pool.query(
      "SELECT to_regclass('app.property_attribute_manual_values') IS NOT NULL AS available",
    );
    const propertyWideOverrideCount = manualTable.rows[0].available
      ? Number((await pool.query(
          `SELECT count(*) FROM app.property_attribute_manual_values
            WHERE account_id = $1 AND attribute_key = 'report.property_characteristics'`,
          [accountId],
        )).rows[0].count)
      : 0;
    assert.equal(propertyWideOverrideCount, 0);

    const changedFoundation = await syncInspectionOperations(pool, auth, session.session.id, {
      operations: [syncOperation("field.upsert", 6, {
        field_path: "custom_appraisal.property_characteristics.main_improvement.foundation",
        base: { exists: true, value: "Slab" },
        value: "Pier and beam",
        source_type: "appraiser",
        appraiser_confirmed: true,
      })],
    });
    assert.equal(changedFoundation.operations[0].status, "applied");
    await refreshCustomAppraisalProposals(pool, auth, session.session.id);
    const beforeConflict = await getCustomAppraisalReview(pool, auth, session.session.id);
    const nextFoundationProposal = beforeConflict.proposals.find((proposal) => (
      proposal.field_path === "custom_appraisal.property_characteristics.main_improvement.foundation"
      && proposal.status === "pending"
    ));
    assert.ok(nextFoundationProposal);
    await pool.query(
      `UPDATE app.custom_appraisal_sections
          SET section_value = jsonb_set(section_value, '{main_improvement,foundation}', '"Web edit"'::jsonb),
              revision = revision + 1, updated_at = now()
        WHERE assignment_file_id = $1 AND section_key = 'report.property_characteristics'`,
      [secondCustom.reportFile.target_id],
    );
    const conflictResult = await reviewCustomAppraisalProposal(
      pool,
      auth,
      session.session.id,
      nextFoundationProposal.id,
      { client_operation_id: randomUUID(), decision: "accept" },
    );
    assert.equal(conflictResult.proposal.status, "conflict");
    assert.equal(conflictResult.proposal.current.value, "Web edit");
    const conflictPreserved = await pool.query(
      `SELECT section_value #>> '{main_improvement,foundation}' AS foundation
         FROM app.custom_appraisal_sections
        WHERE assignment_file_id = $1 AND section_key = 'report.property_characteristics'`,
      [secondCustom.reportFile.target_id],
    );
    assert.equal(conflictPreserved.rows[0].foundation, "Web edit");

    const blockedReadiness = await getInspectionCompletionReadiness(
      pool,
      auth,
      session.session.id,
    );
    assert.equal(blockedReadiness.ready_to_complete, false);
    assert.ok(blockedReadiness.blockers.includes("custom_appraisal_review"));
    await assert.rejects(
      () => completeInspectionSession(pool, auth, session.session.id, {
        client_operation_id: randomUUID(),
        base_session_revision: blockedReadiness.session.revision,
      }),
      (error) => error.message === "inspection_not_ready_conflict"
        && error.details.readiness.blockers.includes("custom_appraisal_review"),
    );

    const unresolvedReview = await getCustomAppraisalReview(pool, auth, session.session.id);
    for (const proposal of unresolvedReview.proposals.filter((item) => (
      item.status === "pending" || item.status === "conflict"
    ))) {
      const rejected = await reviewCustomAppraisalProposal(
        pool,
        auth,
        session.session.id,
        proposal.id,
        { client_operation_id: randomUUID(), decision: "reject" },
      );
      assert.equal(rejected.proposal.status, "rejected");
    }

    const readyToComplete = await getInspectionCompletionReadiness(
      pool,
      auth,
      session.session.id,
    );
    assert.equal(readyToComplete.ready_to_complete, true);
    const completionRequest = {
      client_operation_id: randomUUID(),
      base_session_revision: readyToComplete.session.revision,
    };
    const completedInspection = await completeInspectionSession(
      pool,
      auth,
      session.session.id,
      completionRequest,
    );
    assert.equal(completedInspection.completed, true);
    assert.equal(completedInspection.session.status, "completed");
    assert.equal(completedInspection.session.revision, readyToComplete.session.revision + 1);
    assert.deepEqual(
      await completeInspectionSession(pool, auth, session.session.id, completionRequest),
      completedInspection,
    );
    await assert.rejects(
      () => saveInspectionSketch(pool, auth, session.session.id, {
        ...sketchRequest,
        client_operation_id: randomUUID(),
        base_revision: loadedSketch.sketch.revision,
      }),
      /inspection_session_completed_conflict/,
    );


    const lineage = await pool.query(
      `SELECT prior.is_current AS prior_current,
              current.previous_report_file_id,
              assignment.inherited_from_file_id,
              assignment.assignment_details,
              prior_assignment.assignment_details AS prior_assignment_details
         FROM app.report_files current
         JOIN app.report_files prior ON prior.id = current.previous_report_file_id
         JOIN app.assignment_files assignment ON assignment.id = current.custom_assignment_file_id
         JOIN app.assignment_files prior_assignment ON prior_assignment.id = prior.custom_assignment_file_id
        WHERE current.id = $1`,
      [secondCustom.reportFile.id],
    );
    assert.equal(lineage.rows[0].prior_current, false);
    assert.equal(lineage.rows[0].previous_report_file_id, firstCustom.reportFile.id);
    assert.equal(String(lineage.rows[0].inherited_from_file_id), firstCustom.reportFile.target_id);
    assert.equal(lineage.rows[0].assignment_details.client_name, "Preserved client");
    assert.equal(lineage.rows[0].prior_assignment_details.client_name, "Preserved client");
  } finally {
    await pool.end();
  }
});
