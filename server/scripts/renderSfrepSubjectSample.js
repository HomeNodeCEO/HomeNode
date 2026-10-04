// Synthetic only. Run in a separate QA report; never import into a client file.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import { extractPdfEvidence } from '../src/services/documentIntelligence.js';
import { sfrepDocumentPropertyRole, sfrepSubjectContext } from '../src/services/sfrepSubjectContext.js';
import { buildSfrepReportExport } from '../src/services/sfrepReportExport.js';
import { buildDeterministicZip } from '../src/modules/uad/uadDeliveryPackage.js';
import { SFREP_SUBJECT_QA, SFREP_SUBJECT_DOCUMENTS } from '../test/fixtures/sfrepSubjectDocuments.js';

const directory = resolve(process.argv[2] || 'tmp/sfrep-subject-sample');
await mkdir(directory, { recursive: true });
const documents = [], files = [], addenda = [];
for (const fixture of SFREP_SUBJECT_DOCUMENTS) {
  const pdf = new PDFDocument({ size: 'LETTER', margin: 48 });
  const chunks = [];
  const done = new Promise((resolve, reject) => { pdf.on('data', chunk => chunks.push(chunk)); pdf.on('end', resolve); pdf.on('error', reject); });
  pdf.fontSize(17).text(fixture.lines[0]);
  pdf.moveDown().fontSize(11);
  fixture.lines.slice(1).forEach(line => { pdf.text(line); pdf.moveDown(0.4); });
  pdf.end(); await done;
  const bytes = Buffer.concat(chunks), filename = `synthetic-subject-${fixture.id}.pdf`;
  await writeFile(resolve(directory, filename), bytes);
  const extracted = await extractPdfEvidence(bytes, { requestedType: fixture.type, fileName: filename });
  const document = { id: fixture.id, document_type: fixture.type, title: fixture.title,
    processing_status: 'reviewed', subject_context: SFREP_SUBJECT_QA,
    candidates: extracted.candidates.map((candidate, index) => ({ ...candidate, id: fixture.id * 100 + index,
      document_id: fixture.id, review_status: 'confirmed', confirmed_value: candidate.normalized_value })) };
  document.property_role = sfrepDocumentPropertyRole(document);
  documents.push(document); files.push({ path: `Pdf/${filename}`, body: bytes });
  addenda.push({ documentId: fixture.id, fileName: filename, title: fixture.title });
}
const mapped = buildSfrepReportExport({ documents, pdfAddenda: addenda, subjectContext: sfrepSubjectContext(documents) });
if (mapped.conflicts.length) throw new Error('synthetic_subject_fixture_conflict');
files.unshift({ path: 'Report.xml', body: Buffer.from(mapped.reportXml, 'utf8') });
const output = resolve(directory, 'HomeNode-SFREP-Subject-QA.rpti');
await writeFile(output, buildDeterministicZip(files).content);
await writeFile(resolve(directory, 'subject-preview.json'), JSON.stringify(mapped, null, 2));
console.log(JSON.stringify({ output, mappedFields: mapped.fields.length, assumptions: mapped.assumptions.length }));
