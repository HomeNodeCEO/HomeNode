import assert from "node:assert/strict";
import test from "node:test";
import PDFDocument from "pdfkit";
import { buildSfrepReportExport } from "../src/services/sfrepReportExport.js";

import {
  buildDistrictComparableCandidates,
  buildDocumentFieldCandidates,
  classifyDocument,
  extractPdfEvidence,
  findZoningDescriptionInPages,
} from "../src/services/documentIntelligence.js";

async function textPdf(lines) {
  const pdf = new PDFDocument({ size: "LETTER", margin: 54 });
  const chunks = [];
  pdf.on("data", (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  lines.forEach((line) => pdf.text(line));
  pdf.end();
  return completed;
}

test("document classification recognizes the appraisal document families", () => {
  assert.equal(classifyDocument({ pages: ["ONE TO FOUR FAMILY RESIDENTIAL CONTRACT Earnest Money"] }), "purchase_contract");
  assert.equal(classifyDocument({ pages: ["APPRAISAL ENGAGEMENT LETTER Scope of Work"] }), "engagement_letter");
  assert.equal(classifyDocument({ pages: ["MULTIPLE LISTING SERVICE MLS # 21062330"] }), "mls_sheet");
  assert.equal(classifyDocument({ pages: ["Official Zoning Map Zoning Districts"] }), "zoning_map");
  assert.equal(
    classifyDocument({ pages: ["NTREIS Full Report MLS No 21062330 ST P DOM 14 OLP $525,000 LP $510,000"] }),
    "mls_sheet",
  );
  assert.equal(classifyDocument({ pages: ["APPRAISAL DISTRICT EVIDENCE District Comparable Sales"] }), "district_evidence");
});

test("purchase contracts outrank incidental zoning-ordinance language during classification", () => {
  assert.equal(classifyDocument({
    fileName: "Contract.pdf",
    pages: [
      "ONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)",
      "Title policy exclusions include existing building and zoning ordinances.",
    ],
  }), "purchase_contract");
});

test("district comparable packets retain their classification despite CAD or Realist headings", () => {
  for (const heading of ["Dallas Central Appraisal District", "REALIST PROPERTY REPORT"]) {
    const pages = [[
      heading,
      "APPRAISAL DISTRICT EVIDENCE",
      "Comparable Sale 1",
      "Address: 100 Main Street, Dallas, TX 75201",
      "Sale Date: 06/15/2025",
      "Sale Price: $425,000",
    ].join("\n")];
    const documentType = classifyDocument({ pages });
    assert.equal(documentType, "district_evidence", heading);
    const candidates = buildDocumentFieldCandidates({ documentType, pages });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].field_key, "district_comparable");
    assert.equal(JSON.parse(candidates[0].normalized_value).sale_price, 425_000);
  }
});

test("contract and engagement classification still outrank reference headings and district evidence", () => {
  for (const heading of ["Dallas Central Appraisal District", "REALIST PROPERTY REPORT"]) {
    for (const [title, expected] of [
      ["ONE TO FOUR FAMILY RESIDENTIAL CONTRACT", "purchase_contract"],
      ["APPRAISAL ENGAGEMENT LETTER", "engagement_letter"],
    ]) {
      assert.equal(classifyDocument({ pages: [`${title}\n${heading}\nAPPRAISAL DISTRICT EVIDENCE`] }), expected);
    }
    assert.equal(classifyDocument({ requestedType: "mls_sheet", pages: [heading] }), "mls_sheet");
  }
});

test("standalone CAD and Realist reports still outrank incidental MLS references", () => {
  for (const heading of ["Dallas Central Appraisal District", "REALIST PROPERTY REPORT"]) {
    assert.equal(classifyDocument({ pages: [`${heading}\nMLS Number: 21062330\nList Date: 09/24/2026`] }), "other");
  }
});

