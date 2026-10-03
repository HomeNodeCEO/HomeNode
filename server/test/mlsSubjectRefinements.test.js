import assert from "node:assert/strict";
import test from "node:test";
import { buildUrarSubjectEvidence, identifyUrarSubjectSource } from "../src/services/urarSubjectEvidence.js";
import { extractMlsListingPriceHistory, isMlsListingHistory } from "../src/services/mlsListingPriceHistory.js";
import { buildDocumentFieldCandidates, classifyDocument } from "../src/services/documentIntelligence.js";

const evidence = (...pages) => buildUrarSubjectEvidence({ documentType: "mls_sheet", pages });
const value = (result, field) => result.candidates.find(item => item.field_key === field)?.normalized_value;
const table = "Field Name Effective Dt Change Dt Chg Time Previous Value New Value DOM";
// Synthetic addresses, listing numbers, prices and dates in the verified Matrix
// table structure. No private uploaded appraisal document is stored in the repo.
const history = (rows = [], { id = "QA123456", page = "1/1", address = "100 Example Dr Exampleton" } = {}) => [
  "Listing History from MLS", `MLS #: ${id} ${address} Prop Type: RESI`, "Closed", table,
  ...rows, "MlsStatus 05/01/26 05/01/26 10:07 AM INC CSN", "10/3/26, 4:13 PM Matrix",
  `https://example.mlsmatrix.com/Matrix/Public/DisplayITQPopup.aspx ${page}`,
].join("\n");
const summary = result => JSON.parse(value(result, "listing_price_history"));

test("Matrix HOA None is a reviewable user-workflow false proposal with no invented dues", () => {
  const result = evidence("MLS#: QA123456\nHOA: None HOA Co:\nHOA Mgmt Email: HOA Website:");
  assert.equal(value(result, "pud"), "false");
  assert.equal(value(result, "hoa_dues_amount"), undefined);
  assert.equal(value(result, "hoa_frequency"), undefined);
  const candidate = result.candidates.find(item => item.field_key === "pud");
  assert.equal(candidate.review_status, "suggested");
  assert.match(candidate.extraction_method, /hoa_workflow_proxy$/);
  assert.match(candidate.evidence_excerpt, /not legal proof/);
  assert.equal(candidate.page_number, 1);
});

test("affirmative HOA defaults true even without reported dues, without fabricating amount or period", () => {
  for (const status of ["Yes", "Mandatory", "Required"]) {
    const result = evidence(`HOA: ${status} HOA Co: Example HOA`);
    assert.equal(value(result, "pud"), "true", status);
    assert.equal(value(result, "hoa_dues_amount"), undefined);
    assert.ok(result.unresolved.some(item => item.reason === "affirmative_hoa_dues_not_reported"));
  }
});

test("unambiguous positive labeled dues with a monthly or annual period establish the HOA-exists default", () => {
  for (const text of ["HOA Dues: $120 annually", "HOA Fee: $30 per month", "Association Fee: $25\nAssociation Fee Frequency: Monthly"]) {
    const result = evidence(text);
    assert.equal(value(result, "pud"), "true", text);
    assert.match(result.candidates.find(item => item.field_key === "pud").extraction_method, /hoa_workflow_proxy$/);
  }
  for (const text of ["HOA Dues: $0 annually", "HOA Dues: $100", "HOA Dues: $100 annually\nHOA: Unknown",
    "HOA Dues: $100 annually\nSubType: Condominium", "HOA Dues: $100 annually\nHOA Dues: $200 annually",
    "HOA Dues: $100 annually\nHOA Frequency: Monthly"]) assert.equal(value(evidence(text), "pud"), undefined, text);
  assert.equal(value(evidence("HOA Dues: $100 annually\nHOA: Voluntary"), "pud"), "false");
});

test("Matrix HOA amount and frequency stay bounded to their own labels", () => {
  const result = evidence("HOA: Mandatory HOA Dues: $1,250 annually HOA Co: Example HOA");
  assert.equal(value(result, "pud"), "true");
  assert.equal(value(result, "hoa_dues_amount"), "1250.00");
  assert.equal(value(result, "hoa_frequency"), "per_year");
  const split = evidence("HOA: Yes\nHOA Dues: $125.50\nHOA Dues Freq: Monthly");
  assert.equal(value(split, "hoa_dues_amount"), "125.50");
  assert.equal(value(split, "hoa_frequency"), "per_month");
  const unrelated = evidence("HOA: Mandatory HOA Co: Example 125 Company\nList Price: $300,000");
  assert.equal(value(unrelated, "hoa_dues_amount"), undefined);
});

test("voluntary HOA defaults false with a review flag; unknown HOA remains unknown", () => {
  const voluntary = evidence("HOA: Voluntary\nHOA Dues: $100 per year");
  assert.equal(value(voluntary, "pud"), "false");
  assert.ok(voluntary.unresolved.some(item => item.reason === "voluntary_hoa_defaults_non_pud_review_required"));
  for (const status of ["Unknown", "Optional or mandatory", "See agent", "", "None or Yes", "Possibly", "N/A"]) {
    assert.equal(value(evidence(`HOA: ${status}`), "pud"), undefined, status);
  }
});

