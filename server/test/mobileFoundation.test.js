import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createOidcAccessTokenVerifier,
  normalizeOidcIssuer,
  parseBearerToken,
} from "../src/modules/mobile/auth.js";
import {
  completionReadinessFromCounts,
  normalizeInspectionCompletionRequest,
} from "../src/modules/mobile/completion.js";
import {
  customAppraisalFieldCatalog,
  normalizeCustomAppraisalFieldValue,
} from "../src/modules/mobile/customAppraisal.js";
import {
  formatReportFileNumber,
  normalizeWorkflowType,
} from "../src/modules/mobile/fileNumbers.js";
import { calculateManualSketch } from "../src/modules/mobile/manualSketch.js";
import {
  availableMobilePhotoPositions,
  buildMobilePhotoObjectKey,
  normalizePhotoBatch,
} from "../src/modules/mobile/photos.js";
import { normalizePropertySearch } from "../src/modules/mobile/properties.js";
import { normalizeManualSketchDocument } from "../src/modules/mobile/sketches.js";
import {
  canonicalJson,
  normalizeSyncBatch,
  syncPayloadSha256,
} from "../src/modules/mobile/sync.js";

import {
  normalizePropertyTaxWorkfileData,
  propertyTaxFieldCatalog,
} from "../src/modules/mobile/targetFields.js";
import {
  mobileUadEntityCatalog,
  normalizeMobileUadEntityProposal,
} from "../src/modules/mobile/uadEntities.js";
const ISSUER = "https://identity.example.test";
const AUDIENCE = "https://api.homenode.test/mobile";
const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "mobile-test-key", alg: "RS256", use: "sig" };