test("TREC resale sections produce the complete Hardy contract analysis", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "purchase_contract",
    pages: [
      [
        "1. PARTIES: The parties to this contract are Lorenzo Jr Loredo, Andi Li-Kay Thompson (Seller) and Zachary Thames (Buyer).",
        "3. SALES PRICE:",
        "A. Cash portion of Sales Price payable by Buyer at closing ....... $ 8,475.00",
        "B. Sum of all financing described in the attached: Third Party Financing Addendum $ 274,025.00",
        "C. Sales Price (Sum of A and B) ... $ 282,500.00",
      ].join("\n"),
      "5. EARNEST MONEY AND TERMINATION OPTION:\n(address): $ 2,600.00 as earnest money and $200.00 as the option fee.",
      "",
      "",
      "X (1) Buyer accepts the Property As Is.\n(2) Buyer accepts the Property As Is provided Seller shall complete repairs.",
      [
        "9. CLOSING:",
        "A. The closing of the sale will be on or before September 24 2026, or within 7 days.",
        "12. SETTLEMENT AND OTHER EXPENSES:",
        "(b) an amount not to exceed $ N/A to be applied to Buyer's Expenses.",
      ].join("\n"),
      "",
      "",
      "",
      "EXECUTED the day of 08/25/26 MD, 20 (Effective Date).",
    ],
  });
  const values = Object.fromEntries(candidates.map((candidate) => [
    candidate.field_key,
    candidate.normalized_value,
  ]));
  assert.deepEqual(values, {
    down_payment: "8475.00",
    loan_amount: "274025.00",
    contract_price: "282500.00",
    earnest_money: "2600.00",
    closing_date: "2026-09-24",
    contract_date: "2026-08-25",
    seller_concessions: "0.00",
    seller_name: "Lorenzo Jr Loredo, Andi Li-Kay Thompson",
    buyer_name: "Zachary Thames",
    contract_property_condition: "as_is",
    contract_personal_property_included: "No",
    assignment_type: "purchase_transaction",
  });
  assert.equal(candidates.find((candidate) => candidate.field_key === "contract_date")?.page_number, 10);
  assert.equal(candidates.find((candidate) => candidate.field_key === "closing_date")?.page_number, 6);
});

test('a later buyer or seller signature in the original execution block controls the contract date', () => {
  const candidates = buildDocumentFieldCandidates({ documentType: 'purchase_contract', pages: [
    'ONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)\nSeller Date: 03/14/2026\nBuyer Date Signed: 03/15/2026\nEXECUTED the day of 03/14/2026 (Effective Date).',
    'THIRD PARTY FINANCING ADDENDUM\nBuyer Date: 03/20/2026',
  ] });
  const date = candidates.find(candidate => candidate.field_key === 'contract_date');
  assert.equal(date?.normalized_value, '2026-03-15');
  assert.equal(date?.extraction_method, 'trec_later_original_signature_date');
  assert.equal(date?.page_number, 1);
});

test('earlier and addendum signature dates do not override the explicit effective date', () => {
  const candidates = buildDocumentFieldCandidates({ documentType: 'purchase_contract', pages: [
    'Seller Date: 03/13/2026\nBuyer Date: 03/14/2026\nEXECUTED the day of 03/15/2026 (Effective Date).',
    'NON-REALTY ITEMS ADDENDUM\nBuyer Date: 03/21/2026',
  ] });
  assert.equal(candidates.find(candidate => candidate.field_key === 'contract_date')?.normalized_value, '2026-03-15');
});

test("a checked TREC seller-repair option extracts the specific repair narrative", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "purchase_contract",
    pages: [[
      "(1) Buyer accepts the Property As Is.",
      "X (2) Buyer accepts the Property As Is provided Seller, at Seller's expense, shall complete the following specific repairs and treatments:",
      "Replace the damaged roof shingles and repair the active plumbing leak.",
      "(Do not insert general phrases that do not identify specific repairs and treatments.)",
    ].join("\n")],
  });
  assert.equal(
    candidates.find((candidate) => candidate.field_key === "contract_property_condition")?.normalized_value,
    "seller_repairs",
  );
  assert.equal(
    candidates.find((candidate) => candidate.field_key === "contract_repairs")?.normalized_value,
    "Replace the damaged roof shingles and repair the active plumbing leak.",
  );
});

