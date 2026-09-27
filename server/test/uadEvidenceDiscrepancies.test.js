import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUadEvidenceDiscrepancies,
  loadUadEvidenceDiscrepancies,
} from "../src/modules/uad/evidenceDiscrepancies.js";

const documents = [
  { id: 11, title: "County record", document_type: "other", processing_status: "reviewed" },
  { id: 12, title: "MLS sheet", document_type: "mls_sheet", processing_status: "review_required" },
  { id: 13, title: "Zoning map", document_type: "zoning_map", processing_status: "review_required" },
];

test("page-cited subject differences identify each source and preserve the saved subject record", () => {
  const result = buildUadEvidenceDiscrepancies({
    documents,
    snapshot: {
      account: { county: "Dallas", city: "Garland", postal_code: "75044", legal_description: "LOT 2 BLOCK 1" },
      primary_improvements: { bedroom_count: 3, year_built: 1980, baths_full: 2 },
      owner_parties: [{ owner_name: "Jordan Freeman" }],
    },
    pages: [
      { document_id: 11, page_number: 1, extracted_text: "Legal Description: Lot 2, Block 1\nCounty: Dallas County\nOwner Name: Jordan Freeman\nBedrooms: 3\nLiving Area: 1500 SF\nSite Area: 0.25 acres\nGarage Spaces: 2\nSolar Panels: No" },
      { document_id: 12, page_number: 2, extracted_text: "Legal Description: Lot 3, Block 1\nCounty: Collin\nOwner Name: Alex Freeman\nBedrooms: 4\nLiving Area: 1600 SF\nSite Area: 10890 SF\nGarage Spaces: 3\nSolar Panels: Yes\nSubject Address: 123 Main St, Richardson TX 75080" },
    ],
    candidates: [
      { document_id: 13, field_key: "zoning_code", normalized_value: "SF-7.5", review_status: "suggested", page_number: 1 },
    ],
  });
  const mls = result.discrepancies[12];
  assert.ok(mls.some((item) => item.field_key === "bedrooms" && item.document_page === 2
    && item.other_document_id === 11 && item.other_page === 1));
  assert.ok(mls.some((item) => item.field_key === "legal_description" && item.source === "saved_subject_record"));
  assert.ok(mls.some((item) => item.field_key === "owner_name" && item.other_document_id === 11));
  assert.ok(mls.some((item) => item.field_key === "county" && item.other_document_id === 11));
  assert.ok(mls.some((item) => item.field_key === "city" && item.source === "saved_subject_record"));
  assert.ok(mls.some((item) => item.field_key === "postal_code" && item.source === "saved_subject_record"));
  assert.ok(mls.some((item) => item.field_key === "living_area_sqft" && item.other_document_id === 11));
  assert.ok(mls.some((item) => item.field_key === "garage_spaces" && item.other_document_id === 11));
  assert.ok(mls.some((item) => item.field_key === "solar_panels" && item.other_document_id === 11));
  assert.ok(!mls.some((item) => item.field_key === "site_area_sqft"));
  assert.ok(!result.discrepancies[13].length);
});

test("confirmed values, rejected candidates, and possible multiple owners do not create false alerts", () => {
  const result = buildUadEvidenceDiscrepancies({
    documents: [documents[0], documents[1]],
    snapshot: {
      account: { county: "Dallas", postal_code: "75044-1234" },
      owner_parties: [{ owner_name: "Jordan Freeman" }, { owner_name: "Alex Freeman" }],
    },
    candidates: [
      { document_id: 11, field_key: "subject_property_address", normalized_value: "123 Main St, Garland TX 75044", review_status: "suggested", page_number: 1 },
      { document_id: 12, field_key: "subject_property_address", raw_value: "wrong", confirmed_value: "123 Main St, Garland TX 75044", review_status: "confirmed", page_number: 2 },
      { document_id: 12, field_key: "zoning_code", raw_value: "R-99", review_status: "rejected", page_number: 2 },
    ],
    pages: [
      { document_id: 11, page_number: 1, extracted_text: "Owner Name: Jordan Freeman\nCounty: Dallas County" },
      { document_id: 12, page_number: 2, extracted_text: "Owner Name: Alex Freeman\nCounty: Dallas" },
    ],
  });
  assert.equal(result.discrepancies[11].some((item) => item.source === "saved_subject_record"), false);
  assert.equal(result.discrepancies[12].some((item) => item.source === "saved_subject_record"), false);
  assert.equal(result.discrepancies[12].some((item) => item.field_key === "zoning_code"), false);
});

test("documents listing overlapping owners are not treated as different ownership", () => {
  const result = buildUadEvidenceDiscrepancies({
    documents: [documents[0], documents[1]],
    pages: [
      { document_id: 11, page_number: 1, extracted_text: "Owner: Jordan Freeman\nOwner: Alex Freeman" },
      { document_id: 12, page_number: 1, extracted_text: "Owner: Jordan Freeman" },
    ],
  });
  assert.ok(!result.discrepancies[11].some((item) => item.field_key === "owner_name"));
  assert.ok(!result.discrepancies[12].some((item) => item.field_key === "owner_name"));
});

test("a corrected or rejected zoning candidate is not reintroduced from its PDF text", () => {
  const result = buildUadEvidenceDiscrepancies({
    documents: [documents[0], documents[1]],
    candidates: [
      { document_id: 11, field_key: "zoning_code", raw_value: "R-99", confirmed_value: "R-1", review_status: "confirmed", page_number: 1 },
      { document_id: 12, field_key: "zoning_code", raw_value: "R-99", review_status: "rejected", page_number: 1 },
    ],
    pages: [
      { document_id: 11, page_number: 1, extracted_text: "Zoning Code: R-99" },
      { document_id: 12, page_number: 1, extracted_text: "Zoning Code: R-99" },
    ],
  });
  assert.ok(!result.discrepancies[11].length);
  assert.ok(!result.discrepancies[12].length);
});

test("the database loader only reads documents scoped to one workfile and reports partial coverage", async () => {
  const calls = [];
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("FROM app.assignment_documents")) return { rows: [documents[0]] };
    if (sql.includes("FROM app.assignment_document_field_candidates")) return { rows: [] };
    if (sql.includes("FROM app.assignment_document_pages")) return { rows: [
      { document_id: 11, page_number: 1, extracted_text: "County: Collin", text_truncated: true },
    ] };
    if (sql.includes("FROM appraisal.uad_subject_snapshots")) return { rows: [{ subject_data: { account: { county: "Dallas" } } }] };
    throw new Error("unexpected_query");
  } };
  const result = await loadUadEvidenceDiscrepancies(pool, "workfile-1");
  assert.equal(result.incomplete, true);
  assert.equal(result.discrepancies[11][0].field_key, "county");
  assert.equal(calls[0].params[0], "workfile-1");
  assert.ok(calls.slice(1, 3).every((call) => call.params[0].length === 1 && call.params[0][0] === 11));
  assert.equal(calls[3].params[0], "workfile-1");
});
