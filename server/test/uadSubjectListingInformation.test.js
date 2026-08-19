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
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import { validateCompleteSection } from "../src/modules/uad/editor.js";
import { subjectListingSuggestions } from "../src/modules/uad/sharedData.js";
import {
  UAD_SUBJECT_LISTING_CAPTION_TYPES,
  UAD_SUBJECT_LISTING_DATA_SOURCE_TYPES,
  UAD_SUBJECT_LISTING_ENTITY_GROUPS,
  UAD_SUBJECT_LISTING_STATUS_TYPES,
  UAD_SUBJECT_LISTING_TYPES,
  isVerifiedSubjectListingAsset,
} from "../src/modules/uad/subjectListingCatalog.js";

test("adds always-applicable official URAR Section 19", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "subject_listing_information");
  assert.deepEqual(
    sections.map((item) => item.officialSectionNumber),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
  );
  assert.equal(section?.title, "Subject Listing Information");
  assert.equal(section?.appliesWhen, undefined);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "subject_listing_information").length, 14);
});

test("models the one-year listing decision and repeatable records", () => {
  const decision = getUadField("subject_listing_summary", "0900.0004");
  const source = getUadField("subject_listing_data_source", "0700.0125");
  const status = getUadField("subject_listing", "0900.0013");
  const listingId = getUadField("subject_listing", "0900.0011");
  assert.equal(decision?.reportFieldId, "19.000");
  assert.equal(uadFieldIsRequired(decision, () => undefined), true);
  assert.equal(uadFieldIsVisible(source, (key) => key === "subject_listing_summary:0900.0004" ? false : undefined), true);
  assert.equal(uadFieldIsVisible(source, (key) => key === "subject_listing_summary:0900.0004" ? true : undefined), false);
  assert.equal(uadFieldIsVisible(status, (key) => key === "subject_listing_summary:0900.0004" ? true : undefined), true);
  assert.equal(uadFieldIsRequired(listingId, (key) => key === "subject_listing:0900.0015" ? "MLS" : undefined), true);
  assert.equal(UAD_SUBJECT_LISTING_ENTITY_GROUPS.subject_listing.maxItems, 6);
  assert.equal(UAD_SUBJECT_LISTING_ENTITY_GROUPS.subject_listing_data_source.maxItems, 15);
});

test("uses official Section 19 enumerations and field constraints", () => {
  assert.deepEqual(UAD_SUBJECT_LISTING_STATUS_TYPES, ["Active", "OffMarket", "Pending"]);
  assert.deepEqual(UAD_SUBJECT_LISTING_TYPES, ["Auction", "ForSaleByOwner", "MLS", "Other"]);
  assert.deepEqual(UAD_SUBJECT_LISTING_DATA_SOURCE_TYPES, [
    "AssessorRecord", "BuilderOrDeveloper", "CondominiumQuestionnaire", "CooperativeBoard",
    "CooperativeQuestionnaire", "DataAggregator", "HomeownersAssociation", "LandSurvey", "MLS",
    "Other", "PreviousAppraisalFile", "PropertyManagementCompany", "PropertyOwner",
    "PropertyTenant", "RealEstateAgent",
  ]);

  const listingId = getUadField("subject_listing", "0900.0011");
  const startDate = getUadField("subject_listing", "0900.0012");
  const daysOnMarket = getUadField("subject_listing", "0900.0007");
  assert.equal(normalizeAndValidateUadValue(listingId, "A".repeat(45)).error, null);
  assert.equal(normalizeAndValidateUadValue(listingId, "A".repeat(46)).error?.code, "max_length");
  assert.equal(normalizeAndValidateUadValue(startDate, "2026-06-01").error, null);
  assert.equal(normalizeAndValidateUadValue(startDate, "06/01/2026").error?.code, "date");
  assert.equal(normalizeAndValidateUadValue(daysOnMarket, 0).error, null);
  assert.equal(normalizeAndValidateUadValue(daysOnMarket, -1).error?.code, "integer");

  const entityId = "09b92526-832d-4894-b3ee-c961baad95cc";
  const valid = validateUadSectionValues("subject_listing_information", [{
    context_key: "subject_listing",
    uid: "0900.0013",
    entity_id: entityId,
    value: "Pending",
  }], {
    entityTypesById: new Map([[entityId, "subject_listing"]]),
    entityDataById: new Map([[entityId, {}]]),
  });
  assert.equal(valid.errors.length, 0);
});