test("TREC Section 2D exclusions and stay-with-property language remain separate review items", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "purchase_contract",
    pages: [[
      "ONE TO FOUR FAMILY RESIDENTIAL CONTRACT",
      "D. EXCLUSIONS: The following improvements and accessories will be retained by Seller and must be removed prior to delivery of possession: Shed to stay with property.",
      "E. RESERVATIONS: Any reservation for oil, gas, or other minerals is made in an attached addendum.",
    ].join("\n")],
  });
  const byField = new Map(candidates.map((candidate) => [candidate.field_key, candidate]));
  assert.equal(byField.get("contract_exclusions")?.normalized_value, "Shed to stay with property");
  assert.equal(byField.get("contract_personal_property_included")?.normalized_value, "Yes");
  assert.equal(byField.get("contract_personal_property_details")?.normalized_value, "Shed to stay with property");
  assert.equal(byField.get("contract_exclusions")?.page_number, 1);
  assert.match(byField.get("contract_personal_property_details")?.evidence_excerpt || "", /Shed to stay/);
});

test("negative stay-with-property language is retained as an exclusion without becoming an inclusion", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "purchase_contract",
    pages: [[
      "ONE TO FOUR FAMILY RESIDENTIAL CONTRACT",
      "D. EXCLUSIONS: The following improvements and accessories will be retained by Seller and must be removed prior to delivery of possession: Refrigerator does not stay with property.",
      "E. RESERVATIONS: None.",
    ].join("\n")],
  });
  const byField = new Map(candidates.map((candidate) => [candidate.field_key, candidate]));
  assert.equal(byField.get("contract_exclusions")?.normalized_value, "Refrigerator does not stay with property");
  assert.equal(byField.get("contract_personal_property_included")?.normalized_value, "No");
  assert.equal(byField.has("contract_personal_property_details"), false);
});

test("personal-property inclusion survives PDF line wrapping and plural stay language", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "purchase_contract",
    pages: ["ONE TO FOUR FAMILY RESIDENTIAL CONTRACT\nThe detached storage shed stays with\nthe property."],
  });
  const byField = new Map(candidates.map((candidate) => [candidate.field_key, candidate]));
  assert.equal(byField.get("contract_personal_property_included")?.normalized_value, "Yes");
  assert.match(byField.get("contract_personal_property_details")?.normalized_value || "", /shed stays with the property/i);
});

test("district evidence yields page-cited comparable rows for protest review", () => {
  const candidates = buildDistrictComparableCandidates([
    [
      "APPRAISAL DISTRICT EVIDENCE",
      "Comparable Sale 1",
      "Address: 100 Main Street, Dallas, TX 75201",
      "Account Number: 00000000000000001",
      "Sale Date: 06/15/2025",
      "Sale Price: $425,000",
      "Adjusted Sale Price: $438,000",
      "Living Area: 1,950",
      "Year Built: 1998",
      "Neighborhood Code: NBHD-10",
      "Building Class: 17",
      "Comparable Sale 2",
      "Address: 200 Oak Street, Dallas, TX 75201",
      "Sale Date: 08/20/2025",
      "Sale Price: $450,000",
      "Living Area: 2,050",
    ].join("\n"),
  ]);
  assert.equal(candidates.length, 2);
  const first = JSON.parse(candidates[0].normalized_value);
  assert.equal(first.address, "100 Main Street, Dallas, TX 75201");
  assert.equal(first.sale_date, "2025-06-15");
  assert.equal(first.sale_price, 425_000);
  assert.equal(first.adjusted_value, 438_000);
  assert.equal(first.living_area_sqft, 1_950);
  assert.equal(first.neighborhood_code, "NBHD-10");
  assert.equal(candidates[0].page_number, 1);
  assert.equal(candidates[0].field_key, "district_comparable");
});

test("labeled fields retain the verbatim source text and normalized money", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "purchase_contract",
    pages: ["Contract Price: $425,000\nEarnest Money: $5,000\nSeller: Jordan Example"],
  });
  assert.deepEqual(
    candidates.find((candidate) => candidate.field_key === "contract_price"),
    {
      field_key: "contract_price",
      raw_value: "$425,000",
      normalized_value: "425000.00",
      page_number: 1,
      confidence: 0.86,
      evidence_excerpt: "Contract Price: $425,000",
      extraction_method: "labeled_text",
    },
  );
  assert.equal(candidates.find((candidate) => candidate.field_key === "seller_name")?.raw_value, "Jordan Example");
});

