import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildUadNativePdfFileName,
  buildUadSystemPackageMetadata,
  UAD_SYSTEM_PACKAGE_PROFILE,
  UAD_SYSTEM_PACKAGE_UIDS,
} from "../src/modules/uad/systemPackage.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

test("builds deterministic system-owned URAR package metadata", () => {
  const metadata = buildUadSystemPackageMetadata({
    id: "00000000-0000-4000-8000-000000000001",
    file_number: "HN/UAD 0001",
    current_revision: 7,
  });

  assert.deepEqual(metadata, {
    ...UAD_SYSTEM_PACKAGE_PROFILE,
    appraisalVersionIdentifier: "7",
    pdfFileName: "HN-UAD-0001.pdf",
    pdfObjectUrl: "\\\\HN-UAD-0001.pdf",
  });
  assert.equal(UAD_SYSTEM_PACKAGE_UIDS.length, 12);
  assert.equal(new Set(UAD_SYSTEM_PACKAGE_UIDS).size, 12);
});

test("uses a stable workfile fallback and rejects invalid report revisions", () => {
  assert.equal(
    buildUadNativePdfFileName({ id: "00000000-0000-4000-8000-000000000001" }),
    "00000000-0000-4000-8000-000000000001.pdf",
  );
  assert.throws(
    () => buildUadSystemPackageMetadata({ file_number: "HN-1", current_revision: 0 }),
    /uad_appraisal_version_identifier_invalid/,
  );
  assert.throws(
    () => buildUadSystemPackageMetadata({ file_number: "HN-1", current_revision: 100 }),
    /uad_appraisal_version_identifier_invalid/,
  );
});

test("registers only additive system-owned package fields", () => {
  const sql = fs.readFileSync(
    path.join(TEST_DIRECTORY, "../migrations/20260923_uad_system_package.sql"),
    "utf8",
  );
  for (const uid of UAD_SYSTEM_PACKAGE_UIDS) {
    assert.match(sql, new RegExp(uid.replace(".", "\\.")));
  }
  assert.match(sql, /property_context.*system_package/s);
  assert.match(sql, /system_owned.*true/s);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.doesNotMatch(sql, /UPDATE\s+core\./i);
  assert.doesNotMatch(sql, /UPDATE\s+appraisal\.uad_field_values/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i);
  assert.doesNotMatch(sql, /DROP\s+(TABLE|SCHEMA|COLUMN)/i);
});
