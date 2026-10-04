import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDocument, buildDocumentFieldCandidates } from '../src/services/documentIntelligence.js';
import { buildUrarSubjectEvidence } from '../src/services/urarSubjectEvidence.js';
import { extractMlsListingPriceHistory } from '../src/services/mlsListingPriceHistory.js';
import { projectCustomSubjectDocuments } from '../src/services/customSubjectApplication.js';

// Synthetic records only. These model public report labels and column order;
// no names, addresses, IDs, or amounts from private appraisal PDFs are fixtures.
const title = '04/01/26, 9:18 PM Assignment Print | Dwelling Blocks';
const footer = (page, total = 4, id = '123456') => `https://app.dwellingblocks.com/assignments/${id}/print ${page}/${total}`;
const assignmentPages = () => [
  ['100 Sample Grove Drive, Exampleton, Dallas County, TX 75000', 'Ordered By', 'Example Appraisal Direct',
    'Assignee', 'Sample Appraiser', 'Contacts', 'Borrower', 'Taylor Example', 'taylor@example.test', '5550100',
    'Borrower', 'Morgan Sample', 'morgan@example.test', '5550101', 'Access Contact', 'Alex Access',
    'access@example.test', '5550102', 'Details', title, footer(1)].join('\n'),
  ['Rush', 'No', 'Report Type', 'Single Family Uniform', 'Residential Appraisal (FNMA', '1004)',
    'Loan Number', '999888777', 'FHA Case Number', 'Not set', 'Address To', 'Example Wholesale Mortgage',
    'Notes', 'Apr 1, 2026, 8:32 AM', 'Due Date', 'Apr 3, 2026, 11:59 PM', 'Appointment Date',
    'Mar 28, 2026, 4:15 PM', 'Inspection Status', 'Completed', 'ETA Report Date', 'Apr 3, 2026, 11:59 PM',
    'Appraisal Purpose', 'Purchase', 'Loan Type', 'Conventional', 'Loan Product', 'Conventional 30 Year',
    'Fixed', 'Property Type', 'Single Family Residence', 'Report is on track.', title, footer(2)].join('\n'),
  ['Completed Reports', title, footer(3)].join('\n'),
  ['Fees', 'Offered Amount $450.00', 'Pending Amount $450.00', title, footer(4)].join('\n'),
];
function extract(pages, requestedType = 'other') {
  const documentType = classifyDocument({ requestedType, pages });
  const evidence = buildUrarSubjectEvidence({ documentType, pages });
  const candidates = buildDocumentFieldCandidates({ documentType, pages, subjectEvidence: evidence });
  return { documentType, ...evidence, candidates };
}
const values = result => Object.fromEntries(result.candidates.map(candidate => [candidate.field_key, candidate.normalized_value]));

test('assignment print reads purpose, Address To, subject identity, and combined borrower contact cards', () => {
  const result = extract(assignmentPages()), fields = values(result);
  assert.equal(result.documentType, 'engagement_letter');
  assert.equal(result.source_layout, 'dwelling_blocks_assignment');
  assert.equal(fields.subject_property_address, '100 Sample Grove Drive, Exampleton, TX 75000');
  assert.equal(fields.county, 'Dallas');
  assert.equal(fields.borrower_name, 'Taylor Example / Morgan Sample');
  assert.equal(fields.assignment_type, 'purchase_transaction');
  assert.equal(fields.lender_client_name, 'Example Wholesale Mortgage');
  assert.equal(fields.lender_client_address, undefined, 'the printed lender name is not proof of a preset address');
  assert.equal(fields.property_type, 'Single Family Residence');
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.candidates.filter(candidate => candidate.field_key === 'borrower_name').length, 1);
  for (const candidate of result.candidates) {
    assert.equal(candidate.review_status, 'suggested');
    assert.ok(candidate.page_number === 1 || candidate.page_number === 2);
    assert.match(candidate.extraction_method, /assignment_print_/);
    assert.doesNotMatch(candidate.evidence_excerpt, /@example\.test|Alex Access/);
  }
});

test('a printed lender address remains evidence and is not replaced by a lender preset', () => {
  const pages = assignmentPages();
  pages[1] = pages[1].replace('Example Wholesale Mortgage\nNotes', 'Example Wholesale Mortgage\n20 Finance Road\nAustin, TX 78701\nNotes');
  assert.equal(values(extract(pages)).lender_client_address, '20 Finance Road, Austin, TX 78701');
});