test("dates and assignment purpose are normalized for the appraisal form", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "engagement_letter",
    pages: ["Client: Freeman Appraisal Services\nAssignment Type: Refinance"],
  });
  assert.equal(
    candidates.find((candidate) => candidate.field_key === "assignment_type")?.normalized_value,
    "refinance",
  );
  const contract = buildDocumentFieldCandidates({
    documentType: "purchase_contract",
    pages: ["ONE TO FOUR FAMILY RESIDENTIAL CONTRACT\nContract Date: 08/19/2026\nSeller Concessions: None"],
  });
  assert.equal(
    contract.find((candidate) => candidate.field_key === "contract_date")?.normalized_value,
    "2026-08-19",
  );
  assert.equal(
    contract.find((candidate) => candidate.field_key === "seller_concessions")?.normalized_value,
    "0.00",
  );
  assert.equal(
    contract.find((candidate) => candidate.field_key === "assignment_type")?.normalized_value,
    "purchase_transaction",
  );
});

test("MLS sheets extract the Section 19 status, dates, DOM, OLP, LP, and listing ID", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "mls_sheet",
    pages: [[
      "NORTH TEXAS MULTIPLE LISTING SERVICE",
      "MLS #: 21062330 Status: Closed",
      "LD: 08/01/2026 CD: 08/31/2026 DOM: 31",
      "OLP: $525,000 LP: $510,000",
    ].join("\n")],
  });
  const values = Object.fromEntries(candidates.map((candidate) => [
    candidate.field_key,
    candidate.normalized_value,
  ]));
  assert.deepEqual(values, {
    listing_status: "OffMarket",
    mls_number: "21062330",
    list_date: "2026-08-01",
    listing_end_date: "2026-08-31",
    days_on_market: "31",
    original_list_price: "525000.00",
    list_price: "510000.00",
  });
  assert.ok(candidates.every((candidate) => candidate.page_number === 1));
  assert.equal(candidates.find((candidate) => candidate.field_key === "list_price")?.raw_value, "$510,000");
});

test("MLS dates unsupported by the Subject parser retain valid legacy suggestions", () => {
  for (const [raw, expected] of [
    ["09/24/26", "2026-09-24"],
    ["September 24, 2026", "2026-09-24"],
    ["Sep. 24, 26", "2026-09-24"],
    ["24 September 2026", "2026-09-24"],
    ["2026 September 24", "2026-09-24"],
    ["2026-09-24T12:30:00Z", "2026-09-24"],
    ["2026-09-24T23:30:00-05:00", "2026-09-25"],
    ["February 29, 2024", "2024-02-29"],
    ["2024-02-29T12:30:00Z", "2024-02-29"],
  ]) {
    const candidates = buildDocumentFieldCandidates({ documentType: "mls_sheet", pages: [`List Date: ${raw}`] });
    const listingDates = candidates.filter(candidate => candidate.field_key === "list_date");
    assert.equal(listingDates.length, 1, raw);
    assert.equal(listingDates[0].normalized_value, expected, raw);
    assert.equal(listingDates[0].raw_value, raw);
    assert.match(listingDates[0].extraction_method, /^(?:mls_)?labeled_text$/);
  }
});

test("invalid MLS calendar dates cannot roll forward or create derived end dates", () => {
  for (const raw of [
    "02/30/26", "02/29/2025", "February 30, 2026", "February 29, 2025",
    "30 February 2026", "2026-02-30", "2026-02-30T12:30:00Z", "2025-02-29T12:30:00Z",
    "2026/02/30", "April 31, 2026", "February 30, 26", "30-Feb-26", "2026 Feb 30",
    "Feb. 30, 2026", "2026.02.30", "Feb30,2026",
  ]) {
    const candidates = buildDocumentFieldCandidates({
      documentType: "mls_sheet", pages: [`Status: Active\nList Date: ${raw}\nDOM: 5`],
    });
    assert.equal(candidates.some(candidate => ["list_date", "listing_end_date"].includes(candidate.field_key)), false, raw);
  }
});

