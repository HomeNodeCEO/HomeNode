import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
import { saveDesktopPropertyTaxFile } from "../src/modules/mobile/desktopPropertyTax.js";
import {
  getInspectionSnapshot,
  syncInspectionOperations,
  syncPayloadSha256,
} from "../src/modules/mobile/sync.js";
import { listPreviousAppraisalFiles } from "../src/services/appraisalHistory.js";
import { replicateAppraisalFile } from "../src/services/appraisalReplication.js";
import { importUadMobilePhoto } from "../src/modules/uad/mobileEvidence.js";
import { syncDcadPropertyContext } from "../src/services/propertyContextSync.js";
import { ensurePropertyContextSchema } from "../src/services/propertyContextStore.js";
import {
  customAppraisalSignatureHmac,
  customAppraisalSnapshotChecksum,
  ensureCustomAppraisalWorkfileSchema,
  signCustomAppraisalWorkfile,
} from "../src/services/customAppraisalWorkfiles.js";

const databaseUrl = process.env.DATABASE_URL;
const MOBILE_PHOTO_JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z",
  "base64",
);

function syncOperation(operationKind, baseSessionRevision, payload, clientOperationId = randomUUID()) {
  return {
    client_operation_id: clientOperationId,
    operation_kind: operationKind,
    base_session_revision: baseSessionRevision,
    payload_sha256: syncPayloadSha256(payload),
    payload,
  };
}