test("reconciles listing records, dates, IDs, and total DOM before saving", () => {
  const listingA = { id: "5bd340ba-d4fc-47b7-b2a1-7371e5d4d0fd", entity_type: "subject_listing", ordinal: 1, data: {} };
  const listingB = { id: "51724b3c-661d-4937-a902-f2064f020f67", entity_type: "subject_listing", ordinal: 2, data: {} };
  const values = [
    [null, "subject_listing_summary", "0900.0004", true],
    [listingA.id, "subject_listing", "0900.0013", "OffMarket"],
    [listingA.id, "subject_listing", "0900.0015", "MLS"],
    [listingA.id, "subject_listing", "0900.0011", "MLS-100"],
    [listingA.id, "subject_listing", "0900.0012", "2026-06-01"],
    [listingA.id, "subject_listing", "0900.0010", "2026-06-30"],
    [listingA.id, "subject_listing", "0900.0007", 30],
    [listingA.id, "subject_listing", "0900.0008", 435000],
    [listingB.id, "subject_listing", "0900.0013", "Pending"],
    [listingB.id, "subject_listing", "0900.0015", "MLS"],
    [listingB.id, "subject_listing", "0900.0011", "MLS-101"],
    [listingB.id, "subject_listing", "0900.0012", "2026-07-10"],
    [listingB.id, "subject_listing", "0900.0010", "2026-07-19"],
    [listingB.id, "subject_listing", "0900.0007", 10],
    [listingB.id, "subject_listing", "0900.0008", 425000],
    [null, "subject_listing_summary", "0900.0003", 40],
    [null, "subject_listing_commentary", "0900.0020", "Two relevant listing periods were analyzed."],
  ].map(([entityId, contextKey, uid, value]) => ({
    field: getUadField(contextKey, uid),
    entityId,
    value,
  }));
  assert.deepEqual(
    validateCompleteSection("subject_listing_information", [], values, [listingA, listingB]),
    [],
  );

  const invalid = values.map((item) => ({ ...item }));
  invalid.find((item) => item.entityId === listingB.id && item.field.uid === "0900.0011").value = "mls-100";
  invalid.find((item) => item.entityId === listingB.id && item.field.uid === "0900.0010").value = "2026-07-05";
  invalid.find((item) => item.entityId === null && item.field.uid === "0900.0003").value = 41;
  const codes = validateCompleteSection(
    "subject_listing_information",
    [],
    invalid,
    [listingA, listingB],
  ).map((error) => error.code);
  assert.ok(codes.includes("subject_listing_identifier_duplicate"));
  assert.ok(codes.includes("subject_listing_date_order"));
  assert.ok(codes.includes("subject_listing_total_dom_conflict"));
});

test("maps HomeNode activity to review-only listing suggestions", () => {
  const suggestions = subjectListingSuggestions([
    {
      record_type: "listing",
      mls_status: "Pending",
      listing_id: "NTREIS-123",
      listing_date: "2026-07-01T12:00:00Z",
      activity_date: "2026-07-21T12:00:00Z",
      days_on_market: 21,
      list_price: 425000,
      source: "NTREIS MLS",
      source_record_id: "source-123",
    },
    { record_type: "sale", listing_id: "SETTLED-1", list_price: 410000 },
  ]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].entity_type, "subject_listing");
  assert.equal(suggestions[0].values["subject_listing:0900.0013"], "Pending");
  assert.equal(suggestions[0].values["subject_listing:0900.0015"], "MLS");
  assert.equal(suggestions[0].values["subject_listing:0900.0012"], "2026-07-01");
  assert.equal(suggestions[0].values["subject_listing:0900.0007"], 21);
  assert.equal(suggestions[0].values["subject_listing:0900.0008"], 425000);
  assert.equal(suggestions[0].requires_appraiser_confirmation, true);
  assert.equal(suggestions[0].source_reference, "sales_source_record:source-123");
});

test("recognizes only verified Section 19 subject listing images", () => {
  assert.deepEqual(UAD_SUBJECT_LISTING_CAPTION_TYPES, ["SubjectListingExhibit"]);
  const asset = {
    section_number: 19,
    entity_id: null,
    caption_type: "SubjectListingExhibit",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedSubjectListingAsset(asset), true);
  assert.equal(isVerifiedSubjectListingAsset({ ...asset, section_number: 18 }), false);
  assert.equal(isVerifiedSubjectListingAsset({ ...asset, content_type: "application/pdf" }), false);
  assert.equal(isVerifiedSubjectListingAsset({ ...asset, status: "pending_upload" }), false);
});

test("seeds the Section 19 reference catalog and current rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260901_uad_subject_listing_information.sql"), "utf8");
  assert.match(sql, /ListedWithinPreviousYearIndicator/);
  assert.match(sql, /CumulativeDaysOnMarketCount/);
  assert.match(sql, /SubjectListingExhibit/);
  assert.match(sql, /19\.012\.2/);
  for (const ruleId of [
    "UAD1203", "UAD1204", "UAD1205", "UAD1206",
    "UAD1207", "UAD1208", "UAD1209", "UAD1725", "UAD1726",
  ]) assert.match(sql, new RegExp(ruleId));
  assert.match(sql, /HN-UAD-SUBJECT-LISTING-004/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server and frontend enforce Section 19 without changing legacy forms", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const editor = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  const frontend = fs.readFileSync(path.resolve(directory, "../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx"), "utf8");
  assert.match(editor, /subject_listing_date_order/);
  assert.match(editor, /subject_listing_dom_date_conflict/);
  assert.match(editor, /subject_listing_total_dom_conflict/);
  assert.match(editor, /subject_listing_identifier_duplicate/);
  assert.match(assets, /invalid_uad_subject_listing_content_type/);
  assert.match(assets, /invalid_uad_subject_listing_asset_entity/);
  assert.match(assets, /invalid_uad_subject_listing_asset_caption/);
  assert.match(frontend, /Subject listing information exhibits/);
  assert.doesNotMatch(frontend, /PropertyReport/);
});
