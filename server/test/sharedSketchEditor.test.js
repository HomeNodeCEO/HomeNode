import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { UAD_MIGRATION_NAMES } from "../src/database/uadMigrations.js";
import { normalizeUadSketchInput } from "../src/modules/uad/sketches.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.resolve(directory, relative), "utf8");

test("UAD sketch edits require a bounded optimistic revision", () => {
  const normalized = normalizeUadSketchInput({
    expected_revision: 3,
    geometry: {},
    measurements: {},
    calculated_areas: {},
    area_overrides: {},
    source: "homenode",
  });
  assert.equal(normalized.expectedRevision, 3);
  assert.throws(
    () => normalizeUadSketchInput({ expected_revision: 0 }),
    /invalid_uad_sketch_expected_revision/,
  );
});

test("UAD sketch history and editor renders are additive and idempotent", () => {
  assert.ok(UAD_MIGRATION_NAMES.includes("20260928_uad_sketch_editor.sql"));
  const migration = read("../migrations/20260928_uad_sketch_editor.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS appraisal\.uad_sketch_history/);
  assert.match(migration, /UNIQUE \(sketch_id, revision\)/);
  assert.match(migration, /uad_assets_active_sketch_editor_revision_uidx/);
  assert.match(migration, /WHERE status <> 'deleted'/);
});

test("one desktop measured-sketch editor is wired to all three report workflows", () => {
  const custom = read("../../dcad-frontend/src/pages/PropertyReport.tsx");
  const protest = read("../../dcad-frontend/src/components/PropertyTaxWorkfileReview.tsx");
  const uad = read("../../dcad-frontend/src/features/uad/components/UadSketchEditor.tsx");
  const router = read("../src/modules/uad/router.js");
  const server = read("../src/oldServer.js");
  const desktopSketches = read("../src/modules/mobile/desktopSketches.js");
  assert.match(custom, /<MobileSketchReview/);
  assert.match(protest, /<MobileSketchReview/);
  assert.match(uad, /<MobileSketchReview/);
  assert.match(uad, /editUadSketch/);
  assert.match(router, /shared_across_report_types: true/);
  assert.match(server, /property-tax-protest\/:fileId\/sketch/);
  assert.match(desktopSketches, /saveDesktopInspectionSketch/);
  assert.match(desktopSketches, /savePropertyTaxInspectionSketch/);
});

test("every report file exposes a safe mobile-sync sketch workspace", () => {
  const custom = read("../../dcad-frontend/src/pages/PropertyReport.tsx");
  const protest = read("../../dcad-frontend/src/components/PropertyTaxWorkfileReview.tsx");
  const uadAssets = read("../../dcad-frontend/src/features/uad/components/UadAssetPanel.tsx");
  const uadSketch = read("../../dcad-frontend/src/features/uad/components/UadSketchEditor.tsx");

  assert.match(custom, /<SketchWorkspaceEmptyState/);
  assert.match(protest, /<SketchWorkspaceEmptyState/);
  assert.match(uadSketch, /<SketchWorkspaceEmptyState/);
  assert.match(custom, /setInterval\(refreshWhenVisible, 30_000\)/);
  assert.match(protest, /setInterval\(refreshWhenVisible, 30_000\)/);
  assert.match(uadAssets, /setInterval\(refreshWhenVisible, 30_000\)/);
  assert.match(uadSketch, /setInterval\(refreshWhenVisible, 30_000\)/);
  assert.match(uadAssets, /refreshToken={sketchEditorRefresh}/);
});

test("Custom Appraisal places the measured sketch directly before Land Details", () => {
  const custom = read("../../dcad-frontend/src/pages/PropertyReport.tsx");
  const condition = custom.indexOf("<SubjectConditionConformitySection");
  const sketch = custom.indexOf('title="Custom Appraisal measured sketch editor"');
  const land = custom.indexOf(">Land Details</h3>");

  assert.ok(condition >= 0, "condition section should exist");
  assert.ok(sketch > condition, "sketch should follow the other property characteristics");
  assert.ok(land > sketch, "Land Details should immediately follow the sketch workspace");
});

test("web UAD edits regenerate a verified exhibit and retain the source", () => {
  const source = read("../src/modules/uad/mobileEvidence.js");
  assert.match(source, /export async function editUadSketch/);
  assert.match(source, /renderSketchPng/);
  assert.match(source, /verifyUadAssetUpload/);
  assert.match(source, /retained_source_asset_id/);
  assert.match(source, /retained_for_audit: true/);
});
