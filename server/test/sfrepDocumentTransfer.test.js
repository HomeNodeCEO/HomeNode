import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sfrepTransferInput, readSfrepDocuments, previewSfrepDocuments, packageSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';
import { mergeCustomSubjectApplication, projectCustomSubjectDocuments } from '../src/services/customSubjectApplication.js';

const content = Buffer.from('%PDF-1.7\nSynthetic SFREP transfer fixture\n%%EOF');
const checksum = createHash('sha256').update(content).digest('hex');
const source = () => ({ id: 2, account_id: 'account-1', assignment_file_id: 14, document_type: 'engagement_letter',
  title: 'Engagement', file_name: 'engagement.pdf', content_type: 'application/pdf', file_size_bytes: content.length,
  checksum_sha256: checksum, processing_status: 'reviewed', candidates: [{ id: 20, document_id: 2,
    field_key: 'lender_client_name', confirmed_value: 'Example & Bank', review_status: 'confirmed' }] });
const input = () => ({ accountId: 'account-1', assignmentFileId: 14, documentIds: [2], includeDocuments: true, formId: 'FNMA-1004-0911' });
const body = () => ({ assignment_file_id: 14, document_ids: [2], include_documents: true, form_id: 'FNMA-1004-0911' });
function savedRow(row = source()) {
  const documents = [structuredClone(row)];
  const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(documents) });
  return { ...row, saved_report: { accountId: 'account-1', assignmentFileId: 14, assignmentRevision: 1,
    assignmentDetails: applied.assignmentDetails, subject: { value: applied.subject, revision: 1 },
    evidence: { value: applied.evidence, revision: 1 }, documents } };
}
function snapshotRow(row = savedRow()) {
  const { saved_report, subject_context, ...document } = row;
  return { snapshot: { documents: [document], subject_context, saved_report }, evidence_limit: false };
}

test('transfer input rejects unbounded, duplicate, coerced and extra document selection', () => {
  assert.deepEqual(sfrepTransferInput(body()).documentIds, [2]);
  assert.equal(sfrepTransferInput({ ...body(), form_id: 'FNMA-2055-0911' }).formId, 'FNMA-2055-0911');
  assert.deepEqual(sfrepTransferInput({ ...body(), document_ids: [] }).documentIds, []);
  for (const change of [{ document_ids: [2, 2] }, { document_ids: ['2'] },
    { document_ids: Array.from({ length: 11 }, (_, index) => index + 1) }, { assignment_file_id: '14' },
    { include_documents: 'false' }, { form_id: 'invented' }, { raw_xml: '<Report/>' }]) {
    assert.throws(() => sfrepTransferInput({ ...body(), ...change }));
  }
  assert.throws(() => sfrepTransferInput(body(), { exporting: true }), /sfrep_preview_required/);
});

test('2055 preview and download are bound to the selected form in the digest and XML', async () => {
  const documents = [savedRow()];
  documents.saved_report = documents[0].saved_report;
  const urar = previewSfrepDocuments(documents, { ...input(), includeDocuments: false });
  const exteriorInput = { ...input(), includeDocuments: false, formId: 'FNMA-2055-0911' };
  const exterior = previewSfrepDocuments(documents, exteriorInput);
  assert.notEqual(exterior.preview_digest, urar.preview_digest);
  assert.equal(exterior.filename, 'HomeNode-SFREP-2055-file-14.rpti');
  assert.match(exterior.reportXml, /<Form Id="FNMA-2055-0911">/);
  assert.deepEqual(exterior.fields, urar.fields);
  await assert.rejects(packageSfrepDocuments(null, null, documents, exterior,
    { ...exteriorInput, previewDigest: urar.preview_digest }), /sfrep_preview_changed/);
});

test('zero PDF attachments still maps saved workfile fields and prepares a fields-only RPTI', async () => {
  const row = snapshotRow(); row.snapshot.documents = [];
  row.snapshot.saved_report.assignmentDetails.lender_client_name = 'Example & Bank';
  const selected = { ...input(), documentIds: [], includeDocuments: false };
  const documents = await readSfrepDocuments({ query: async () => ({ rows: [row] }) }, selected);
  assert.equal(documents.length, 0);
  const preview = previewSfrepDocuments(documents, selected);
  assert.deepEqual(preview.documents, []);
  assert.deepEqual(preview.pdfAddenda, []);
  assert.match(preview.reportXml, /Example &amp; Bank/);
  const packageResult = await packageSfrepDocuments(null, null, documents, preview, { ...selected, previewDigest: preview.preview_digest },
    { loadContent: () => assert.fail('no source PDF should be fetched') });
  assert.deepEqual([...unzipStored(packageResult.content).keys()], ['Report.xml']);
});

