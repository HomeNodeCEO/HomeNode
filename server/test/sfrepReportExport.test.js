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

test("assignment types use reviewed engagement evidence, not purchase-contract document classification", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", "purchase_transaction")], { document_type: "engagement_letter" })] });
  assert.ok(result.reportXml.includes('<CheckBoxField Id="AssignmentTypePurchaseCheckBox" Data="true" />'));
  assert.doesNotMatch(result.reportXml, /Data="false"/);
  assert.equal(buildSfrepReportExport({ documents: [doc(1, [], { document_type: "purchase_contract" })] }).fields.length, 0);
  const conflict = buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", "purchase_transaction")], { document_type: "engagement_letter" }), doc(2, [candidate("assignment_type", "refinance")], { document_type: "engagement_letter" })] });
  assert.equal(conflict.fields.length, 0);
  assert.equal(conflict.conflicts[0].sourceField, "assignment_type");
  assert.equal(buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", "heloc")])] }).fields.length, 0);
  assert.equal(buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", "__proto__")])] }).fields.length, 0);
  const contract = doc(3, [candidate("assignment_type", "purchase_transaction", { extraction_method: "document_classification" })], { document_type: "purchase_contract" });
  const engagement = doc(4, [candidate("assignment_type", "refinance")], { document_type: "engagement_letter" });
  const engagementWins = buildSfrepReportExport({ documents: [contract, engagement] });
  assert.equal(values(engagementWins).AssignmentTypeRefinanceCheckBox, "true");
  assert.equal(values(engagementWins).AssignmentTypePurchaseCheckBox, undefined);
  assert.equal(engagementWins.conflicts.length, 0);
  assert.match(engagementWins.omitted[0].reason, /reviewed engagement evidence/);
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

const subjectDoc = (id, candidates, rest = {}) => doc(id, candidates, { property_role: "subject", ...rest });
const mls = (id, listedOn, rest = {}) => subjectDoc(id, [candidate("list_date", listedOn, { id: id * 10 })], { document_type: "mls_sheet", ...rest });
const dated = (effectiveDate, rest = {}) => ({ effectiveDate, effectiveDateSource: "inspection_date", ...rest });

test("Subject aliases have verified destinations and retain reviewed-document provenance", () => {
  const result = buildSfrepReportExport({ documents: [subjectDoc(1, [
    candidate("subject_street_address", "513 Hardy Dr", { id: 11 }),
    candidate("subject_city", "Garland"), candidate("subject_state", "tx"), candidate("subject_zip", "75041"),
    candidate("borrower_name", "Explicit Borrower"), candidate("record_owner_name", "Explicit Record Owner"),
    candidate("county", "Dallas"), candidate("assessor_parcel_number", "000001234"),
    candidate("tax_year", "2026"), candidate("tax_amount", "1234"),
    candidate("neighborhood_name", "Oak Creek Addition", { id: 12 }),
    candidate("lender_client_name", "Example Bank"),
    candidate("lender_client_address", "100 Bank St, Dallas, TX 75001"),
  ], { document_type: "public_record" }), subjectDoc(2, [candidate("assignment_type", "refinance")], { document_type: "engagement_letter" })] });
  assert.equal(values(result).NeighborhoodName, "Oak Creek Addition");
  assert.equal(values(result).OwnerName, "Explicit Record Owner");
  assert.equal(values(result).State, "TX");
  assert.equal(values(result).RealEstateTaxAmount, "1234.00");
  assert.equal(values(result).AssignmentTypeRefinanceCheckBox, "true");
  assert.deepEqual(result.fields.find((field) => field.fieldId === "NeighborhoodName").provenance, {
    kind: "reviewed_document", sourceField: "neighborhood_name", documentId: 1, candidateId: 12, documentType: "public_record",
  });
  assert.ok(result.fields.every((field) => field.provenance.kind === "reviewed_document"));
});

test("neighborhood comes from reviewed named evidence, never an entire legal description or unreviewed subdivision", () => {
  const result = buildSfrepReportExport({ documents: [subjectDoc(1, [
    candidate("legal_description", "LOT 1 BLOCK 2 LONG METES AND BOUNDS DESCRIPTION"),
    candidate("subdivision_name", "Unreviewed Subdivision", { review_status: "suggested" }),
  ])] });
  assert.equal(values(result).NeighborhoodName, undefined);
  assert.equal(values(result).LegalDescription, "LOT 1 BLOCK 2 LONG METES AND BOUNDS DESCRIPTION");
  const reviewed = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("subdivision_name", "Reviewed Addition")])] });
  assert.equal(values(reviewed).NeighborhoodName, "Reviewed Addition");
  const conflict = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("subdivision_name", "A"), candidate("neighborhood_name", "B")])] });
  assert.equal(values(conflict).NeighborhoodName, undefined);
  assert.deepEqual(conflict.conflicts[0].values, ["A", "B"]);
});

