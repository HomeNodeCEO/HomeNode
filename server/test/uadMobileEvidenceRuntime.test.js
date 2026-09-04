import assert from "node:assert/strict";
import test from "node:test";

import { importUadMobilePhoto } from "../src/modules/uad/mobileEvidence.js";

const IDS = Object.freeze({
  workfile: "11111111-1111-4111-8111-111111111111",
  reportFile: "22222222-2222-4222-8222-222222222222",
  photo: "33333333-3333-4333-8333-333333333333",
  session: "44444444-4444-4444-8444-444444444444",
  asset: "55555555-5555-4555-8555-555555555555",
  actor: "66666666-6666-4666-8666-666666666666",
});

function photoRow(overrides = {}) {
  return {
    id: IDS.photo,
    report_file_id: IDS.reportFile,
    inspection_session_id: IDS.session,
    category: "Dwelling front",
    caption: "Front elevation",
    room_ref: null,
    room_label: null,
    position: 1,
    captured_at: "2026-09-04T12:00:00.000Z",
    verified_at: "2026-09-04T12:01:00.000Z",
    revision: 4,
    variant: "display",
    object_key: "private/mobile/front.jpg",
    original_file_name: "front.jpg",
    content_type: "image/jpeg",
    byte_size: 2048,
    expected_byte_size: 2048,
    pixel_width: 1600,
    pixel_height: 1200,
    ...overrides,
  };
}

function assetRow(overrides = {}) {
  return {
    id: IDS.asset,
    workfile_id: IDS.workfile,
    entity_id: null,
    asset_kind: "photo",
    section_number: 8,
    caption_type: "DwellingFront",
    caption: "Front elevation",
    object_key: "private/uad/front.jpg",
    original_file_name: "front.jpg",
    content_type: "image/jpeg",
    byte_size: 2048,
    status: "verified",
    capture_metadata: {
      mobile_photo_id: IDS.photo,
      mobile_photo_revision: 4,
    },
    uploaded_at: "2026-09-04T12:02:00.000Z",
    verified_at: "2026-09-04T12:03:00.000Z",
    created_at: "2026-09-04T12:02:00.000Z",
    ...overrides,
  };
}

function importPool({ photo = photoRow(), existing = assetRow(), listed = [assetRow()] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql.includes("JOIN app.report_files report_file")) {
        return { rows: [{ id: IDS.reportFile, file_number: "HN-UAD-1" }] };
      }
      if (sql.includes("FROM app.inspection_photos photo")) return { rows: [photo] };
      if (sql.includes("capture_metadata ->> $2 = $3")) return { rows: existing ? [existing] : [] };
      if (sql.includes("INSERT INTO appraisal.uad_audit_events")) return { rows: [] };
      if (sql.includes("ORDER BY section_number NULLS LAST")) return { rows: listed };
      throw new Error(`unexpected_query:${sql}`);
    },
  };
}

function importInput() {
  return {
    section_number: 8,
    caption_type: "DwellingFront",
    caption: "Front elevation",
  };
}

test("an exact verified mobile-photo retry repairs audit state without rereading the source object", async () => {
  const pool = importPool();
  let sourceReads = 0;
  const result = await importUadMobilePhoto(
    pool,
    {
      async getObject() {
        sourceReads += 1;
        throw new Error("source_object_temporarily_unavailable");
      },
    },
    IDS.workfile,
    IDS.photo,
    importInput(),
    IDS.actor,
  );

  assert.equal(result.idempotent, true);
  assert.equal(result.asset.id, IDS.asset);
  assert.equal(sourceReads, 0);
  const audit = pool.queries.find(({ sql }) => sql.includes("INSERT INTO appraisal.uad_audit_events"));
  assert.ok(audit);
  assert.equal(audit.parameters[5], "mobile_photo_id");
  assert.equal(audit.parameters[6], IDS.photo);
  assert.match(audit.sql, /WHERE NOT EXISTS/);
  assert.match(audit.sql, /pg_advisory_xact_lock/);
  assert.match(audit.sql, /id = \$1::uuid AND workfile_id = \$2::uuid/);
  assert.match(audit.sql, /audit\.workfile_id = \$2::uuid/);
});

test("a changed mobile-photo revision cannot masquerade as an idempotent retry", async () => {
  const pool = importPool({ existing: assetRow({
    capture_metadata: { mobile_photo_id: IDS.photo, mobile_photo_revision: 3 },
  }) });
  let sourceReads = 0;
  await assert.rejects(
    () => importUadMobilePhoto(
      pool,
      { async getObject() { sourceReads += 1; } },
      IDS.workfile,
      IDS.photo,
      importInput(),
      IDS.actor,
    ),
    /uad_mobile_evidence_import_conflict/,
  );
  assert.equal(sourceReads, 0);
  assert.equal(pool.queries.some(({ sql }) => sql.includes("INSERT INTO appraisal.uad_audit_events")), false);
});

test("a verified import with a missing canonical asset fails closed before source I/O", async () => {
  const pool = importPool({ listed: [] });
  let sourceReads = 0;
  await assert.rejects(
    () => importUadMobilePhoto(
      pool,
      { async getObject() { sourceReads += 1; } },
      IDS.workfile,
      IDS.photo,
      importInput(),
      IDS.actor,
    ),
    /uad_mobile_evidence_import_state_missing/,
  );
  assert.equal(sourceReads, 0);
});
