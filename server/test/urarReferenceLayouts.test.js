import assert from "node:assert/strict";
import test from "node:test";
import { identifyUrarReferenceLayout, inspectUrarReferenceLayout, extractUrarReferenceLayout } from "../src/services/urarReferenceLayouts.js";

// Entirely synthetic records. Only the public report labels/layout are modeled.
const CAD_ACCOUNT = "11111000000222222";
const CAD = [
  "Home | Find Property | Contact Us",
  `Residential Account #${CAD_ACCOUNT}`,
  "Location Owner Legal Desc Value Main Improvement Additional Improvements Land Exemptions Estimated Taxes History",
  "Property Location (Current 2027)",
  "Address: 100 SAMPLE MEADOW LN",
  "Neighborhood: CODE-99",
  "Mapsco: 11A-A (DALLAS)",
  "DCAD Property Map",
  "2026 Appraisal Notice",
  "Owner (Current 2027)",
  "EXAMPLE AVERY &",
  "SAMPLE MORGAN",
  "900 POSTAL RD",
  "ELSEWHERE, TEXAS 750009999",
  "Multi-Owner (Current 2027)",
  "Owner Name Ownership %",
  "EXAMPLE AVERY & 50%",
  "SAMPLE MORGAN 50%",
  "Legal Desc (Current 2027)",
  "1: SUNLIT GROVE 7",
  "2: BLK 2 LT 3",
  "3:",
  "4: INT202500000001 DD01012025 CO-DC",
  "5: 0000000000000 CODE00000",
  "Deed Transfer Date: 01/02/2025",
  "Value",
  "2026 Certified Values",
  "Market Value: $200,000",
  "9/30/26, 1:00 PM DCAD: Residential Acct Detail",
  `https://www.dallascad.org/AcctDetailRes.aspx?ID=${CAD_ACCOUNT} 1/3`,
].join("\n");
const REALIST = [
  "100 Sample Meadow Ln, Exampleton, TX 75000-1111, Sample County Active Listing",
  "APN: 11-11100-000-222-2222 CLIP: 1000000000",
  "MLS List Date",
  "05/01/2026",
  "OWNER INFORMATION",
  "Owner Name Example Avery Tax Billing Zip+4 9999",
  "Tax Billing Address 900 Postal Rd Ownership Right Vesting",
  "Tax Billing City & State Elsewhere, TX No Mail Flag",
  "LOCATION INFORMATION",
  "Location City Exampleton Subdivision Sunlit Grove 07",
  "TAX INFORMATION",
  "Tax ID 11-11100-000-222-2222 Exemption(s)",
  "ASSESSMENT & TAX",
  "Assessment Year 2026 2025 2024",
  "Assessed Value - Total $200,000 $190,000 $180,000",
  "Tax Year Total Tax Change ($) Change (%)",
  "2023 $4,000",
  "2024 $4,200 $200 5.00%",
  "2025 $4,444 $244 5.81%",
  "Jurisdiction Tax Amount Tax Type Tax Rate",
  "Example County $300.00 Actual .2000",
  "Exampleton $1,000.00 Actual .5000",
  "Total Estimated Tax Rate 2.0000",
  "CHARACTERISTICS",
  "Land Use - Corelogic SFR Sewer Type Unknown",
  "Property Details Courtesy of Example Reviewer, Example MLS Generated on: 09/30/26",
  "The data within this report is compiled by CoreLogic from public and private sources. The data is deemed reliable, but is not guaranteed.",
  "Page 1/4",
].join("\n");
const extract = (sourceKind, pages) => extractUrarReferenceLayout({ sourceKind, pages: typeof pages === "string" ? [pages] : pages });
const values = result => Object.fromEntries(result.candidates.map(candidate => [candidate.field_key, candidate.normalized_value]));

test("complete source-layout signatures identify CAD/Realist without logo text or Realist branding", () => {
  assert.equal(identifyUrarReferenceLayout([CAD]), "cad");
  assert.equal(identifyUrarReferenceLayout([REALIST]), "realist");
  assert.equal(identifyUrarReferenceLayout([CAD, REALIST]), null);
  assert.deepEqual(extract("cad", [CAD, REALIST]).candidates, []);
});