test("explicit comparable and unknown property roles cannot populate any Subject fields", () => {
  for (const property_role of ["comparable", "unknown", "invalid_role"]) {
    const result = buildSfrepReportExport({ documents: [doc(1, [
      candidate("owner_name", "Wrong Owner"), candidate("tax_amount", "8000"),
      candidate("subject_city", "Wrong City"), candidate("lender_client_name", "Wrong Lender"),
      candidate("pud", "true"), candidate("list_date", "2026-09-01"),
    ], { property_role, document_type: "mls_sheet" })], subjectContext: dated("2026-10-02") });
    assert.equal(result.fields.length, 0);
    assert.equal(result.omitted.length, 6);
    assert.ok(result.omitted.every((entry) => /not verified as subject/.test(entry.reason)));
  }
});

test("PUD requires explicit reviewed evidence; HOA dues never infer it", () => {
  const onlyHoa = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("hoa_dues_amount", "75"), candidate("hoa_frequency", "per_month")])] });
  assert.equal(values(onlyHoa).AssessmentAmount, "75.00");
  assert.equal(values(onlyHoa).AssessmentPerMonthCheckBox, "true");
  assert.equal(values(onlyHoa).PropertyTypePUDCheckBox, undefined);
  assert.ok(onlyHoa.warnings.some((warning) => /HOA dues.*do not establish PUD/.test(warning)));
  for (const value of [true, "true", "Yes"]) {
    const result = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("pud", value)])] });
    assert.equal(values(result).PropertyTypePUDCheckBox, "true");
  }
  const unreviewed = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("pud", "true", { review_status: "suggested" })])] });
  assert.equal(values(unreviewed).PropertyTypePUDCheckBox, undefined);
  const explicitType = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("property_type", "Planned Unit Development")])] });
  assert.equal(values(explicitType).PropertyTypePUDCheckBox, "true");
});

test("explicit not-PUD does not erase a checkbox, and conflicts block all PUD exports", () => {
  const notPud = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("pud", false)])] });
  assert.equal(values(notPud).PropertyTypePUDCheckBox, undefined);
  assert.match(notPud.omitted[0].reason, /unchecked PUD value is not exported/);
  const conflict = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("pud", "false")]), subjectDoc(2, [candidate("property_type", "PUD")])] });
  assert.equal(values(conflict).PropertyTypePUDCheckBox, undefined);
  assert.deepEqual(conflict.conflicts[0].values, ["PropertyTypePUDCheckBox=false", "PropertyTypePUDCheckBox=true"]);
  assert.doesNotMatch(conflict.reportXml, /Data="false"/);
});

test("HOA periodicity is never prorated and incompatible frequency checkboxes are not both emitted", () => {
  const annual = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("hoa_frequency", "per_year")])] });
  assert.equal(values(annual).AssessmentPerYearCheckBox, "true");
  const unsupported = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("hoa_frequency", "per_quarter")])] });
  assert.equal(unsupported.fields.length, 0);
  assert.match(unsupported.omitted[0].reason, /not prorated/);
  const conflicting = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("hoa_frequency", "per_year"), candidate("hoa_frequency", "per_month")])] });
  assert.equal(conflicting.fields.length, 0);
  assert.equal(conflicting.conflicts[0].sourceField, "hoa_frequency");
  for (const frequency of [null, "per_quarter", "other"]) {
    const candidates = [candidate("hoa_dues_amount", "300")];
    if (frequency) candidates.push(candidate("hoa_frequency", frequency));
    const unsupportedAmount = buildSfrepReportExport({ documents: [subjectDoc(1, candidates)] });
    assert.equal(values(unsupportedAmount).AssessmentAmount, undefined);
    assert.equal(values(unsupportedAmount).PropertyTypePUDCheckBox, undefined);
  }
  const periodsConflict = buildSfrepReportExport({ documents: [
    subjectDoc(1, [candidate("hoa_dues_amount", "75"), candidate("hoa_frequency", "per_month")]),
    subjectDoc(2, [candidate("hoa_dues_amount", "75"), candidate("hoa_frequency", "per_year")]),
  ] });
  assert.equal(values(periodsConflict).AssessmentAmount, undefined);
});