test("condominium and cooperative records cannot acquire a default PUD assumption", () => {
  for (const type of ["Property Type: Condominium", "SubType: Condo", "Housing Type: Co-op", "Property Type: Cooperative"]) {
    const result = evidence(`HOA: Yes\n${type}\nHOA Dues: $200/month`);
    assert.equal(value(result, "pud"), undefined, type);
    assert.ok(result.unresolved.some(item => item.reason === "hoa_workflow_proxy_ineligible_property_type"));
  }
});

test("explicit PUD values take precedence and contradictory HOA observations require review", () => {
  const explicit = evidence("PUD: No\nHOA: Mandatory\nHOA Dues: $125 per month");
  assert.equal(value(explicit, "pud"), "false");
  assert.ok(explicit.unresolved.some(item => item.reason === "hoa_status_conflicts_with_explicit_pud"));
  assert.equal(value(evidence("PUD: Unknown\nHOA: Mandatory\nHOA Dues: $125 per month"), "pud"), undefined);
  for (const text of ["HOA: None\nHOA: Mandatory", "HOA: None\nHOA Dues: $125 per month", "HOA: Mandatory\nHOA Dues: $100\nHOA Dues: $200"]) {
    assert.equal(value(evidence(text), "pud"), undefined);
  }
});

test("single complete Matrix history with status changes proves no price rows, not sold price or DOM", () => {
  const rows = ["MlsStatus 09/19/26 09/20/26 10:42 AM PND SLD ($310,000) 72",
    "MlsStatus 08/18/26 09/10/26 07:50 AM AOC PND 91",
    "MlsStatus 08/18/26 08/19/26 02:00 PM ACT AOC 73",
    "MlsStatus 05/01/26 06/11/26 12:39 PM CSN ACT"];
  const result = extractMlsListingPriceHistory([history(rows)]), data = summary(result);
  assert.equal(data.listing_id, "QA123456"); assert.equal(data.list_date, "2026-05-01");
  assert.equal(data.coverage, "complete"); assert.equal(data.reduction_count, 0);
  assert.deepEqual(data.price_changes, []); assert.deepEqual(data.reductions, []);
  assert.equal(data.final_list_price, null);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.candidates[0].page_number, 1);
  assert.match(result.candidates[0].evidence_excerpt, /INC CSN/);
  assert.equal(value(result, "days_on_market"), undefined);
  assert.equal(value(result, "list_price"), undefined);
});

test("actual price changes are sorted chronologically and reductions exclude increases and original-price fields", () => {
  const result = extractMlsListingPriceHistory([history([
    "ListPrice 08/10/26 08/11/26 01:00 PM $290,000 $275,000 90",
    "ListPrice 07/01/26 07/02/26 01:00 PM $285,000 $290,000 60",
    "OriginalListPrice 06/01/26 06/02/26 01:00 PM $310,000 $300,000 30",
    "ListPrice 05/20/26 05/21/26 01:00 PM $300,000 $285,000 20",
  ])]);
  const data = summary(result);
  assert.equal(data.reduction_count, 2); assert.equal(data.first_reduction_date, "2026-05-20");
  assert.equal(data.last_reduction_date, "2026-08-10"); assert.equal(data.final_list_price, "275000.00");
  assert.equal(data.price_changes.length, 3); assert.equal(data.price_changes[1].new_price, "290000.00");
  assert.equal(data.price_changes[0].change_date, "2026-05-21");
});

test("unproven page coverage or missing initial listing event cannot prove complete no-reductions", () => {
  for (const page of [history([], { page: "1/2" }), history().replace(/https:[^\n]+/, ""), history().replace(/MlsStatus 05\/01[^\n]+/, "MlsStatus 06/01/26 06/01/26 10:00 AM CSN ACT")]) {
    const result = extractMlsListingPriceHistory([page]);
    assert.equal(summary(result).coverage, "partial");
    assert.ok(result.unresolved.some(item => item.reason === "listing_history_coverage_incomplete"));
  }
});

test("same-day prices use the printed change time; irreconcilable chains and malformed rows fail closed", () => {
  const result = extractMlsListingPriceHistory([history([
    "ListPrice 05/20/26 05/20/26 02:00 PM $290,000 $285,000 20",
    "ListPrice 05/20/26 05/20/26 09:00 AM $300,000 $290,000 20",
  ])]);
  assert.equal(summary(result).final_list_price, "285000.00");
  for (const row of ["ListPrice 02/30/26 03/01/26 01:00 PM $300,000 $290,000 20",
    "ListPrice 05/20/26 05/20/26 01:00 PM Unknown $290,000 20",
    "UnknownPrice 05/20/26 05/20/26 01:00 PM $300,000 $290,000 20",
    "ListPrice 05/20/26 05/20/26 13:00 PM $300,000 $290,000 20"]) {
    const bad = extractMlsListingPriceHistory([history([row])]);
    assert.deepEqual(bad.candidates, []); assert.ok(bad.unresolved.length);
  }
  assert.deepEqual(extractMlsListingPriceHistory([history([
    "ListPrice 05/20/26 05/20/26 09:00 AM $300,000 $290,000 20",
    "ListPrice 05/21/26 05/21/26 09:00 AM $299,000 $285,000 21",
  ])]).candidates, []);
});