test("valid strict Subject list-date alternatives still replace the first legacy match", () => {
  const candidates = buildDocumentFieldCandidates({ documentType: "mls_sheet", pages: [
    "List Date: 09/24/2026\nList Date: 09/25/2026",
  ] });
  const listingDates = candidates.filter(candidate => candidate.field_key === "list_date");
  assert.deepEqual(listingDates.map(candidate => candidate.normalized_value), ["2026-09-24", "2026-09-25"]);
  assert.ok(listingDates.every(candidate => candidate.extraction_method.startsWith("urar_subject_mls_sheet_")));
});

test("all distinct valid MLS listing dates survive mixed text, numeric, and ISO datetime formats", () => {
  const lines = ["List Date: September 24, 2026", "List Date: 09/25/2026",
    "List Date: 2026-09-26T23:30:00-05:00", "Original Listing Date: 09/28/26",
    "Listing Date: 29 September 2026", "LD: 2026 September 30"];
  for (const rows of [lines, [...lines].reverse()]) {
    const candidates = buildDocumentFieldCandidates({ documentType: "mls_sheet", pages: [
      `Status: Active\nDOM: 5\n${rows.join("\n")}`,
    ] });
    const dates = candidates.filter(candidate => candidate.field_key === "list_date");
    assert.deepEqual(dates.map(candidate => candidate.normalized_value).sort(),
      ["2026-09-24", "2026-09-25", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
    assert.ok(dates.every(candidate => candidate.page_number === 1 && candidate.evidence_excerpt.includes(candidate.raw_value)));
    assert.equal(candidates.some(candidate => candidate.extraction_method === "mls_list_date_dom_derivation"), false);
    const preview = buildSfrepReportExport({ documents: [{ id: 21, document_type: "mls_sheet", property_role: "subject",
      processing_status: "reviewed", candidates: dates.map((candidate, index) => ({ ...candidate, id: index + 1,
        review_status: "confirmed", confirmed_value: candidate.normalized_value })) }],
    subjectContext: { effectiveDate: "2026-10-02", effectiveDateSource: "assignment_effective_date" } });
    assert.ok(preview.conflicts.some(conflict => conflict.sourceField === "list_date"));
    assert.equal(preview.fields.some(field => field.fieldId === "CurrentPriorListingYesCheckBox"), false);
  }
});

test("legacy-only, inline, and standalone MLS date alternatives retain distinct page-cited evidence", () => {
  const candidates = buildDocumentFieldCandidates({ documentType: "mls_sheet", pages: [
    "Status: Active\nLD: Sep. 24, 26 | LD: September 25, 2026 | DOM: 5",
    "List Date\n2026-09-26T23:30:00-05:00",
  ] });
  const dates = candidates.filter(candidate => candidate.field_key === "list_date");
  assert.deepEqual(dates.map(candidate => [candidate.normalized_value, candidate.page_number]),
    [["2026-09-24", 1], ["2026-09-25", 1], ["2026-09-27", 2]]);
  assert.equal(candidates.some(candidate => candidate.field_key === "listing_end_date"), false);
  const split = buildDocumentFieldCandidates({ documentType: "mls_sheet", pages: ["List Date", "September 24, 2026"] });
  assert.equal(split.some(candidate => candidate.field_key === "list_date"), false, "standalone values never cross pages");
});

test("MLS date collection deduplicates equivalent suggestions and fails closed at its distinct-date bound", () => {
  const repeated = Array.from({ length: 2_100 }, (_, index) => `List Date: ${index % 2 ? "September 24, 2026" : "09/24/26"}`).join("\n");
  const dates = buildDocumentFieldCandidates({ documentType: "mls_sheet", pages: [repeated] }).filter(candidate => candidate.field_key === "list_date");
  assert.equal(dates.length, 1); assert.equal(dates[0].normalized_value, "2026-09-24");
  const distinct = Array.from({ length: 2_001 }, (_, index) => `List Date: ${new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10)}`).join("\n");
  assert.deepEqual(buildDocumentFieldCandidates({ documentType: "mls_sheet", pages: [`Status: Active\nDOM: 5\n${distinct}`] }), [],
    "overflow cannot retain a truncated set or a derived first-winner end date");
});

test("multi-listing diagnostics suppress legacy candidates instead of mixing one address with another listing date", () => {
  const pages = ["Property Address: 100 Example Drive, Garland, TX 75041\nMLS#: 12345678 Active LP: $295,000",
    "999 Other Road, Dallas, TX 75225\nMLS#: 87654321 Active LP: $500,000\nList Date: 09/24/2026"];
  assert.deepEqual(buildDocumentFieldCandidates({ documentType: "mls_sheet", pages }), []);
  assert.deepEqual(buildDocumentFieldCandidates({ documentType: "mls_sheet", pages: ["List Date: September 24, 2026"],
    subjectEvidence: { source_kind: "mls_sheet", candidates: [], conflicts: [], unresolved: [{ reason: "multiple_mls_listing_identities" }] } }), []);
});

test("alternate MLS identity labels cannot mix subject fields with another listing's date", () => {
  const pairs = [
    ["MLS No. 12345678", "MLS No. 87654321"],
    ["MLS Number: 12345678", "MLS Number: 87654321"],
    ["MLS ID=A1001", "MLS ID=B1002"],
    ["Listing ID: A1001", "Listing ID: B1002"],
    ["NTREIS Full Report MLS No 12345678 ST P", "NTREIS Full Report MLS No 87654321 ST P"],
    ["MLS #\n12345678", "MLS #\n87654321"],
  ];
  for (const [first, second] of pairs) {
    const pages = [`Property Address: 100 Example Drive, Garland, TX 75041\n${first}`,
      `999 Other Road, Dallas, TX 75225\n${second}\nList Date: 09/24/2026`];
    assert.deepEqual(buildDocumentFieldCandidates({ documentType: "mls_sheet", pages }), [], first);
  }
});

test("an additional malformed MLS record cannot borrow another record's subject identity", () => {
  const subject = "100 Example Drive, Garland, TX 75041\nMLS#: 12345678 Active 100 Example Drive Garland, TX 75041 LP: $295,000";
  for (const label of ["MLS#: UNKNOWN", "MLS Number: ?", "MLS ID:\nUNKNOWN"]) {
    const other = `${label}\nList Date: 09/24/2026`;
    for (const pages of [[subject, other], [other, subject]]) {
      assert.deepEqual(buildDocumentFieldCandidates({ documentType: "mls_sheet", pages }), [], label);
    }
  }
});

test("an active MLS listing derives a reviewable end date from LD and DOM when no end date is printed", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "mls_sheet",
    pages: ["MLS No. 21069999 | ST Active | LD 08/20/2026 | DOM 10 | OLP $600,000 | LP $589,000"],
  });
  const endDate = candidates.find((candidate) => candidate.field_key === "listing_end_date");
  assert.equal(endDate?.normalized_value, "2026-08-29");
  assert.equal(endDate?.extraction_method, "mls_list_date_dom_derivation");
  assert.match(endDate?.evidence_excerpt || "", /Derived from/);
});

