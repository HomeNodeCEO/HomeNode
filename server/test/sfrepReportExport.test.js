import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSfrepReportExport,
  SFREP_MAX_DOCUMENTS,
  SFREP_PRIMARY_FORM_ID,
  SFREP_SUPPORTED_FORM_IDS,
} from "../src/services/sfrepReportExport.js";

const candidate = (field_key, value, rest = {}) => ({ field_key, confirmed_value: value, review_status: "confirmed", ...rest });
const doc = (id, candidates = [], rest = {}) => ({ id, candidates, processing_status: "reviewed", ...rest });
const values = (result) => Object.fromEntries(result.fields.map((field) => [field.fieldId, field.value]));

test("only individually confirmed current candidates populate report fields", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [
    candidate("lender_client_name", "Approved Bank", { id: 8 }),
    candidate("contract_price", "100000", { review_status: "suggested" }),
    candidate("owner_name", "Rejected", { review_status: "rejected" }),
    { field_key: "borrower_name", normalized_value: "Unreviewed" },
  ], { processing_status: "reviewed", extracted_data: { owner_name: "Do not use" }, review_history: [candidate("contract_price", "99")] })] });
  assert.deepEqual(values(result), { LenderClientCompanyName: "Approved Bank" });
  assert.equal(result.fields[0].candidateId, 8);
  assert.equal(result.fields[0].documentId, 1);
});

test("verified FNMA1004 mappings preserve roles, format amounts and contract dates", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [
    candidate("lender_client_name", "Example Bank"),
    candidate("lender_client_address", "1 Bank Rd, Dallas, TX 75201"),
    candidate("contract_price", "$282,500"),
    candidate("contract_date", "2026-08-25"),
    candidate("borrower_name", "Confirmed Borrower"),
    candidate("owner_name", "Public Record Owner"),
    candidate("seller_name", "Seller"),
    candidate("buyer_name", "Buyer"),
    candidate("closing_date", "2026-09-24"),
  ])] });
  assert.deepEqual(values(result), {
    BorrowerName: "Confirmed Borrower", ContractDate: "08/25/2026",
    LenderClientCompanyName: "Example Bank", LenderClientCompanyUnparsedAddress: "1 Bank Rd, Dallas, TX 75201",
    OwnerName: "Public Record Owner", SalePriceAmount: "282500.00",
  });
  assert.deepEqual(result.omitted.map((entry) => entry.sourceField), ["buyer_name", "closing_date", "seller_name"]);
  assert.ok(result.reportXml.includes('<Form Id="FNMA-1004-0911">'));
  assert.ok(result.reportXml.includes('AixmlVersion="1.5"'));
  assert.equal(result.formId, SFREP_PRIMARY_FORM_ID);
  assert.deepEqual(SFREP_SUPPORTED_FORM_IDS, ["FNMA-1004-0911"]);
});

test("explicit blank confirmation never falls back to extracted text; unknowns cannot erase fields", () => {
  for (const value of ["", "  ", "N/A", "unknown", "xsi:nil", "null", "--", {}, false]) {
    const result = buildSfrepReportExport({ documents: [doc(1, [candidate("lender_client_name", value, { normalized_value: "Old Extraction" })])] });
    assert.equal(result.fields.length, 0);
    assert.equal(result.omitted.length, 1);
    assert.doesNotMatch(result.reportXml, /Data=""|Old Extraction/);
  }
  const result = buildSfrepReportExport({ documents: [doc(1, [candidate("tax_amount", 0), candidate("bedrooms", 0)])] });
  assert.equal(values(result).RealEstateTaxAmount, "0.00");
  assert.equal(values(result).RoomCountBedrooms, "0");
});

test("legacy confirmed candidates may use their normalized value when no edited value exists", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [{ field_key: "contract_price", review_status: "confirmed", confirmed_value: null, normalized_value: "500000.00" }])] });
  assert.equal(values(result).SalePriceAmount, "500000.00");
});

test("stale candidates from processing, failed, or unknown-status documents never populate fields", () => {
  for (const processing_status of ["uploaded", "processing", "extraction_failed", "ocr_required", null, undefined]) {
    const result = buildSfrepReportExport({ documents: [doc(1, [candidate("owner_name", "Old Owner")], { processing_status })] });
    assert.equal(result.fields.length, 0);
    assert.match(result.omitted[0].reason, /stale/);
  }
  const result = buildSfrepReportExport({ documents: [doc(1, [candidate("owner_name", "Approved Owner")], { processing_status: "review_required" })] });
  assert.equal(values(result).OwnerName, "Approved Owner");
});

test("XML attributes escape markup, quotes, apostrophes and retain line breaks", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [candidate("legal_description", `A&B <Lot> "2" O'Neil\nBlock\t3 😃`)])], application: { vendorName: "<Vendor>" } });
  assert.ok(result.reportXml.includes('Data="A&amp;B &lt;Lot&gt; &quot;2&quot; O&apos;Neil&#10;Block&#9;3 😃"'));
  assert.ok(result.reportXml.includes('VendorName="&lt;Vendor&gt;"'));
  assert.equal(values(result).LegalDescription, `A&B <Lot> "2" O'Neil\nBlock\t3 😃`);
});

