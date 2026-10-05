import assert from "node:assert/strict";
import test from "node:test";
import { buildUrarSubjectEvidence, identifyUrarSubjectSource, URAR_SUBJECT_FIELD_KEYS } from "../src/services/urarSubjectEvidence.js";
import { buildDocumentFieldCandidates } from "../src/services/documentIntelligence.js";
import { sfrepDocumentPropertyRole } from "../src/services/sfrepSubjectContext.js";
import { previewSfrepDocuments } from "../src/services/sfrepDocumentTransfer.js";

const extract = (documentType, ...pages) => buildUrarSubjectEvidence({ documentType, pages });
const field = (result, key) => result.candidates.find(candidate => candidate.field_key === key);
const value = (result, key) => field(result, key)?.normalized_value;

test("engagement extracts explicitly labeled Subject roles with existing candidate provenance", () => {
  const result = extract("engagement_letter", "APPRAISAL ENGAGEMENT LETTER", [
    "Borrower(s): Taylor Example & Morgan Example", "Assignment Purpose: Refinance",
    "Lender/Client: Example Lending", "Lender/Client Address: 20 Finance Road, Austin, TX 78701",
    "Subject Property Address: 123 Test Avenue, Dallas, TX 75201-1234", "Property Type: Single Family Residential",
  ].join("\n"));
  assert.equal(result.source_kind, "engagement_letter"); assert.equal(result.review_required, true);
  assert.equal(value(result, "borrower_name"), "Taylor Example & Morgan Example");
  assert.equal(value(result, "assignment_type"), "refinance");
  assert.equal(value(result, "lender_client_name"), "Example Lending");
  assert.equal(value(result, "lender_client_address"), "20 Finance Road, Austin, TX 78701");
  assert.equal(value(result, "subject_street_address"), "123 Test Avenue");
  assert.equal(value(result, "subject_city"), "Dallas"); assert.equal(value(result, "subject_state"), "TX");
  assert.equal(value(result, "subject_zip"), "75201-1234"); assert.equal(value(result, "property_type"), "Single Family Residential");
  for (const candidate of result.candidates) {
    assert.equal(candidate.page_number, 2); assert.equal(candidate.review_status, "suggested");
    assert.equal(candidate.source_kind, "engagement_letter");
    assert.ok(candidate.evidence_excerpt); assert.match(candidate.extraction_method, /^urar_subject_engagement_letter_/);
    assert.equal(candidate.confirmed_value, undefined);
  }
});

test("buyer/seller/applicant and generic engagement addresses never become borrower/owner/subject", () => {
  const result = extract("engagement_letter", "Buyer: Pat Buyer\nSeller: Sam Seller\nApplicant: Alex Applicant\nAddress: 99 Lender Road\nCity: Austin\nState: TX\nZip: 78701");
  assert.deepEqual(result.candidates, []);
  assert.ok(result.unresolved.some(item => item.field_key === "borrower_name" && item.reason === "label_not_found"));
});

test("same-page labeled continuations and full postal addresses preserve excerpts", () => {
  const result = extract("engagement_letter", "Borrower Name:\nTaylor Example\nProperty Address: 123 Test Avenue\nDallas, TX 75201");
  assert.equal(value(result, "borrower_name"), "Taylor Example");
  assert.equal(value(result, "subject_city"), "Dallas");
  assert.equal(field(result, "subject_city").evidence_excerpt, "Property Address: 123 Test Avenue\nDallas, TX 75201");
  const split = extract("engagement_letter", "Borrower Name:", "Unrelated Page Two Name");
  assert.equal(value(split, "borrower_name"), undefined);
  assert.ok(split.unresolved.some(item => item.reason === "labeled_value_missing"));
});

test("a following label is not swallowed as a missing value and ambiguous inline columns are refused", () => {
  const result = extract("engagement_letter", "Borrower:\nLender Name: Example Bank\nBorrower: Pat Example Lender Name: Other Bank");
  assert.equal(value(result, "borrower_name"), undefined); assert.equal(value(result, "lender_client_name"), "Example Bank");
  assert.ok(result.unresolved.some(item => item.reason === "ambiguous_labeled_value"));
});

