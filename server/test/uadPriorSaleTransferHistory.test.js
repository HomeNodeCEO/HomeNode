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
  uadFieldIsVisible,
} from "../src/modules/uad/fieldCatalog.js";
import { validateCompleteSection } from "../src/modules/uad/editor.js";
import {
  UAD_OWNERSHIP_TRANSFER_TYPES,
  UAD_PRIOR_SALE_TRANSFER_ENTITY_GROUPS,
  UAD_PRIOR_SALE_TYPES,
  UAD_PRIOR_TRANSFER_CAPTION_TYPES,
  UAD_PRIOR_TRANSFER_DATA_SOURCE_TYPES,
  UAD_TRANSFER_AMOUNT_UNAVAILABLE_REASONS,
  isVerifiedPriorSaleTransferAsset,
} from "../src/modules/uad/priorSaleTransferCatalog.js";
import { subjectPriorTransferSuggestions } from "../src/modules/uad/sharedData.js";

const value = (entityId, contextKey, uid, fieldValue) => ({
  field: getUadField(contextKey, uid),
  entityId,
  value: fieldValue,
});

test("adds the always-applicable official URAR Section 21 editor", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "prior_sale_transfer_history");
  assert.deepEqual(
    sections.map((item) => item.officialSectionNumber),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 26, 29],
  );
  assert.equal(section?.title, "Prior Sale and Transfer History");
  assert.equal(section?.appliesWhen, undefined);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "prior_sale_transfer_history").length, 27);
  assert.equal(UAD_PRIOR_SALE_TRANSFER_ENTITY_GROUPS.sales_comparable.createEnabled, false);
  assert.equal(UAD_PRIOR_SALE_TRANSFER_ENTITY_GROUPS.comparable_prior_transfer.parentEntityType, "sales_comparable");
  assert.equal(
    UAD_PRIOR_SALE_TRANSFER_ENTITY_GROUPS.comparable_prior_transfer_data_source.parentEntityType,
    "comparable_prior_transfer",
  );
});

test("uses official Section 21 enumerations, formats, and amount alternatives", () => {
  assert.deepEqual(UAD_OWNERSHIP_TRANSFER_TYPES, ["DeedTransferOnly", "Sale"]);
  assert.equal(UAD_PRIOR_SALE_TYPES.includes("REOSale"), true);
  assert.equal(UAD_PRIOR_SALE_TYPES.includes("TypicallyMotivated"), true);
  assert.deepEqual(UAD_TRANSFER_AMOUNT_UNAVAILABLE_REASONS, ["NotDisclosed", "NotRecorded", "Other"]);
  assert.deepEqual(UAD_PRIOR_TRANSFER_DATA_SOURCE_TYPES, [
    "AssessorRecord", "BuilderOrDeveloper", "CooperativeBoard", "DataAggregator", "Deed",
    "HomeownersAssociation", "MLS", "Other", "PreviousAppraisalFile",
    "PropertyManagementCompany", "PropertyOwner", "PropertyTenant",
  ]);

  const amount = getUadField("subject_prior_transfer", "0800.0012");
  const unavailable = getUadField("subject_prior_transfer", "0800.0009");
  const date = getUadField("subject_prior_transfer", "0800.0011");
  assert.equal(normalizeAndValidateUadValue(amount, 0).error, null);
  assert.equal(normalizeAndValidateUadValue(amount, -1).error?.code, "currency");
  assert.equal(normalizeAndValidateUadValue(date, "2025-08-01").error, null);
  assert.equal(normalizeAndValidateUadValue(date, "08/01/2025").error?.code, "date");
  assert.equal(uadFieldIsRequired(amount, () => undefined), true);
  assert.equal(uadFieldIsRequired(amount, (key) => key.endsWith("0800.0009") ? "NotRecorded" : undefined), false);
  assert.equal(uadFieldIsVisible(unavailable, (key) => key.endsWith("0800.0012") ? 375000 : undefined), false);
});