test("MLS abbreviations populate listing status and DOM from common NTREIS layouts", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "mls_sheet",
    pages: ["MLS #: 21069998 | Lst Status: A | LD: 08/20/2026 | DOM/CDOM: 10/14 | OLP: $600,000 | LP: $589,000"],
  });
  const values = Object.fromEntries(candidates.map((candidate) => [
    candidate.field_key,
    candidate.normalized_value,
  ]));

  assert.equal(values.listing_status, "Active");
  assert.equal(values.days_on_market, "10");
});

test("MLS contract dates become Section 19 end dates only for Pending or Sold listings", () => {
  const pending = buildDocumentFieldCandidates({
    documentType: "mls_sheet",
    pages: ["MLS # 21070001 | Status P | LD 08/20/2026 | Contract Date 08/27/2026 | DOM 8 | LP $589,000"],
  });
  const active = buildDocumentFieldCandidates({
    documentType: "mls_sheet",
    pages: ["MLS # 21070002 | Status ACT | LD 08/20/2026 | CD 08/27/2026 | DOM 5 | LP $589,000"],
  });
  const sold = buildDocumentFieldCandidates({
    documentType: "mls_sheet",
    pages: ["MLS # 21070003 | Status SLD | LD 08/01/2026 | Contract Date 08/21/2026 | Closed Date 08/31/2026 | DOM 21 | LP $589,000"],
  });

  assert.equal(pending.find((candidate) => candidate.field_key === "listing_status")?.normalized_value, "Pending");
  assert.equal(pending.find((candidate) => candidate.field_key === "listing_end_date")?.normalized_value, "2026-08-27");
  assert.equal(
    pending.find((candidate) => candidate.field_key === "listing_end_date")?.extraction_method,
    "mls_contract_date_as_listing_end_date",
  );
  assert.equal(active.find((candidate) => candidate.field_key === "listing_end_date")?.normalized_value, "2026-08-24");
  assert.equal(active.find((candidate) => candidate.field_key === "listing_end_date")?.extraction_method, "mls_list_date_dom_derivation");
  assert.equal(sold.find((candidate) => candidate.field_key === "listing_status")?.normalized_value, "OffMarket");
  assert.equal(sold.find((candidate) => candidate.field_key === "listing_end_date")?.normalized_value, "2026-08-21");
  assert.equal(pending.some((candidate) => candidate.field_key === "contract_date"), false);
  assert.equal(active.some((candidate) => candidate.field_key === "contract_date"), false);
  assert.equal(sold.some((candidate) => candidate.field_key === "contract_date"), false);
});