test("MLS separate subject address labels, calendar date, dues and explicit PUD are suggestions", () => {
  const result = extract("mls_sheet", "Street Address: 123 Test Avenue | City: Dallas | State: tx | Zip: 75201\nList Date: 09/24/2026\nHOA Dues: $1,200 annually\nPUD: No");
  assert.equal(value(result, "subject_street_address"), "123 Test Avenue");
  assert.equal(value(result, "subject_state"), "TX"); assert.equal(value(result, "list_date"), "2026-09-24");
  assert.equal(value(result, "hoa_dues_amount"), "1200.00"); assert.equal(value(result, "hoa_frequency"), "per_year");
  assert.equal(value(result, "pud"), "false");
  assert.equal(value(extract("mls_sheet", "Planned Unit Development: Yes"), "pud"), "true");
});

test("HOA existence, mandatory membership and condo type never imply PUD", () => {
  const result = extract("mls_sheet", "HOA: Mandatory\nHOA Dues: $100/month\nProperty Type: Condominium\nPlanned Development: Yes\nPUD: Unknown");
  assert.equal(value(result, "hoa_dues_amount"), "100.00"); assert.equal(value(result, "hoa_frequency"), "per_month");
  assert.equal(value(result, "pud"), undefined); assert.ok(result.unresolved.some(item => item.field_key === "pud"));
});

test("separately labeled HOA frequency remains exact without annualizing", () => {
  const result = extract("mls_sheet", "Association Fee: $225.50\nAssociation Fee Frequency: Quarterly");
  assert.equal(value(result, "hoa_dues_amount"), "225.50"); assert.equal(value(result, "hoa_frequency"), "per_quarter");
  const bad = extract("mls_sheet", "HOA Dues: $50-$75\nHOA Frequency: sometimes");
  assert.deepEqual(bad.candidates, []);
});

test("unknown dates, invalid dates, state names, ZIPs and uncertain assignment purposes remain unresolved", () => {
  const result = extract("mls_sheet", "List Date: 02/30/2026\nState: ZZ\nZip: 7520\nPUD: Yes or No");
  assert.deepEqual(result.candidates, []);
  assert.equal(value(extract("mls_sheet", "List Date: 09/24/26"), "list_date"), undefined);
  assert.equal(value(extract("engagement_letter", "Assignment Type: Purchase or Refinance"), "assignment_type"), undefined);
});

test("adjacent explicitly labeled MLS columns retain only the validated list-date token", () => {
  const good = extract("mls_sheet", "LD: 08/01/2026 CD: 08/31/2026 DOM: 31");
  assert.equal(value(good, "list_date"), "2026-08-01");
  assert.equal(field(good, "list_date").raw_value, "08/01/2026");
  assert.equal(field(good, "list_date").evidence_excerpt, "LD: 08/01/2026 CD: 08/31/2026 DOM: 31");
  assert.equal(value(extract("mls_sheet", "LD: 02/30/2026 CD: 03/31/2026 DOM: 31"), "list_date"), undefined);
});

test("CAD Other upload requires textual source identity and extracts owner/APN/county/legal provenance", () => {
  const result = extract("other", "DALLAS CENTRAL APPRAISAL DISTRICT\nOwner Name: Example Holdings LLC\nAccount Number: 0000123400000\nCounty: Dallas\nLegal Description: Subdivision: TEST MEADOWS; Lot 12; Block A");
  assert.equal(result.source_kind, "cad");
  assert.equal(value(result, "owner_name"), "Example Holdings LLC");
  assert.equal(value(result, "assessor_parcel_number"), "0000123400000");
  assert.equal(value(result, "county"), "Dallas"); assert.equal(value(result, "neighborhood_name"), "TEST MEADOWS");
  assert.match(field(result, "neighborhood_name").extraction_method, /legal_subdivision_label$/);
  assert.match(field(result, "neighborhood_name").evidence_excerpt, /^Legal Description:/);
});

test("unlabeled lot/block legal descriptions and marketing neighborhoods do not become subdivision facts", () => {
  const result = extract("other", "COLLIN APPRAISAL DISTRICT\nLegal Description: LOT 1 BLK A SUNRISE ESTATES\nNeighborhood: Luxury Northside\nSubdivision: Advertising Name\nSeller: Sam Seller");
  assert.equal(value(result, "neighborhood_name"), undefined); assert.equal(value(result, "owner_name"), undefined);
  assert.ok(result.unresolved.some(item => item.reason === "legal_subdivision_not_explicit"));
});