test("multiple historical MLS records stay independent, including their current-source identities", () => {
  const first = history(["ListPrice 06/01/26 06/01/26 09:00 AM $350,000 $340,000 30"], { page: "1/2" });
  const second = history([], { id: "QA654321", page: "2/2" });
  const result = evidence(first, second);
  assert.equal(result.source_layout, "matrix_listing_history");
  assert.equal(result.candidates.length, 2); assert.deepEqual(result.conflicts, []);
  const data = result.candidates.map(item => JSON.parse(item.normalized_value));
  assert.equal(data[0].listing_id, "QA123456"); assert.equal(data[0].reduction_count, 1);
  assert.equal(data[1].listing_id, "QA654321"); assert.equal(data[1].reduction_count, 0);
  assert.ok(data.every(item => item.coverage === "complete"));
  assert.equal(result.candidates[1].page_number, 2);
});

test("malformed history identities and contradictory same-ID properties cannot share a summary", () => {
  for (const id of ["Unknown", "NULL", "12", "QA123456/OTHER", "A".repeat(46)]) {
    const result = extractMlsListingPriceHistory([history([], { id })]);
    assert.deepEqual(result.candidates, [], id);
    assert.ok(result.unresolved.some(item => item.reason === "listing_history_identity_ambiguous"), id);
  }
  const result = extractMlsListingPriceHistory([
    history([], { page: "1/2" }), history([], { page: "2/2", address: "200 Different Dr Exampleton" }),
  ]);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.unresolved.some(item => item.reason === "listing_history_identity_ambiguous"));
});

test("ordinary MLS sheet prices cannot imply no reductions; bounded history input never truncates to success", () => {
  assert.deepEqual(extractMlsListingPriceHistory(["MLS#: QA123456\nLP: $300,000 OLP: $300,000"]).candidates, []);
  for (const pages of [[history(), null], [history(), "\uFFFD"], Array(251).fill(history()), [history(), "x".repeat(4_001)]]) {
    const result = extractMlsListingPriceHistory(pages);
    assert.deepEqual(result.candidates, []); assert.ok(result.unresolved.length);
  }
  assert.equal(isMlsListingHistory(history()), true);
  assert.equal(identifyUrarSubjectSource({ documentType: "other", pages: [history()] }), "mls_sheet");
});

test("generic CAD/Realist census values preserve tract identifiers and reject unrelated numbers", () => {
  for (const heading of ["DALLAS APPRAISAL DISTRICT", "REALIST"]) {
    const result = buildUrarSubjectEvidence({ documentType: "other", pages: [`${heading}\nCensus Tract: 0123.45`] });
    assert.equal(value(result, "census_tract"), "0123.45");
    assert.equal(value(buildUrarSubjectEvidence({ documentType: "other", pages: [`${heading}\nCensus Tract:\nSchool District Code: 1234`] }), "census_tract"), undefined);
  }
});

test("history documents reach review without generic listing fields mixing current and previous records", () => {
  const pages = [history([], { page: "1/2" }), history([], { id: "QA654321", page: "2/2" })];
  const documentType = classifyDocument({ requestedType: "other", fileName: "History.pdf", pages });
  assert.equal(documentType, "mls_sheet");
  const candidates = buildDocumentFieldCandidates({ documentType, pages });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(item => item.field_key === "listing_price_history"));
  assert.deepEqual(candidates.map(item => JSON.parse(item.normalized_value).listing_id), ["QA123456", "QA654321"]);
});

test("Matrix sheet DOM, LD and OLP are distinct printed values, not CDOM or status history values", () => {
  const candidates = buildDocumentFieldCandidates({ documentType: "mls_sheet", pages: [
    "MLS#: 12345678 Active Option Contract 100 Example Dr Exampleton, TX 75000 LP: $300,000\nProperty Type: Residential SubType: Single Family OLP: $310,000\nCDOM: 83 DOM: 57 LD: 05/01/2026 XD:\nHOA: None HOA Co:",
  ] });
  const fields = Object.fromEntries(candidates.map(item => [item.field_key, item.normalized_value]));
  assert.equal(fields.days_on_market, "57"); assert.equal(fields.list_date, "2026-05-01");
  assert.equal(fields.original_list_price, "310000.00"); assert.equal(fields.list_price, "300000.00");
  assert.equal(fields.pud, "false"); assert.equal(fields.listing_price_history, undefined);
});