test("auto-classified MLS shorthand does not expose a separate contract-date confirmation", () => {
  const pages = ["NTREIS Full Report | MLS No 21070004 | ST P | LD 08/20/2026 | Contract Date 08/27/2026 | DOM 8 | OLP $600,000 | LP $589,000"];
  const documentType = classifyDocument({ pages });
  const candidates = buildDocumentFieldCandidates({ documentType, pages });

  assert.equal(documentType, "mls_sheet");
  assert.equal(candidates.find((candidate) => candidate.field_key === "listing_status")?.normalized_value, "Pending");
  assert.equal(candidates.find((candidate) => candidate.field_key === "days_on_market")?.normalized_value, "8");
  assert.equal(candidates.find((candidate) => candidate.field_key === "listing_end_date")?.normalized_value, "2026-08-27");
  assert.equal(candidates.some((candidate) => candidate.field_key === "contract_date"), false);
});

test("engagement letters separate duplicated lender columns and retain the assignment address", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "engagement_letter",
    pages: [
      [
        "ENGAGEMENT LETTER",
        "Client: Bank of America Lender: Bank of America",
        "Address: 100 North Tryon Street",
        "CHARLOTTE, NC 28255 Address: 100 North Tryon Street",
        "CHARLOTTE, NC 28255",
        "SERVICE PROVIDER INFORMATION",
        "Service Provider: Jordan Freeman",
        "Address: 1909 Snowmass Ln",
        "GARLAND, TX 75044",
      ].join("\n"),
      [
        "Property Address: 513 HARDY DR",
        "Garland, TX 750413536",
        "Loan Purpose: Purchase",
      ].join("\n"),
    ],
  });

  assert.equal(
    candidates.find((candidate) => candidate.field_key === "lender_client_name")?.normalized_value,
    "Bank of America",
  );
  assert.equal(
    candidates.find((candidate) => candidate.field_key === "lender_client_address")?.normalized_value,
    "100 North Tryon Street, CHARLOTTE, NC 28255",
  );
  assert.equal(
    candidates.find((candidate) => candidate.field_key === "subject_property_address")?.normalized_value,
    "513 HARDY DR, Garland, TX 75041-3536",
  );
  assert.equal(
    candidates.find((candidate) => candidate.field_key === "assignment_type")?.normalized_value,
    "purchase_transaction",
  );
});

test("zoning description suggestion uses the exact official line associated with the code", () => {
  const suggestion = findZoningDescriptionInPages([
    "Legend\nSF-7 - Single-Family Residential-7 (minimum 7,000 square foot lots)\nC-1 - Commercial",
  ], "SF-7");
  assert.equal(suggestion?.raw_value, "Single-Family Residential-7 (minimum 7,000 square foot lots)");
  assert.equal(suggestion?.page_number, 1);
  assert.equal(suggestion?.extraction_method, "zoning_code_context");
});