test("CAD recorded subdivision first lines preserve exact phase digits and complete legal excerpts", () => {
  for (const [legal, name] of [
    ["MONICA PARK 4\nBLK 17 LT 36\nINT202500250251 DD01012025", "MONICA PARK 4"],
    ["HOLIDAY PARK NORTH 6\nBLK F LOT 15", "HOLIDAY PARK NORTH 6"],
    ["MONICA PARK 4 BLK 17 LT 36", "MONICA PARK 4"],
    ["TEST ADDITION LOT 12 BLOCK A", "TEST ADDITION"],
  ]) {
    const result = extract("other", `DALLAS APPRAISAL DISTRICT\nLegal Description:\n${legal}\nOwner: Sample Owner`);
    assert.equal(value(result, "legal_description"), legal);
    assert.equal(value(result, "neighborhood_name"), name);
    assert.equal(field(result, "neighborhood_name").evidence_excerpt, `Legal Description:\n${legal}`);
    assert.equal(field(result, "neighborhood_name").extraction_method, "urar_subject_cad_legal_subdivision_lot_block");
    assert.equal(value(result, "owner_name"), "Sample Owner");
  }
});

test("abstract, tract, metes-and-bounds, owner and street text are not subdivision names", () => {
  for (const name of ["ABSTRACT 1442", "TRACT A", "J SMITH SURVEY", "BEING 1.5 ACRES", "METES AND BOUNDS", "OWNER SAMPLE NAME", "123 MAIN STREET", "A-1122", "PARCEL A"]) {
    const result = extract("other", `DALLAS APPRAISAL DISTRICT\nLegal Description: ${name}\nBLK 17 LT 36`);
    assert.equal(value(result, "neighborhood_name"), undefined, name);
  }
});

test("legal continuation never crosses pages and next labeled field is not swallowed", () => {
  const result = extract("other", "DALLAS APPRAISAL DISTRICT\nLegal Description: MONICA PARK 4", "BLK 17 LT 36\nOwner: Sample Owner");
  assert.equal(value(result, "neighborhood_name"), undefined);
  assert.equal(value(result, "legal_description"), "MONICA PARK 4");
  const nested = extract("other", "DALLAS APPRAISAL DISTRICT\nLegal Description:\nSubdivision: MONICA PARK 4; Lot 1; Block A\nOwner: Sample Owner");
  assert.equal(value(nested, "neighborhood_name"), "MONICA PARK 4");
});

test("legal capture limits report unresolved text instead of emitting a truncated legal description", () => {
  const result = extract("other", `DALLAS APPRAISAL DISTRICT\nLegal Description: MONICA PARK 4\nBLK 17 LT 36\n${Array.from({ length: 15 }, (_, i) => `INSTRUMENT ${i}`).join("\n")}`);
  assert.equal(value(result, "legal_description"), undefined); assert.equal(value(result, "neighborhood_name"), undefined);
  assert.ok(result.unresolved.some(item => item.reason === "legal_text_limit_exceeded"));
});

test("Realist Other upload extracts actual tax year and real estate tax amount, never assessment values", () => {
  const result = extract("other", "CoreLogic Realist Property Detail Report\nTax Year: 2025\nReal Estate Taxes: $6,123.45\nAssessed Value: $425,000\nTaxable Value: $350,000\nAssessment Year: 2026");
  assert.equal(result.source_kind, "realist"); assert.equal(value(result, "tax_year"), "2025");
  assert.equal(value(result, "tax_amount"), "6123.45");
  assert.equal(result.candidates.length, 2);
  const assessmentOnly = extract("other", "REALIST\nAssessed Value: $425,000\nAssessment Year: 2026\nEstimated Taxes: $7,000");
  assert.deepEqual(assessmentOnly.candidates, []);
});

