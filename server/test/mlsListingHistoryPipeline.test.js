import assert from 'node:assert/strict';
import test from 'node:test';
import PDFDocument from 'pdfkit';
import { extractPdfEvidence } from '../src/services/documentIntelligence.js';
import { projectCustomSubjectDocuments, mergeCustomSubjectApplication } from '../src/services/customSubjectApplication.js';
import { savedSfrepSubjectFields } from '../src/services/sfrepSavedReport.js';
import { buildSfrepReportExport } from '../src/services/sfrepReportExport.js';

const subject = { accountId: 'SYNTHETIC-HISTORY', address: '100 Example Dr', city: 'Exampleton',
  state: 'TX', postalCode: '75000', effectiveDate: '2026-07-31' };
const historyRows = [
  'ListPrice 06/10/26 06/10/26 02:30 PM $290,000 $285,000 40',
  'ListPrice 06/10/26 06/10/26 09:05 AM $300,000 $290,000 40',
];

async function syntheticPdf(pages) {
  const pdf = new PDFDocument({ size: 'LETTER', margin: 30 });
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    pdf.on('data', chunk => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
  for (let index = 0; index < pages.length; index += 1) {
    if (index) pdf.addPage();
    pdf.fontSize(8);
    for (const line of pages[index]) pdf.text(line);
  }
  pdf.end();
  return complete;
}

async function reviewedSources(rows = historyRows) {
  const documents = [];
  const inputs = [
    { type: 'mls_sheet', pages: [[
      'MLS#: QA123456', 'Subject Address: 100 Example Dr, Exampleton, TX 75000',
      'List Date: 05/01/2026', 'Original List Price: $300,000', 'Days on Market: 42',
    ]] },
    { type: 'purchase_contract', pages: [[
      'PROMULGATED BY THE TEXAS REAL ESTATE COMMISSION (TREC)',
      'ONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)',
    ], ['Contract Concerning 100 Example Dr, Exampleton, TX 75000 Page 2 of 2', 'Contract Date: 07/15/2026']] },
    { type: 'mls_sheet', pages: [[
      'Listing History from MLS', 'MLS #: QA123456 100 Example Dr Exampleton Prop Type: RESI', 'Pending',
      'Field Name Effective Dt Change Dt Chg Time Previous Value New Value DOM', ...rows,
      'MlsStatus 05/01/26 05/01/26 10:07 AM INC ACT',
      'https://example.mlsmatrix.com/Matrix/Public/DisplayITQPopup.aspx 1/1',
    ]] },
  ];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index], id = index + 1;
    const extracted = await extractPdfEvidence(await syntheticPdf(input.pages), {
      requestedType: input.type, fileName: `synthetic-${id}.pdf`,
    });
    assert.equal(extracted.document_type, input.type);
    assert.equal(extracted.page_count, input.pages.length);
    documents.push({ id, document_type: input.type, subject_context: subject, processing_status: 'reviewed',
      candidates: extracted.candidates.map((candidate, offset) => ({ ...candidate, id: id * 100 + offset + 1,
        document_id: id, review_status: 'confirmed', confirmed_value: candidate.normalized_value })) });
  }
  return documents;
}

test('printed same-day Matrix timestamps survive PDF extraction, reviewed HomeNode persistence, and SFREP export', async () => {
  const documents = await reviewedSources();
  const source = documents[2].candidates.find(candidate => candidate.field_key === 'listing_price_history');
  const parsed = JSON.parse(source.confirmed_value);
  assert.equal(parsed.coverage, 'complete');
  assert.deepEqual(parsed.price_changes.map(row => row.recorded_at), ['2026-06-10T09:05', '2026-06-10T14:30']);
  const projection = projectCustomSubjectDocuments(documents);
  const applied = mergeCustomSubjectApplication({ projection });
  const expected = 'Subject was listed on 05/01/2026 for $300,000, the price was reduced 2 times between 06/10/2026 and 06/10/2026 to $285,000, on the market for 42 days, under current contract on 07/15/2026';
  assert.equal(applied.subject.urar_subject?.listing_history_summary, expected, JSON.stringify(projection.warnings));
  const receipt = applied.evidence.fields.listing_history_summary;
  assert.equal(receipt.sourceEvidence.find(entry => entry.sourceField === 'listing_price_history').value, source.confirmed_value);
  const saved = { accountId: subject.accountId, assignmentFileId: 7001, assignmentRevision: 1,
    subject: { revision: 1, value: applied.subject }, assignmentDetails: applied.assignmentDetails,
    evidence: { revision: 1, value: applied.evidence }, documents };
  const canonical = savedSfrepSubjectFields(saved, { accountId: subject.accountId, assignmentFileId: 7001 });
  const exported = buildSfrepReportExport({ savedReportFields: canonical.fields, subjectOnly: true });
  assert.equal(exported.fields.find(field => field.fieldId === 'CurrentPriorListingDataSources')?.value, expected);
});

for (const [description, rows] of [
  ['missing printed time', [historyRows[0].replace('02:30 PM ', ''), historyRows[1]]],
  ['tied printed time', [historyRows[0].replace('02:30 PM', '09:05 AM'), historyRows[1]]],
  ['invalid printed calendar date', [historyRows[0].replace('06/10/26 02:30', '02/30/26 02:30'), historyRows[1]]],
  ['invalid printed time', [historyRows[0].replace('02:30 PM', '13:30 PM'), historyRows[1]]],
]) {
  test(`${description} cannot produce an automatically applied listing narrative`, async () => {
    const documents = await reviewedSources(rows);
    assert.equal(documents[2].candidates.some(candidate => candidate.field_key === 'listing_price_history'), false);
    const projection = projectCustomSubjectDocuments(documents);
    assert.equal(projection.fields.some(field => field.key === 'listing_history_summary'), false);
    assert.ok(projection.warnings.some(warning => warning.startsWith('Listing history:')));
  });
}
