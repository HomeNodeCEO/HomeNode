import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalCustomAppraisalFileName,
  customAppraisalSnapshotChecksum,
  customAppraisalSignatureHmac,
  normalizeCustomAppraisalSaveReason,
  normalizeCustomAppraisalSectionKey,
  normalizeCustomAppraisalSectionRevision,
  normalizeCustomAppraisalSectionValue,
  normalizeCustomAppraisalWarningCodes,
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
  assert.equal(verifyCustomAppraisalSignedSnapshot({ snapshot: { legacy: true } }, null), true);
});