test("CAD and Realist emit only explicitly qualified subject/situs addresses for identity checks", () => {
  for (const heading of ["DALLAS APPRAISAL DISTRICT", "REALIST PROPERTY DETAIL"]) {
    const result = extract("other", `${heading}\nSitus Address: 123 Test Avenue\nDallas, TX 75201\nAPN: 000012345\nOwner Mailing Address: 456 Other Road\nMailing City: Austin\nMailing State: TX\nMailing Zip: 78701\nAddress: 999 Generic Street\nCity: Houston\nState: TX\nZip: 77001`);
    assert.equal(value(result, "subject_property_address"), "123 Test Avenue, Dallas, TX 75201");
    assert.equal(value(result, "subject_city"), "Dallas"); assert.equal(value(result, "subject_zip"), "75201");
    assert.equal(value(result, "assessor_parcel_number"), "000012345");
    assert.deepEqual(result.conflicts, []);
  }
  const mailingOnly = extract("other", "REALIST\nOwner Mailing Address: 456 Other Road\nMailing City: Austin\nCity: Austin\nState: TX\nZip: 78701");
  assert.deepEqual(mailingOnly.candidates, []);
});

test("CAD/Realist qualified address components preserve exact evidence without combining owner mailing fields", () => {
  const result = extract("other", "REALIST\nProperty Street Address: 123 Test Avenue\nSitus City: Dallas\nProperty State: TX\nSitus Zip Code: 75201\nOwner Address: 456 Other Road\nLoan Account Number: 999999");
  assert.equal(value(result, "subject_street_address"), "123 Test Avenue");
  assert.equal(value(result, "subject_city"), "Dallas"); assert.equal(value(result, "subject_state"), "TX");
  assert.equal(value(result, "subject_zip"), "75201"); assert.equal(value(result, "assessor_parcel_number"), undefined);
});

test("explicit reference source classifier survives incidental MLS identifiers without filename trust", () => {
  assert.equal(identifyUrarSubjectSource({ documentType: "other", pages: ["REALIST PROPERTY DETAIL\nMLS # 1234567\nDOM: 12"] }), "realist");
  assert.equal(identifyUrarSubjectSource({ documentType: "other", pages: ["DALLAS APPRAISAL DISTRICT\nMLS # 1234567"] }), "cad");
  assert.equal(identifyUrarSubjectSource({ documentType: "other", pages: ["MLS # 1234567"] }), null);
  assert.equal(identifyUrarSubjectSource({ documentType: "other", pages: ["REALIST\nDALLAS APPRAISAL DISTRICT"] }), null);
  assert.ok(Object.isFrozen(URAR_SUBJECT_FIELD_KEYS));
  for (const key of ["subject_city", "assessor_parcel_number", "neighborhood_name", "pud", "tax_amount"]) assert.ok(URAR_SUBJECT_FIELD_KEYS.includes(key));
  assert.equal(URAR_SUBJECT_FIELD_KEYS.includes("buyer_name"), false);
});

test("unidentified, mixed-source and unsupported document types never gain source-specific candidates", () => {
  for (const result of [extract("other", "Owner: Example Owner\nTax Year: 2025"),
    extract("other", "REALIST\nDALLAS APPRAISAL DISTRICT\nTax Year: 2025\nOwner: Example Owner"),
    extract("purchase_contract", "Borrower: Pat Example\nOwner: Sam Example")]) {
    assert.deepEqual(result.candidates, []); assert.equal(result.source_kind, null);
  }
  const identified = buildUrarSubjectEvidence({ documentType: "other", sourceKind: "cad", pages: ["Owner: Example Owner"] });
  assert.equal(value(identified, "owner_name"), "Example Owner");
  const filenameOnly = buildUrarSubjectEvidence({ documentType: "other", fileName: "Realist.pdf", pages: ["Tax Year: 2025"] });
  assert.deepEqual(filenameOnly.candidates, []);
});

test("conflicting values on different pages are retained as alternatives and flagged for review", () => {
  const result = extract("other", "REALIST\nTax Year: 2024\nReal Estate Taxes: $5,000", "Tax Year: 2025\nReal Estate Taxes: $6,000");
  assert.equal(result.candidates.length, 4); assert.equal(result.conflicts.length, 2);
  assert.deepEqual(result.conflicts.find(item => item.field_key === "tax_year"), { field_key: "tax_year", values: ["2024", "2025"], page_numbers: [1, 2] });
  assert.ok(result.candidates.every(candidate => candidate.review_status === "suggested"));
});

test("equivalent repeated values do not create conflicts and duplicates within a page are collapsed", () => {
  const result = extract("mls_sheet", "HOA Dues: $100\nHOA Dues: $100.00", "HOA Dues: 100.00");
  assert.equal(result.candidates.length, 2); assert.deepEqual(result.conflicts, []);
});