test("mobile report files preserve prior versions and allocate one daily assignment sequence", {
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
    assert.match(firstCustom.reportFile.file_number, /^CA-\d{4}-\d{3}-01$/);
    assert.equal(firstCustom.reportFile.previous_report_file_id, null);
    const firstCustomOwnership = await pool.query(
      `SELECT organization_id, assigned_appraiser_user_id, created_by_user_id, updated_by_user_id
         FROM app.assignment_files WHERE id = $1`,
      [firstCustom.reportFile.target_id],
    );
    assert.equal(firstCustomOwnership.rows[0].organization_id, organizationId);
    assert.equal(firstCustomOwnership.rows[0].assigned_appraiser_user_id, userId);
    assert.equal(firstCustomOwnership.rows[0].created_by_user_id, userId);
    assert.equal(firstCustomOwnership.rows[0].updated_by_user_id, userId);

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
    assert.match(secondCustom.reportFile.file_number, /^CA-\d{4}-\d{3}-02$/);
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
    assert.match(uad.reportFile.file_number, /^3\.6-\d{4}-\d{3}-03$/);
    assert.match(tax.reportFile.file_number, /^PT-\d{4}-\d{3}-04$/);

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
    assert.equal(taxTargetReview.catalog.length, 23);
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

    const saveOperationId = randomUUID();
    const durableSaveInput = {
      client_operation_id: saveOperationId,
      expected_revision: 3,
      workfile_data: {
        subject: { condition_rating: "C5" },
        valuation: { tax_year: 2026 },
      },
    };
    const durableSave = await saveDesktopPropertyTaxFile(
      pool,
      accountId,
      tax.reportFile.target_id,
      durableSaveInput,
      { actorUserId: userId, actorLabel: "Mobile Test Appraiser" },
    );
    const durableReplay = await saveDesktopPropertyTaxFile(
      pool,
      accountId,
      tax.reportFile.target_id,
      durableSaveInput,
      { actorUserId: userId, actorLabel: "Mobile Test Appraiser" },
    );
    assert.equal(durableSave.revision, 4);
    assert.equal(durableReplay.revision, 4);
    await assert.rejects(
      saveDesktopPropertyTaxFile(
        pool,
        accountId,
        tax.reportFile.target_id,
        {
          ...durableSaveInput,
          workfile_data: {
            subject: { condition_rating: "C5" },
            valuation: { tax_year: 2025 },
          },
        },
        { actorUserId: userId, actorLabel: "Mobile Test Appraiser" },
      ),
      /property_tax_protest_save_operation_conflict/,
    );
    const durableCounts = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM app.tax_protest_file_history
           WHERE tax_protest_file_id = $1 AND revision = 4) AS history,
         (SELECT count(*)::integer FROM app.tax_protest_save_operations
           WHERE tax_protest_file_id = $1 AND client_operation_id = $2) AS operations,
         (SELECT count(*)::integer FROM app.report_file_events
           WHERE report_file_id = $3
             AND event_type = 'property_tax_protest.desktop_saved') AS events`,
      [tax.reportFile.target_id, saveOperationId, tax.reportFile.id],
    );
    assert.deepEqual(durableCounts.rows[0], { history: 1, operations: 1, events: 1 });

    const discovery = await listReportFiles(pool, auth, { accountId });
    assert.equal(discovery.files.length, 4);
    assert.equal(discovery.recentlyCreated, true);
    assert.ok(discovery.files.some((file) => file.id === firstCustom.reportFile.id && !file.is_current));
    assert.ok(discovery.files.some((file) => file.id === secondCustom.reportFile.id && file.is_current));

    const search = await searchMobileProperties(pool, auth, { query: "100 Test" });
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].account_id, accountId);
    assert.equal(search.results[0].workflows.custom_appraisal.count, 2);
    assert.equal(search.results[0].workflows.uad_3_6.count, 1);
    assert.equal(search.results[0].workflows.property_tax_protest.count, 1);

    const selected = await getMobileProperty(pool, auth, accountId);
    assert.equal(selected.property.address, "100 Test Street");
    assert.equal(selected.files.length, 4);

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
        return {
          byte_size: MOBILE_PHOTO_JPEG.length,
          etag: objectKey.includes("/original/") ? "original-etag" : "display-etag",
          content_type: "image/jpeg",
        };
      },
      async getObject() {
        return {
          body: MOBILE_PHOTO_JPEG,
          byte_size: MOBILE_PHOTO_JPEG.length,
          content_type: "image/jpeg",
        };
      },
      async putObject({ body }) {
        return { byte_size: body.length, etag: "verified-etag", content_type: "image/jpeg" };
      },
      async deleteObject() { return { deleted: true }; },
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
            byte_size: MOBILE_PHOTO_JPEG.length,
            width: 1,
            height: 1,
          },
          {
            client_object_id: randomUUID(),
            variant: "display",
            file_name: "kitchen-display.jpg",
            content_type: "image/jpeg",
            byte_size: MOBILE_PHOTO_JPEG.length,
            width: 1,
            height: 1,
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

    const placeholderRequest = {
      photos: [{
        ...photoRequest.photos[0],
        client_photo_id: randomUUID(),
        category: "Front",
        category_source: "custom_catalog",
        room_ref: null,
        room_label: null,
        objects: photoRequest.photos[0].objects.map((object) => ({
          ...object,
          client_object_id: randomUUID(),
        })),
      }],
    };
    const placeholderBatch = await createPhotoUploadBatch(
      pool,
      photoStorage,
      auth,
      session.session.id,
      placeholderRequest,
    );
    const placeholderRemovalOperationId = randomUUID();
    const deletedPlaceholder = await removeInspectionPhoto(
      pool,
      auth,
      session.session.id,
      placeholderBatch.photos[0].photo.id,
      {
        client_operation_id: placeholderRemovalOperationId,
        base_revision: placeholderBatch.photos[0].photo.revision,
      },
    );
    assert.equal(deletedPlaceholder.disposition, "placeholder_deleted");
    assert.equal(deletedPlaceholder.photo.status, "deleted");
    const retriedPlaceholderRemoval = await removeInspectionPhoto(
      pool,
      auth,
      session.session.id,
      placeholderBatch.photos[0].photo.id,
      {
        client_operation_id: placeholderRemovalOperationId,
        base_revision: placeholderBatch.photos[0].photo.revision,
      },
    );
    assert.equal(retriedPlaceholderRemoval.disposition, "placeholder_deleted");
    assert.equal(retriedPlaceholderRemoval.photo.status, "deleted");

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

    const uadPhotoRequest = {
      photos: [{
        ...photoRequest.photos[0],
        client_photo_id: randomUUID(),
        category_source: "manual",
        room_ref: null,
        room_label: null,
        objects: photoRequest.photos[0].objects.map((object) => ({
          ...object,
          client_object_id: randomUUID(),
        })),
      }],
    };
    const uadPhotoBatch = await createPhotoUploadBatch(
      pool,
      photoStorage,
      auth,
      uadSession.session.id,
      uadPhotoRequest,
    );
    const uadVerifiedPhoto = await verifyInspectionPhoto(
      pool,
      photoStorage,
      auth,
      uadSession.session.id,
      uadPhotoBatch.photos[0].photo.id,
    );
    const importedAssetId = randomUUID();
    await pool.query(
      `INSERT INTO appraisal.uad_assets (
         id, workfile_id, asset_kind, section_number, caption_type, caption,
         storage_provider, storage_bucket, object_key, original_file_name,
         content_type, byte_size, status, capture_metadata, uploaded_at, verified_at
       ) VALUES (
         $1, $2, 'photo', 10, 'Kitchen', 'Kitchen',
         'r2', 'mobile-photo-test', $3, 'kitchen-display.jpg',
         'image/jpeg', 1200, 'verified', $4::jsonb, now(), now()
       )`,
      [
        importedAssetId,
        uad.reportFile.target_id,
        `organizations/${organizationId}/uad/${importedAssetId}/kitchen-display.jpg`,
        JSON.stringify({
          mobile_photo_id: uadVerifiedPhoto.id,
          mobile_photo_revision: uadVerifiedPhoto.revision,
        }),
      ],
    );
    let importedSourceReads = 0;
    const importStorage = {
      async getObject() {
        importedSourceReads += 1;
        throw new Error("unexpected_mobile_source_read");
      },
    };
    const importInput = {
      section_number: 10,
      caption_type: "Kitchen",
      caption: "Kitchen",
    };
    const importedRetry = await importUadMobilePhoto(
      pool,
      importStorage,
      uad.reportFile.target_id,
      uadVerifiedPhoto.id,
      importInput,
      userId,
    );
    assert.equal(importedRetry.idempotent, true);
    assert.equal(importedRetry.asset.id, importedAssetId);
    assert.equal(importedSourceReads, 0);
    await importUadMobilePhoto(
      pool,
      importStorage,
      uad.reportFile.target_id,
      uadVerifiedPhoto.id,
      importInput,
      userId,
    );
    const importAudit = await pool.query(
      `SELECT asset.created_by_user_id,
              count(audit.id)::integer AS audit_count
         FROM appraisal.uad_assets asset
         LEFT JOIN appraisal.uad_audit_events audit
           ON audit.workfile_id = asset.workfile_id
          AND audit.event_type = 'uad_asset.mobile_photo_imported'
          AND audit.entity_id = asset.id::text
          AND audit.metadata ->> 'provenance_key' = 'mobile_photo_id'
          AND audit.metadata ->> 'provenance_value' = $2
        WHERE asset.id = $1
        GROUP BY asset.created_by_user_id`,
      [importedAssetId, uadVerifiedPhoto.id],
    );
    assert.equal(importAudit.rows[0].created_by_user_id, userId);
    assert.equal(importAudit.rows[0].audit_count, 1);

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
    assert.equal(lineage.rows[0].inherited_from_file_id, null);
    assert.equal(lineage.rows[0].assignment_details.client_name, undefined);
    assert.equal(lineage.rows[0].prior_assignment_details.client_name, "Preserved client");

    const appraisalHistory = await listPreviousAppraisalFiles(pool, accountId);
    assert.equal(appraisalHistory.files.filter((file) => file.workflow_type === "custom_appraisal").length, 3);
    assert.equal(appraisalHistory.files.filter((file) => file.workflow_type === "uad_3_6").length, 1);
    assert.ok(appraisalHistory.files.find((file) => file.id === secondCustom.reportFile.id)?.subject_snapshot_id);
    assert.ok(appraisalHistory.files.find((file) => file.id === uad.reportFile.id)?.appraisal_case_id);

    const replicationRequestId = randomUUID();
    const newAssignmentReplicationInput = {
      mode: "new_assignment_template",
      target_workflow_type: "uad_3_6",
      effective_date: "2026-08-19",
      inspection_date: "2026-08-18",
      client_request_id: replicationRequestId,
    };
    const newAssignmentReplication = await replicateAppraisalFile(pool, {
      accountId,
      sourceReportFileId: secondCustom.reportFile.id,
      input: newAssignmentReplicationInput,
    });
    assert.equal(newAssignmentReplication.change_review_required, true);
    assert.equal(newAssignmentReplication.report_file.workflow_type, "uad_3_6");
    assert.notEqual(
      newAssignmentReplication.report_file.appraisal_case_id,
      appraisalHistory.files.find((file) => file.id === secondCustom.reportFile.id)?.appraisal_case_id,
    );
    const newReplicationRecord = await pool.query(
      `SELECT replication.change_review_required,
              replication.attestation ->> 'mutable_subject_data_copied_to_target' AS mutable_copied,
              source.appraisal_case_id AS source_case_id,
              target.appraisal_case_id AS target_case_id
         FROM app.appraisal_file_replications replication
         JOIN app.report_files source ON source.id = replication.source_report_file_id
         JOIN app.report_files target ON target.id = replication.target_report_file_id
        WHERE replication.target_report_file_id = $1`,
      [newAssignmentReplication.report_file.id],
    );
    assert.equal(newReplicationRecord.rows[0].change_review_required, true);
    assert.equal(newReplicationRecord.rows[0].mutable_copied, "false");
    assert.notEqual(newReplicationRecord.rows[0].source_case_id, newReplicationRecord.rows[0].target_case_id);
    const replayedReplication = await replicateAppraisalFile(pool, {
      accountId,
      sourceReportFileId: secondCustom.reportFile.id,
      input: newAssignmentReplicationInput,
    });
    assert.equal(replayedReplication.report_file.id, newAssignmentReplication.report_file.id);
    const replicationCount = await pool.query(
      `SELECT count(*)::integer AS count
         FROM app.report_files
        WHERE creation_request_id = $1`,
      [replicationRequestId],
    );
    assert.equal(replicationCount.rows[0].count, 1);
    await assert.rejects(
      () => replicateAppraisalFile(pool, {
        accountId,
        sourceReportFileId: secondCustom.reportFile.id,
        input: { ...newAssignmentReplicationInput, inspection_date: "2026-08-17" },
      }),
      /replication_request_conflict/,
    );

    const sameAssignmentReplication = await replicateAppraisalFile(pool, {
      accountId,
      sourceReportFileId: uad.reportFile.id,
      input: {
        mode: "same_assignment_alternate",
        target_workflow_type: "custom_appraisal",
        same_assignment_confirmed: true,
      },
    });
    assert.equal(sameAssignmentReplication.change_review_required, false);
    const sameReplicationRecord = await pool.query(
      `SELECT source.appraisal_case_id AS source_case_id,
              target.appraisal_case_id AS target_case_id,
              source.subject_snapshot_id AS source_snapshot_id,
              target.subject_snapshot_id AS target_snapshot_id
         FROM app.appraisal_file_replications replication
         JOIN app.report_files source ON source.id = replication.source_report_file_id
         JOIN app.report_files target ON target.id = replication.target_report_file_id
        WHERE replication.target_report_file_id = $1`,
      [sameAssignmentReplication.report_file.id],
    );
    assert.equal(sameReplicationRecord.rows[0].target_case_id, sameReplicationRecord.rows[0].source_case_id);
    assert.equal(sameReplicationRecord.rows[0].target_snapshot_id, sameReplicationRecord.rows[0].source_snapshot_id);
  } finally {
    await pool.end();
  }
});

test("property-context source locks prevent overlapping PostgreSQL sync sessions", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  const holder = await pool.connect();
  const lockKey = "homenode:property-context:dcad_parcels";
  let acquired = false;
  let fetchCalls = 0;
  try {
    await ensurePropertyContextSchema(pool);
    const lock = await holder.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [lockKey],
    );
    acquired = lock.rows[0]?.acquired === true;
    assert.equal(acquired, true);

    const result = await syncDcadPropertyContext(pool, {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("contended_sync_must_not_fetch");
      },
    });
    assert.deepEqual(result, {
      source_key: "dcad_parcels",
      skipped: true,
      reason: "property_context_sync_already_running",
    });
    assert.equal(fetchCalls, 0);
  } finally {
    if (acquired) {
      await holder.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [lockKey],
      );
    }
    holder.release();
    await pool.end();
  }
});

test("Custom Appraisal signature retries return one committed snapshot and artifact", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  const organizationId = randomUUID();
  const signerUserId = randomUUID();
  const signatureEventId = randomUUID();
  const accountId = `sign-retry-${randomUUID()}`;
  const signingSecret = "integration-signing-secret-value-0001";
  const signedAt = "2026-09-04T12:00:00.000Z";
  try {
    await pool.query(
      `INSERT INTO app_auth.organizations (id, legal_name, display_name)
       VALUES ($1, 'Signing Retry Organization', 'Signing Retry Organization')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO app_auth.users (id, email, display_name)
       VALUES ($1, $2, 'Signing Retry Appraiser')`,
      [signerUserId, `${signerUserId}@example.test`],
    );
    await pool.query(
      `INSERT INTO core.accounts (account_id, address, city, postal_code)
       VALUES ($1, '200 Retry Street', 'Dallas', '75201')`,
      [accountId],
    );
    const assignment = await pool.query(
      `INSERT INTO app.assignment_files (
         account_id, file_number, assignment_details,
         organization_id, assigned_appraiser_user_id
       ) VALUES ($1, $2, '{}'::jsonb, $3, $4)
       RETURNING id`,
      [accountId, `RETRY-${signatureEventId.slice(0, 8)}`, organizationId, signerUserId],
    );
    const assignmentFileId = Number(assignment.rows[0].id);
    await ensureCustomAppraisalWorkfileSchema(pool);
    const workfile = await pool.query(
      `SELECT canonical_file_name, schema_version
         FROM app.custom_appraisal_workfiles
        WHERE assignment_file_id = $1`,
      [assignmentFileId],
    );
    const snapshot = {
      record_kind: "homenode_custom_appraisal_signed_snapshot",
      assignment_file_id: assignmentFileId,
      status: "signed",
      signed_at: signedAt,
      signed_by: "Signing Retry Appraiser",
      signature: {
        event_id: signatureEventId,
        organization_id: organizationId,
        signer_user_id: signerUserId,
      },
    };
    const checksum = customAppraisalSnapshotChecksum(snapshot);
    const signatureHmac = customAppraisalSignatureHmac(signingSecret, {
      signatureEventId,
      organizationId,
      signerUserId,
      signedAt,
      snapshotChecksumSha256: checksum,
    });
    const signed = await pool.query(
      `INSERT INTO app.custom_appraisal_signed_snapshots (
         assignment_file_id, canonical_file_name, schema_version,
         snapshot, checksum_sha256, signed_by, signed_at,
         organization_id, signed_by_user_id, signature_event_id,
         signature_hmac_sha256
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::timestamptz,$8,$9,$10,$11)
       RETURNING id`,
      [
        assignmentFileId,
        workfile.rows[0].canonical_file_name,
        Number(workfile.rows[0].schema_version),
        JSON.stringify(snapshot),
        checksum,
        "Signing Retry Appraiser",
        signedAt,
        organizationId,
        signerUserId,
        signatureEventId,
        signatureHmac,
      ],
    );
    await pool.query(
      `UPDATE app.custom_appraisal_workfiles
          SET status = 'signed', signed_at = $2, signed_by = $3
        WHERE assignment_file_id = $1`,
      [assignmentFileId, signedAt, "Signing Retry Appraiser"],
    );
    const content = Buffer.from("%PDF-1.4\n% HomeNode retry fixture\n", "utf8");
    const contentChecksum = createHash("sha256").update(content).digest("hex");
    await pool.query(
      `INSERT INTO app.custom_appraisal_report_artifacts (
         assignment_file_id, signed_snapshot_id, canonical_file_name,
         report_version, workfile_checksum_sha256, content_sha256,
         content, byte_size, page_count, generated_by
       ) VALUES ($1,$2,$3,2,$4,$5,$6,$7,9,'HomeNode test')`,
      [
        assignmentFileId,
        signed.rows[0].id,
        `retry-${assignmentFileId}.pdf`,
        checksum,
        contentChecksum,
        content,
        content.length,
      ],
    );

    const retried = await signCustomAppraisalWorkfile(pool, {
      accountId,
      assignmentFileId,
      signedBy: "Signing Retry Appraiser",
      signerUserId,
      signatureEventId,
      signingSecret,
      acknowledgedWarningCodes: [],
    });
    assert.equal(retried.signature.event_id, signatureEventId);
    assert.equal(retried.checksum_sha256, checksum);
    assert.equal(retried.report_pdf.checksum_sha256, contentChecksum);
    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM app.custom_appraisal_signed_snapshots
           WHERE signature_event_id = $1) AS snapshots,
         (SELECT count(*)::integer FROM app.custom_appraisal_report_artifacts
           WHERE assignment_file_id = $2) AS artifacts`,
      [signatureEventId, assignmentFileId],
    );
    assert.deepEqual(counts.rows[0], { snapshots: 1, artifacts: 1 });
  } finally {
    await pool.end();
  }
});