test("incidental labels, disclaimers, and spoofed CAD domains cannot establish a layout", () => {
  for (const pages of [
    ["DCAD: Residential Acct Detail\nResidential Account #11111000000222222"],
    [CAD.replace("https://www.dallascad.org/", "https://www.dallascad.org.evil.example/")],
    [CAD.replace("DCAD: Residential Acct Detail", "This email refers to DCAD: Residential Acct Detail")],
    [REALIST.replace("LOCATION INFORMATION", "Location section quoted here")],
    [REALIST.replace("Property Details Courtesy of", "An email mentions Property Details Courtesy of")],
    ["Property Details\nCoreLogic public and private sources\nOWNER INFORMATION\nTAX INFORMATION"],
  ]) assert.equal(identifyUrarReferenceLayout(pages), null);
  assert.deepEqual(extract("cad", REALIST).candidates, []);
  assert.deepEqual(extract("realist", CAD).candidates, []);
});

test("reference inspection distinguishes unrecognized text from mixed and structurally incomplete input", () => {
  assert.deepEqual(inspectUrarReferenceLayout([CAD]), { sourceKind: "cad", unresolved: [] });
  assert.deepEqual(inspectUrarReferenceLayout([REALIST]), { sourceKind: "realist", unresolved: [] });
  assert.deepEqual(inspectUrarReferenceLayout(["REALIST\nTax Amount: $1234"]), { sourceKind: null, unresolved: [] });
  assert.deepEqual(inspectUrarReferenceLayout([CAD, REALIST]), { sourceKind: null, unresolved: [{ reason: "reference_layout_mixed_sources" }] });
  for (const pages of [[REALIST, null], [REALIST, "x".repeat(500_001)], [REALIST, "x".repeat(4_001)],
    [REALIST, "\uFFFD"], Array(251).fill(""), Array(9).fill(Array(200).fill("x".repeat(2500)).join("\n"))]) {
    const result = inspectUrarReferenceLayout(pages);
    assert.equal(result.sourceKind, null);
    assert.equal(result.unresolved.length, 1);
    assert.match(result.unresolved[0].reason, /^reference_layout_(?:page|text|line)_/);
  }
});

test("CAD current sections extract property, account, complete owners and numbered legal evidence", () => {
  const result = extract("cad", CAD), fields = values(result);
  assert.equal(fields.subject_property_address, "100 SAMPLE MEADOW LN");
  assert.equal(fields.assessor_parcel_number, CAD_ACCOUNT);
  assert.equal(fields.owner_name, "EXAMPLE AVERY &\nSAMPLE MORGAN");
  assert.equal(fields.neighborhood_name, "SUNLIT GROVE 7");
  assert.equal(fields.legal_description, "SUNLIT GROVE 7\nBLK 2 LT 3\nINT202500000001 DD01012025 CO-DC\n0000000000000 CODE00000");
  assert.equal(fields.county, undefined);
  assert.equal(fields.subject_city, undefined);
  assert.equal(fields.subject_zip, undefined);
  assert.ok(result.unresolved.some(item => item.reason === "cad_county_not_explicit_or_ambiguous"));
  assert.ok(result.candidates.every(candidate => candidate.page_number === 1 && candidate.review_status === "suggested"
    && candidate.source_kind === "cad" && candidate.extraction_method.startsWith("urar_subject_cad_dcad_")));
  const owner = result.candidates.find(candidate => candidate.field_key === "owner_name");
  assert.doesNotMatch(owner.evidence_excerpt, /POSTAL|ELSEWHERE|50%/);
  const legal = result.candidates.find(candidate => candidate.field_key === "legal_description");
  assert.match(legal.evidence_excerpt, /Legal Desc.*\n1: SUNLIT GROVE 7\n2: BLK 2 LT 3\n3:\n4:/);
  assert.doesNotMatch(legal.evidence_excerpt, /Deed Transfer|Market Value/);
});

test("CAD county requires its own explicit property-location label", () => {
  const fields = values(extract("cad", CAD.replace("Neighborhood: CODE-99", "County: Example County\nNeighborhood: CODE-99")));
  assert.equal(fields.county, "Example County");
});

