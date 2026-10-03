import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSfrepReportExport,
  SFREP_MAX_DOCUMENTS,
  SFREP_PRIMARY_FORM_ID,
  SFREP_SUPPORTED_FORM_IDS,
} from "../src/services/sfrepReportExport.js";
import { sfrepDocumentPropertyRole } from "../src/services/sfrepSubjectContext.js";

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
  assert.equal(values(result).RealEstateTaxAmount, "0");
  assert.equal(values(result).RoomCountBedrooms, "0");
});

test("legacy confirmed candidates may use their normalized value when no edited value exists", () => {
  const result = buildSfrepReportExport({ documents: [doc(1, [{ field_key: "contract_price", review_status: "confirmed", confirmed_value: null, normalized_value: "500000.00" }])] });
  assert.equal(values(result).SalePriceAmount, "500000.00");
});

test("exact reviewed placeholders cannot escape through old confirmations or matching parcel identity", () => {
  const accountId = "00001234567890000";
  for (const sourceField of ["subject_street_address", "subject_property_address"]) {
    for (const marker of ["TBD", "tba", "Pending", "UNASSIGNED", "Unknown", "To be determined", "not disclosed", "unavailable", "TBD."]) {
      for (const storage of [
        { confirmed_value: marker, normalized_value: "100 Old Suggestion Dr" },
        { confirmed_value: null, normalized_value: marker },
        { confirmed_value: null, normalized_value: null, raw_value: marker },
      ]) {
        const document = doc(1, [candidate(sourceField, null, storage), candidate("assessor_parcel_number", accountId)], {
          document_type: "public_record",
          subject_context: { accountId, address: "100 Example Dr", city: "Garland", postalCode: "75041" },
        });
        document.property_role = sfrepDocumentPropertyRole(document);
        assert.equal(document.property_role, "subject", `${sourceField}: ${marker}`);
        const result = buildSfrepReportExport({ documents: [document] });
        assert.deepEqual(values(result), { AssessorsParcelNumber: accountId });
        assert.equal(result.omitted[0].sourceField, sourceField);
        assert.doesNotMatch(result.reportXml, /StreetAddress|100 Old Suggestion Dr/);
      }
    }
  }
});

