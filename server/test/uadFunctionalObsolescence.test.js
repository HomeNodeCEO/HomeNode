import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  getUadEditorSections,
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldIsRequired,
  uadFieldIsVisible,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import {
  UAD_FUNCTIONAL_ISSUE_TYPES,
  isVerifiedFunctionalObsolescenceAsset,
} from "../src/modules/uad/functionalObsolescenceCatalog.js";

test("adds the official always-displayed URAR Section 11 fields", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "functional_obsolescence");
  assert.deepEqual(sections.map((item) => item.officialSectionNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(section?.key, "functional_obsolescence");
  assert.equal(section?.title, "Functional Obsolescence");
  assert.equal(section?.appliesWhen, undefined);
  assert.equal(section?.groups.reduce((count, group) => count + group.fields.length, 0), 3);
  assert.equal(getUadField("functional_obsolescence", "3600.0002")?.reportFieldId, "11.000");
  assert.equal(getUadField("functional_obsolescence_commentary", "3600.0006")?.reportFieldId, "11.001");
});

test("uses the exact Appendix A-1 functional issue enumerations and limits", () => {
  assert.deepEqual(UAD_FUNCTIONAL_ISSUE_TYPES, [
    "CeilingHeight",
    "FloorPlan",
    "NonConformity",
    "None",
    "Other",
    "Overimprovement",
    "Underimprovement",
  ]);
  const types = getUadField("functional_obsolescence", "3600.0002");
  const other = getUadField("functional_obsolescence", "3600.0003");
  const commentary = getUadField("functional_obsolescence_commentary", "3600.0006");
  assert.deepEqual(normalizeAndValidateUadValue(types, ["FloorPlan", "Other"]).value, ["FloorPlan", "Other"]);
  assert.equal(normalizeAndValidateUadValue(types, ["Unsupported"]).error?.code, "enumeration");
  assert.equal(other?.maxLength, 33);
  assert.equal(commentary?.maxLength, 5000);
  assert.equal(normalizeAndValidateUadValue(other, "x".repeat(34)).error?.code, "max_length");
});

test("requires conditional Other detail and functional-obsolescence commentary", () => {
  const other = getUadField("functional_obsolescence", "3600.0003");
  const commentary = getUadField("functional_obsolescence_commentary", "3600.0006");
  const actualIssue = (key) => key === "functional_obsolescence:3600.0002" ? ["FloorPlan"] : undefined;
  const none = (key) => key === "functional_obsolescence:3600.0002" ? ["None"] : undefined;
  const otherIssue = (key) => key === "functional_obsolescence:3600.0002" ? ["Other"] : undefined;
  assert.equal(uadFieldIsVisible(other, otherIssue), true);
  assert.equal(uadFieldIsRequired(other, otherIssue), true);
  assert.equal(uadFieldIsVisible(commentary, actualIssue), true);
  assert.equal(uadFieldIsRequired(commentary, actualIssue), true);
  assert.equal(uadFieldIsVisible(commentary, none), true);
  assert.equal(uadFieldIsRequired(commentary, none), false);
  assert.equal(validateUadSectionValues("functional_obsolescence", [
    { context_key: "functional_obsolescence", uid: "3600.0002", value: ["None"] },
  ]).errors.length, 0);
});

test("recognizes only verified Section 11 image exhibits", () => {
  const asset = {
    section_number: 11,
    caption_type: "FunctionalObsolescenceExhibit",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedFunctionalObsolescenceAsset(asset), true);
  assert.equal(isVerifiedFunctionalObsolescenceAsset({ ...asset, section_number: 10 }), false);
  assert.equal(isVerifiedFunctionalObsolescenceAsset({ ...asset, status: "pending_upload" }), false);
  assert.equal(isVerifiedFunctionalObsolescenceAsset({ ...asset, content_type: "application/pdf" }), false);
});

test("seeds Section 11 reference fields and official rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260824_uad_functional_obsolescence.sql"), "utf8");
  assert.match(sql, /FunctionalIssueType/);
  assert.match(sql, /FunctionalIssueDescription/);
  assert.match(sql, /11\.002\.2/);
  assert.match(sql, /UAD1680/);
  assert.match(sql, /UAD1681/);
  assert.match(sql, /HN-UAD-FUNCTIONAL-002/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.match(sql, /Appendix H-1 v1\.5/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server validation protects Section 11 cross-field requirements", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  assert.match(source, /functional_issue_none_conflict/);
  assert.match(source, /functional_issue_limit/);
  assert.match(source, /Functional issues contain an unsupported selection/);
});