test("CAD owner mailing address cannot fill a missing property location", () => {
  const result = extract("cad", CAD.replace("Address: 100 SAMPLE MEADOW LN", "Address: Unknown"));
  assert.equal(values(result).subject_property_address, undefined);
  assert.ok(result.unresolved.some(item => item.field_key === "subject_property_address"));
  assert.equal(values(result).owner_name, "EXAMPLE AVERY &\nSAMPLE MORGAN");
});

test("CAD owner placeholders, next sections and unidentified mailing boundaries are omitted", () => {
  for (const ownerBlock of [
    "Unknown\n900 POSTAL RD\nELSEWHERE, TEXAS 750009999",
    "EXAMPLE AVERY &\nUnknown\n900 POSTAL RD",
    "EXAMPLE AVERY &\nSAMPLE MORGAN",
    "900 POSTAL RD\nELSEWHERE, TEXAS 750009999",
    "EXAMPLE AVERY &\nValue\nSAMPLE MORGAN\n900 POSTAL RD",
  ]) {
    const pages = CAD.replace("EXAMPLE AVERY &\nSAMPLE MORGAN\n900 POSTAL RD\nELSEWHERE, TEXAS 750009999", ownerBlock);
    assert.equal(values(extract("cad", pages)).owner_name, undefined, ownerBlock);
  }
});

test("CAD property and mailing blocks never cross pages", () => {
  const pages = CAD.split("900 POSTAL RD");
  pages[1] = `900 POSTAL RD${pages[1]}`;
  assert.equal(values(extract("cad", pages)).owner_name, undefined);
});

test("CAD labeled mailing boundaries cannot become part of an owner name", () => {
  for (const label of ["Mailing Address", "Owner Mailing Address:", "Tax Billing Address", "Address:"]) {
    const result = extract("cad", CAD.replace("900 POSTAL RD", `${label}\n900 POSTAL RD`));
    assert.equal(values(result).owner_name, "EXAMPLE AVERY &\nSAMPLE MORGAN");
    assert.doesNotMatch(result.candidates.find(candidate => candidate.field_key === "owner_name").evidence_excerpt, /Mailing|Billing|Address/);
  }
});

test("CAD multi-record packets and account/footer mismatches fail closed", () => {
  for (const pages of [
    [CAD, CAD.replaceAll(CAD_ACCOUNT, "99999000000222222")],
    [CAD.replace(`ID=${CAD_ACCOUNT}`, "ID=99999000000222222")],
    [CAD, "Residential Account #UNKNOWN"],
    [CAD, "https://www.dallascad.org/AcctDetailRes.aspx?ID=UNKNOWN"],
    [CAD.replace("Owner (Current 2027)", "Property Location (Current 2027)\nAddress: 200 Other St\nOwner (Current 2027)")],
  ]) {
    const result = extract("cad", pages);
    assert.deepEqual(result.candidates, []);
    assert.ok(result.unresolved.some(item => item.reason === "cad_multiple_or_mismatched_records"));
  }
});

test("CAD truncated or ambiguous numbered legal descriptions never produce partial legal facts", () => {
  for (const page of [
    CAD.replace("5: 0000000000000 CODE00000\n", ""),
    CAD.replace("3:\n", "2: OTHER LEGAL ROW\n"),
    CAD.replace("2: BLK 2 LT 3\n", "2: BLK 2\nLT 3\n"),
  ]) {
    const result = extract("cad", page);
    assert.equal(values(result).legal_description, undefined);
    assert.equal(values(result).neighborhood_name, undefined);
    assert.ok(result.unresolved.some(item => item.reason === "cad_numbered_legal_incomplete_or_ambiguous"));
  }
});

test("CAD neighborhood is exact recorded subdivision text, never neighborhood code or an abstract", () => {
  for (const [first, second] of [["ABSTRACT 99 TRACT 2", "BLK 2 LT 3"], ["SUNLIT GROVE 7", "TRACT 2"]]) {
    const result = extract("cad", CAD.replace("1: SUNLIT GROVE 7", `1: ${first}`).replace("2: BLK 2 LT 3", `2: ${second}`));
    assert.equal(values(result).neighborhood_name, undefined);
    assert.ok(values(result).legal_description);
  }
});