test("reconciles subject transfer records, amount choice, and linked data sources", () => {
  const transfer = { id: "eb73b675-3d4d-4ddb-9a8a-4d74d2c37f1a", entity_type: "subject_prior_transfer", parent_entity_id: null, ordinal: 1, data: {} };
  const source = { id: "3036e944-275f-4c7e-9510-1fb0e5123ef3", entity_type: "subject_prior_transfer_data_source", parent_entity_id: transfer.id, ordinal: 1, data: {} };
  const values = [
    value(null, "subject_prior_transfer_summary", "0800.0005", true),
    value(transfer.id, "subject_prior_transfer", "0800.0018", "Sale"),
    value(transfer.id, "subject_prior_transfer", "0800.0013", "TypicallyMotivated"),
    value(transfer.id, "subject_prior_transfer", "0800.0011", "2025-08-01"),
    value(transfer.id, "subject_prior_transfer", "0800.0012", 375000),
    value(source.id, "subject_prior_transfer_data_source", "0700.0125", "Deed"),
    value(null, "subject_prior_transfer_commentary", "1600.0008", "The subject transfer history was researched and analyzed."),
    value(null, "comparable_prior_transfer_commentary", "1600.0008", "No sales comparables have been selected yet."),
  ];
  assert.deepEqual(validateCompleteSection(
    "prior_sale_transfer_history",
    [],
    values,
    [transfer, source],
  ), []);

  const bothAmountForms = [
    ...values,
    value(transfer.id, "subject_prior_transfer", "0800.0009", "NotRecorded"),
  ];
  assert.ok(validateCompleteSection(
    "prior_sale_transfer_history",
    [],
    bothAmountForms,
    [transfer, source],
  ).some((error) => error.code === "subject_prior_transfer_amount_choice_required"));

  assert.ok(validateCompleteSection(
    "prior_sale_transfer_history",
    [],
    values,
    [transfer],
  ).some((error) => error.code === "subject_prior_transfer_data_source_required"));

  const noTransferConflict = values.map((item) => ({ ...item }));
  noTransferConflict.find((item) => item.field?.uid === "0800.0005").value = false;
  assert.ok(validateCompleteSection(
    "prior_sale_transfer_history",
    [],
    noTransferConflict,
    [transfer, source],
  ).some((error) => error.code === "subject_prior_transfer_record_conflict"));
});

test("links comparable transfer histories to the shared future Section 22 entities", () => {
  const subjectNoSource = { id: "11dd84dd-122c-44fe-8e22-ce15c486630e", entity_type: "subject_no_prior_transfer_data_source", parent_entity_id: null, ordinal: 1, data: {} };
  const comparable = { id: "cbb16c69-b45d-4a06-87ad-901bd25035c7", entity_type: "sales_comparable", parent_entity_id: null, ordinal: 1, data: {} };
  const transfer = { id: "7832acc9-aa2a-41bc-949b-66fe4211357c", entity_type: "comparable_prior_transfer", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const source = { id: "6ecb541f-4e25-43c3-8340-ea7be32f225b", entity_type: "comparable_prior_transfer_data_source", parent_entity_id: transfer.id, ordinal: 1, data: {} };
  const values = [
    value(null, "subject_prior_transfer_summary", "0800.0005", false),
    value(subjectNoSource.id, "subject_no_prior_transfer_data_source", "0700.0125", "AssessorRecord"),
    value(null, "subject_prior_transfer_commentary", "1600.0008", "No subject transfers were found after research."),
    value(null, "comparable_prior_transfer_commentary", "1600.0008", "Comparable transfer histories were analyzed."),
    value(comparable.id, "sales_comparable", "1800.0192", 1),
    value(comparable.id, "comparable_prior_transfer_summary", "1800.0198", true),
    value(transfer.id, "comparable_prior_transfer", "1800.0209", "DeedTransferOnly"),
    value(transfer.id, "comparable_prior_transfer", "1800.0207", "2025-10-15"),
    value(transfer.id, "comparable_prior_transfer", "1800.0205", "NotDisclosed"),
    value(source.id, "comparable_prior_transfer_data_source", "0700.0125", "AssessorRecord"),
  ];
  assert.deepEqual(validateCompleteSection(
    "prior_sale_transfer_history",
    [],
    values,
    [subjectNoSource, comparable, transfer, source],
  ), []);

  const duplicateComparable = { ...comparable, id: "477decc3-f720-4055-8e3f-997a6d651f7c", ordinal: 2 };
  const duplicateValues = [
    ...values,
    value(duplicateComparable.id, "sales_comparable", "1800.0192", 1),
    value(duplicateComparable.id, "comparable_prior_transfer_summary", "1800.0198", false),
  ];
  assert.ok(validateCompleteSection(
    "prior_sale_transfer_history",
    [],
    duplicateValues,
    [subjectNoSource, comparable, duplicateComparable, transfer, source],
  ).some((error) => error.code === "comparable_ordinal_duplicate"));

  const orphanNoTransferSource = {
    id: "3dd18cc5-2bbf-4413-807b-ce3aef70f9bc",
    entity_type: "comparable_no_prior_transfer_data_source",
    parent_entity_id: "32b45925-690c-4030-93df-220652522552",
    ordinal: 1,
    data: {},
  };
  assert.ok(validateCompleteSection(
    "prior_sale_transfer_history",
    [],
    [
      ...values,
      value(orphanNoTransferSource.id, "comparable_no_prior_transfer_data_source", "0700.0125", "MLS"),
    ],
    [subjectNoSource, comparable, transfer, source, orphanNoTransferSource],
  ).some((error) => error.code === "comparable_no_prior_transfer_data_source_orphaned"));
});

test("maps HomeNode closed sales and CAD transfers to review-only suggestions", () => {
  const suggestions = subjectPriorTransferSuggestions([
    {
      record_type: "closed_sale",
      source_record_id: 501,
      closing_date: "2025-08-01",
      activity_date: "2025-08-01",
      sale_price: "375000",
      source: "NTREIS MLS",
    },
    {
      record_type: "cad_transfer",
      activity_date: "2024-04-10",
      sale_price: null,
      source: "CAD deed record",
    },
    { record_type: "listing", activity_date: "2026-06-01", list_price: 435000 },
  ]);
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].values["subject_prior_transfer:0800.0018"], "Sale");
  assert.equal(suggestions[0].values["subject_prior_transfer:0800.0012"], 375000);
  assert.equal(suggestions[0].related_entities[0].values["subject_prior_transfer_data_source:0700.0125"], "MLS");
  assert.equal(suggestions[1].values["subject_prior_transfer:0800.0018"], "DeedTransferOnly");
  assert.equal(suggestions[1].values["subject_prior_transfer:0800.0009"], "NotRecorded");
  assert.equal(suggestions.every((suggestion) => suggestion.requires_appraiser_confirmation), true);
});