test("address splitting rejects exact placeholder components without stripping meaningful names", () => {
  for (const sourceField of ["subject_property_address", "subject_street_address"]) {
    for (const address of ["TBD, Garland, TX 75041", "Pending, Garland, TX 75041", "100 Example Dr, Unknown, TX 75041"]) {
      const result = buildSfrepReportExport({ documents: [doc(1, [candidate(sourceField, address)], { property_role: "subject" })] });
      assert.equal(result.fields.length, 0, address);
      assert.equal(result.omitted.length, 1);
    }
  }
  const result = buildSfrepReportExport({ documents: [doc(1, [
    candidate("owner_name", "TBD Holdings LLC"), candidate("borrower_name", "Pending Investments LLC"),
    candidate("lender_client_name", "Unknown River Bank"), candidate("subject_property_address", "100 Pending Lane, Unknown Creek, TX 75041"),
  ])] });
  assert.deepEqual(values(result), {
    OwnerName: "TBD Holdings LLC", BorrowerName: "Pending Investments LLC", LenderClientCompanyName: "Unknown River Bank",
    StreetAddress: "100 Pending Lane", City: "Unknown Creek", State: "TX", ZipCode: "75041",
  });
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
  const result = buildSfrepReportExport({ documents: [doc(1, [candidate("lender_client_name", `A&B <Lot> "2" O'Neil\nBlock\t3 😃`)])], application: { vendorName: "<Vendor>" } });
  assert.ok(result.reportXml.includes('Data="A&amp;B &lt;Lot&gt; &quot;2&quot; O&apos;Neil&#10;Block&#9;3 😃"'));
  assert.ok(result.reportXml.includes('VendorName="&lt;Vendor&gt;"'));
  assert.equal(values(result).LenderClientCompanyName, `A&B <Lot> "2" O'Neil\nBlock\t3 😃`);
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

test("legacy UAD tax and HOA amounts project to whole dollars with exact reviewed source retained", () => {
  for (const [source, expected] of [["$4,321.49", "4321"], ["$4,321.50", "4322"], ["$4,321.51", "4322"], ["4321.00", "4321"], [" 00120.5 ", "121"], ["0", "0"], ["0.01", "0"], ["999999999999.49", "999999999999"], ["999999999999.50", "1000000000000"]]) {
    const documents = [doc(1, [candidate("tax_amount", source, { id: 11 }), candidate("hoa_dues_amount", source, { id: 12 }), candidate("hoa_frequency", "per_month")], { document_type: "public_record" })];
    const before = structuredClone(documents);
    const result = buildSfrepReportExport({ documents });
    for (const fieldId of ["RealEstateTaxAmount", "AssessmentAmount"]) {
      const field = result.fields.find((entry) => entry.fieldId === fieldId);
      assert.equal(field.value, expected, `${fieldId}: ${source}`);
      assert.equal(field.sourceValue, source);
      assert.equal(field.formattingRule, "uad_whole_dollars_half_up");
      assert.equal(field.provenance.kind, "reviewed_document");
      assert.equal(field.provenance.documentId, 1);
      assert.equal(field.provenance.candidateId, fieldId === "RealEstateTaxAmount" ? 11 : 12);
      assert.ok(result.reportXml.includes(`<TextField Id="${fieldId}" Data="${expected}" />`));
    }
    assert.equal(values(result).AssessmentPerMonthCheckBox, "true");
    assert.equal(values(result).AssessmentPerYearCheckBox, undefined);
    assert.equal(result.warnings.filter((warning) => /rounded half up/.test(warning)).length, /\.(?:00)$/.test(source) || source === "0" ? 0 : 2);
    assert.deepEqual(documents, before);
  }
  const contract = buildSfrepReportExport({ documents: [doc(1, [candidate("contract_price", "$4,321.50")])] });
  assert.equal(values(contract).SalePriceAmount, "4321.50");
  assert.equal(contract.fields[0].sourceValue, undefined);
  assert.equal(contract.fields[0].formattingRule, undefined);
});

test("pre-rounding tax and HOA amounts remain conflicting even when their report dollars would match", () => {
  for (const keys of [["tax_amount", "tax_amount"], ["tax_amount", "real_estate_tax_amount"], ["hoa_dues_amount", "hoa_dues_amount"]]) {
    const documents = keys.map((key, index) => doc(index + 1, [candidate(key, index ? "4321.40" : "4321.49"), candidate("hoa_frequency", "per_year")]));
    const result = buildSfrepReportExport({ documents });
    const fieldId = keys[0] === "hoa_dues_amount" ? "AssessmentAmount" : "RealEstateTaxAmount";
    assert.equal(values(result)[fieldId], undefined);
    assert.deepEqual(result.conflicts[0].values, ["4321.40", "4321.49"]);
    assert.equal(result.warnings.some((warning) => /rounded half up/.test(warning)), false);
    assert.deepEqual(result, buildSfrepReportExport({ documents: [...documents].reverse() }));
    const selected = buildSfrepReportExport({ documents, selectedDocumentIds: [1] });
    assert.equal(values(selected)[fieldId], "4321");
    assert.equal(selected.fields.find((field) => field.fieldId === fieldId).sourceValue, "4321.49");
  }
});

test("equivalent tax aliases retain the deterministically selected exact source after formatting", () => {
  const result = buildSfrepReportExport({ documents: [
    doc(2, [candidate("real_estate_tax_amount", "4321.50", { id: 22 })]),
    doc(1, [candidate("tax_amount", "$4,321.50", { id: 11 })]),
  ] });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].value, "4322");
  assert.equal(result.fields[0].sourceValue, "$4,321.50");
  assert.equal(result.fields[0].documentId, 1);
  assert.equal(result.fields[0].candidateId, 11);
});