test("unreadable, blank, unknown, truncated and oversized input cannot invent candidates", () => {
  for (const pages of [[], [null], [""], ["Borrower: Unknown"], ["Borrower: N/A"], [`Borrower: ${"a".repeat(4_001)}`]]) {
    const result = buildUrarSubjectEvidence({ documentType: "engagement_letter", pages });
    assert.deepEqual(result.candidates, []); assert.equal(result.review_required, true); assert.ok(result.unresolved.length);
  }
  const oversize = buildUrarSubjectEvidence({ documentType: "engagement_letter", pages: [`Borrower: Pat Example\n${"x".repeat(500_000)}`] });
  assert.deepEqual(oversize.candidates, []); assert.ok(oversize.unresolved.some(item => item.reason === "text_limit_exceeded"));
});

test("full address and explicitly different components produce a conflict, never silent precedence", () => {
  const result = extract("mls_sheet", "Property Address: 123 Test Avenue, Dallas, TX 75201\nCity: Austin");
  assert.deepEqual(result.conflicts.find(item => item.field_key === "subject_city")?.values, ["Dallas", "Austin"]);
});

test("Realist standalone labels retain page provenance and do not require punctuation", () => {
  const result = extract("other", "REALIST PROPERTY REPORT", [
    "Property Address", "100 Example Dr", "Garland, TX 75041", "APN #", "00001234567890000",
    "Tax Year", "2025", "Total Taxes", "$4,321.50", "Situs County", "Dallas",
  ].join("\n"));
  assert.equal(value(result, "subject_property_address"), "100 Example Dr, Garland, TX 75041");
  assert.equal(value(result, "assessor_parcel_number"), "00001234567890000");
  assert.equal(value(result, "tax_year"), "2025"); assert.equal(value(result, "tax_amount"), "4321.50");
  assert.equal(value(result, "county"), "Dallas");
  assert.equal(field(result, "subject_property_address").evidence_excerpt, "Property Address\n100 Example Dr\nGarland, TX 75041");
  assert.ok(result.candidates.every(candidate => candidate.page_number === 2 && candidate.review_status === "suggested"));
});

test("missing standalone values never absorb the next recognized label or owner-mailing section", () => {
  const result = extract("other", ["REALIST", "Property Address", "APN", "00001234567890000",
    "Property Street Address", "Owner Mailing Address", "999 Other Street", "Austin, TX 78701",
    "Tax Year", "Total Taxes", "$4,321.50", "Property County", "Mailing County", "Collin"].join("\n"));
  assert.equal(value(result, "subject_property_address"), undefined); assert.equal(value(result, "subject_street_address"), undefined);
  assert.equal(value(result, "tax_year"), undefined); assert.equal(value(result, "county"), undefined);
  assert.equal(value(result, "assessor_parcel_number"), "00001234567890000"); assert.equal(value(result, "tax_amount"), "4321.50");
  assert.ok(result.unresolved.filter(item => item.reason === "labeled_value_missing").length >= 4);
  assert.equal(value(extract("other", "REALIST\nProperty Address", "100 Example Dr, Garland, TX 75041"), "subject_property_address"), undefined);
});

test("Subject placeholders and non-address messages remain unresolved even with a locality continuation", () => {
  for (const placeholder of ["TBD", "T.B.D.", "Unknown", "Not Available", "Pending", "To be determined", "Unassigned", "No address assigned", "APN", "0 TBD"]) {
    const result = extract("other", `REALIST\nProperty Address: ${placeholder}\nGarland, TX 75041\nAPN: 00001234567890000`);
    assert.equal(value(result, "subject_property_address"), undefined, placeholder);
    assert.equal(value(result, "subject_street_address"), undefined, placeholder);
    assert.ok(result.unresolved.some(item => item.field_key === "subject_property_address" && item.reason === "labeled_value_unparseable"), placeholder);
  }
  assert.equal(value(extract("other", "REALIST\nSitus Street Address\nTBD\nProperty County: Unknown"), "subject_street_address"), undefined);
});

test("standalone CAD legal blocks stop at subsequent bare labels and retain exact recorded subdivision", () => {
  const result = extract("other", "DALLAS APPRAISAL DISTRICT\nLegal Description\nMONICA PARK 4\nBLK 17 LT 36\nOwner Name\nExample Owner\nProperty Address\n100 Example Dr, Garland, TX 75041");
  assert.equal(value(result, "legal_description"), "MONICA PARK 4\nBLK 17 LT 36");
  assert.equal(value(result, "neighborhood_name"), "MONICA PARK 4"); assert.equal(value(result, "owner_name"), "Example Owner");
});