test("recognizes only verified Section 21 report images", () => {
  assert.deepEqual(UAD_PRIOR_TRANSFER_CAPTION_TYPES, ["PriorSaleAndTransferHistoryExhibit"]);
  const asset = {
    section_number: 21,
    entity_id: null,
    caption_type: "PriorSaleAndTransferHistoryExhibit",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedPriorSaleTransferAsset(asset), true);
  assert.equal(isVerifiedPriorSaleTransferAsset({ ...asset, section_number: 20 }), false);
  assert.equal(isVerifiedPriorSaleTransferAsset({ ...asset, content_type: "application/pdf" }), false);
  assert.equal(isVerifiedPriorSaleTransferAsset({ ...asset, status: "pending_upload" }), false);
});

test("seeds the complete Section 21 catalog and current compliance rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260903_uad_prior_sale_transfer_history.sql"), "utf8");
  assert.match(sql, /PriorSalesOrTransfersIndicator/);
  assert.match(sql, /OwnershipTransferTransactionAmount/);
  assert.match(sql, /PriorSaleAndTransferHistoryExhibit/);
  assert.match(sql, /21\.013\.2/);
  for (const ruleId of [
    "UAD1191", "UAD1192", "UAD1193", "UAD1194", "UAD1195", "UAD1196", "UAD1197",
    "UAD1198", "UAD1199", "UAD1200", "UAD1201", "UAD1202", "UAD1431", "UAD1432",
    "UAD1436", "UAD1439", "UAD1440", "UAD1442", "UAD1444", "UAD1698", "UAD1734",
    "UAD1735", "UAD1744",
  ]) assert.match(sql, new RegExp(ruleId));
  assert.match(sql, /HN-UAD-PRIOR-TRANSFER-004/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server and frontend enforce Section 21 without changing legacy forms", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const editor = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  const frontend = fs.readFileSync(path.resolve(directory, "../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx"), "utf8");
  assert.match(editor, /amount_choice_required/);
  assert.match(editor, /comparable_prior_transfer_required/);
  assert.match(editor, /comparable_ordinal_duplicate/);
  assert.match(assets, /invalid_uad_prior_transfer_content_type/);
  assert.match(assets, /invalid_uad_prior_transfer_asset_entity/);
  assert.match(assets, /invalid_uad_prior_transfer_asset_caption/);
  assert.match(frontend, /Prior sale and transfer history exhibits/);
  assert.doesNotMatch(frontend, /PropertyReport/);
});