test("fee-simple default is opt-in and has a traceable user-default assumption instead of invented evidence", () => {
  assert.equal(buildSfrepReportExport().fields.length, 0);
  const result = buildSfrepReportExport({ subjectContext: { feeSimpleDefault: true } });
  assert.deepEqual(result.fields[0], {
    sourceField: "property_rights", documentId: null, candidateId: null,
    fieldId: "PropertyRightsAppraisedFeeSimpleCheckBox", value: "true", type: "CheckBoxField",
    provenance: { kind: "user_default", sourceField: "property_rights", documentId: null, candidateId: null, rule: "user_requested_fee_simple_default" },
  });
  assert.equal(result.assumptions.length, 1);
  assert.equal(result.assumptions[0].fieldId, result.fields[0].fieldId);
  assert.match(result.assumptions[0].reason, /not a fact extracted/);
  assert.ok(result.warnings.includes(result.assumptions[0].reason));
});

test("reviewed property rights override or suppress the user default, including conflicts and unknown values", () => {
  for (const sourceField of ["property_rights", "property_rights_appraised"]) {
    const leasehold = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate(sourceField, "Leasehold")])], subjectContext: { feeSimpleDefault: true } });
    assert.equal(values(leasehold).PropertyRightsAppraisedFeeSimpleCheckBox, undefined);
    assert.equal(values(leasehold).PropertyRightsAppraisedLeaseholdCheckBox, "true");
    assert.equal(leasehold.assumptions.length, 0);
    assert.equal(leasehold.fields[0].provenance.kind, "reviewed_document");
  }
  const conflict = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("property_rights", "fee_simple")]), subjectDoc(2, [candidate("property_rights_appraised", "leasehold")])], subjectContext: { feeSimpleDefault: true } });
  assert.equal(conflict.fields.length, 0);
  assert.equal(conflict.assumptions.length, 0);
  assert.equal(conflict.conflicts.length, 1);
  for (const value of ["unknown", "other", ""]) {
    const unsupported = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("property_rights", value)])], subjectContext: { feeSimpleDefault: true } });
    assert.equal(unsupported.fields.length, 0);
    assert.equal(unsupported.assumptions.length, 0);
  }
});

test("listing Yes uses inclusive preceding calendar-year boundaries and records its exact derivation", () => {
  for (const listedOn of ["2025-10-02", "2026-01-15", "2026-10-02"]) {
    const result = buildSfrepReportExport({ documents: [mls(1, listedOn)], subjectContext: dated("2026-10-02") });
    assert.equal(values(result).CurrentPriorListingYesCheckBox, "true");
    assert.equal(values(result).CurrentPriorListingNoCheckBox, undefined);
    assert.deepEqual(result.fields[0].provenance, {
      kind: "derived_reviewed_document", sourceField: "list_date", documentId: 1, candidateId: 10, documentType: "mls_sheet",
      rule: "subject_mls_list_date_within_preceding_12_calendar_months", sourceValue: listedOn,
      effectiveDate: "2026-10-02", effectiveDateSource: "inspection_date", effectiveDateSourceDocumentId: null,
      windowStart: "2025-10-02", windowEnd: "2026-10-02",
    });
  }
});