test("Realist county requires a property-qualified label and never consumes mailing county", () => {
  const result = extract("other", "REALIST\nProperty County: Dallas\nMailing County: Collin\nCounty: Tarrant");
  assert.equal(value(result, "county"), "Dallas"); assert.deepEqual(result.conflicts, []);
  assert.equal(value(extract("other", "REALIST\nCounty\nCollin\nMailing County\nTarrant"), "county"), undefined);
});

test("standalone Realist identity permits confirmed taxes but never supplies CAD street identity", () => {
  const context = { accountId: "00001234567890000", address: "100 Example Dr", city: "Garland", postalCode: "75041" };
  for (const address of ["Property Address\n100 Example Dr, Garland, TX 75041", "Property Address: TBD"]) {
    const candidates = buildDocumentFieldCandidates({ documentType: "other", pages: [`REALIST\n${address}\nAPN\n00001234567890000\nTax Year\n2025\nTotal Taxes\n$4,321.50`] });
    const document = { id: 1, document_type: "other", processing_status: "reviewed", file_size_bytes: 100, subject_context: context,
      candidates: candidates.map((candidate, index) => ({ ...candidate, id: index + 1, document_id: 1, review_status: "confirmed", confirmed_value: candidate.normalized_value })) };
    document.property_role = sfrepDocumentPropertyRole(document);
    assert.equal(document.property_role, "subject");
    const preview = previewSfrepDocuments([document], { accountId: context.accountId, assignmentFileId: 1, includeDocuments: false, formId: "FNMA-1004-0911" });
    assert.equal(preview.fields.find(item => item.fieldId === "RealEstateTaxAmount")?.value, "4322");
    assert.equal(preview.fields.find(item => item.fieldId === "RealEstateTaxAmount")?.sourceValue, "4321.50");
    assert.equal(preview.fields.find(item => item.fieldId === "StreetAddress")?.value, undefined);
  }
});

test("single-listing MLS print heading supplies exact subject identity without using broker addresses", () => {
  const result = extract("mls_sheet", [
    "100 Example Drive, Garland, Texas 75041",
    "MLS#: 12345678 Active Option Contract 100 Example Drive Garland, TX 75041-1234 LP: $295,000",
    "Property Type: Residential SubType: Single Family OLP: $295,000",
    "Parcel ID: 00001234567890000 Plan Dvlpm:",
    "HOA: None HOA Co:",
    "LO Addr: 999 Other Road Dallas, Texas 75225",
  ].join("\n"));
  assert.equal(value(result, "subject_property_address"), "100 Example Drive, Garland, TX 75041");
  assert.equal(value(result, "subject_city"), "Garland");
  assert.equal(value(result, "subject_state"), "TX");
  assert.equal(value(result, "subject_zip"), "75041");
  assert.equal(value(result, "assessor_parcel_number"), "00001234567890000");
  assert.equal(value(result, "pud"), "false");
  assert.match(field(result, "pud").extraction_method, /hoa_workflow_proxy$/);
  assert.equal(value(result, "hoa_dues_amount"), undefined);
  assert.ok(field(result, "subject_property_address").evidence_excerpt.includes("MLS#: 12345678"));
  assert.ok(result.candidates.every(candidate => candidate.page_number === 1 && candidate.review_status === "suggested"));
});

