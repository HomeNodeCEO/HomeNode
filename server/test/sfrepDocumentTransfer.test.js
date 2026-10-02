import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sfrepTransferInput, readSfrepDocuments, previewSfrepDocuments, packageSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';

const content = Buffer.from('%PDF-1.7\nSynthetic SFREP transfer fixture\n%%EOF');
const checksum = createHash('sha256').update(content).digest('hex');
const source = () => ({ id: 2, account_id: 'account-1', assignment_file_id: 14, document_type: 'engagement_letter',
  title: 'Engagement', file_name: 'engagement.pdf', content_type: 'application/pdf', file_size_bytes: content.length,
  checksum_sha256: checksum, processing_status: 'reviewed', candidates: [{ id: 20, document_id: 2,
    field_key: 'lender_client_name', confirmed_value: 'Example & Bank', review_status: 'confirmed' }] });
const input = () => ({ accountId: 'account-1', assignmentFileId: 14, documentIds: [2], includeDocuments: true, formId: 'FNMA-1004-0911' });
const body = () => ({ assignment_file_id: 14, document_ids: [2], include_documents: true, form_id: 'FNMA-1004-0911' });

test('transfer input rejects unbounded, duplicate, coerced and extra document selection', () => {
  assert.deepEqual(sfrepTransferInput(body()).documentIds, [2]);
  for (const change of [{ document_ids: [] }, { document_ids: [2, 2] }, { document_ids: ['2'] },
    { document_ids: Array.from({ length: 11 }, (_, index) => index + 1) }, { assignment_file_id: '14' },
    { include_documents: 'false' }, { form_id: 'invented' }, { raw_xml: '<Report/>' }]) {
    assert.throws(() => sfrepTransferInput({ ...body(), ...change }));
  }
  assert.throws(() => sfrepTransferInput(body(), { exporting: true }), /sfrep_preview_required/);
});

test('source read binds account, assignment and document IDs and rejects a partial result', async () => {
  let query;
  const pool = { query: async value => { query = value; return { rows: [source()] }; } };
  assert.equal((await readSfrepDocuments(pool, input()))[0].id, 2);
  assert.deepEqual(query.values, ['account-1', 14, [2], 201]);
  assert.match(query.text, /document\.assignment_file_id = \$2/);
  assert.match(query.text, /uad_workfile_id IS NULL AND document.tax_protest_file_id IS NULL/);
  assert.match(query.text, /report_file\.custom_assignment_file_id = assignment\.id/);
  assert.match(query.text, /appraisal_case\.organization_id IS NOT DISTINCT FROM assignment\.organization_id/);
  await assert.rejects(readSfrepDocuments({ query: async () => ({ rows: [] }) }, input()), /sfrep_document_not_found/);
  await assert.rejects(readSfrepDocuments({ query: async () => ({ rows: [{ ...source(), assignment_file_id: 15 }] }) }, input()), /sfrep_document_not_found/);
});

test('production preview binds subject identity and effective date into the reviewed digest', async () => {
  const row = { ...source(), subject_context: { accountId: 'account-1', address: '100 Example Dr', city: 'Garland', postalCode: '75041', effectiveDate: '2026-08-31', inspectionDate: null },
    upload_date: '2026-10-02', candidates: [...source().candidates, { id: 21, document_id: 2, field_key: 'subject_property_address', confirmed_value: '100 Example Dr, Garland, TX 75041', review_status: 'confirmed' }] };
  const read = () => readSfrepDocuments({ query: async () => ({ rows: [row] }) }, input());
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

test('preview changes when evidence, assignment or source-copy choice changes', () => {
  const documents = [source()];
  const preview = previewSfrepDocuments(documents, input());
  assert.equal(preview.preview_digest, previewSfrepDocuments(documents, input()).preview_digest);
  assert.notEqual(preview.preview_digest, previewSfrepDocuments(documents, { ...input(), assignmentFileId: 15 }).preview_digest);
  assert.notEqual(preview.preview_digest, previewSfrepDocuments(documents, { ...input(), includeDocuments: false }).preview_digest);
  documents[0].candidates[0].confirmed_value = 'Corrected Bank';
  assert.notEqual(preview.preview_digest, previewSfrepDocuments(documents, input()).preview_digest);
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