test('source read binds account, assignment and document IDs and rejects a partial result', async () => {
  let query;
  const pool = { query: async value => { query = value; return { rows: [snapshotRow()] }; } };
  assert.equal((await readSfrepDocuments(pool, input()))[0].id, 2);
  assert.deepEqual(query.values, ['account-1', 14, [2], 201, 8 * 1024 * 1024]);
  assert.match(query.text, /document\.assignment_file_id = \$2/);
  assert.match(query.text, /uad_workfile_id IS NULL AND document.tax_protest_file_id IS NULL/);
  assert.match(query.text, /report_file\.custom_assignment_file_id = assignment\.id/);
  assert.match(query.text, /appraisal_case\.organization_id IS NOT DISTINCT FROM assignment\.organization_id/);
  assert.match(query.text, /saved_subject\.section_key = 'report.subject_identification'/);
  assert.match(query.text, /saved_evidence\.section_key = 'report.subject_evidence'/);
  assert.match(query.text, /LEFT JOIN app\.custom_appraisal_workfile_sections saved_market\s+ON saved_market\.assignment_file_id = assignment\.id AND saved_market\.section_key = 'market_conditions'/);
  assert.match(query.text, /LEFT JOIN app\.custom_appraisal_workfile_sections saved_workspace\s+ON saved_workspace\.assignment_file_id = assignment\.id AND saved_workspace\.section_key = 'neighborhood_workspace'/);
  assert.doesNotMatch(query.text, /app\.custom_appraisal_sections saved_(?:market|workspace)/);
  assert.match(query.text, /'canonicalIdentity', jsonb_build_object\('accountId', subject\.account_id/);
  assert.match(query.text, /'county', subject\.county, 'assessorParcelNumber', subject\.account_id/);
  assert.match(query.text, /'state', to_jsonb\(subject\)->>'state'/);
  assert.match(query.text, /LIMIT 51/);
  assert.match(query.text, /source_rows AS MATERIALIZED/);
  assert.match(query.text, /'document_type', document_type, 'title', title, 'file_name', file_name/);
  assert.match(query.text, /payload AS MATERIALIZED/);
  assert.match(query.text, /octet_length\(snapshot::text\) > \$5/);
  assert.match(query.text, /CASE WHEN evidence_limit THEN NULL ELSE snapshot END AS snapshot/);
  assert.doesNotMatch(query.text, /document\.content\b/);
  await assert.rejects(readSfrepDocuments({ query: async () => ({ rows: [] }) }, input()), /sfrep_document_not_found/);
  await assert.rejects(readSfrepDocuments({ query: async () => ({ rows: [snapshotRow({ ...savedRow(), assignment_file_id: 15 })] }) }, input()), /sfrep_document_not_found/);
});

test('production preview binds subject identity and effective date into the reviewed digest', async () => {
  const row = { ...source(), subject_context: { accountId: 'account-1', address: '100 Example Dr', city: 'Garland', postalCode: '75041', effectiveDate: '2026-08-31', inspectionDate: null },
    upload_date: '2026-10-02', candidates: [...source().candidates, { id: 21, document_id: 2, field_key: 'subject_property_address', confirmed_value: '100 Example Dr, Garland, TX 75041', review_status: 'confirmed' }] };
  const stored = savedRow(row);
  const read = () => readSfrepDocuments({ query: async () => ({ rows: [snapshotRow({ ...row, saved_report: structuredClone(stored.saved_report) })] }) }, input());
  let docs = await read();
  assert.equal(docs[0].property_role, 'subject');
  const preview = previewSfrepDocuments(docs, input());
  assert.equal(preview.effectiveDateContext.effectiveDate, '2026-08-31');
  assert.match(preview.reportXml, /Example &amp; Bank/);
  row.subject_context = { ...row.subject_context, effectiveDate: '2026-09-01' };
  assert.notEqual(preview.preview_digest, previewSfrepDocuments(await read(), input()).preview_digest);
  row.subject_context = { ...row.subject_context, address: '102 Example Dr' };
  docs = await read();
  assert.equal(docs[0].property_role, 'comparable');
  assert.doesNotMatch(previewSfrepDocuments(docs, input()).reportXml, /Example &amp; Bank/);
});

test('source read fails closed without saved report data or with oversized/foreign evidence', async () => {
  await assert.rejects(readSfrepDocuments({ query: async () => ({ rows: [snapshotRow(source())] }) }, input()), /invalid_saved_report/);
  for (const [change, expected] of [
    [row => { row.saved_report.documents = Array(51).fill(source()); }, /evidence_limit/],
    [row => { row.saved_report.documents[0].account_id = 'other'; }, /document_not_found/],
    [row => { row.saved_report.documents[0].assignment_file_id = 15; }, /document_not_found/],
    [row => { row.saved_report.documents[0].candidates = Array(201).fill({}); }, /evidence_limit/],
  ]) {
    const row = savedRow(); change(row);
    await assert.rejects(readSfrepDocuments({ query: async () => ({ rows: [snapshotRow(row)] }) }, input()), expected);
  }
});

test('ten selected PDFs use one shared report snapshot and do not attach it to every document', async () => {
  const row = snapshotRow();
  row.snapshot.documents = Array.from({ length: 10 }, (_, index) => ({ ...source(), id: index + 2,
    candidates: [{ ...source().candidates[0], id: 20 + index, document_id: index + 2 }] }));
  row.snapshot.saved_report.documents = structuredClone(row.snapshot.documents);
  let reads = 0;
  const documents = await readSfrepDocuments({ query: async () => { reads++; return { rows: [row] }; } },
    { ...input(), documentIds: row.snapshot.documents.map(document => document.id) });
  assert.equal(reads, 2); // Optional-relation probe, then one bounded shared snapshot.
  assert.equal(documents.length, 10);
  assert.equal(documents.filter(document => Object.hasOwn(document, 'saved_report')).length, 1);
  assert.equal(documents[0].saved_report.documents.length, 10);
  assert.equal(documents[0].saved_report, row.snapshot.saved_report);
});

test('SQL evidence-limit flag refuses the suppressed payload before accessing snapshot data', async () => {
  const row = { evidence_limit: true, get snapshot() { assert.fail('oversized snapshot must not be accessed'); } };
  await assert.rejects(readSfrepDocuments({ query: async () => ({ rows: [row] }) }, input()), /sfrep_evidence_limit/);
});

test('snapshot shape, selected IDs, candidate caps and defense-in-depth byte cap fail closed', async () => {
  for (const [change, expected] of [
    [row => { delete row.evidence_limit; }, /invalid_saved_report/],
    [row => { row.snapshot = null; }, /invalid_saved_report/],
    [row => { row.snapshot.documents = []; }, /document_not_found/],
    [row => { row.snapshot.documents[0].id = 9; }, /document_not_found/],
    [row => { row.snapshot.documents[0].candidates = Array(201).fill({}); }, /evidence_limit/],
    [row => { row.snapshot.saved_report.subject.value.notes = 'x'.repeat(8 * 1024 * 1024); }, /evidence_limit/],
  ]) {
    const row = snapshotRow(); change(row);
    await assert.rejects(readSfrepDocuments({ query: async () => ({ rows: [row] }) }, input()), expected);
  }
  const row = snapshotRow();
  row.snapshot.documents.push(structuredClone(row.snapshot.documents[0]));
  await assert.rejects(readSfrepDocuments({ query: async () => ({ rows: [row] }) }, { ...input(), documentIds: [2, 3] }), /document_not_found/);
  await assert.rejects(readSfrepDocuments({ query: async () => ({ rows: [snapshotRow(), snapshotRow()] }) }, input()), /document_not_found/);
});

test('preview changes when evidence, assignment or source-copy choice changes', () => {
  const documents = [source()];
  const preview = previewSfrepDocuments(documents, input());
  assert.equal(preview.preview_digest, previewSfrepDocuments(documents, input()).preview_digest);
  assert.notEqual(preview.preview_digest, previewSfrepDocuments(documents, { ...input(), assignmentFileId: 15 }).preview_digest);
  assert.notEqual(preview.preview_digest, previewSfrepDocuments(documents, { ...input(), includeDocuments: false }).preview_digest);
  documents[0].candidates[0].confirmed_value = 'Corrected Bank';
  assert.notEqual(preview.preview_digest, previewSfrepDocuments(documents, input()).preview_digest);
});

test('Subject and Contract transfer maps reviewed contract scalars while retaining the original PDF', async () => {
  const document = { ...source(), document_type: 'purchase_contract', property_role: 'subject', candidates: [
    { id: 20, document_id: 2, field_key: 'contract_price', confirmed_value: '300000', review_status: 'confirmed' },
    { id: 21, document_id: 2, field_key: 'contract_date', confirmed_value: '2026-08-25', review_status: 'confirmed' },
  ] };
  const preview = previewSfrepDocuments([document], input());
  assert.match(preview.reportXml, /<CheckBoxField Id="AnalyzedContractYesCheckBox" Data="true" \/>/);
  assert.match(preview.reportXml, /<TextField Id="SalePriceAmount" Data="300000.00" \/>/);
  assert.match(preview.reportXml, /<TextField Id="ContractDate" Data="08\/25\/2026" \/>/);
  assert.doesNotMatch(preview.reportXml, /AnalyzedContractDescription/);
  assert.ok(preview.knownMissing.some(item => item.fieldId === 'AnalyzedContractDescription'));
  assert.equal(preview.pdfAddenda.length, 1);
  assert.equal(preview.omitted.filter(item => /Outside the current Subject-section/.test(item.reason)).length, 0,
    'contract terms are now handled as one section instead of reported as unsupported Subject fields');
  const packaged = await packageSfrepDocuments({}, {}, [document], preview, { ...input(), previewDigest: preview.preview_digest }, {
    loadContent: async () => ({ ...document, content }),
  });
  assert.deepEqual(unzipStored(packaged.content).get('Pdf/document-2.pdf'), content);
});

function unzipStored(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0);
    const length = buffer.readUInt32LE(offset + 18), nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28), start = offset + 30 + nameLength + extraLength;
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
    files.set(name, buffer.subarray(start, start + length));
    offset = start + length;
  }
  return files;
}