test("old, future, absent, invalid, and unreviewed MLS dates never imply offered-for-sale No", () => {
  for (const listedOn of ["2025-10-01", "2026-10-03", "2026-02-30", "unknown", ""]) {
    const result = buildSfrepReportExport({ documents: [mls(1, listedOn)], subjectContext: dated("2026-10-02") });
    assert.equal(values(result).CurrentPriorListingYesCheckBox, undefined);
    assert.equal(values(result).CurrentPriorListingNoCheckBox, undefined);
    assert.equal(result.omitted.length, 1);
  }
  const noDates = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("listing_status", "Active")], { document_type: "mls_sheet" })], subjectContext: dated("2026-10-02") });
  assert.equal(noDates.fields.length, 0);
  const unreviewed = mls(1, "2026-09-01");
  unreviewed.candidates[0].review_status = "suggested";
  assert.equal(buildSfrepReportExport({ documents: [unreviewed], subjectContext: dated("2026-10-02") }).fields.length, 0);
});

test("calendar lookback clamps leap day and does not use 365 days", () => {
  const leapEffective = buildSfrepReportExport({ documents: [mls(1, "2023-02-28")], subjectContext: dated("2024-02-29") });
  assert.equal(leapEffective.effectiveDateContext.windowStart, "2023-02-28");
  assert.equal(values(leapEffective).CurrentPriorListingYesCheckBox, "true");
  const beforeLeapWindow = buildSfrepReportExport({ documents: [mls(1, "2023-02-27")], subjectContext: dated("2024-02-29") });
  assert.equal(beforeLeapWindow.fields.length, 0);
  const acrossLeap = buildSfrepReportExport({ documents: [mls(1, "2023-03-01")], subjectContext: dated("2024-03-01") });
  assert.equal(acrossLeap.effectiveDateContext.windowStart, "2023-03-01");
  assert.equal(values(acrossLeap).CurrentPriorListingYesCheckBox, "true");
  const afterLeap = buildSfrepReportExport({ documents: [mls(1, "2024-02-29")], subjectContext: dated("2025-02-28") });
  assert.equal(afterLeap.effectiveDateContext.windowStart, "2024-02-28");
  assert.equal(values(afterLeap).CurrentPriorListingYesCheckBox, "true");
});

test("listing derivation requires verified subject MLS identity and effective-date context", () => {
  for (const overrides of [{ property_role: undefined }, { property_role: "unknown" }, { property_role: "comparable" }, { document_type: "other" }]) {
    const result = buildSfrepReportExport({ documents: [mls(1, "2026-09-01", overrides)], subjectContext: dated("2026-10-02") });
    assert.equal(result.fields.length, 0);
    assert.equal(result.omitted.length, 1);
  }
  const noEffectiveDate = buildSfrepReportExport({ documents: [mls(1, "2026-09-01")] });
  assert.equal(noEffectiveDate.fields.length, 0);
  assert.match(noEffectiveDate.omitted[0].reason, /Effective date is unavailable/);
});

test("explicit reviewed offered-for-sale No is allowed but conflicts with a derived Yes", () => {
  const explicitNo = subjectDoc(2, [candidate("offered_for_sale_prior_12_months", "no")]);
  const no = buildSfrepReportExport({ documents: [explicitNo], subjectContext: dated("2026-10-02") });
  assert.equal(values(no).CurrentPriorListingNoCheckBox, "true");
  assert.equal(no.fields[0].provenance.kind, "reviewed_document");
  const conflict = buildSfrepReportExport({ documents: [mls(1, "2026-09-01"), explicitNo], subjectContext: dated("2026-10-02") });
  assert.equal(conflict.fields.length, 0);
  assert.equal(conflict.conflicts.length, 1);
  assert.deepEqual(conflict.conflicts[0].documentIds, [1, 2]);
  const oldDate = buildSfrepReportExport({ documents: [mls(1, "2020-01-01"), explicitNo], subjectContext: dated("2026-10-02") });
  assert.equal(values(oldDate).CurrentPriorListingNoCheckBox, "true");
});

test("conflicting reviewed MLS dates block a derived checkbox even when both dates would imply Yes", () => {
  const documents = [mls(1, "2026-09-01"), mls(2, "2026-09-02")];
  const result = buildSfrepReportExport({ documents, subjectContext: dated("2026-10-02") });
  assert.equal(result.fields.length, 0);
  assert.deepEqual(result.conflicts, [{ sourceField: "list_date", documentIds: [1, 2], values: ["2026-09-01", "2026-09-02"] }]);
  const reversed = buildSfrepReportExport({ documents: [...documents].reverse(), subjectContext: dated("2026-10-02") });
  assert.deepEqual(result, reversed);
  const selected = buildSfrepReportExport({ documents, fieldSelections: { list_date: 2 }, subjectContext: dated("2026-10-02") });
  assert.equal(values(selected).CurrentPriorListingYesCheckBox, "true");
  assert.equal(selected.fields[0].documentId, 2);
});