test("Realist header is subject identity and latest complete total-tax row stays a paired source", () => {
  const result = extract("realist", REALIST), fields = values(result);
  assert.equal(fields.subject_property_address, "100 Sample Meadow Ln, Exampleton, TX 75000-1111");
  assert.equal(fields.subject_street_address, "100 Sample Meadow Ln");
  assert.equal(fields.subject_city, "Exampleton");
  assert.equal(fields.subject_state, "TX");
  assert.equal(fields.subject_zip, "75000-1111");
  assert.equal(fields.county, "Sample");
  assert.equal(fields.assessor_parcel_number, "11-11100-000-222-2222");
  assert.equal(fields.tax_year, "2025");
  assert.equal(fields.tax_amount, "4444.00");
  assert.equal(fields.owner_name, undefined);
  assert.equal(fields.list_date, undefined);
  const pair = result.candidates.filter(candidate => ["tax_year", "tax_amount"].includes(candidate.field_key));
  assert.equal(pair.length, 2);
  assert.equal(pair[0].evidence_excerpt, pair[1].evidence_excerpt);
  assert.equal(pair[0].page_number, pair[1].page_number);
  assert.match(pair[0].evidence_excerpt, /Tax Year Total Tax.*\n2025 \$4,444 \$244 5.81%$/);
  assert.equal(pair[0].extraction_method, pair[1].extraction_method);
  assert.ok(result.candidates.every(candidate => candidate.source_kind === "realist" && candidate.review_status === "suggested"));
  assert.deepEqual(result.unresolved, []);
});

test("Realist missing latest tax total never falls back silently to an older year or change amount", () => {
  for (const latest of ["2025", "2025 N/A -$8 -0.19%", "2025 $244 5.81%", "2025 -$8 -0.19%", "2025 Unknown"]) {
    const result = extract("realist", REALIST.replace("2025 $4,444 $244 5.81%", latest));
    assert.equal(values(result).tax_year, undefined, latest);
    assert.equal(values(result).tax_amount, undefined, latest);
    assert.ok(result.unresolved.some(item => item.reason === "realist_latest_tax_year_incomplete"));
  }
});

test("Realist tax selection uses the greatest explicit year, not row order or assessment year", () => {
  const result = extract("realist", REALIST.replace("2023 $4,000\n2024 $4,200 $200 5.00%\n2025 $4,444 $244 5.81%",
    "2025 $4,444 $244 5.81%\n2023 $4,000\n2024 $4,200 $200 5.00%"));
  assert.equal(values(result).tax_year, "2025");
  assert.equal(values(result).tax_amount, "4444.00");
});

test("Realist warns on incomplete prior-year rows while retaining a complete latest pair", () => {
  const result = extract("realist", REALIST.replace("2024 $4,200 $200 5.00%", "2024 N/A"));
  assert.equal(values(result).tax_amount, "4444.00");
  assert.ok(result.unresolved.some(item => item.reason === "realist_prior_tax_year_incomplete"));
});

test("Realist duplicate years, multiple tables and malformed rows cannot choose an arbitrary total", () => {
  for (const page of [
    REALIST.replace("2024 $4,200 $200 5.00%", "2025 $4,200 $200 5.00%"),
    `${REALIST}\nTax Year Total Tax Change ($) Change (%)\n2026 $999`,
    REALIST.replace("2024 $4,200 $200 5.00%", "Unassigned $4,200 $200 5.00%"),
  ]) {
    const result = extract("realist", page);
    assert.equal(values(result).tax_year, undefined);
    assert.equal(values(result).tax_amount, undefined);
    assert.ok(result.unresolved.length);
  }
});

test("Realist jurisdiction amounts and assessment values never substitute for the total-tax table", () => {
  const page = REALIST.replace(/Tax Year Total Tax Change \(\$\) Change \(%\)\n2023[^]*?(?=Jurisdiction)/, "");
  const result = extract("realist", page);
  assert.equal(values(result).tax_year, undefined);
  assert.equal(values(result).tax_amount, undefined);
  assert.ok(result.unresolved.some(item => item.reason === "realist_total_tax_table_missing"));
});