test('RPTI contains correctly encoded reviewed fields and checksum-verified original PDF', async () => {
  const documents = [source()], options = input();
  const preview = previewSfrepDocuments(documents, options);
  const result = await packageSfrepDocuments({}, {}, documents, preview, { ...options, previewDigest: preview.preview_digest }, {
    loadContent: async () => ({ ...source(), content }),
  });
  const entries = unzipStored(result.content);
  assert.deepEqual([...entries.keys()].sort(), ['Pdf/document-2.pdf', 'Report.xml']);
  assert.deepEqual(entries.get('Pdf/document-2.pdf'), content);
  const xml = entries.get('Report.xml').toString('utf8');
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>/i);
  assert.match(xml, /LenderClientCompanyName/);
  assert.match(xml, /Example &amp; Bank/);
  assert.match(xml, /PdfField Id="Pdf" Data="document-2.pdf"/);
});

test('stale previews and changed source ownership cannot download source content', async () => {
  const documents = [source()], options = input(), preview = previewSfrepDocuments(documents, options);
  await assert.rejects(packageSfrepDocuments({}, {}, documents, preview, { ...options, previewDigest: '0'.repeat(64) }, {
    loadContent: async () => { assert.fail('stale preview must not fetch PDFs'); },
  }), /sfrep_preview_changed/);
  for (const change of [{ assignment_file_id: 99 }, { account_id: 'other-account' },
    { content: Buffer.from('%PDF-1.7 altered') }, { checksum_sha256: 'f'.repeat(64) }, { uad_workfile_id: 'foreign-workfile' }]) {
    await assert.rejects(packageSfrepDocuments({}, {}, documents, preview, { ...options, previewDigest: preview.preview_digest }, {
      loadContent: async () => ({ ...source(), content, ...change }),
    }), /sfrep_document_integrity_failed/);
  }
});

