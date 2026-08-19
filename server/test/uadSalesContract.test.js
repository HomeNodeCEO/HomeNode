import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateCompleteSection } from "../src/modules/uad/editor.js";
import {
  UAD_PHASE_ONE_FIELDS,
  getUadEditorSections,
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldIsRequired,
  uadFieldIsVisible,
} from "../src/modules/uad/fieldCatalog.js";
import {
  UAD_SALES_CONTRACT_CAPTION_TYPES,
  UAD_SALES_CONTRACT_TRANSFER_TERMS,
  isVerifiedSalesContractAsset,
} from "../src/modules/uad/salesContractCatalog.js";

test("adds the official URAR Section 20 editor", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "sales_contract");
  assert.deepEqual(
    sections.map((item) => item.officialSectionNumber),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  );
  assert.equal(section?.title, "Sales Contract");
  assert.equal(section?.appliesWhen, undefined);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "sales_contract").length, 14);
});

test("implements the active-contract and contract-review conditional workflow", () => {
  const exists = getUadField("sales_contract", "0600.0016");
  const reviewed = getUadField("sales_contract", "0600.0010");
  const armsLength = getUadField("sales_contract", "0600.0002");
  const price = getUadField("sales_contract", "0600.0008");
  const analysis = getUadField("sales_contract_commentary", "0600.0014");
  assert.equal(uadFieldIsRequired(exists, () => undefined), true);
  assert.equal(uadFieldIsVisible(reviewed, (key) => key === "sales_contract:0600.0016" ? true : undefined), true);
  assert.equal(uadFieldIsRequired(armsLength, (key) => key === "sales_contract:0600.0016" ? true : undefined), true);
  assert.equal(uadFieldIsVisible(price, (key) => key === "sales_contract:0600.0010" ? false : undefined), false);
  assert.equal(uadFieldIsVisible(price, (key) => key === "sales_contract:0600.0010" ? true : undefined), true);
  assert.equal(uadFieldIsRequired(analysis, (key) => key === "sales_contract:0600.0010" ? false : undefined), true);
});

test("uses exact transfer terms and enforces official formats", () => {
  assert.deepEqual(UAD_SALES_CONTRACT_TRANSFER_TERMS, [
    "CourtOrderedNonForeclosureSale", "EstateSale", "ForeclosureSale", "LandSale", "Other",
    "PreSubdivisionSale", "RelocationSale", "REOSale", "SaleBetweenRelatedParties",
    "ShortSale", "TypicallyMotivated",
  ]);
  const transferTerms = getUadField("sales_contract", "0600.0017");
  const contractDate = getUadField("sales_contract", "0600.0009");
  const contractPrice = getUadField("sales_contract", "0600.0008");
  const concessions = getUadField("sales_contract", "0600.0011");
  assert.equal(normalizeAndValidateUadValue(transferTerms, "TypicallyMotivated").error, null);
  assert.equal(normalizeAndValidateUadValue(transferTerms, "ArmsLength").error?.code, "enumeration");
  assert.equal(normalizeAndValidateUadValue(contractDate, "2026-07-15").error, null);
  assert.equal(normalizeAndValidateUadValue(contractDate, "07/15/2026").error?.code, "date");
  assert.equal(normalizeAndValidateUadValue(contractPrice, 435000).error, null);
  assert.equal(normalizeAndValidateUadValue(contractPrice, 0).error?.code, "currency");
  assert.equal(normalizeAndValidateUadValue(concessions, 0).error?.code, "currency");
});

test("reconciles absence, review, and concession decisions before saving", () => {
  const values = [
    ["sales_contract", "0600.0016", true],
    ["sales_contract", "0600.0010", true],
    ["sales_contract", "0600.0002", true],
    ["sales_contract", "0600.0008", 435000],
    ["sales_contract", "0600.0009", "2026-07-15"],
    ["sales_contract", "0600.0017", "TypicallyMotivated"],
    ["sales_contract", "0600.0004", false],
    ["sales_contract", "0600.0006", true],
    ["sales_contract", "0600.0005", true],
    ["sales_contract", "0600.0011", 7500],
    ["sales_contract", "0600.0007", true],
  ].map(([contextKey, uid, value]) => ({ field: getUadField(contextKey, uid), entityId: null, value }));
  assert.deepEqual(validateCompleteSection("sales_contract", [], values, []), []);

  const noContract = values.map((item) => ({ ...item }));
  noContract.find((item) => item.field.uid === "0600.0016").value = false;
  assert.ok(validateCompleteSection("sales_contract", [], noContract, [])
    .some((error) => error.code === "sales_contract_absent_detail_conflict"));

  const noConcessions = values.map((item) => ({ ...item }));
  noConcessions.find((item) => item.field.uid === "0600.0006").value = false;
  assert.ok(validateCompleteSection("sales_contract", [], noConcessions, [])
    .some((error) => error.code === "sales_contract_concession_detail_conflict"));
});

test("recognizes only verified workfile-level Section 20 images", () => {
  assert.deepEqual(UAD_SALES_CONTRACT_CAPTION_TYPES, ["SalesContractExhibit"]);
  const asset = {
    section_number: 20,
    entity_id: null,
    caption_type: "SalesContractExhibit",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedSalesContractAsset(asset), true);
  assert.equal(isVerifiedSalesContractAsset({ ...asset, section_number: 19 }), false);
  assert.equal(isVerifiedSalesContractAsset({ ...asset, content_type: "application/pdf" }), false);
  assert.equal(isVerifiedSalesContractAsset({ ...asset, status: "pending_upload" }), false);
});

test("seeds the complete Section 20 reference catalog and current rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260902_uad_sales_contract.sql"), "utf8");
  assert.match(sql, /SalesContractExistsIndicator/);
  assert.match(sql, /SalesContractReviewedIndicator/);
  assert.match(sql, /TotalSalesConcessionAmount/);
  assert.match(sql, /SalesContractExhibit/);
  assert.match(sql, /20\.012\.2/);
  for (const ruleId of [
    "UAD1127", "UAD1128", "UAD1129", "UAD1130", "UAD1131", "UAD1132",
    "UAD1133", "UAD1134", "UAD1135", "UAD1136", "UAD1728",
  ]) assert.match(sql, new RegExp(ruleId));
  assert.match(sql, /HN-UAD-SALES-CONTRACT-004/);
  assert.match(sql, /'1\.007','redisplay','Summary Contract Price'/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server and frontend enforce Section 20 without changing legacy forms", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const editor = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  const frontend = fs.readFileSync(path.resolve(directory, "../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx"), "utf8");
  assert.match(editor, /sales_contract_absent_detail_conflict/);
  assert.match(editor, /sales_contract_unreviewed_detail_conflict/);
  assert.match(editor, /sales_contract_concession_detail_conflict/);
  assert.match(editor, /sales_contract_asset_conflict/);
  assert.match(assets, /invalid_uad_sales_contract_content_type/);
  assert.match(assets, /invalid_uad_sales_contract_asset_entity/);
  assert.match(assets, /invalid_uad_sales_contract_asset_caption/);
  assert.match(frontend, /Sales contract exhibits/);
  assert.doesNotMatch(frontend, /PropertyReport/);
});
