import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalCustomAppraisalFileName,
  customAppraisalSnapshotChecksum,
  customAppraisalSignatureHmac,
  normalizeCustomAppraisalSignatureEventId,
  normalizeCustomAppraisalSaveReason,
  normalizeCustomAppraisalSectionKey,
  normalizeCustomAppraisalSectionRevision,
  normalizeCustomAppraisalSectionValue,
  normalizeCustomAppraisalWarningCodes,
  signCustomAppraisalWorkfile,
  verifyCustomAppraisalSignedSnapshot,
} from "../src/services/customAppraisalWorkfiles.js";

test("builds stable unique Custom Appraisal workfile names", () => {
  assert.equal(
    canonicalCustomAppraisalFileName(" FAS 2026 / 001 ", 42),
    "fas-2026-001-42.homenode-appraisal.json",
  );
  assert.notEqual(
    canonicalCustomAppraisalFileName("FAS 2026 / 001", 42),
    canonicalCustomAppraisalFileName("FAS 2026 / 001", 43),
  );
  assert.throws(
    () => canonicalCustomAppraisalFileName("FAS-1", 0),
    /invalid_assignment_file_id/,
  );
});

test("validates independently versioned workfile sections", () => {
  assert.equal(normalizeCustomAppraisalSectionKey(" Sales_Comparison "), "sales_comparison");
  assert.equal(normalizeCustomAppraisalSectionRevision("3"), 3);
  assert.deepEqual(normalizeCustomAppraisalSectionValue({ rows: [] }), { rows: [] });
  assert.equal(normalizeCustomAppraisalSaveReason("manual_save"), "manual_save");
  assert.throws(() => normalizeCustomAppraisalSectionKey("bad.section"), /invalid_custom_appraisal_section_key/);
  assert.throws(() => normalizeCustomAppraisalSectionRevision(-1), /invalid_custom_appraisal_section_revision/);
  assert.throws(() => normalizeCustomAppraisalSectionValue([]), /invalid_custom_appraisal_section_value/);
  assert.throws(() => normalizeCustomAppraisalSaveReason("silent"), /invalid_custom_appraisal_save_reason/);
});

test("rejects oversized workfile sections before a database write", () => {
  assert.throws(
    () => normalizeCustomAppraisalSectionValue({ payload: "x".repeat(900_000) }),
    /custom_appraisal_section_too_large/,
  );
});

test("normalizes an exact bounded set of acknowledged E&O warning codes", () => {
  assert.deepEqual(
    normalizeCustomAppraisalWarningCodes([
      " Subject_GLA_Missing ",
      "subject_gla_missing",
      "account_data_quality_review",
    ]),
    ["subject_gla_missing", "account_data_quality_review"],
  );
  assert.deepEqual(normalizeCustomAppraisalWarningCodes(undefined), []);
  assert.throws(
    () => normalizeCustomAppraisalWarningCodes(["bad.warning"]),
    /invalid_custom_appraisal_warning_codes/,
  );
  assert.throws(
    () => normalizeCustomAppraisalWarningCodes("subject_gla_missing"),
    /invalid_custom_appraisal_warning_codes/,
  );
});

test("normalizes a client signature event or creates a valid fallback", () => {
  assert.equal(
    normalizeCustomAppraisalSignatureEventId(" 10000000-0000-4000-8000-000000000001 "),
    "10000000-0000-4000-8000-000000000001",
  );
  assert.match(normalizeCustomAppraisalSignatureEventId(), /^[0-9a-f-]{36}$/);
  assert.throws(
    () => normalizeCustomAppraisalSignatureEventId("not-an-event"),
    /invalid_custom_appraisal_signature_event/,
  );
});

test("authenticates a signed snapshot with a server-held deterministic HMAC", () => {
  const input = {
    signatureEventId: "10000000-0000-4000-8000-000000000001",
    organizationId: "20000000-0000-4000-8000-000000000001",
    signerUserId: "30000000-0000-4000-8000-000000000001",
    signedAt: "2026-08-26T12:00:00.000Z",
    snapshotChecksumSha256: "a".repeat(64),
  };
  const first = customAppraisalSignatureHmac("s".repeat(32), input);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, customAppraisalSignatureHmac("s".repeat(32), input));
  assert.notEqual(first, customAppraisalSignatureHmac("s".repeat(32), {
    ...input,
    snapshotChecksumSha256: "b".repeat(64),
  }));
  assert.throws(
    () => customAppraisalSignatureHmac("too-short", input),
    /custom_appraisal_signing_secret_not_configured/,
  );
});