test("effective-date context is deterministic, source-labeled, and placeholder warnings are explicit", () => {
  const subjectContext = dated("2026-10-02", { effectiveDateSource: "document_upload_date_placeholder", effectiveDateSourceDocumentId: 1 });
  const result = buildSfrepReportExport({ documents: [mls(1, "2026-09-01")], subjectContext });
  assert.deepEqual(result.effectiveDateContext, {
    effectiveDate: "2026-10-02", source: "document_upload_date_placeholder", sourceDocumentId: 1,
    windowStart: "2025-10-02", windowEnd: "2026-10-02", calendarMonths: 12, isPlaceholder: true,
  });
  assert.equal(result.fields[0].provenance.effectiveDateSourceDocumentId, 1);
  assert.ok(result.warnings.some((warning) => /provisionally a document upload date/.test(warning)));
  const actual = buildSfrepReportExport({ documents: [mls(1, "2026-09-01")], subjectContext: dated("2026-10-02", { effectiveDateSource: "assignment_effective_date" }) });
  assert.equal(actual.effectiveDateContext.isPlaceholder, false);
  assert.notDeepEqual(result.effectiveDateContext, actual.effectiveDateContext);
  // Same XML can have different material date provenance; the caller must bind
  // effectiveDateContext and provenance into its preview digest as documented.
  assert.equal(result.reportXml, actual.reportXml);
});

test("invalid or unlabeled effective-date context fails closed", () => {
  for (const subjectContext of [
    { effectiveDate: "2026-02-30", effectiveDateSource: "inspection_date" },
    { effectiveDate: "10/02/2026", effectiveDateSource: "inspection_date" },
    { effectiveDate: "2026-10-02" }, { effectiveDateSource: "inspection_date" },
    { effectiveDate: "2026-10-02", effectiveDateSource: "today" },
    { effectiveDate: "2026-10-02", effectiveDateSource: "inspection_date", effectiveDateSourceDocumentId: -1 },
    { feeSimpleDefault: "true" },
  ]) assert.throws(() => buildSfrepReportExport({ subjectContext }), /sfrep_invalid_/);
});

test("derived offered-for-sale checkbox does not fabricate the composite UAD listing field", () => {
  const document = mls(1, "2026-09-01");
  document.candidates.push(candidate("mls_number", "12345678"), candidate("list_price", "250000"), candidate("days_on_market", "30"));
  const result = buildSfrepReportExport({ documents: [document], subjectContext: dated("2026-10-02") });
  assert.equal(values(result).CurrentPriorListingYesCheckBox, "true");
  assert.equal(values(result).CurrentPriorListingDataSources, undefined);
  assert.equal(result.knownMissing[0].fieldId, "CurrentPriorListingDataSources");
  assert.deepEqual(result.omitted.map((entry) => entry.sourceField), ["days_on_market", "list_price", "mls_number"]);
  assert.doesNotMatch(result.reportXml, /12345678|250000|CurrentPriorListingDataSources/);
});

test("equivalent structured addresses and city whitespace collapse without altering display values or provenance", () => {
  const documents = [
    subjectDoc(1, [candidate("subject_property_address", "100 EXAMPLE DRIVE, SALT  LAKE CITY, UT 84101", { id: 11 })]),
    subjectDoc(2, [candidate("subject_street_address", "100 Example Dr", { id: 21 }), candidate("subject_city", "Salt Lake City"),
      candidate("subject_state", "ut"), candidate("subject_zip", "84101")]),
  ];
  const result = buildSfrepReportExport({ documents });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.fields.length, 4);
  assert.equal(values(result).StreetAddress, "100 EXAMPLE DRIVE");
  assert.equal(values(result).City, "SALT  LAKE CITY");
  assert.equal(values(result).State, "UT");
  const street = result.fields.find((field) => field.fieldId === "StreetAddress");
  assert.equal(street.documentId, 1);
  assert.equal(street.candidateId, 11);
  assert.equal(street.provenance.sourceField, "subject_property_address");
  assert.deepEqual(result, buildSfrepReportExport({ documents: [...documents].reverse() }));
});