test('fields-only transfer reads no PDFs and oversized copies are rejected before fetch', async () => {
  const documents = [source()], options = { ...input(), includeDocuments: false };
  const preview = previewSfrepDocuments(documents, options);
  const result = await packageSfrepDocuments({}, {}, documents, preview, { ...options, previewDigest: preview.preview_digest }, {
    loadContent: async () => { assert.fail('fields-only must not read storage'); },
  });
  assert.deepEqual([...unzipStored(result.content).keys()], ['Report.xml']);
  assert.throws(() => previewSfrepDocuments([{ ...source(), file_size_bytes: 51 * 1024 * 1024 }], input()), /sfrep_package_too_large/);
});

test('original storage reads receive the reviewed byte limit and cancellation signal', async () => {
  const documents = [source()], options = input(), preview = previewSfrepDocuments(documents, options);
  const controller = new AbortController();
  let storageCalls = 0;
  const storage = { configured: true, getObject: async request => {
    storageCalls++;
    assert.equal(request.maxBytes, content.length);
    assert.equal(request.signal, controller.signal);
    assert.equal(request.objectKey, 'synthetic-evidence');
    return { body: content };
  } };
  await packageSfrepDocuments({}, storage, documents, preview, { ...options, previewDigest: preview.preview_digest }, {
    signal: controller.signal, loadContent: async (_pool, _id, { storage: scopedStorage }) => {
      assert.equal(scopedStorage.configured, true);
      const result = await scopedStorage.getObject({ objectKey: 'synthetic-evidence' });
      return { ...source(), content: result.body };
    },
  });
  assert.equal(storageCalls, 1);
});
