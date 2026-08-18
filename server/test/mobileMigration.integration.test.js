import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import {
  createInspectionSession,
  createReportFile,
  listReportFiles,
} from "../src/modules/mobile/reportFiles.js";
import { getMobileProperty, searchMobileProperties } from "../src/modules/mobile/properties.js";
import {
  createPhotoUploadBatch,
  listInspectionPhotos,
  removeInspectionPhoto,
  updateInspectionPhoto,
  verifyInspectionPhoto,
} from "../src/modules/mobile/photos.js";
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
        room_ref: "room-kitchen",
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