test("structured street comparison allows presentation labels but keeps every secondary identity exact", () => {
  const equal = buildSfrepReportExport({ documents: [
    subjectDoc(1, [candidate("subject_street_address", "100 Example Drive Building A Floor 2 Apt 4")]),
    subjectDoc(2, [candidate("subject_street_address", "100 EXAMPLE DR BLDG A FL 2 UNIT 4")]),
  ] });
  assert.equal(equal.conflicts.length, 0);
  assert.equal(equal.fields.length, 1);
  for (const other of [
    "101 Example Dr Building A Floor 2 Apt 4",
    "100 Examples Dr Building A Floor 2 Apt 4",
    "100 Example Dr Building A Floor 2 Apt 5",
    "100 Example Dr Building B Floor 2 Apt 4",
    "100 Example Dr Building A Floor 3 Apt 4",
    "100 Example Dr Building A Floor 2",
  ]) {
    const different = buildSfrepReportExport({ documents: [
      subjectDoc(1, [candidate("subject_street_address", "100 Example Drive Building A Floor 2 Apt 4")]),
      subjectDoc(2, [candidate("subject_street_address", other)]),
    ] });
    assert.equal(different.fields.length, 0, other);
    assert.equal(different.conflicts.length, 1, other);
  }
});

test("locality differences remain conflicts and ZIP codes are never reduced to ZIP5", () => {
  const differentCity = buildSfrepReportExport({ documents: [
    subjectDoc(1, [candidate("subject_property_address", "100 Example Drive, Dallas, TX 75001")]),
    subjectDoc(2, [candidate("subject_property_address", "100 Example Dr, Addison, TX 75001")]),
  ] });
  assert.equal(values(differentCity).StreetAddress, "100 Example Drive");
  assert.equal(values(differentCity).City, undefined);
  assert.deepEqual(differentCity.conflicts[0].values, ["Addison", "Dallas"]);
  for (const [field, first, second] of [
    ["subject_city", "Fort Worth", "Ft Worth"],
    ["subject_state", "TX", "OK"],
    ["subject_zip", "75001", "75002"],
    ["subject_zip", "75001", "75001-1234"],
  ]) {
    const result = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate(field, first)]), subjectDoc(2, [candidate(field, second)])] });
    assert.equal(result.fields.length, 0);
    assert.equal(result.conflicts.length, 1);
  }
});

test("street comparison never drops raw locality tails or collapses punctuated secondary identifiers", () => {
  for (const [first, second] of [
    ["100 Example Drive, Dallas, TX 75001", "100 Example Dr, Addison, TX 75001"],
    ["100 Example Drive Apt 1-2", "100 Example Dr Apt 12"],
    ["100 Example Drive Building A-1 Apt 2", "100 Example Dr Building A1 Apt 2"],
    ["100 Example Drive Floor 1/2", "100 Example Dr Floor 12"],
    ["Unparsed Street", "UNPARSED STREET"],
  ]) {
    const result = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("subject_street_address", first)]), subjectDoc(2, [candidate("subject_street_address", second)])] });
    assert.equal(result.fields.length, 0, `${first} / ${second}`);
    assert.equal(result.conflicts.length, 1);
  }
  const commaUnit = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("subject_street_address", "100 Example Drive, Apt 2")]), subjectDoc(2, [candidate("subject_street_address", "100 Example Dr Unit 2")])] });
  assert.equal(commaUnit.conflicts.length, 0);
});

test("address comparison normalization never rewrites or reorders borrower, owner, or legal identities", () => {
  for (const [field, first, second] of [
    ["owner_name", "SMITH, JANE", "Jane Smith"],
    ["borrower_name", "Jane Smith", "JANE SMITH"],
    ["legal_description", "Lot 1 Block A", "LOT 1 BLOCK A"],
  ]) {
    const result = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate(field, first)]), subjectDoc(2, [candidate(field, second)])] });
    assert.equal(result.fields.length, 0);
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(result.conflicts[0].values, [first, second].sort());
  }
});
