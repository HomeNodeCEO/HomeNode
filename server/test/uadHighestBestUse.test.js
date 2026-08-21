import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UAD_PHASE_ONE_FIELDS,
  getUadEditorSections,
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldIsRequired,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import {
  UAD_HIGHEST_BEST_USE_CAPTION_TYPES,
  isVerifiedHighestBestUseAsset,
} from "../src/modules/uad/highestBestUseCatalog.js";

test("adds official always-displayed URAR Section 16", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "highest_best_use");
  assert.deepEqual(
    sections.map((item) => item.officialSectionNumber),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 26, 29],
  );
  assert.equal(section?.title, "Highest and Best Use");
  assert.equal(section?.appliesWhen, undefined);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "highest_best_use").length, 6);
});

test("maps all five Appendix A-1 conclusions to their official UIDs and report fields", () => {
  const expected = [
    ["3100.0004", "16.000"],
    ["3100.0006", "16.001"],
    ["3100.0003", "16.002"],
    ["3100.0005", "16.003"],
    ["3100.0007", "16.004"],
  ];
  for (const [uid, reportFieldId] of expected) {
    const field = getUadField("highest_best_use", uid);
    assert.equal(field?.reportFieldId, reportFieldId);
    assert.equal(field?.dataType, "boolean");
    assert.equal(field?.required, true);
    assert.equal(normalizeAndValidateUadValue(field, true).error, null);
    assert.equal(normalizeAndValidateUadValue(field, "true").error?.code, "boolean");
  }
});

test("requires commentary when any Section 16 answer is No", () => {
  const commentary = getUadField("highest_best_use_commentary", "3100.0010");
  const allYes = (key) => key.startsWith("highest_best_use:") ? true : undefined;
  const legallyNo = (key) => key === "highest_best_use:3100.0004" ? false : true;
  assert.equal(commentary?.reportFieldId, "16.005");
  assert.equal(commentary?.maxLength, 5000);
  assert.equal(uadFieldIsRequired(commentary, allYes), false);
  assert.equal(uadFieldIsRequired(commentary, legallyNo), true);
  assert.equal(normalizeAndValidateUadValue(commentary, "x".repeat(5001)).error?.code, "max_length");
});

test("validates complete appraiser-entered Section 16 values", () => {
  const valid = validateUadSectionValues("highest_best_use", [
    { context_key: "highest_best_use", uid: "3100.0004", value: true },
    { context_key: "highest_best_use", uid: "3100.0006", value: true },
    { context_key: "highest_best_use", uid: "3100.0003", value: true },
    { context_key: "highest_best_use", uid: "3100.0005", value: true },
    { context_key: "highest_best_use", uid: "3100.0007", value: true },
    { context_key: "highest_best_use_commentary", uid: "3100.0010", value: "The present use satisfies all four tests." },
  ]);
  assert.equal(valid.errors.length, 0);
  const invalid = validateUadSectionValues("highest_best_use", [
    { context_key: "highest_best_use", uid: "3100.0004", value: "Yes" },
  ]);
  assert.equal(invalid.errors[0]?.code, "boolean");
});

test("recognizes only verified Section 16 image exhibits", () => {
  assert.deepEqual(UAD_HIGHEST_BEST_USE_CAPTION_TYPES, ["HighestAndBestUseExhibit"]);
  const asset = {
    section_number: 16,
    caption_type: "HighestAndBestUseExhibit",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedHighestBestUseAsset(asset), true);
  assert.equal(isVerifiedHighestBestUseAsset({ ...asset, section_number: 15 }), false);
  assert.equal(isVerifiedHighestBestUseAsset({ ...asset, content_type: "application/pdf" }), false);
  assert.equal(isVerifiedHighestBestUseAsset({ ...asset, status: "pending_upload" }), false);
});

test("seeds Section 16 fields, Summary redisplay, exhibits, and official rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260829_uad_highest_best_use.sql"), "utf8");
  assert.match(sql, /LegallyPermissibleIndicator/);
  assert.match(sql, /SiteHighestBestUseIndicator/);
  assert.match(sql, /HighestAndBestUseExhibit/);
  assert.match(sql, /16\.006\.2/);
  assert.match(sql, /1\.024/);
  assert.match(sql, /location_role.*redisplay/s);
  for (const ruleId of ["UAD1659", "UAD1660", "UAD1661", "UAD1662", "UAD1663"]) {
    assert.match(sql, new RegExp(ruleId));
  }
  assert.match(sql, /HN-UAD-HIGHEST-BEST-USE-001/);
  assert.match(sql, /HN-UAD-HIGHEST-BEST-USE-002/);
  assert.match(sql, /Appendix H-1 v1\.5/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server and frontend enforce the Section 16 workflow", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const editor = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  const frontend = fs.readFileSync(path.resolve(directory, "../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx"), "utf8");
  assert.match(editor, /highest_best_use_present_use_conflict/);
  assert.match(assets, /invalid_uad_highest_best_use_content_type/);
  assert.match(assets, /invalid_uad_highest_best_use_asset_entity/);
  assert.match(frontend, /these UAD answers remain appraiser-controlled/);
  assert.match(frontend, /Highest and best use exhibits/);
});