test("invalid XML controls and lone surrogates are omitted, never silently altered", () => {
  for (const badValue of ["Bank\u0000Name", "Bank\u001fName", "Bank\ud800Name", "Bank\uffffName"]) {
    const result = buildSfrepReportExport({ documents: [doc(1, [candidate("lender_client_name", badValue)])] });
    assert.equal(result.fields.length, 0);
    assert.match(result.omitted[0].reason, /XML 1.0/);
  }
});

test("conflicts are omitted deterministically regardless of input order", () => {
  const documents = [doc(2, [candidate("contract_price", "300000", { id: 20 })]), doc(1, [candidate("contract_price", "280000", { id: 10 })])];
  const first = buildSfrepReportExport({ documents });
  const second = buildSfrepReportExport({ documents: [...documents].reverse() });
  assert.deepEqual(first, second);
  assert.equal(first.fields.length, 0);
  assert.deepEqual(first.conflicts, [{ sourceField: "contract_price", documentIds: [1, 2], values: ["280000.00", "300000.00"] }]);
  assert.equal(first.omitted.length, 2);
});

test("equal normalized values collapse; a selected source or document subset resolves conflicts", () => {
  const documents = [doc(2, [candidate("contract_price", "$280,000")]), doc(1, [candidate("contract_price", "280000.00")])];
  const duplicate = buildSfrepReportExport({ documents });
  assert.equal(duplicate.fields.length, 1);
  assert.equal(duplicate.fields[0].documentId, 1);
  assert.equal(duplicate.conflicts.length, 0);
  documents[0].candidates[0].confirmed_value = "300000";
  const chosen = buildSfrepReportExport({ documents, fieldSelections: { contract_price: 2 } });
  assert.equal(values(chosen).SalePriceAmount, "300000.00");
  assert.equal(chosen.conflicts.length, 0);
  const subset = buildSfrepReportExport({ documents, selectedDocumentIds: [1] });
  assert.equal(values(subset).SalePriceAmount, "280000.00");
  assert.equal(subset.omitted.length, 0);
});

test("destination aliases conflict instead of producing duplicate SFREP fields", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [candidate("tax_amount", "100"), candidate("real_estate_tax_amount", "200")])] });
  assert.equal(result.fields.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].values, ["100.00", "200.00"]);
});

test("assignment types use verified affirmative checkboxes without inferring from document class", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", "purchase_transaction")], { document_type: "purchase_contract" })] });
  assert.ok(result.reportXml.includes('<CheckBoxField Id="AssignmentTypePurchaseCheckBox" Data="true" />'));
  assert.doesNotMatch(result.reportXml, /Data="false"/);
  assert.equal(buildSfrepReportExport({ documents: [doc(1, [], { document_type: "purchase_contract" })] }).fields.length, 0);
  const conflict = buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", "purchase_transaction")]), doc(2, [candidate("assignment_type", "refinance")])] });
  assert.equal(conflict.fields.length, 0);
  assert.equal(conflict.conflicts[0].sourceField, "assignment_type");
  assert.equal(buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", "heloc")])] }).fields.length, 0);
  assert.equal(buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", "__proto__")])] }).fields.length, 0);
});

test("reviewed public-record facts target verified fields without treating values as appraiser opinions", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [
    candidate("legal_description", "Lot 1 Block 2"), candidate("assessor_parcel_number", "000012340000"),
    candidate("county", "Dallas"), candidate("tax_year", "2025"), candidate("tax_amount", "8,500.31"),
    candidate("site_area_sqft", "7,500"), candidate("year_built", "1998"), candidate("bedrooms", "3"),
    candidate("gross_living_area_sqft", "2000"), candidate("zoning_code", "R-7.5"),
    candidate("zoning_description", "Single Family"), candidate("market_value", "300000"),
  ])] });
  assert.equal(values(result).AssessorsParcelNumber, "000012340000");
  assert.equal(values(result).Area, "7500 sf");
  assert.equal(values(result).YearBuiltDescription, "1998");
  assert.equal(values(result).RealEstateTaxAmount, "8500.31");
  assert.equal(values(result).SpecificZoningClassification, "R-7.5");
  assert.equal(values(result).GrossLivingArea, "2000");
  assert.ok(result.omitted.some((entry) => entry.sourceField === "market_value"));
  assert.doesNotMatch(result.reportXml, /AppraisedValueAmount/);
});