for (const [label, alter] of [
  ['missing page', pages => pages.slice(0, 3)],
  ['different assignment record', pages => [pages[0], pages[1].replace('/123456/', '/777777/'), ...pages.slice(2)]],
  ['duplicate subject header', pages => [pages[0], pages[1] + '\n999 Other Lane, Othercity, Other County, TX 75001', ...pages.slice(2)]],
  ['invalid subject state', pages => [pages[0].replace('TX 75000', 'ZZ 75000'), ...pages.slice(1)]],
]) {
  test(`assignment print does not borrow identity from ${label}`, () => {
    const result = extract(alter(assignmentPages()), 'engagement_letter');
    assert.deepEqual(result.candidates, []);
    assert.ok(result.unresolved.some(item => item.reason.startsWith('assignment_print_')));
  });
}

test('an unreadable borrower card does not become a partial borrower group or an email address', () => {
  const pages = assignmentPages();
  pages[0] = pages[0].replace('Morgan Sample\nmorgan@example.test', 'morgan@example.test');
  const result = extract(pages);
  assert.equal(values(result).borrower_name, undefined);
  assert.equal(values(result).assignment_type, 'purchase_transaction');
  assert.ok(result.unresolved.some(item => item.reason === 'assignment_print_borrower_contacts_ambiguous'));
});

test('MLS dues and annual frequency stop at the adjacent association Phone label', () => {
  const result = extract(['HOA: Mandatory\nHOA Dues: $720/Annually Phone: 5550103'], 'mls_sheet');
  assert.equal(values(result).hoa_dues_amount, '720.00');
  assert.equal(values(result).hoa_frequency, 'per_year');
  assert.equal(values(result).pud, 'true');
  assert.equal(result.unresolved.some(item => item.field_key === 'hoa_dues_amount'), false);
  assert.match(result.candidates.find(candidate => candidate.field_key === 'hoa_dues_amount').evidence_excerpt, /Phone: 5550103/);
});

test('adjacent HOA contact fields do not turn Unknown into Yes or treat a phone as dues', () => {
  for (const status of ['None', 'Voluntary', 'Unknown']) {
    const fields = values(extract([`HOA: ${status}\nHOA Dues: Phone: 5550103`], 'mls_sheet'));
    assert.equal(fields.hoa_dues_amount, undefined);
    assert.equal(fields.hoa_frequency, undefined);
    assert.equal(fields.pud, status === 'Unknown' ? undefined : 'false');
  }
});

const cad = [
  'Residential Account #11111000000222222', 'Property Location (Current 2027)', 'Address: 100 SAMPLE GROVE DR',
  'Neighborhood: X-99', 'Mapsco: 11A (DALLAS)', 'Owner (Current 2027)', 'EXAMPLE AVERY',
  '900 POSTAL RD', 'ELSEWHERE, TEXAS 750009999', 'Legal Desc (Current 2027)', '1: SAMPLE GROVE',
  '2: BLK 2 LT 3', '3:', '4: INT202500000001 DD01012025 CO-DC', '5: 0000000000000 CODE00000',
  'Estimated Taxes (2025 Certified Values)', 'City School County College Hospital Special District',
  'Taxing Jurisdiction EXAMPLETON EXAMPLE ISD DALLAS COUNTY DALLAS COLLEGE PARKLAND HOSPITAL UNASSIGNED',
  '2025 Tax Rate 0.1 0.2 0.3 0.4 0.5 0', 'Total Estimated Taxes: $15,432.00',
  '10/01/26, 1:00 PM DCAD: Residential Acct Detail',
  'https://www.dallascad.org/AcctDetailRes.aspx?ID=11111000000222222 1/1',
].join('\n');

test('DCAD owner remains separate from mailing address and county uses its explicit tax column', () => {
  const result = extract([cad]);
  assert.equal(values(result).owner_name, 'EXAMPLE AVERY');
  assert.equal(values(result).county, 'Dallas');
  const county = result.candidates.find(candidate => candidate.field_key === 'county');
  assert.match(county.evidence_excerpt, /^Estimated Taxes/);
  assert.match(county.extraction_method, /dcad_tax_county_jurisdiction$/);
});

test('DCAD brand, Mapsco, or an unverified jurisdiction row alone cannot infer county', () => {
  for (const text of [cad.replace('City School County College Hospital Special District', 'Notes'),
    cad.replace('Estimated Taxes (2025 Certified Values)', 'Unverified table'),
    cad.replace('EXAMPLE ISD DALLAS COUNTY', 'EXAMPLE ISD OTHER COUNTY')]) {
    assert.equal(values(extract([text])).county, undefined);
  }
});