test("MLS heading identity is not guessed from later office addresses, unrelated PDFs, or multiple listings", () => {
  const heading = "100 Example Drive, Garland, TX 75041\nMLS#: 12345678 Active LP: $295,000\nParcel ID: 00001234567890000 Plan Dvlpm:";
  const multiple = extract("mls_sheet", heading, heading.replaceAll("12345678", "87654321"));
  assert.equal(value(multiple, "subject_property_address"), undefined);
  assert.equal(value(multiple, "assessor_parcel_number"), undefined);
  assert.ok(multiple.unresolved.some(item => item.reason === "multiple_mls_listing_identities"));
  for (const pages of [
    ["MLS#: 12345678 Active LP: $295,000\nLO Addr: 999 Other Rd, Dallas, TX 75225"],
    ["A report about available listings\n100 Example Dr, Garland, TX 75041"],
    ["MLS#: 12345678 Active LP: $295,000", "100 Example Dr, Garland, TX 75041"],
  ]) assert.equal(value(extract("mls_sheet", ...pages), "subject_property_address"), undefined);
  assert.equal(value(extract("other", heading), "subject_property_address"), undefined);
  const letterhead = extract("mls_sheet", "Example Brokerage\n999 Broker Road, Garland, TX 75041\nMLS#: 12345678 Active 100 Example Drive Garland, TX 75041 LP: $295,000");
  assert.equal(value(letterhead, "subject_property_address"), undefined);
  const differingExtendedZip = extract("mls_sheet", "100 Example Drive, Garland, TX 75041-1111\nMLS#: 12345678 Active 100 Example Drive Garland, TX 75041-2222 LP: $295,000");
  assert.equal(value(differingExtendedZip, "subject_property_address"), undefined);
  const multiLabeled = extract("mls_sheet", `${heading}\nProperty Address: 100 Example Dr, Garland, TX 75041`, "MLS#: 87654321 Active LP: $123,000\nList Date: 09/01/2026");
  assert.deepEqual(multiLabeled.candidates, []);
});

test("multi-listing guard recognizes every supported MLS and Listing label with optional delimiters", () => {
  const first = "Property Address: 100 Example Dr, Garland, TX 75041\nMLS#: 12345678\nList Date: 09/01/2026";
  for (const label of ["MLS#", "MLS #", "MLS No", "MLS No.", "MLS Number", "MLS ID",
    "Listing #", "Listing No", "Listing No.", "Listing Number", "Listing ID"]) {
    for (const delimiter of [" ", ": ", "= ", "# ", "- "]) {
      const second = `${label}${delimiter}87654321\nList Date: 09/24/2026`;
      for (const pages of [[first, second], [second, first]]) {
        const result = extract("mls_sheet", ...pages);
        assert.deepEqual(result.candidates, [], `${label}${delimiter}`);
        assert.ok(result.unresolved.some(item => item.reason === "multiple_mls_listing_identities"), `${label}${delimiter}`);
      }
    }
  }
});

test("inline, undelimited hash, alphanumeric and same-page standalone listing IDs cannot mix records", () => {
  for (const identifiers of [
    "NTREIS Report MLS No. AB-123 Status: Active\nMLS ID=CD-456",
    "MLS#12345678\nListing#87654321",
    "MLS No: AB-123 | Listing Number: CD-456",
    "MLS No: AB-123; Listing ID: CD-456",
    "MLS#\n12345678\nListing ID:\n87654321",
  ]) {
    const result = extract("mls_sheet", `Property Address: 100 Example Dr, Garland, TX 75041\n${identifiers}\nList Date: 09/24/2026`);
    assert.deepEqual(result.candidates, [], identifiers);
    assert.ok(result.unresolved.some(item => item.reason === "multiple_mls_listing_identities"), identifiers);
  }
});

test("equivalent listing IDs deduplicate case-insensitively without weakening Matrix identity rules", () => {
  const result = extract("mls_sheet", "Property Address: 100 Example Dr, Garland, TX 75041\nMLS No. ab-123\nListing ID=AB-123\nMLS#\nAb-123\nList Date: 09/24/2026");
  assert.equal(value(result, "subject_property_address"), "100 Example Dr, Garland, TX 75041");
  assert.equal(value(result, "list_date"), "2026-09-24");
  assert.equal(result.unresolved.some(item => /mls_listing_identit/.test(item.reason)), false);
  const noMatrixHeading = extract("mls_sheet", "100 Example Dr, Garland, TX 75041\nMLS No. 12345678 Active 100 Example Dr Garland, TX 75041 LP: $200,000\nList Date: 09/24/2026");
  assert.equal(value(noMatrixHeading, "subject_property_address"), undefined);
});

test("a blank explicitly qualified Matrix lease reference is not another primary listing", () => {
  const first = "Property Address: 100 Example Dr, Garland, TX 75041\nMLS#: 12345678";
  const result = extract("mls_sheet", `${first}\nCountry: United States Lse MLS#:`, "List Date: 09/24/2026");
  assert.equal(value(result, "list_date"), "2026-09-24");
  assert.equal(result.unresolved.some(item => /mls_listing_identit/.test(item.reason)), false);
  assert.deepEqual(extract("mls_sheet", `${first}\nCountry: United States Lse MLS#: UNKNOWN\nList Date: 09/24/2026`).candidates, []);
});