test("Realist tax rows on a separate unverified property page cannot borrow an earlier identity", () => {
  const table = "Tax Year Total Tax Change ($) Change (%)\n2023 $4,000\n2024 $4,200 $200 5.00%\n2025 $4,444 $244 5.81%";
  const result = extract("realist", [REALIST.replace(table, ""), `ASSESSMENT & TAX\n${table}\nCHARACTERISTICS`]);
  assert.equal(values(result).tax_amount, undefined);
  assert.equal(values(result).tax_year, undefined);
  assert.ok(result.unresolved.some(item => item.reason === "realist_tax_table_not_on_verified_property_page"));
});

test("Realist property identity cannot come from owner billing rows or mixed property packets", () => {
  for (const pages of [
    [REALIST.replace(/^.*\n/, "")],
    [REALIST.replace("APN: 11-11100-000-222-2222", "Tax Billing APN: 11-11100-000-222-2222")],
    [REALIST, REALIST.replace("100 Sample Meadow Ln", "200 Other Street")],
    [REALIST.replace("OWNER INFORMATION", "APN: 99-99900-000-222-2222\nOWNER INFORMATION")],
    [REALIST, "APN:\n99-99900-000-222-2222\nTax Year Total Tax Change ($) Change (%)\n2026 $999"],
    [REALIST, "APN: UNKNOWN PARCEL"],
    [REALIST, "200 Other Street, Othercity, TX UNKNOWN, Other County Active Listing"],
    [REALIST, "OWNER INFORMATION\nOwner Name Someone Else"],
  ]) {
    const result = extract("realist", pages);
    assert.deepEqual(result.candidates, []);
    assert.ok(result.unresolved.some(item => item.reason === "realist_property_identity_missing_or_multiple_records"));
  }
});

test("oversized, unreadable or mixed reference inputs fail closed without dropping conflicting pages", () => {
  for (const pages of [null, [CAD, null], Array(251).fill(CAD), [CAD, "x".repeat(500_001)], [CAD, "x".repeat(4_001)], [CAD, "\uFFFD"]]) {
    assert.equal(identifyUrarReferenceLayout(pages), null);
    const result = extractUrarReferenceLayout({ sourceKind: "cad", pages });
    assert.deepEqual(result.candidates, []);
    assert.ok(result.unresolved.length);
  }
});

test("reference adapters are deterministic and do not mutate supplied pages", () => {
  const pages = Object.freeze([REALIST]);
  assert.deepEqual(extract("realist", pages), extract("realist", pages));
  assert.equal(pages[0], REALIST);
});

test("verified reference layouts extract Census Tract only from the subject location section", () => {
  const cad = extract("cad", CAD.replace("Neighborhood: CODE-99", "Neighborhood: CODE-99\nCensus Tract: 0123.45"));
  assert.equal(values(cad).census_tract, "0123.45");
  const realist = extract("realist", REALIST.replace("TAX INFORMATION", "School District Example ISD Census Tract 123.45\nTAX INFORMATION"));
  assert.equal(values(realist).census_tract, "123.45");
  const candidate = realist.candidates.find(item => item.field_key === "census_tract");
  assert.equal(candidate.page_number, 1);
  assert.match(candidate.evidence_excerpt, /^LOCATION INFORMATION\nSchool District/);
  for (const content of ["Census Tract", "Census Tract 123.45.77", "Census Tract Unknown",
    "Census Tract 123.45\nCensus Tract 124.46", "Census Tract\nSchool District Code 1234"]) {
    const result = extract("realist", REALIST.replace("TAX INFORMATION", `${content}\nTAX INFORMATION`));
    assert.equal(values(result).census_tract, undefined, content);
    assert.ok(result.unresolved.some(item => item.reason === "reference_census_tract_missing_or_ambiguous"));
  }
  assert.equal(values(extract("realist", REALIST.replace("OWNER INFORMATION", "Census Tract 9999.99\nOWNER INFORMATION"))).census_tract, undefined);
});
