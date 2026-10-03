import assert from "node:assert/strict";
import test from "node:test";
import PDFDocument from "pdfkit";
import { buildDocumentFieldCandidates, classifyDocument, extractPdfEvidence } from "../src/services/documentIntelligence.js";
import { buildUrarSubjectEvidence, identifyUrarSubjectSource } from "../src/services/urarSubjectEvidence.js";

// Synthetic values in the actual TREC section structure exercise the production
// contract parser, not a mocked candidate projection or private report data.
const trec = [
  "ONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)",
  "1. PARTIES: The parties to this contract are Seller Example (Seller) and Buyer Example (Buyer).",
  "3. SALES PRICE:",
  "A. Cash portion of Sales Price payable by Buyer at closing ....... $ 20,000.00",
  "B. Sum of all financing described in the attached: Third Party Financing Addendum $ 280,000.00",
  "C. Sales Price (Sum of A and B) ... $ 300,000.00",
].join("\n");
const district = [
  "APPRAISAL DISTRICT EVIDENCE",
  "Comparable Sale 1",
  "Address: 100 Example Street, Dallas, TX 75201",
  "Sale Date: 06/15/2025",
  "Sale Price: $425,000",
].join("\n");
const zoning = "Zoning Code: R-7\nZoning Description: Detached Single-Family Residential";
const cadLayout = [
  "Residential Account #00001234567890000",
  "Property Location (Current 2027)",
  "DCAD: Residential Acct Detail",
  "https://www.dallascad.org/AcctDetailRes.aspx?ID=00001234567890000",
].join("\n");
const realistLayout = [
  "OWNER INFORMATION", "LOCATION INFORMATION", "TAX INFORMATION", "ASSESSMENT & TAX",
  "Property Details Courtesy of QA Reviewer Generated on: 10/02/26",
  "The data within this report is compiled by CoreLogic from public and private sources.",
].join("\n");
const damage = [
  ["replacement character", ["Unrelated footer \uFFFD"]],
  ["control character", ["Unrelated footer \u0001"]],
  ["overlong line", ["x".repeat(4_001)]],
  ["more than 250 pages", Array(250).fill("Unrelated appendix page")],
  ["mixed reference appendices", [cadLayout, realistLayout]],
];
const projected = candidates => candidates.map(({ field_key, normalized_value, page_number, extraction_method }) => (
  { field_key, normalized_value, page_number, extraction_method }
));

for (const [documentType, content, expectedField, expectedValue] of [
  ["purchase_contract", trec, "contract_price", "300000.00"],
  ["district_evidence", district, "district_comparable", null],
  ["zoning_map", zoning, "zoning_code", "R-7"],
  ["zoning_ordinance", zoning, "zoning_description", "Detached Single-Family Residential"],
]) {
  for (const [label, extraPages] of damage) {
    test(`${documentType} retains its own page-cited evidence despite Subject-only ${label} limits`, () => {
      const pages = [content, ...extraPages];
      const clean = buildDocumentFieldCandidates({ documentType, pages: [content] });
      const candidates = buildDocumentFieldCandidates({ documentType, pages });
      const expected = clean.find(candidate => candidate.field_key === expectedField);
      assert.ok(expected, "the real document parser must produce the baseline evidence");
      if (expectedValue) assert.equal(expected.normalized_value, expectedValue);
      else assert.equal(JSON.parse(expected.normalized_value).sale_price, 425_000);
      assert.deepEqual(projected(candidates), projected(clean));
      const actual = candidates.find(candidate => candidate.field_key === expectedField);
      assert.equal(actual.page_number, 1);
      // The district parser may retain subsequent appendix text in its raw
      // block; its original evidence and normalized comparable stay intact.
      assert.ok(actual.raw_value.startsWith(expected.raw_value));
      assert.ok(actual.evidence_excerpt.includes(expected.evidence_excerpt));
      const subject = buildUrarSubjectEvidence({ documentType, pages });
      assert.equal(subject.source_kind, null);
      assert.deepEqual(subject.candidates, []);
      assert.equal(subject.unresolved.some(item => item.reason === "source_input_incomplete"), false);
    });
  }
}