test("verifies HMAC-protected signed snapshots and rejects database tampering", () => {
  const signingSecret = "v".repeat(32);
  const snapshot = {
    z: 3,
    nested: { y: 2, a: 1 },
    saved_at: new Date("2026-08-26T11:00:00.000Z"),
  };
  assert.equal(
    customAppraisalSnapshotChecksum(snapshot),
    customAppraisalSnapshotChecksum({
      nested: { a: 1, y: 2 },
      saved_at: "2026-08-26T11:00:00.000Z",
      z: 3,
    }),
  );
  const row = {
    snapshot,
    checksum_sha256: customAppraisalSnapshotChecksum(snapshot),
    signature_event_id: "10000000-0000-4000-8000-000000000001",
    organization_id: "20000000-0000-4000-8000-000000000001",
    signed_by_user_id: "30000000-0000-4000-8000-000000000001",
    signed_at: new Date("2026-08-26T12:00:00.000Z"),
  };
  row.signature_hmac_sha256 = customAppraisalSignatureHmac(signingSecret, {
    signatureEventId: row.signature_event_id,
    organizationId: row.organization_id,
    signerUserId: row.signed_by_user_id,
    signedAt: row.signed_at,
    snapshotChecksumSha256: row.checksum_sha256,
  });
  assert.equal(verifyCustomAppraisalSignedSnapshot(row, signingSecret), true);
  assert.throws(
    () => verifyCustomAppraisalSignedSnapshot({ ...row, snapshot: { ...snapshot, z: 4 } }, signingSecret),
    /custom_appraisal_signed_snapshot_integrity_failed/,
  );
  assert.throws(
    () => verifyCustomAppraisalSignedSnapshot({ ...row, signature_hmac_sha256: "0".repeat(64) }, signingSecret),
    /custom_appraisal_signed_snapshot_integrity_failed/,
  );
  assert.throws(
    () => verifyCustomAppraisalSignedSnapshot({
      snapshot: { legacy: "tampered" },
      checksum_sha256: "0".repeat(64),
    }, null),
    /custom_appraisal_signed_snapshot_integrity_failed/,
  );
  assert.equal(verifyCustomAppraisalSignedSnapshot({ snapshot: { legacy: true } }, null), true);
});

test("an exact signature retry returns the committed snapshot without signing again", async () => {
  const signatureEventId = "10000000-0000-4000-8000-000000000001";
  const organizationId = "20000000-0000-4000-8000-000000000001";
  const signerUserId = "30000000-0000-4000-8000-000000000001";
  const signingSecret = "r".repeat(32);
  const signedAt = "2026-09-04T12:00:00.000Z";
  const snapshot = {
    record_kind: "homenode_custom_appraisal_signed_snapshot",
    assignment_file_id: 41,
    status: "signed",
    signed_at: signedAt,
    signed_by: "Authenticated Appraiser",
    signature: {
      event_id: signatureEventId,
      organization_id: organizationId,
      signer_user_id: signerUserId,
    },
  };
  const checksum = customAppraisalSnapshotChecksum(snapshot);
  const existingEvent = {
    id: "40000000-0000-4000-8000-000000000001",
    assignment_file_id: 41,
    account_id: "ACCOUNT_1",
    snapshot,
    checksum_sha256: checksum,
    signed_by: "Authenticated Appraiser",
    organization_id: organizationId,
    current_organization_id: organizationId,
    signed_by_user_id: signerUserId,
    signature_event_id: signatureEventId,
    signed_at: new Date(signedAt),
  };
  existingEvent.signature_hmac_sha256 = customAppraisalSignatureHmac(signingSecret, {
    signatureEventId,
    organizationId,
    signerUserId,
    signedAt,
    snapshotChecksumSha256: checksum,
  });
  const artifact = {
    canonical_file_name: "file-41.pdf",
    content_sha256: "b".repeat(64),
    page_count: 9,
    byte_size: 12_345,
    generated_at: new Date("2026-09-04T12:00:01.000Z"),
  };
  const statements = [];
  const client = {
    async query(sql) {
      const statement = String(sql);
      statements.push(statement);
      if (statement.includes("WHERE snapshot.signature_event_id = $1")) {
        return { rows: [existingEvent] };
      }
      if (statement.includes("FROM app.custom_appraisal_report_artifacts WHERE")) {
        return { rows: [artifact] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return client;
    },
  };

  const result = await signCustomAppraisalWorkfile(pool, {
    accountId: "ACCOUNT_1",
    assignmentFileId: 41,
    signedBy: "Authenticated Appraiser",
    signerUserId,
    signatureEventId,
    signingSecret,
    acknowledgedWarningCodes: [],
  });

  assert.equal(result.checksum_sha256, checksum);
  assert.equal(result.report_pdf.canonical_file_name, "file-41.pdf");
  assert.equal(result.report_pdf.byte_size, 12_345);
  assert.equal(statements.some((sql) => sql.includes("pg_advisory_xact_lock")), true);
  assert.equal(
    statements.some((sql) => sql.includes("INSERT INTO app.custom_appraisal_signed_snapshots")),
    false,
  );
  assert.equal(
    statements.some((sql) => sql.includes("UPDATE app.custom_appraisal_workfiles")),
    false,
  );
  assert.equal(statements.at(-1), "COMMIT");

  const renamedRetry = await signCustomAppraisalWorkfile(pool, {
    accountId: "ACCOUNT_1",
    assignmentFileId: 41,
    signedBy: "Updated WorkOS Display Name",
    signerUserId,
    signatureEventId,
    signingSecret,
    acknowledgedWarningCodes: [],
  });
  assert.equal(renamedRetry.signature.event_id, signatureEventId);

  await assert.rejects(
    signCustomAppraisalWorkfile(pool, {
      accountId: "ACCOUNT_1",
      assignmentFileId: 41,
      signedBy: "Another Account User",
      signerUserId: "30000000-0000-4000-8000-000000000002",
      signatureEventId,
      signingSecret,
      acknowledgedWarningCodes: [],
    }),
    /custom_appraisal_signature_event_conflict/,
  );
  assert.equal(statements.at(-1), "ROLLBACK");
});
