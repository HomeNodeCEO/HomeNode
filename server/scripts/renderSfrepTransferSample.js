// Generates synthetic evidence only, for testing import in a separate SFREP report.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { previewSfrepDocuments, packageSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';

const directory = resolve(process.argv[2] || 'tmp/sfrep-sample');
const pdf = new PDFDocument({ size: 'LETTER', margin: 48 });
const parts = [];
const finished = new Promise((done, reject) => { pdf.on('data', chunk => parts.push(chunk)); pdf.on('end', done); pdf.on('error', reject); });
pdf.fontSize(20).text('HomeNode / SFREP integration test');
pdf.moveDown().fontSize(12).text('SYNTHETIC EVIDENCE - NOT AN APPRAISAL');
pdf.moveDown().text('This source PDF tests import as an Appraise-It Pro PDF addendum.');
pdf.text('Lender: Example QA Bank');
pdf.text('Lender address: 100 Example Avenue, Sample City, TX 75000');
pdf.text('Contract price: $282,500.00');
pdf.end();
await finished;
const values = { file_number: 'HOMENODE-SFREP-QA', lender_client_name: 'Example QA Bank',
  lender_client_address: '100 Example Avenue, Sample City, TX 75000', contract_price: '282500.00',
  contract_date: '2026-09-30', assignment_type: 'purchase_transaction' };
const pdfBytes = Buffer.concat(parts), checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const input = { accountId: 'synthetic-sfrep', assignmentFileId: 1, documentIds: [1], includeDocuments: true, includePhotos: true,
  formId: process.argv[3] === '2055' ? 'FNMA-2055-0911' : 'FNMA-1004-0911' };
const documents = [{ id: 1, account_id: input.accountId, assignment_file_id: input.assignmentFileId,
  title: 'Synthetic engagement and contract', file_name: 'synthetic-evidence.pdf', document_type: 'engagement_letter', processing_status: 'reviewed',
  content_type: 'application/pdf', file_size_bytes: pdfBytes.length, checksum_sha256: checksum(pdfBytes),
  candidates: Object.entries(values).map(([field_key, confirmed_value], index) => ({
    id: index + 1, document_id: 1, field_key, confirmed_value, review_status: 'confirmed',
  })) }];
const photos = [], objects = new Map();
for (const [index, label] of ['Front exterior — synthetic', 'Rear exterior — synthetic', 'Kitchen — edited label', 'Garage — synthetic'].entries()) {
  const bytes = await sharp({ create: { width: 640, height: 400, channels: 3,
    background: ['#7c3aed', '#d4af37', '#4c1d95', '#f5d985'][index] } }).png().toBuffer();
  const objectKey = `synthetic/photo-${index + 1}.png`; objects.set(objectKey, bytes);
  photos.push({ id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    account_id: input.accountId, assignment_file_id: input.assignmentFileId, category: label.split(' — ')[0],
    caption: label, position: index + 1, revision: 1, status: 'verified',
    verified_at: '2026-10-06T12:00:00Z', object_verified_at: '2026-10-06T12:00:00Z',
    object_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, variant: 'display', object_key: objectKey,
    content_type: 'image/png', byte_size: bytes.length, checksum_sha256: checksum(bytes) });
}
const preview = previewSfrepDocuments(documents, input, photos);
const result = await packageSfrepDocuments({}, { configured: true, async getObject({ objectKey }) {
  const body = objects.get(objectKey); return { body, byte_size: body?.length };
} }, documents, preview, { ...input, previewDigest: preview.preview_digest },
{ loadContent: async () => ({ ...documents[0], content: pdfBytes }) });
await mkdir(directory, { recursive: true });
const outputPath = resolve(directory, `HomeNode-SFREP-synthetic-${input.formId.includes('2055') ? '2055' : '1004'}.rpti`);
await writeFile(outputPath, result.content);
await writeFile(resolve(directory, 'Report.xml'), preview.reportXml);
console.log(outputPath);