test("recognized missing or malformed listing IDs fail closed rather than matching a token prefix", () => {
  const first = "Property Address: 100 Example Dr, Garland, TX 75041\nMLS#: 12345678";
  for (const token of ["UNKNOWN", "Unavailable", "Not Available", "PENDING", "TBD", "N/A", "", "AB", "A".repeat(46),
    "12345678/OTHER", "12345678_OTHER", "12345678.OTHER", "12345678@OTHER", "---"]) {
    const second = `MLS#: ${token}\nList Date: 09/24/2026`;
    for (const pages of [[first, second], [second, first], [`${first}\n${second}`]]) {
      const result = extract("mls_sheet", ...pages);
      assert.deepEqual(result.candidates, [], token);
      assert.ok(result.unresolved.some(item => item.reason === "ambiguous_mls_listing_identity"), token);
    }
  }
});

test("standalone listing labels never borrow an ID from a different page or another field", () => {
  for (const pages of [
    ["Property Address: 100 Example Dr, Garland, TX 75041\nMLS No.", "12345678\nList Date: 09/24/2026"],
    ["Property Address: 100 Example Dr, Garland, TX 75041\nMLS ID:\nList Date: 09/24/2026"],
  ]) {
    const result = extract("mls_sheet", ...pages);
    assert.deepEqual(result.candidates, []);
    assert.ok(result.unresolved.some(item => item.reason === "ambiguous_mls_listing_identity"));
  }
});

test("MLS guard does not invent identifiers from partial label words or unrelated digits", () => {
  for (const incidental of ["XMLS No: 87654321", "MLS Numbered: 87654321", "Listing Identifier: 87654321",
    "MLS Nozzle: 87654321", "AMLS#: 87654321", "Parcel ID: 87654321", "Tax Year: 2025"]) {
    const result = extract("mls_sheet", `Property Address: 100 Example Dr, Garland, TX 75041\nMLS#: 12345678\n${incidental}\nList Date: 09/24/2026`);
    assert.equal(value(result, "list_date"), "2026-09-24", incidental);
    assert.equal(result.unresolved.some(item => /mls_listing_identit/.test(item.reason)), false, incidental);
  }
});

test("a Realist jurisdiction amount never becomes the total property tax", () => {
  const result = extract("other", "REALIST\nProperty Address: 100 Example Dr, Garland, TX 75041\nAPN: 00001234567890000\nTax Jurisdiction: City of Example\nTax Amount: $1,500.00");
  assert.equal(value(result, "tax_amount"), undefined);
  assert.ok(result.unresolved.some(item => item.reason === "jurisdiction_tax_is_not_property_total"));
});

test("invalid or mixed reference inputs cannot fall back to apparently valid first-page fields", () => {
  const firstPage = "REALIST PROPERTY REPORT\nProperty Address: 100 Example Dr, Garland, TX 75041\nTax Year: 2025\nTax Amount: $1,234";
  for (const pages of [[firstPage, "x".repeat(500_001)], [firstPage, null], [firstPage, "\uFFFD"]]) {
    const result = extract("other", ...pages);
    assert.deepEqual(result.candidates, []);
    assert.ok(result.unresolved.some(item => item.reason === "source_input_incomplete"));
    assert.deepEqual(buildDocumentFieldCandidates({ documentType: "other", pages }), []);
  }
  const cad = "Residential Account #00001234567890000\nProperty Location (Current 2027)\nDCAD: Residential Acct Detail\nhttps://www.dallascad.org/AcctDetailRes.aspx?ID=00001234567890000";
  const realist = `${firstPage}\nOWNER INFORMATION\nLOCATION INFORMATION\nTAX INFORMATION\nASSESSMENT & TAX\nProperty Details Courtesy of QA Reviewer Generated on: 10/02/26\nThe data within this report is compiled by CoreLogic from public and private sources.`;
  const mixed = extract("other", cad, realist);
  assert.deepEqual(mixed.candidates, []);
  assert.ok(mixed.unresolved.some(item => item.reason === "reference_layout_mixed_sources"));
  assert.deepEqual(buildDocumentFieldCandidates({ documentType: "other", pages: [cad, realist] }), []);
});