test("whole-dollar display never revives invalid money or prorates an unsupported HOA period", () => {
  for (const source of ["unknown", "", "12,34.50", "4321.501", "-1.50", "1e3", "1/2", "1000000000000"]) {
    const result = buildSfrepReportExport({ documents: [doc(1, [candidate("tax_amount", source), candidate("hoa_dues_amount", source), candidate("hoa_frequency", "per_month")])] });
    assert.equal(values(result).RealEstateTaxAmount, undefined);
    assert.equal(values(result).AssessmentAmount, undefined);
    assert.equal(result.warnings.some((warning) => /rounded half up/.test(warning)), false);
  }
  const result = buildSfrepReportExport({ documents: [doc(1, [candidate("hoa_dues_amount", "120.50"), candidate("hoa_frequency", "per_quarter")])] });
  assert.equal(values(result).AssessmentAmount, undefined);
  assert.match(result.omitted.find((entry) => entry.sourceField === "hoa_dues_amount").reason, /not prorated/);
});

test("legal-description display folds line controls without truncating or changing original evidence", () => {
  const source = '  EXAMPLE  PARK 4\r\n  BLK 17\tLT 36\rSECTION B\n' + 'LONG LEGAL '.repeat(20) + 'END  ';
  const documents = [doc(1, [candidate("legal_description", source, { id: 10 })])];
  const result = buildSfrepReportExport({ documents });
  const field = result.fields[0];
  assert.equal(field.value, 'EXAMPLE  PARK 4 BLK 17 LT 36 SECTION B ' + 'LONG LEGAL '.repeat(20) + 'END');
  assert.equal(field.sourceValue, source);
  assert.equal(field.formattingRule, "single_line_legal_description");
  assert.deepEqual(field.provenance, { kind: "reviewed_document", sourceField: "legal_description", documentId: 1, candidateId: 10, documentType: null });
  assert.equal(documents[0].candidates[0].confirmed_value, source);
  assert.match(result.warnings.join("\n"), /LegalDescription.*line breaks\/tabs.*single-line.*not truncated/);
  assert.doesNotMatch(result.reportXml, /&#10;|&#13;|&#9;/);
  const unchanged = buildSfrepReportExport({ documents: [doc(1, [candidate("legal_description", "EXAMPLE  PARK 4")])] });
  assert.equal(unchanged.fields[0].value, "EXAMPLE  PARK 4");
  assert.equal(unchanged.fields[0].sourceValue, "EXAMPLE  PARK 4");
  assert.equal(unchanged.warnings.some((warning) => /line breaks\/tabs/.test(warning)), false);
});

test("legal line folding cannot merge distinct reviewed legal descriptions before conflict detection", () => {
  const documents = [doc(1, [candidate("legal_description", "EXAMPLE PARK 4\nBLK 17 LT 36")]), doc(2, [candidate("legal_description", "EXAMPLE PARK 4 BLK 17 LT 36")])];
  const result = buildSfrepReportExport({ documents });
  assert.equal(values(result).LegalDescription, undefined);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.warnings.some((warning) => /line breaks\/tabs/.test(warning)), false);
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

test("explicit known Other engagement purposes export their checkbox and meaningful description together", () => {
  for (const [purpose, description] of [
    ["heloc", "HELOC"], ["HELOC", "HELOC"], ["rtl", "RTL"], ["bridge_loan", "Bridge loan"],
    ["new_construction", "New construction"], ["rehab", "Rehab"], ["dscr", "DSCR"],
  ]) {
    const result = buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", purpose, { id: 10 })], {
      document_type: "engagement_letter", property_role: "subject",
    })] });
    assert.deepEqual(values(result), { AssignmentTypeOtherCheckBox: "true", AssignmentTypeOtherDescription: description });
    assert.equal(result.conflicts.length, 0);
    for (const field of result.fields) {
      assert.equal(field.documentId, 1);
      assert.equal(field.candidateId, 10);
      assert.equal(field.provenance.kind, "reviewed_document");
      assert.equal(field.assignmentType, undefined);
    }
    assert.match(result.reportXml, /<CheckBoxField Id="AssignmentTypeOtherCheckBox" Data="true"/);
    assert.match(result.reportXml, /<TextField Id="AssignmentTypeOtherDescription"/);
  }
  for (const purpose of ["other", "unknown", "TBD", "any reason", "__proto__"]) {
    const result = buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", purpose)], { document_type: "engagement_letter" })] });
    assert.equal(result.fields.length, 0, purpose);
  }
  for (const override of [{ review_status: "suggested" }, { review_status: "rejected" }]) {
    const result = buildSfrepReportExport({ documents: [doc(1, [candidate("assignment_type", "heloc", override)], { document_type: "engagement_letter" })] });
    assert.equal(result.fields.length, 0);
  }
});