test('Realist latest Total Tax, not assessed value or year-over-year change, supplies taxes', () => {
  const page = ['100 Sample Grove Dr, Exampleton, TX 75000-1111, Dallas County Active Listing',
    'APN: 11-11100-000-222-2222 CLIP: 1000000000', 'OWNER INFORMATION', 'Owner Name Newer Owner',
    'LOCATION INFORMATION', 'Census Tract 123.45', 'TAX INFORMATION', 'ASSESSMENT & TAX',
    'Assessment Year 2026 2025 2024', 'Assessed Value - Total $700,000 $600,000 $500,000',
    'Tax Year Total Tax Change ($) Change (%)', '2023 $13,000', '2024 $14,000 $1,000 7.69%',
    '2025 $15,432 $1,432 10.23%', 'Jurisdiction Tax Amount Tax Type Tax Rate', 'Dallas County $999.00 Actual .2000',
    'CHARACTERISTICS', 'Property Details Courtesy of Example Reviewer, Example MLS Generated on: 10/01/26',
    'The data within this report is compiled by CoreLogic from public and private sources.'].join('\n');
  const fields = values(extract([page]));
  assert.equal(fields.tax_year, '2025');
  assert.equal(fields.tax_amount, '15432.00');
  assert.equal(fields.census_tract, '123.45');
  assert.equal(fields.county, 'Dallas');
  assert.equal(fields.owner_name, undefined, 'current Realist owners must not replace a separately reviewed CAD owner');
});

const historyHeader = 'Field Name Effective Dt Change Dt Chg Time Previous Value New Value DOM';
const history = [
  'Listing History from MLS', 'MLS #: QA90001 100 Sample Grove Dr Exampleton Prop Type: RLSE', 'Cancelled', historyHeader,
  'MlsStatus 04/14/26 04/16/26 11:44 PM HOLD CAN 6', 'MlsStatus 04/13/26 04/13/26 09:40 PM ACT HOLD 6',
  'MlsStatus 03/09/26 03/09/26 04:14 PM ACT',
  'MLS #: QA80001 100 Sample Grove Dr Exampleton Prop Type: RESI', 'Closed', historyHeader,
  'MlsStatus 04/11/26 04/13/26 09:45 PM PND SLD ($755,000) 281',
  'MlsStatus 03/16/26 03/23/26 11:29 PM AC PND 290',
  'MlsStatus 12/10/25 03/09/26 03:54 PM PND AC 201',
  'MlsStatus 12/10/25 12/10/25 05:16 PM ACT PND 201',
  'MlsStatus 05/04/25 05/19/25 09:08 AM CSN ACT', 'MlsStatus 05/04/25 05/04/25 09:42 PM CSN',
  'MLS #: QA70001 100 Sample Grove Dr Exampleton Prop Type: RESI', 'Closed', historyHeader,
  'MLSStatus 08/05/20 08/06/20 10:00 AM PND SLD ($440,000) 0',
  'MLSStatus 08/04/20 08/04/20 12:07 PM ACT PND 0', 'MLSStatus 08/04/20 08/04/20 12:05 PM ACT 0',
  '10/1/26, 2:05 PM Matrix', 'https://example.mlsmatrix.com/Matrix/Public/DisplayITQPopup.aspx 1/1',
].join('\n');

test('Matrix blank Previous Value origins and AC/HOLD transitions retain independent MLS histories', () => {
  const result = extractMlsListingPriceHistory([history]);
  assert.deepEqual(result.unresolved, []);
  const summaries = result.candidates.map(candidate => JSON.parse(candidate.normalized_value));
  assert.equal(summaries.length, 3);
  assert.deepEqual(summaries.map(summary => [summary.listing_id, summary.list_date, summary.coverage]),
    [['QA90001', '2026-03-09', 'complete'], ['QA80001', '2025-05-04', 'complete'], ['QA70001', '2020-08-04', 'complete']]);
  for (const summary of summaries) {
    assert.equal(summary.reduction_count, 0);
    assert.equal(summary.final_list_price, null, 'sold prices printed in status rows are not list prices');
    assert.deepEqual(summary.price_changes, []);
  }
});

test('a missing origin, incomplete pages, or noninitial lone status cannot prove no reductions', () => {
  const missing = extractMlsListingPriceHistory([history.replace('MlsStatus 05/04/25 05/04/25 09:42 PM CSN\n', '')]);
  assert.equal(JSON.parse(missing.candidates[1].normalized_value).coverage, 'partial');
  const partial = extractMlsListingPriceHistory([history.replace('aspx 1/1', 'aspx 1/2')]);
  assert.ok(partial.candidates.every(candidate => JSON.parse(candidate.normalized_value).coverage === 'partial'));
  for (const replacement of ['PND', 'SLD', 'ACT 12', 'UNRECOGNIZED']) {
    assert.deepEqual(extractMlsListingPriceHistory([history.replace('09:42 PM CSN', `09:42 PM ${replacement}`)]).candidates, []);
  }
});