for (const documentType of ["purchase_contract", "district_evidence", "zoning_map", "zoning_ordinance", "map"]) {
  for (const sourceKind of ["cad", "realist", "mls_sheet", "engagement_letter"]) {
    test(`${sourceKind} hints cannot take ownership of explicitly typed ${documentType}`, () => {
      const pages = ["REALIST PROPERTY REPORT\nOwner: Example Owner\nTax Year: 2025\nBorrower: Example Borrower"];
      const subject = buildUrarSubjectEvidence({ documentType, pages, sourceKind });
      assert.equal(subject.source_kind, null);
      assert.deepEqual(subject.candidates, []);
      assert.equal(identifyUrarSubjectSource({ documentType, pages }), null);
    });
  }
}

for (const [documentType, content] of [
  ["engagement_letter", "APPRAISAL ENGAGEMENT LETTER\nBorrower: Example Borrower\nSubject Property Address: 100 Example Street, Dallas, TX 75201"],
  ["mls_sheet", "MLS#: 12345678\nProperty Address: 100 Example Street, Dallas, TX 75201\nList Date: 09/24/2026"],
  ["other", "REALIST PROPERTY REPORT\nProperty Address: 100 Example Street, Dallas, TX 75201\nTax Year: 2025\nTax Amount: $1,234"],
]) {
  for (const [label, extraPages] of damage) {
    test(`${documentType} still fails closed for ${label}`, () => {
      const pages = [content, ...extraPages];
      assert.ok(buildUrarSubjectEvidence({ documentType, pages: [content] }).candidates.length);
      const subject = buildUrarSubjectEvidence({ documentType, pages });
      assert.deepEqual(subject.candidates, []);
      assert.ok(subject.unresolved.some(item => item.reason === "source_input_incomplete"));
      assert.deepEqual(buildDocumentFieldCandidates({ documentType, pages }), []);
    });
  }
}

test("unclassified Other remains fail-closed when corruption could hide its Subject source", () => {
  const pages = ["Contract Price: $300,000", "\uFFFD"];
  const subject = buildUrarSubjectEvidence({ documentType: "other", pages });
  assert.equal(subject.source_kind, null);
  assert.ok(subject.unresolved.some(item => item.reason === "source_input_incomplete"));
  assert.deepEqual(buildDocumentFieldCandidates({ documentType: "other", pages }), []);
});

for (const documentType of [null, "unrecognized_type"]) {
  test(`unrecognized type ${JSON.stringify(documentType)} does not bypass Subject input validation`, () => {
    const subject = buildUrarSubjectEvidence({ documentType, pages: ["\uFFFD"] });
    assert.ok(subject.unresolved.some(item => item.reason === "source_input_incomplete"));
  });
}

for (const [content, expectedType] of [[trec, "purchase_contract"], [district, "district_evidence"]]) {
  test(`auto-classified ${expectedType} retains precedence over damaged reference appendices`, () => {
    const pages = [content, cadLayout, realistLayout, "\uFFFD"];
    const documentType = classifyDocument({ requestedType: "other", pages });
    assert.equal(documentType, expectedType);
    assert.ok(buildDocumentFieldCandidates({ documentType, pages }).length);
  });
}

test("real PDF admission still rejects more than 250 pages before every document-type parser", async () => {
  // In-memory synthetic bytes only; no PDF files, mocks, or report data.
  const pdf = new PDFDocument({ autoFirstPage: false });
  const chunks = [];
  pdf.on("data", chunk => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  for (let index = 0; index < 251; index += 1) pdf.addPage();
  pdf.end();
  const bytes = await completed;
  for (const requestedType of ["purchase_contract", "district_evidence", "zoning_map", "zoning_ordinance", "map", "engagement_letter", "mls_sheet", "other"]) {
    await assert.rejects(extractPdfEvidence(bytes, { requestedType }), /document_page_limit_exceeded/);
  }
});
