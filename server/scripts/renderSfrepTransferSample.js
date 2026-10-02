// Generates synthetic evidence only, for testing import in a separate SFREP report.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import { buildSfrepReportExport } from '../src/services/sfrepReportExport.js';
import { buildDeterministicZip } from '../src/modules/uad/uadDeliveryPackage.js';

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
const mapped = buildSfrepReportExport({ documents: [{ id: 1, title: 'Synthetic engagement and contract', processing_status: 'reviewed',
  candidates: Object.entries(values).map(([field_key, confirmed_value], index) => ({
    id: index + 1, document_id: 1, field_key, confirmed_value, review_status: 'confirmed',
  })) }], pdfAddenda: [{ documentId: 1, fileName: 'synthetic-evidence.pdf', title: 'HomeNode QA source evidence' }] });
const result = buildDeterministicZip([{ path: 'Report.xml', body: Buffer.from(mapped.reportXml) },
  { path: 'Pdf/synthetic-evidence.pdf', body: Buffer.concat(parts) }]);
await mkdir(directory, { recursive: true });
const outputPath = resolve(directory, 'HomeNode-SFREP-synthetic.rpti');
await writeFile(outputPath, result.content);
console.log(outputPath);