test('multiple source MLS records still produce the exact template from the matching reviewed sale only', () => {
  const subject = { accountId: 'SYNTHETIC-INTAKE', address: '100 Sample Grove Dr', city: 'Exampleton',
    state: 'TX', postalCode: '75000', effectiveDate: '2026-04-01' };
  const inputs = [
    extract(['MLS#: QA80001\nSubject Address: 100 Sample Grove Dr, Exampleton, TX 75000\nList Date: 05/04/2025\nOriginal List Price: $765,000\nDays on Market: 281'], 'mls_sheet'),
    extract(['PROMULGATED BY THE TEXAS REAL ESTATE COMMISSION (TREC)\nONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)',
      'Contract Concerning 100 Sample Grove Dr, Exampleton, TX 75000 Page 2 of 2\nContract Date: 03/16/2026'], 'purchase_contract'),
    extract([history], 'mls_sheet'),
  ];
  const documents = inputs.map((input, index) => ({ id: index + 1, document_type: input.documentType,
    subject_context: subject, processing_status: 'reviewed', candidates: input.candidates.map((candidate, offset) => ({
      ...candidate, id: (index + 1) * 100 + offset + 1, document_id: index + 1,
      review_status: 'confirmed', confirmed_value: candidate.normalized_value,
    })) }));
  const projected = projectCustomSubjectDocuments(documents);
  assert.equal(projected.fields.find(field => field.key === 'listing_history_summary')?.value,
    'Subject was listed on 05/04/2025 for $765,000, no reductions in list price, on the market for 281 days, under current contract on 03/16/2026',
    JSON.stringify(projected.warnings));
});

test('TREC OCR amount and spaced closing-date labels remain reviewable source values', () => {
  const result = extract(['3. SALES PRICE:\nC. Sales Price (SUM of A @nd B) ......ccooiiiiiii eee 765,000.00\n4. LEASES:',
    '9. CLOSING:\nA. The closing of the sale will be on or before April 16     , 2026     , or within 7 days'], 'purchase_contract');
  assert.equal(values(result).contract_price, '765000.00');
  assert.equal(values(result).closing_date, '2026-04-16');
  assert.match(result.candidates.find(candidate => candidate.field_key === 'contract_price').extraction_method, /sales_price_line_ocr$/);
});

test('a dollarless blank or invalid Section 3C does not borrow a number from the next section', () => {
  for (const row of ['C. Sales Price (SUM of A @nd B) ..........', 'C. Sales Price (SUM of A @nd B) 765,00.00']) {
    assert.equal(values(extract([`${row}\n4. LEASES: $123,456.00`], 'purchase_contract')).contract_price, undefined);
  }
});

test('a complete effective date above its form baseline is extracted but signature dates and OCR fragments are not', () => {
  const form = 'EXECUTED the        day of          , 20    (Effective Date).\n(BROKER: FILL IN THE DATE OF FINAL ACCEPTANCE.)';
  const good = extract([`3/16/2026\n${form}\nBuyer signature 03/14/2026`], 'purchase_contract');
  assert.equal(values(good).contract_date, '2026-03-16');
  for (const prefix of ['', '026', '02/30/2026']) {
    assert.equal(values(extract([`${prefix}\n${form}\nBuyer signature 03/14/2026`], 'purchase_contract')).contract_date, undefined);
  }
});

test('contradictory main and addendum addresses remain a visible review-only observation, not subject identity', () => {
  const result = extract(['* ONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE) =',
    'Contract Concerning 100 sample grove, Dallas, Tx 75000 Page 2 of 3 11-04-2024',
    'ContractConcerning ~~ 100 sample grove, Dallas, Tx 75000 Page3of 3 11-04-2024',
    'ADDENDUM FOR BACK-UP CONTRACT\nTO CONTRACT CONCERNING THE PROPERTY AT\n100 Sample Grove Dr, Exampleton, TX 75000'], 'purchase_contract');
  const fields = values(result);
  assert.equal(fields.subject_property_address, undefined);
  assert.match(fields.contract_printed_subject_addresses, /Review required/);
  assert.match(fields.contract_printed_subject_addresses, /Main contract \(pages 2, 3\): 100 sample grove, Dallas, Tx 75000/);
  assert.match(fields.contract_printed_subject_addresses, /Addendum \(pages 4\): 100 Sample Grove Dr, Exampleton, TX 75000/);
  assert.match(result.candidates.find(candidate => candidate.field_key === 'contract_printed_subject_addresses').evidence_excerpt, /Page 4:/);
});

test('brokerage addresses and a standalone addendum do not create contract subject diagnostics', () => {
  for (const pages of [
    ['ONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)', 'Office address: 100 Broker Ln, Dallas, TX 75000',
      'Office address: 200 Broker Ln, Othercity, TX 75001'],
    ['TO CONTRACT CONCERNING THE PROPERTY AT\n100 Sample Grove Dr, Exampleton, TX 75000'],
  ]) assert.equal(values(extract(pages, 'purchase_contract')).contract_printed_subject_addresses, undefined);
});
