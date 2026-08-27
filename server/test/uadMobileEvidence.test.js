import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { UAD_MIGRATION_NAMES } from "../src/database/uadMigrations.js";
import { UAD_PHOTO_CATEGORIES } from "../src/modules/mobile/photos.js";

const directory = path.dirname(fileURLToPath(import.meta.url));

test("mobile capture exposes UAD-specific field labels", () => {
  assert.deepEqual(UAD_PHOTO_CATEGORIES.slice(0, 4), [
    "Dwelling front",
    "Dwelling rear",
    "Street/property access",
    "Site/view",
  ]);
  assert.ok(UAD_PHOTO_CATEGORIES.includes("Defect/damage"));
});

test("UAD mobile evidence bridge preserves provenance and report-file isolation", () => {
  const source = fs.readFileSync(
    path.resolve(directory, "../src/modules/uad/mobileEvidence.js"),
    "utf8",
  );
  assert.match(source, /report_file\.uad_workfile_id = workfile\.id/);
  assert.match(source, /photo\.report_file_id = \$2 AND photo\.status = 'verified'/);
  assert.match(source, /review_status = 'appraiser_confirmed'/);
  assert.match(source, /mobile_photo_id/);
  assert.match(source, /mobile_sketch_id/);
  assert.match(source, /renderSketchPng/);
  assert.match(source, /verifyUadAssetUpload/);
  assert.doesNotMatch(source, /createDownloadUrl\([^)]*expiresInSeconds:\s*(?:[6-9]\d\d|\d{4,})/);
});

test("mobile evidence imports have active-record idempotency indexes", () => {
  assert.ok(UAD_MIGRATION_NAMES.includes("20260927_uad_mobile_evidence.sql"));
  const migration = fs.readFileSync(
    path.resolve(directory, "../migrations/20260927_uad_mobile_evidence.sql"),
    "utf8",
  );
  assert.match(migration, /uad_assets_active_mobile_photo_uidx/);
  assert.match(migration, /uad_assets_active_mobile_sketch_uidx/);
  assert.match(migration, /WHERE status <> 'deleted'/);
});
