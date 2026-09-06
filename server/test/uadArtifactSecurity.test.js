import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import PDFDocument from "pdfkit";

import { createUadAssetUpload, verifyUadAssetUpload } from "../src/modules/uad/assets.js";
import { buildDeterministicZip } from "../src/modules/uad/uadDeliveryPackage.js";
import { inspectUadAssetPayload, inspectUadPdfSafety } from "../src/modules/uad/uadFileSecurity.js";
import { validateUadSubschema } from "../src/modules/uad/uadSubschema.js";
import { runUadArtifactSecurityChecks } from "../src/modules/uad/uadArtifactSecurity.js";

const WORKFILE_ID = "00000000-0000-4000-8000-000000000001";
const ASSET_ID = "00000000-0000-4000-8000-000000000002";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function staticPdf() {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ compress: true, info: { Title: "Static measurement source" } });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.text("Static measurement source");
    document.end();
  });
}

function compressedActivePdf() {
  const chunks = [Buffer.from("%PDF-1.7\n%\x80\x81\x82\x83\n", "latin1")];
  const offsets = new Map();
  let length = chunks[0].length;
  const append = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1");
    chunks.push(chunk);
    length += chunk.length;
  };
  const appendObject = (number, body) => {
    offsets.set(number, length);
    append(`${number} 0 obj\n`);
    append(body);
    append("\nendobj\n");
  };

  appendObject(2, "<< /Type /Pages /Count 1 /Kids [3 0 R] >>");
  appendObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");

  const catalog = "<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>";
  const action = "<< /S /JavaScript /JS (app.alert\\(1\\)) >>";
  const objectHeader = `1 0 4 ${Buffer.byteLength(catalog, "latin1") + 1} `;
  const objectStream = deflateSync(Buffer.from(`${objectHeader}${catalog} ${action}`, "latin1"));
  appendObject(5, Buffer.concat([
    Buffer.from(`<< /Type /ObjStm /N 2 /First ${Buffer.byteLength(objectHeader)} /Length ${objectStream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    objectStream,
    Buffer.from("\nendstream", "latin1"),
  ]));

  const xrefOffset = length;
  const xrefEntry = (type, field2, field3) => {
    const entry = Buffer.alloc(7);
    entry.writeUInt8(type, 0);
    entry.writeUInt32BE(field2, 1);
    entry.writeUInt16BE(field3, 5);
    return entry;
  };
  const xref = deflateSync(Buffer.concat([
    xrefEntry(0, 0, 65_535),
    xrefEntry(2, 5, 0),
    xrefEntry(1, offsets.get(2), 0),
    xrefEntry(1, offsets.get(3), 0),
    xrefEntry(2, 5, 1),
    xrefEntry(1, offsets.get(5), 0),
    xrefEntry(1, xrefOffset, 0),
  ]));
  appendObject(6, Buffer.concat([
    Buffer.from(`<< /Type /XRef /Size 7 /Root 1 0 R /W [1 4 2] /Length ${xref.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    xref,
    Buffer.from("\nendstream", "latin1"),
  ]));
  append(`startxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

function assetRow(overrides = {}) {
  return {
    id: ASSET_ID,
    workfile_id: WORKFILE_ID,
    storage_provider: "r2",
    storage_bucket: "synthetic-only",
    object_key: `organizations/${ORGANIZATION_ID}/uad/${WORKFILE_ID}/assets/${ASSET_ID}/probe.png`,
    original_file_name: "probe.png",
    content_type: "image/png",
    capture_metadata: { expected_byte_size: PNG.length },
    organization_id: ORGANIZATION_ID,
    entity_id: null,
    asset_kind: "photo",
    section_number: 8,
    caption_type: "DwellingFront",
    caption: null,
    byte_size: PNG.length,
    status: "verified",
    uploaded_at: "2026-08-21T00:00:00.000Z",
    verified_at: "2026-08-21T00:00:00.000Z",
    created_at: "2026-08-21T00:00:00.000Z",
    workfile_status: "draft",
    ...overrides,
  };
}

function verificationHarness(source, persistOutcome) {
  const queries = [];
  const clients = [];
  const storageContractFailures = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      assert.match(sql, /JOIN appraisal\.uad_workfiles/);
      assert.match(sql, /asset\.status IN \('pending_upload', 'uploaded'\)/);
      assert.deepEqual(params, [ASSET_ID, WORKFILE_ID]);
      return { rows: [structuredClone(source)] };
    },
    async connect() {
      const client = { active: false, released: false, statements: [],
        async query(sql, params = []) {
          queries.push({ sql, params });
          const statement = sql.replace(/\s+/g, " ").trim();
          client.statements.push(statement);
          if (statement === "BEGIN ISOLATION LEVEL READ COMMITTED") {
            assert.equal(client.active, false); client.active = true;
            assert.deepEqual(params, []); return { rows: [] };
          }
          assert.equal(client.active, true);
          if (statement === "COMMIT" || statement === "ROLLBACK") {
            assert.deepEqual(params, []); client.active = false; return { rows: [] };
          }
          if (statement === "SELECT id, organization_id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE") {
            assert.deepEqual(params, [WORKFILE_ID]);
            return { rows: [{ id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "draft", signed_at: null }] };
          }
          if (statement === "SELECT EXISTS ( SELECT 1 FROM appraisal.uad_signatures WHERE workfile_id = $1 ) AS has_signatures") {
            assert.deepEqual(params, [WORKFILE_ID]); return { rows: [{ has_signatures: false }] };
          }
          if (statement === "SELECT id, workfile_id, object_key, original_file_name, content_type, section_number, entity_id, asset_kind, caption_type, caption, storage_provider, storage_bucket, capture_metadata, status FROM appraisal.uad_assets WHERE id = $1 AND workfile_id = $2 FOR UPDATE") {
            assert.deepEqual(params, [ASSET_ID, WORKFILE_ID]);
            return { rows: [structuredClone(source)] };
          }
          assert.match(statement, /^WITH mutable_workfile AS /);
          assert.match(statement, /AND status IN \('pending_upload', 'uploaded'\) AND EXISTS \(SELECT 1 FROM mutable_workfile\)/);
          return persistOutcome(sql, params);
        },
        release() { assert.equal(client.released, false); assert.equal(client.active, false); client.released = true; },
      };
      clients.push(client); return client;
    },
  };
  return { pool, queries,
    assertOutsideTransaction() {
      try { assert.equal(clients.some(client => client.active), false); }
      catch (error) { storageContractFailures.push(error.message); throw error; }
    },
    assertComplete() {
      assert.deepEqual(storageContractFailures, [], "rejection/cleanup must not swallow a storage-lock assertion");
      assert.equal(clients.length, 2, "verification owns distinct preflight and final outcome transactions");
      assert.equal(clients.every(client => client.released && !client.active), true);
      assert.equal(clients.every(client => client.statements.at(-1) === "COMMIT"), true);
      assert.equal(clients.filter(client => client.statements.some(sql => sql.startsWith("WITH mutable_workfile"))).length, 1);
    },
  };
}

test("verified asset inspection rejects MIME spoofing, unsafe PDFs, and image bombs", () => {
  const inspected = inspectUadAssetPayload(PNG, "image/png");
  assert.equal(inspected.byte_size, PNG.length);
  assert.equal(inspected.dimensions.pixels, 1);
  assert.match(inspected.checksum_sha256, /^[a-f0-9]{64}$/);

  assert.throws(() => inspectUadAssetPayload(Buffer.alloc(PNG.length, 0x41), "image/png"), /content_type_mismatch/);
  assert.throws(
    () => inspectUadAssetPayload(Buffer.from("%PDF-1.7\n1 0 obj <</OpenAction 2 0 R>>", "ascii"), "application/pdf"),
    /pdf_active_content/,
  );
  assert.throws(
    () => inspectUadAssetPayload(Buffer.from("%PDF-1.7\n1 0 obj <</Open#41ction 2 0 R>>", "ascii"), "application/pdf"),
    /pdf_active_content/,
  );
  const oversizedDimensions = Buffer.from(PNG);
  oversizedDimensions.writeUInt32BE(20_001, 16);
  assert.throws(() => inspectUadAssetPayload(oversizedDimensions, "image/png"), /image_dimensions/);
});

test("verified asset inspection rejects parser-confused non-Buffer body shapes", async () => {
  const invalidBodies = [
    PNG.toString("base64"),
    [...PNG],
    new Uint8Array(PNG),
    { body: PNG },
    null,
  ];
  for (const body of invalidBodies) {
    assert.throws(
      () => inspectUadAssetPayload(body, "image/png"),
      /invalid_uad_asset_body_type/,
    );
    await assert.rejects(
      () => inspectUadPdfSafety(body),
      /invalid_uad_asset_body_type/,
    );
  }
});

test("parser-aware PDF inspection accepts static documents and rejects malformed structures", async () => {
  await inspectUadPdfSafety(await staticPdf());
  await assert.rejects(
    () => inspectUadPdfSafety(compressedActivePdf()),
    /pdf_active_content/,
  );
  await assert.rejects(
    () => inspectUadPdfSafety(Buffer.from("%PDF-1.7\nnot-a-valid-pdf", "ascii")),
    /pdf_structure/,
  );
});

test("new UAD uploads reject active SVG documents before issuing a storage URL", async () => {
  await assert.rejects(
    () => createUadAssetUpload(
      { query: async () => assert.fail("invalid content must not reach PostgreSQL") },
      { createUploadUrl: () => assert.fail("invalid content must not receive a signed URL") },
      WORKFILE_ID,
      { asset_kind: "sketch", content_type: "image/svg+xml", file_name: "active.svg", byte_size: 100 },
    ),
    /invalid_uad_asset_content_type/,
  );
});

test("asset verification copies reviewed bytes to a checksum-addressed immutable key", async () => {
  const source = assetRow({ status: "pending_upload", byte_size: null });
  const fixture = verificationHarness(source, (sql, params) => {
    assert.match(sql, /updated_asset AS/);
    return { rows: [assetRow({ object_key: params[5] })] };
  });
  const operations = [];
  const storage = {
    async inspectObject({ objectKey }) {
      fixture.assertOutsideTransaction();
      operations.push(["inspect", objectKey]);
      return { byte_size: PNG.length, content_type: "image/png", etag: "source-etag" };
    },
    async getObject({ objectKey }) {
      fixture.assertOutsideTransaction();
      operations.push(["get", objectKey]);
      return { body: PNG, byte_size: PNG.length, content_type: "image/png" };
    },
    async putObject({ objectKey, contentType, body }) {
      fixture.assertOutsideTransaction();
      operations.push(["put", objectKey, contentType, body.length]);
      return { byte_size: body.length, etag: "verified-etag" };
    },
    async deleteObject({ objectKey }) {
      fixture.assertOutsideTransaction();
      operations.push(["delete", objectKey]);
      return { deleted: true };
    },
  };

  const result = await verifyUadAssetUpload(fixture.pool, storage, WORKFILE_ID, ASSET_ID);
  const update = fixture.queries.find((query) => /updated_asset AS/.test(query.sql));
  assert.equal(result.status, "verified");
  assert.match(update.params[4], /^[a-f0-9]{64}$/);
  assert.match(update.params[5], new RegExp(`/verified-assets/${ASSET_ID}/${update.params[4]}/probe\\.png$`));
  assert.deepEqual(operations.map(([operation]) => operation), ["inspect", "get", "put", "delete"]);
  assert.equal(operations.at(-1)[1], source.object_key);
  fixture.assertComplete();
});

test("asset verification rejects and removes a same-size MIME-spoofed upload", async () => {
  const source = assetRow({ status: "pending_upload", byte_size: null });
  const spoof = Buffer.alloc(PNG.length, 0x41);
  let rejected = false;
  const fixture = verificationHarness(source, (sql) => {
    assert.match(sql, /SET status = 'rejected'/); rejected = true;
    return { rows: [{ id: ASSET_ID }] };
  });
  const deleted = [];
  const storage = {
    inspectObject: async () => { fixture.assertOutsideTransaction(); return { byte_size: spoof.length, content_type: "image/png", etag: "spoof" }; },
    getObject: async () => { fixture.assertOutsideTransaction(); return { body: spoof, byte_size: spoof.length, content_type: "image/png" }; },
    putObject: async () => assert.fail("spoofed bytes must never be copied"),
    deleteObject: async ({ objectKey }) => { fixture.assertOutsideTransaction(); deleted.push(objectKey); },
  };
  await assert.rejects(
    () => verifyUadAssetUpload(fixture.pool, storage, WORKFILE_ID, ASSET_ID),
    /invalid_uad_uploaded_asset/,
  );
  assert.equal(rejected, true);
  assert.deepEqual(deleted, [source.object_key]);
  fixture.assertComplete();
});

test("asset verification rejects and removes structurally invalid PDF bytes", async () => {
  const malformed = Buffer.from("%PDF-1.7\nnot-a-valid-pdf", "ascii");
  const source = assetRow({
    status: "pending_upload",
    byte_size: null,
    content_type: "application/pdf",
    original_file_name: "probe.pdf",
    object_key: `organizations/${ORGANIZATION_ID}/uad/${WORKFILE_ID}/assets/${ASSET_ID}/probe.pdf`,
    capture_metadata: { expected_byte_size: malformed.length },
  });
  let rejected = false;
  const fixture = verificationHarness(source, (sql) => {
    assert.match(sql, /SET status = 'rejected'/); rejected = true;
    return { rows: [{ id: ASSET_ID }] };
  });
  const deleted = [];
  const storage = {
    inspectObject: async () => { fixture.assertOutsideTransaction(); return { byte_size: malformed.length, content_type: "application/pdf" }; },
    getObject: async () => { fixture.assertOutsideTransaction(); return { body: malformed, byte_size: malformed.length, content_type: "application/pdf" }; },
    putObject: async () => assert.fail("invalid PDF bytes must never be copied"),
    deleteObject: async ({ objectKey }) => { fixture.assertOutsideTransaction(); deleted.push(objectKey); },
  };

  await assert.rejects(
    () => verifyUadAssetUpload(fixture.pool, storage, WORKFILE_ID, ASSET_ID),
    /invalid_uad_uploaded_asset/,
  );
  assert.equal(rejected, true);
  assert.deepEqual(deleted, [source.object_key]);
  fixture.assertComplete();
});

test("ZIP construction rejects portable traversal, device, collision, and control-character paths", () => {
  for (const path of [
    "../escape.txt",
    "C:/escape.txt",
    "Images//empty.jpg",
    "Images/./dot.jpg",
    "Images/CON.txt",
    "Images/name:stream.jpg",
    "Images/line\nfeed.jpg",
  ]) {
    assert.throws(() => buildDeterministicZip([{ path, body: "x" }]), /uad_package_entry_path_invalid/);
  }
  assert.throws(
    () => buildDeterministicZip([{ path: "Report.xml", body: "a" }, { path: "report.xml", body: "b" }]),
    /uad_package_entry_duplicate/,
  );
});

test("the local subschema boundary fails closed on DTD and processing-instruction payloads", async () => {
  await assert.rejects(
    () => validateUadSubschema('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'),
    /uad_xml_dtd_forbidden/,
  );
  await assert.rejects(
    () => validateUadSubschema('<?xml version="1.0"?><?xml-stylesheet href="https://invalid.example/x"?><MESSAGE/>'),
    /uad_xml_processing_instruction_forbidden/,
  );
});

test("the artifact security evidence runner reports only bounded control results", async () => {
  const result = await runUadArtifactSecurityChecks({ checkedAt: "2026-08-21T23:00:00.000Z" });
  assert.equal(result.ok, true);
  assert.equal(result.checks.verified_asset_payload.mime_spoof_rejected, true);
  assert.equal(result.checks.deterministic_package.unsafe_paths_rejected, true);
  assert.equal(result.checks.local_xml_parser.dtd_rejected, true);
  assert.doesNotMatch(JSON.stringify(result), /file:\/\/\/etc\/passwd|invalid\.example|OpenAction|checksum_sha256/);
});