test("subject addresses split explicit US locality components, but do not guess ambiguous localities", () => {
  for (const address of ["513 Hardy Dr, Garland, TX 75041", "513 Hardy Dr, Garland TX 75041"]) {
    const result = buildSfrepReportExport({ documents: [doc(1, [candidate("subject_property_address", address)])] });
    assert.deepEqual(values(result), { City: "Garland", State: "TX", StreetAddress: "513 Hardy Dr", ZipCode: "75041" });
  }
  const street = buildSfrepReportExport({ documents: [doc(1, [candidate("subject_property_address", "513 Hardy Dr")])] });
  assert.equal(values(street).StreetAddress, "513 Hardy Dr");
  const ambiguous = buildSfrepReportExport({ documents: [doc(1, [candidate("subject_property_address", "513 Hardy Dr Garland TX 75041")])] });
  assert.equal(ambiguous.fields.length, 0);
});

test("invalid dates, amounts, area, and numeric fields are omitted rather than guessed", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [
    candidate("contract_date", "2026-02-30"), candidate("contract_price", "$1,2,3"),
    candidate("site_area_sqft", "0.17 acres"), candidate("tax_year", "next year"),
    candidate("gross_living_area_sqft", "approximately 2,000"), candidate("bedrooms", "3.5"),
  ])] });
  assert.equal(result.fields.length, 0);
  assert.equal(result.omitted.length, 6);
});

test("unsupported contract and MLS details remain visible in the omission list", () => {
  const keys = ["seller_concessions", "earnest_money", "loan_amount", "contract_repairs", "mls_number", "list_price", "days_on_market", "unexpected_field"];
  const result = buildSfrepReportExport({ documents: [doc(1, keys.map((key) => candidate(key, "42")))] });
  assert.equal(result.fields.length, 0);
  assert.equal(result.omitted.length, keys.length);
  assert.ok(result.omitted.every((entry) => entry.reason.length > 20));
});

test("PDF addenda reference case-sensitive Pdf folder basenames and do not require extraction", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [], { title: 'Engagement & "Scope"', processing_status: "ocr_required" })], pdfAddenda: [{ documentId: 1, fileName: "Document-1.pdf" }] });
  assert.equal(result.fields.length, 0);
  assert.ok(result.reportXml.includes('<Form Id="PDFAddendum" CustomTitle="Engagement &amp; &quot;Scope&quot;">'));
  assert.ok(result.reportXml.includes('<PdfField Id="Pdf" Data="Document-1.pdf" />'));
  assert.equal((result.reportXml.match(/<Form Id="FNMA-1004-0911">/g) || []).length, 1);
  assert.deepEqual(result.pdfAddenda, [{ documentId: 1, fileName: "Document-1.pdf", title: 'Engagement & "Scope"' }]);
});

test("PDF addenda cannot traverse paths, collide, or reference unselected documents", () => {
  for (const fileName of ["../x.pdf", "..\\x.pdf", "Pdf/x.pdf", "/x.pdf", "C:x.pdf", "x.exe", "CON.pdf", "https://x.pdf", "x..pdf", "x\u0000.pdf"]) {
    assert.throws(() => buildSfrepReportExport({ documents: [doc(1)], pdfAddenda: [{ documentId: 1, fileName }] }), /sfrep_invalid_pdf_filename/);
  }
  assert.throws(() => buildSfrepReportExport({ documents: [doc(1)], pdfAddenda: [{ documentId: 1, fileName: "a.pdf" }, { documentId: 1, fileName: "A.PDF" }] }), /sfrep_duplicate_pdf_filename/);
  assert.throws(() => buildSfrepReportExport({ documents: [doc(1), doc(2)], selectedDocumentIds: [1], pdfAddenda: [{ documentId: 2, fileName: "2.pdf" }] }), /sfrep_invalid_pdf_document/);
});

test("cross-document candidates and invalid selection identities fail safely", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [candidate("owner_name", "Other Assignment", { document_id: 2 })])] });
  assert.equal(result.fields.length, 0);
  assert.match(result.omitted[0].reason, /identity/);
  assert.throws(() => buildSfrepReportExport({ documents: [doc(1), doc("1")] }), /sfrep_invalid_document_id/);
  assert.throws(() => buildSfrepReportExport({ documents: [doc(1)], selectedDocumentIds: [2] }), /sfrep_invalid_document_selection/);
  assert.throws(() => buildSfrepReportExport({ documents: [doc(1)], fieldSelections: { contract_price: 2 } }), /sfrep_invalid_field_selection/);
  assert.throws(() => buildSfrepReportExport({ documents: Array.from({ length: SFREP_MAX_DOCUMENTS + 1 }, (_, index) => doc(index + 1)) }), /sfrep_invalid_documents/);
  assert.throws(() => buildSfrepReportExport({ formId: "URAR" }), /sfrep_unsupported_form/);
});

test("mapper does not mutate input documents or reviewed candidates", () => {
  const documents = Object.freeze([Object.freeze(doc(1, Object.freeze([Object.freeze(candidate("contract_price", "300000"))])))]);
  assert.equal(values(buildSfrepReportExport({ documents })).SalePriceAmount, "300000.00");
});