test("zoning documents do not emit unrelated contract candidates", () => {
  const candidates = buildDocumentFieldCandidates({
    documentType: "zoning_ordinance",
    pages: ["EFFECTIVE DATE.\nR-S - Single-Family District"],
  });
  assert.equal(candidates.some((candidate) => candidate.field_key === "contract_date"), false);
});

test("a real machine-readable PDF produces page-cited contract suggestions", async () => {
  const buffer = await textPdf([
    "ONE TO FOUR FAMILY RESIDENTIAL CONTRACT",
    "Contract Price: $425,000",
    "Contract Date: 08/19/2026",
  ]);
  const extraction = await extractPdfEvidence(buffer, { fileName: "contract.pdf" });
  assert.equal(extraction.document_type, "purchase_contract");
  assert.equal(extraction.extraction_status, "review_required");
  assert.equal(extraction.page_count, 1);
  assert.equal(
    extraction.candidates.find((candidate) => candidate.field_key === "contract_price")?.normalized_value,
    "425000.00",
  );
  assert.equal(
    extraction.candidates.find((candidate) => candidate.field_key === "contract_date")?.page_number,
    1,
  );
});

test("an image-only or blank PDF is routed to OCR review without invented fields", async () => {
  const buffer = await textPdf([]);
  const extraction = await extractPdfEvidence(buffer, { fileName: "scanned-contract.pdf" });
  assert.equal(extraction.extraction_status, "ocr_required");
  assert.equal(extraction.extraction_method, "none");
  assert.deepEqual(extraction.candidates, []);
});

test("a configured OCR provider turns a scanned PDF into page-cited review suggestions", async () => {
  const buffer = await textPdf([]);
  const extraction = await extractPdfEvidence(buffer, {
    fileName: "scanned-contract.pdf",
    ocrProvider: {
      configured: true,
      async analyzePdf() {
        return {
          provider: "test_ocr",
          extraction_method: "test_ocr",
          model_id: "read",
          api_version: "test",
          operation_id: "operation-1",
          pages: [
            "ONE TO FOUR FAMILY RESIDENTIAL CONTRACT\nContract Price: $425,000\nContract Date: 08/19/2026",
          ],
        };
      },
    },
  });
  assert.equal(extraction.extraction_status, "review_required");
  assert.equal(extraction.extraction_method, "test_ocr");
  assert.equal(extraction.ocr_metadata.operation_id, "operation-1");
  assert.equal(
    extraction.candidates.find((candidate) => candidate.field_key === "contract_price")?.normalized_value,
    "425000.00",
  );
  assert.equal(
    extraction.candidates.find((candidate) => candidate.field_key === "contract_date")?.page_number,
    1,
  );
  assert.equal(
    extraction.candidates.find((candidate) => candidate.field_key === "contract_price")?.extraction_method,
    "labeled_text",
  );
});

test("MLS header status is read completely and United States never becomes Active", () => {
  const fields = pages => buildDocumentFieldCandidates({ documentType: "mls_sheet", pages });
  const result = fields([
    "100 Example Drive, Garland, Texas 75041\nMLS#: 12345678 Active Option Contract 100 Example Drive Garland, TX 75041-1234 LP: $295,000\nCountry: United States Lse MLS#:",
    "CDOM: 77 DOM: 77 LD: 05/29/2026 XD:\nContract Date: 08/25/2026 Option Expire Date: 09/01/2026",
  ]);
  assert.equal(result.find(item => item.field_key === "listing_status")?.normalized_value, "Pending");
  assert.equal(result.find(item => item.field_key === "listing_end_date")?.normalized_value, "2026-08-25");
  assert.match(result.find(item => item.field_key === "listing_status")?.evidence_excerpt, /Active Option Contract/);
  assert.equal(fields(["Country: United States Lse MLS#: \nList Date: 05/29/2026\nDOM: 77"]).some(item => item.field_key === "listing_status" || item.field_key === "listing_end_date"), false);
  assert.equal(fields(["Status: ActiveXYZ"]).some(item => item.field_key === "listing_status"), false);
});