test("assignment conflicts suppress every Other component and source selection restores one complete choice", () => {
  const engagement = (id, purpose) => doc(id, [candidate("assignment_type", purpose, { id: id * 10 })], { document_type: "engagement_letter" });
  for (const other of ["purchase_transaction", "refinance", "bridge_loan"]) {
    const documents = [engagement(1, "heloc"), engagement(2, other)];
    const result = buildSfrepReportExport({ documents });
    assert.equal(result.fields.length, 0, other);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].sourceField, "assignment_type");
    assert.deepEqual(result.conflicts[0].documentIds, [1, 2]);
    assert.deepEqual(result, buildSfrepReportExport({ documents: [...documents].reverse() }));
    const selected = buildSfrepReportExport({ documents, fieldSelections: { assignment_type: 1 } });
    assert.deepEqual(values(selected), { AssignmentTypeOtherCheckBox: "true", AssignmentTypeOtherDescription: "HELOC" });
    assert.equal(selected.conflicts.length, 0);
    assert.ok(selected.fields.every((field) => field.documentId === 1));
  }
  const documents = [engagement(2, "heloc"), engagement(1, "heloc")];
  const duplicate = buildSfrepReportExport({ documents });
  assert.equal(duplicate.fields.length, 2);
  assert.equal(duplicate.conflicts.length, 0);
  assert.ok(duplicate.fields.every((field) => field.documentId === 1 && field.candidateId === 10));
  assert.deepEqual(duplicate, buildSfrepReportExport({ documents: [...documents].reverse() }));
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
  assert.equal(values(result).RealEstateTaxAmount, "8500");
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
  assert.equal(values(result).RealEstateTaxAmount, "1234");
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
  assert.equal(values(onlyHoa).AssessmentAmount, "75");
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

test("locality differences and distinct ZIP destinations remain conflicts", () => {
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
    ["subject_zip", "75001-1234", "75001-5678"],
  ]) {
    const result = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate(field, first)]), subjectDoc(2, [candidate(field, second)])] });
    assert.equal(result.fields.length, 0);
    assert.equal(result.conflicts.length, 1);
  }
});

test("equivalent numeric APN separators collapse without changing display, leading zeroes, or source provenance", () => {
  const documents = [
    subjectDoc(2, [candidate("assessors_parcel_number", "00123450067890000", { id: 22 })]),
    subjectDoc(1, [candidate("assessor_parcel_number", "00-12345-006-789-0000", { id: 11 })]),
  ];
  const before = structuredClone(documents);
  const result = buildSfrepReportExport({ documents });
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(values(result), { AssessorsParcelNumber: "00-12345-006-789-0000" });
  assert.equal(result.fields[0].documentId, 1);
  assert.equal(result.fields[0].candidateId, 11);
  assert.equal(result.fields[0].provenance.sourceField, "assessor_parcel_number");
  assert.deepEqual(result, buildSfrepReportExport({ documents: [...documents].reverse() }));
  assert.deepEqual(documents, before);
  for (const other of ["123450067890000", "00123450067890001", "AB-123", "0012345/0067890000"]) {
    const conflict = buildSfrepReportExport({ documents: [documents[1], subjectDoc(3, [candidate("assessor_parcel_number", other)])] });
    assert.equal(conflict.fields.length, 0, other);
    assert.equal(conflict.conflicts.length, 1);
  }
  const alpha = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("assessor_parcel_number", "AB-123")]), subjectDoc(2, [candidate("assessor_parcel_number", "AB123")])] });
  assert.equal(alpha.fields.length, 0);
  assert.equal(alpha.conflicts.length, 1);
});