function encoded(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function token(overrides = {}) {
  const header = encoded({ alg: "RS256", typ: "JWT", kid: publicJwk.kid });
  const payload = encoded({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "user_123",
    iat: Math.floor(NOW / 1000) - 30,
    exp: Math.floor(NOW / 1000) + 300,
    ...overrides,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`, "ascii"), privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifier() {
  return createOidcAccessTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: `${ISSUER}/.well-known/jwks.json`,
    now: () => NOW,
    fetchImpl: async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
}


test("inspection completion requires authoritative queues to be clear", () => {
  const request = normalizeInspectionCompletionRequest({
    client_operation_id: "4cc2f528-65fd-4f4d-8e12-b8ac84a32fc7",
    base_session_revision: 7,
  });
  assert.equal(request.baseSessionRevision, 7);
  assert.throws(
    () => normalizeInspectionCompletionRequest({
      client_operation_id: "4cc2f528-65fd-4f4d-8e12-b8ac84a32fc7",
      base_session_revision: 7,
      submit_report: true,
    }),
    /invalid_inspection_completion_request/,
  );

  const session = {
    id: "36a1a6e1-72cc-46dc-92c5-6f47c49a912e",
    report_file_id: "31824969-2883-475a-abfd-4c3c44b7f9ea",
    organization_id: "fc0c68e9-e00c-443d-9253-d9c570b2e8fa",
    appraiser_user_id: "06d27a75-1499-4562-a39e-e1d353ce69cf",
    workflow_type: "custom_appraisal",
    file_number: "HN-CA-2026-000001",
    status: "review_required",
    revision: 7,
    base_report_revision: 1,
    registry_revision: 3,
  };
  const blocked = completionReadinessFromCounts(session, {
    sync_conflicts: 1,
    custom_reviews: 2,
    target_reviews: 5,
    uad_entity_reviews: 5,
    unverified_photos: 1,
    sketch_exists: false,
    draft_sketches: 0,
  });
  assert.equal(blocked.ready_to_complete, false);
  assert.deepEqual(blocked.blockers, [
    "sync_conflicts",
    "custom_appraisal_review",
    "photo_verification",
  ]);

  const ready = completionReadinessFromCounts(session, {
    sync_conflicts: 0,
    custom_reviews: 0,
    target_reviews: 12,
    uad_entity_reviews: 12,
    unverified_photos: 0,
    sketch_exists: false,
    draft_sketches: 0,
  });
  assert.equal(ready.ready_to_complete, true);
  assert.deepEqual(ready.blockers, []);
});

test("formats independent, recognizable report-file sequences", () => {
  assert.equal(formatReportFileNumber({
    workflowType: "custom_appraisal",
    calendarYear: 2026,
    sequenceNumber: 1,
  }), "HN-CA-2026-000001");
  assert.equal(formatReportFileNumber({
    workflowType: "uad_3_6",
    calendarYear: 2026,
    sequenceNumber: 1,
  }), "HN-UAD-2026-000001");
  assert.equal(formatReportFileNumber({
    workflowType: "property_tax_protest",
    calendarYear: 2026,
    sequenceNumber: 1,
  }), "HN-PTP-2026-000001");
  assert.throws(() => normalizeWorkflowType("uploaded_jpeg"), /invalid_workflow_type/);
});

test("normalizes bounded mobile property searches", () => {
  assert.equal(normalizePropertySearch("  100   Test Street "), "100 Test Street");
  assert.throws(() => normalizePropertySearch("x"), /invalid_property_search_query/);
  assert.throws(() => normalizePropertySearch("x".repeat(121)), /invalid_property_search_query/);
});

test("canonicalizes and validates offline sync operations", () => {
  const payload = {
    value: "Observed condition",
    field_path: "inspection.general.appraiser_comments",
    base: { exists: false },
    source_type: "appraiser",
    appraiser_confirmed: true,
  };
  assert.equal(canonicalJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  const operations = normalizeSyncBatch({
    operations: [{
      client_operation_id: "10000000-0000-4000-8000-000000000001",
      operation_kind: "field.upsert",
      base_session_revision: 1,
      payload_sha256: syncPayloadSha256(payload),
      payload,
    }],
  });
  assert.equal(operations[0].payload.field_path, "inspection.general.appraiser_comments");
  assert.throws(() => normalizeSyncBatch({
    operations: [{
      client_operation_id: "10000000-0000-4000-8000-000000000001",
      operation_kind: "field.upsert",
      base_session_revision: 1,
      payload_sha256: "0".repeat(64),
      payload,
    }],
  }), /invalid_payload_sha256/);
  const targetPayload = {
    value: "C3",
    field_path: "property_tax_protest.subject.condition_rating",
    base: { exists: false },
    target_base: { exists: true, value: "C4" },
    target_base_revision: 3,
    source_type: "appraiser",
    appraiser_confirmed: true,
  };
  const targetOperation = normalizeSyncBatch({
    operations: [{
      client_operation_id: "10000000-0000-4000-8000-000000000002",
      operation_kind: "field.upsert",
      base_session_revision: 1,
      payload_sha256: syncPayloadSha256(targetPayload),
      payload: targetPayload,
    }],
  })[0];
  assert.deepEqual(targetOperation.payload.target_base, { exists: true, value: "C4" });
  assert.equal(targetOperation.payload.target_base_revision, 3);

  const incompleteTargetPayload = { ...targetPayload };
  delete incompleteTargetPayload.target_base_revision;
  assert.throws(() => normalizeSyncBatch({
    operations: [{
      client_operation_id: "10000000-0000-4000-8000-000000000003",
      operation_kind: "field.upsert",
      base_session_revision: 1,
      payload_sha256: syncPayloadSha256(incompleteTargetPayload),
      payload: incompleteTargetPayload,
    }],
  }), /invalid_sync_payload/);
});

test("property tax adapter exposes a bounded canonical field catalog", () => {
  const catalog = propertyTaxFieldCatalog();
  assert.equal(catalog.length, 18);
  assert.equal(new Set(catalog.map((field) => field.field_path)).size, catalog.length);
  assert.ok(catalog.every((field) => field.target_reference.kind === "property_tax_protest"));
  assert.ok(catalog.some((field) => field.field_path.endsWith(".repair_cost_to_cure")));
  assert.ok(catalog.some((field) => field.field_path.endsWith(".district_appraised_value")));
  assert.ok(catalog.some((field) => field.field_path.endsWith(".protest_rationale")));
  assert.ok(catalog.every((field) => !field.field_path.startsWith("custom_appraisal.")));
  const normalized = normalizePropertyTaxWorkfileData({
    subject: { condition_rating: "C4", living_area_sqft: "2450" },
    unrelated: { preserved: true },
  });
  assert.equal(normalized.subject.living_area_sqft, 2450);
  assert.deepEqual(normalized.unrelated, { preserved: true });
  assert.throws(
    () => normalizePropertyTaxWorkfileData({ subject: { condition_rating: "C7" } }),
    /invalid_property_tax_protest_enum/,
  );
});

test("mobile UAD entity proposals use only the official repeatable catalog", () => {
  const catalog = mobileUadEntityCatalog();
  assert.ok(catalog.some((item) => item.entity_type === "unit_room" && item.parent_entity_types.includes("unit")));
  assert.equal(catalog.find((item) => item.entity_type === "dwelling")?.create_enabled, false);
  assert.equal(catalog.find((item) => item.entity_type === "sales_comparable")?.create_enabled, true);
  assert.equal(catalog.filter((item) => item.entity_type === "amenity").length, 5);
  const request = normalizeMobileUadEntityProposal({
    client_operation_id: "10000000-0000-4000-8000-000000000010",
    action: "create",
    entity_type: "unit_room",
    parent_entity_id: "10000000-0000-4000-8000-000000000011",
    label: "Kitchen",
    data: {},
    base_target_revision: 2,
  });
  assert.equal(request.entityType, "unit_room");
  assert.equal(request.parentEntityId, "10000000-0000-4000-8000-000000000011");
  const comparableRequest = normalizeMobileUadEntityProposal({
    client_operation_id: "10000000-0000-4000-8000-000000000013",
    action: "create",
    entity_type: "sales_comparable",
    label: "Comparable 1",
    data: {},
    base_target_revision: 2,
  });
  assert.equal(comparableRequest.entityType, "sales_comparable");
  assert.throws(() => normalizeMobileUadEntityProposal({
    client_operation_id: "10000000-0000-4000-8000-000000000012",
    action: "create",
    entity_type: "dwelling",
    label: "Dwelling 2",
    data: {},
    base_target_revision: 2,
  }), /invalid_uad_entity_creation_disabled/);
});
test("custom appraisal adapter exposes only mapped, bounded assignment fields", () => {
  const catalog = customAppraisalFieldCatalog();
  assert.ok(catalog.length >= 30);
  assert.ok(catalog.some((field) => field.field_path.endsWith(".foundation")));
  assert.ok(catalog.some((field) => field.field_path.endsWith(".kitchen_countertop_type")));
  assert.equal(
    normalizeCustomAppraisalFieldValue(
      "custom_appraisal.property_characteristics.main_improvement.living_area_sqft",
      "2450",
    ),
    2450,
  );
  assert.equal(
    normalizeCustomAppraisalFieldValue(
      "custom_appraisal.assignment_details.subject_condition_rating",
      "c4-c3",
    ),
    "C4-C3",
  );
  assert.throws(
    () => normalizeCustomAppraisalFieldValue("report.property_characteristics.secret", "value"),
    /invalid_custom_appraisal_field_path/,
  );
  assert.throws(
    () => normalizeCustomAppraisalFieldValue(
      "custom_appraisal.property_characteristics.main_improvement.bedroom_count",
      1.5,
    ),
    /invalid_custom_appraisal_integer/,
  );
});

test("manual sketch calculator requires closure before calculating square footage", () => {
  const rectangle = calculateManualSketch({
    vertices: [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
      { x: 0, y: 30 },
      { x: 0, y: 0 },
    ],
  });
  assert.equal(rectangle.closed, true);
  assert.equal(rectangle.self_intersecting, false);
  assert.equal(rectangle.calculated_area_sqft, 1200);
  assert.equal(rectangle.perimeter_feet, 140);
  assert.equal(rectangle.ansi_review_required, true);

  const open = calculateManualSketch({
    vertices: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }],
  });
  assert.equal(open.closed, false);
  assert.equal(open.calculated_area_sqft, null);
});

test("manual sketch calculator rejects self-intersecting outlines", () => {
  const result = calculateManualSketch({
    vertices: [
      { x: 0, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
      { x: 20, y: 0 },
      { x: 0, y: 0 },
    ],
  });
  assert.equal(result.closed, true);
  assert.equal(result.self_intersecting, true);
  assert.equal(result.calculated_area_sqft, null);
});

test("normalizes ANSI review areas, classifications, and stable room references", () => {
  const areaId = "10000000-0000-4000-8000-000000000021";
  const roomId = "10000000-0000-4000-8000-000000000022";
  const sketch = normalizeManualSketchDocument({
    measurement_standard: "ansi_z765_2021",
    measurement_method: "exterior",
    review_status: "appraiser_confirmed",
    areas: [{
      id: areaId,
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
      id: roomId,
      area_id: areaId,
      label: "Kitchen",
      room_type: "kitchen",
      anchor: { x: 20, y: 15 },
    }],
  });
  assert.equal(sketch.summary.above_grade_finished_sqft, 1200);
  assert.equal(sketch.summary.room_count, 1);
  assert.equal(sketch.areas[0].calculation.segments[0].length_feet, 40);
  assert.equal(sketch.areas[0].calculation.reported_area_sqft, 1200);
  assert.equal(sketch.rooms[0].room_ref, `sketch-room:${roomId}`);
  assert.equal(sketch.ansi_review_required, false);
  assert.throws(() => normalizeManualSketchDocument({
    review_status: "appraiser_confirmed",
    areas: [{
      id: areaId,
      label: "Open outline",
      vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }],
    }],
    rooms: [],
  }), /sketch_not_ready_for_confirmation/);
});

test("normalizes room-labeled photo batches with original and display objects", () => {
  const photos = normalizePhotoBatch({
    photos: [{
      client_photo_id: "10000000-0000-4000-8000-000000000010",
      room_ref: "sketch-room-kitchen",
      room_label: "Kitchen",
      source: "camera",
      captured_at: "2026-08-23T12:00:00.000Z",
      objects: [
        {
          client_object_id: "10000000-0000-4000-8000-000000000011",
          variant: "original",
          file_name: "IMG 0001.HEIC",
          content_type: "image/heic",
          byte_size: 4_000,
          width: 4032,
          height: 3024,
        },
        {
          client_object_id: "10000000-0000-4000-8000-000000000012",
          variant: "display",
          file_name: "IMG 0001-display.jpg",
          content_type: "image/jpeg",
          byte_size: 1_200,
          width: 2048,
          height: 1536,
        },
      ],
    }],
  });
  assert.equal(photos[0].category, "Kitchen");
  assert.equal(photos[0].categorySource, "sketch_room");
  assert.equal(photos[0].caption, "Kitchen");
  assert.equal(photos[0].captionSource, "room_auto");
  assert.match(photos[0].requestSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => normalizePhotoBatch({
    photos: [{
      client_photo_id: "10000000-0000-4000-8000-000000000010",
      category: "Other",
      objects: [{
        client_object_id: "10000000-0000-4000-8000-000000000011",
        variant: "original",
        file_name: "IMG.HEIC",
        content_type: "image/heic",
        byte_size: 4_000,
      }],
    }],
  }), /mobile_photo_display_derivative_required/);
  assert.throws(
    () => normalizePhotoBatch({ photos: Array.from({ length: 101 }, () => ({})) }),
    /invalid_mobile_photo_batch/,
  );
});

test("builds private report-file scoped mobile photo object keys", () => {
  assert.equal(buildMobilePhotoObjectKey({
    organizationId: "org-1",
    reportFileId: "file-1",
    photoId: "photo-1",
    objectId: "object-1",
    variant: "original",
    fileName: "Front view #1.heic",
  }), "organizations/org-1/mobile/report-files/file-1/photos/photo-1/original/object-1/Front-view-1.heic");
});

test("mobile photo positions reuse an excluded slot before exceeding 100", () => {
  const occupied = Array.from({ length: 100 }, (_unused, index) => index + 1)
    .filter((position) => position !== 37);
  assert.deepEqual(availableMobilePhotoPositions(occupied), [37]);
});

test("accepts only a bounded bearer token and HTTPS OIDC issuer", () => {
  assert.equal(parseBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.throws(() => parseBearerToken("Basic abc"), /invalid_access_token/);
  assert.equal(normalizeOidcIssuer(`${ISSUER}/`), `${ISSUER}/`);
  assert.throws(() => normalizeOidcIssuer("http://identity.example.test"), /invalid_oidc_issuer/);
});

test("verifies an RS256 OIDC access token with JWKS", async () => {
  const claims = await verifier().verify(token());
  assert.equal(claims.sub, "user_123");
  assert.equal(claims.iss, ISSUER);
});


test("preflights OIDC discovery and supported signing keys", async () => {
  const status = await verifier().preflight();
  assert.equal(status.configured, true);
  assert.equal(status.issuer, ISSUER);
  assert.equal(status.audience, AUDIENCE);
  assert.equal(status.jwksUri, `${ISSUER}/.well-known/jwks.json`);
  assert.equal(status.signingAlgorithm, "RS256");
  assert.equal(status.supportedKeyCount, 1);
});

test("reports an unconfigured OIDC verifier without contacting a provider", async () => {
  const status = await createOidcAccessTokenVerifier().preflight();
  assert.deepEqual(status, { configured: false });
});

test("production mobile-user provisioning is transactional and fail-closed", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(directory, "../scripts/provisionMobileUser.js"),
    "utf8",
  );
  assert.match(source, /process\.env\.NODE_ENV === "production"/);
  assert.match(source, /synthetic users cannot be provisioned in production/);
  assert.match(source, /await client\.query\("BEGIN"\)/);
  assert.match(source, /await client\.query\("COMMIT"\)/);
  assert.match(source, /await client\.query\("ROLLBACK"\)/);
  assert.match(source, /OIDC identity is already mapped to another HomeNode user/);
  assert.match(source, /HomeNode user is already mapped to another subject for this issuer/);
  assert.doesNotMatch(source, /DELETE\s+FROM/i);
});

test("rejects expired, wrong-audience, and tampered OIDC tokens", async () => {
  const oidc = verifier();
  await assert.rejects(() => oidc.verify(token({ exp: Math.floor(NOW / 1000) - 120 })), /invalid_access_token/);
  await assert.rejects(() => oidc.verify(token({ aud: "wrong-audience" })), /invalid_access_token/);
  const valid = token();
  const parts = valid.split(".");
  parts[1] = encoded({ ...JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")), sub: "attacker" });
  await assert.rejects(() => oidc.verify(parts.join(".")), /invalid_access_token/);
});

test("mobile migration is additive and encodes retention, lineage, and sparse edits", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(directory, "../migrations/20260821_mobile_foundation.sql"),
    "utf8",
  );
  assert.match(source, /CREATE TABLE IF NOT EXISTS app\.report_files/);
  assert.match(source, /previous_report_file_id uuid REFERENCES app\.report_files/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS app\.inspection_field_edits/);
  assert.match(source, /required_retention_years integer NOT NULL DEFAULT 5/);
  assert.match(source, /CHECK \(required_retention_years = 5\)/);
  assert.match(source, /UNIQUE \(inspection_session_id, client_operation_id\)/);
  assert.doesNotMatch(source, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);

  const offlineSource = fs.readFileSync(
    path.resolve(directory, "../migrations/20260822_mobile_offline_sync.sql"),
    "utf8",
  );
  assert.match(offlineSource, /ADD COLUMN IF NOT EXISTS client_operation_id uuid/);
  assert.match(offlineSource, /ADD COLUMN IF NOT EXISTS is_tombstone boolean/);
  assert.match(offlineSource, /mobile_sync_operations_unresolved_conflict_idx/);
  assert.doesNotMatch(offlineSource, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);

  const photoSource = fs.readFileSync(
    path.resolve(directory, "../migrations/20260823_mobile_photos.sql"),
    "utf8",
  );
  assert.match(photoSource, /CREATE TABLE IF NOT EXISTS app\.inspection_photos/);
  assert.match(photoSource, /CREATE TABLE IF NOT EXISTS app\.inspection_photo_objects/);
  assert.match(photoSource, /CREATE TABLE IF NOT EXISTS app\.inspection_photo_events/);
  assert.match(photoSource, /required_retention_years integer NOT NULL DEFAULT 5/);
  assert.match(photoSource, /retention_until >= retention_starts_at \+ interval '5 years'/);
  assert.doesNotMatch(photoSource, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);

  const customSource = fs.readFileSync(
    path.resolve(directory, "../migrations/20260824_mobile_custom_appraisal.sql"),
    "utf8",
  );
  assert.match(customSource, /CREATE TABLE IF NOT EXISTS app\.custom_appraisal_sections/);
  assert.match(customSource, /CREATE TABLE IF NOT EXISTS app\.custom_appraisal_proposals/);
  assert.match(customSource, /CREATE TABLE IF NOT EXISTS app\.custom_appraisal_review_operations/);
  assert.match(customSource, /CREATE TABLE IF NOT EXISTS app\.custom_appraisal_adapter_events/);
  assert.match(customSource, /status IN \('pending', 'accepted', 'rejected', 'conflict', 'superseded'\)/);
  assert.doesNotMatch(customSource, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);

  const sketchSource = fs.readFileSync(
    path.resolve(directory, "../migrations/20260825_mobile_manual_sketch.sql"),
    "utf8",
  );
  assert.match(sketchSource, /CREATE TABLE IF NOT EXISTS app\.inspection_sketches/);
  assert.match(sketchSource, /CREATE TABLE IF NOT EXISTS app\.inspection_sketch_rooms/);
  assert.match(sketchSource, /CREATE TABLE IF NOT EXISTS app\.inspection_sketch_history/);
  assert.match(sketchSource, /CREATE TABLE IF NOT EXISTS app\.inspection_sketch_operations/);
  assert.match(sketchSource, /CREATE TABLE IF NOT EXISTS app\.inspection_sketch_events/);
  assert.doesNotMatch(sketchSource, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);

  const targetSource = fs.readFileSync(
    path.resolve(directory, "../migrations/20260827_mobile_target_adapters.sql"),
    "utf8",
  );
  assert.match(targetSource, /ADD COLUMN IF NOT EXISTS target_base jsonb/);
  assert.match(targetSource, /CREATE TABLE IF NOT EXISTS app\.mobile_target_field_proposals/);
  assert.match(targetSource, /CREATE TABLE IF NOT EXISTS app\.mobile_target_review_operations/);
  assert.match(targetSource, /CREATE TABLE IF NOT EXISTS app\.mobile_target_adapter_events/);
  assert.match(targetSource, /workflow_type IN \('uad_3_6', 'property_tax_protest'\)/);
  assert.doesNotMatch(targetSource, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);

  const workfileSource = fs.readFileSync(
    path.resolve(directory, "../migrations/20260828_custom_appraisal_workfiles.sql"),
    "utf8",
  );
  assert.match(workfileSource, /CREATE TABLE IF NOT EXISTS app\.custom_appraisal_workfiles/);
  assert.match(workfileSource, /CREATE TABLE IF NOT EXISTS app\.custom_appraisal_workfile_sections/);
  assert.match(workfileSource, /CREATE TABLE IF NOT EXISTS app\.custom_appraisal_signed_snapshots/);
  assert.match(workfileSource, /checksum_sha256 ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.doesNotMatch(workfileSource, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);

  const entitySource = fs.readFileSync(
    path.resolve(directory, "../migrations/20260831_mobile_uad_entities.sql"),
    "utf8",
  );
  assert.match(entitySource, /CREATE TABLE IF NOT EXISTS app\.mobile_uad_entity_proposals/);
  assert.match(entitySource, /CREATE TABLE IF NOT EXISTS app\.mobile_uad_entity_review_operations/);
  assert.match(entitySource, /CREATE TABLE IF NOT EXISTS app\.mobile_uad_entity_events/);
  assert.match(entitySource, /action IN \('create', 'delete'\)/);
  assert.doesNotMatch(entitySource, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);

  const completionSource = fs.readFileSync(
    path.resolve(directory, "../migrations/20260911_mobile_inspection_completion.sql"),
    "utf8",
  );
  assert.match(completionSource, /ADD COLUMN IF NOT EXISTS completed_by_user_id uuid/);
  assert.match(completionSource, /CREATE TABLE IF NOT EXISTS app\.inspection_completion_operations/);
  assert.match(completionSource, /UNIQUE \(inspection_session_id\)/);
  assert.doesNotMatch(completionSource, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);
});