test("compatible ZIP5 and one ZIP+4 preserve the complete reviewed value and its exact provenance", () => {
  const documents = [
    subjectDoc(1, [candidate("subject_zip", "75001", { id: 11 })]),
    subjectDoc(3, [candidate("subject_zip_code", "75001-2468", { id: 33 })]),
    subjectDoc(2, [candidate("subject_property_address", "100 Example Dr, Addison, TX 75001-2468", { id: 22 })]),
  ];
  const before = structuredClone(documents);
  const result = buildSfrepReportExport({ documents });
  assert.equal(result.conflicts.length, 0);
  const zip = result.fields.find((field) => field.fieldId === "ZipCode");
  assert.equal(zip.value, "75001-2468");
  assert.equal(zip.documentId, 2);
  assert.equal(zip.candidateId, 22);
  assert.equal(zip.sourceField, "subject_property_address");
  assert.deepEqual(zip.provenance, { kind: "reviewed_document", sourceField: "subject_property_address", documentId: 2, candidateId: 22, documentType: null });
  assert.deepEqual(result, buildSfrepReportExport({ documents: [...documents].reverse() }));
  assert.deepEqual(documents, before);
});

test("ZIP5 cannot bridge conflicting ZIP+4 destinations or different base ZIPs", () => {
  for (const additional of ["75001-1357", "75002", "75002-2468"]) {
    const result = buildSfrepReportExport({ documents: [
      subjectDoc(1, [candidate("subject_zip", "75001")]),
      subjectDoc(2, [candidate("subject_zip_code", "75001-2468")]),
      subjectDoc(3, [candidate("subject_zip", additional)]),
    ] });
    assert.equal(values(result).ZipCode, undefined, additional);
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(result.conflicts[0].documentIds, [1, 2, 3]);
  }
});

test("old confirmed street fields with full localities split into verified address destinations", () => {
  const document = doc(1, [candidate("subject_street_address", "100 Example Dr, Garland, TX 75041")], {
    subject_context: { address: "100 Example Dr", city: "Garland", postalCode: "75041" },
  });
  document.property_role = sfrepDocumentPropertyRole(document);
  assert.equal(document.property_role, "subject");
  assert.deepEqual(values(buildSfrepReportExport({ documents: [document] })), {
    StreetAddress: "100 Example Dr", City: "Garland", State: "TX", ZipCode: "75041",
  });
  const conflict = buildSfrepReportExport({ documents: [
    subjectDoc(1, [candidate("subject_street_address", "100 Example Drive, Dallas, TX 75001")]),
    subjectDoc(2, [candidate("subject_street_address", "100 Example Dr, Addison, TX 75001")]),
  ] });
  assert.equal(values(conflict).StreetAddress, "100 Example Drive");
  assert.equal(values(conflict).City, undefined);
  assert.deepEqual(conflict.conflicts[0].values, ["Addison", "Dallas"]);
  for (const ambiguous of ["100 Example Dr, Garland", "100 Example Dr, unknown locality", "100 Example Dr Garland TX 75041", "100 Example Dr, Apt 2, Garland, TX 75041", "100 Example Dr, Apt 2 TX 75041"]) {
    const result = buildSfrepReportExport({ documents: [subjectDoc(1, [candidate("subject_street_address", ambiguous)])] });
    assert.equal(result.fields.length, 0, ambiguous);
    assert.match(result.omitted[0].reason, /cannot be safely split/);
  }
});

test("street comparison preserves explicit secondary components without collapsing their punctuation", () => {
  for (const [first, second] of [
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

test("Pending MLS status gets its unmapped-listing reason without weakening placeholder protection", () => {
  const result = buildSfrepReportExport({ documents: [subjectDoc(1, [
    candidate("listing_status", "Pending"), candidate("subject_street_address", "Pending"),
  ], { document_type: "mls_sheet" })] });
  assert.equal(result.fields.length, 0);
  assert.match(result.omitted.find((entry) => entry.sourceField === "listing_status").reason, /composite UAD semantics/);
  assert.match(result.omitted.find((entry) => entry.sourceField === "subject_street_address").reason, /Blank, unknown/);
});
