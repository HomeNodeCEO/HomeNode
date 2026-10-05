import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { ensureAssignmentDocumentsSchema } from '../src/services/assignmentDocuments.js';
import { ensureCensusGeographySchema } from '../src/services/censusGeography.js';
import { readCustomSubjectDocuments, projectCustomSubjectDocuments, mergeCustomSubjectApplication } from '../src/services/customSubjectApplication.js';
import { readSfrepDocuments, previewSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';

test('actual PostgreSQL binds matched Census and reviewed HOA receipts into the same saved Subject export', {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let client;
  try {
    const identity = await pool.query('SELECT current_database() AS name');
    assert.match(identity.rows[0].name, /_test$/, 'synthetic integration requires a test database');
    await ensureAssignmentDocumentsSchema(pool);
    await ensureCensusGeographySchema(pool);
    client = await pool.connect();
    await client.query('BEGIN');
    const accountId = `QAS${Date.now()}`;
    await client.query("INSERT INTO core.accounts (account_id, address, city, postal_code) VALUES ($1, '100 Example Dr', 'Garland', '75041')", [accountId]);
    const assignment = await client.query("INSERT INTO app.assignment_files (account_id, file_number) VALUES ($1, $2) RETURNING id", [accountId, `SFREP-SYNTH-${randomUUID()}`]);
    const assignmentFileId = Number(assignment.rows[0].id);
    await client.query(`INSERT INTO core.account_census_geographies (account_id, tract_code, tract_geoid, status)
      VALUES ($1, '001234', '48113001234', 'matched')`, [accountId]);
    const bytes = Buffer.from('%PDF-1.4 Synthetic MLS subject fixture');
    const inserted = await client.query(`INSERT INTO app.assignment_documents
      (account_id, assignment_file_id, document_type, title, file_name, content_type, content, checksum_sha256, file_size_bytes, processing_status)
      VALUES ($1, $2, 'mls_sheet', 'Synthetic MLS', 'synthetic.pdf', 'application/pdf', $3, $4, $5, 'reviewed') RETURNING id`,
    [accountId, assignmentFileId, bytes, createHash('sha256').update(bytes).digest('hex'), bytes.length]);
    const documentId = Number(inserted.rows[0].id);
    for (const [key, value, raw, method] of [
      ['subject_property_address', '100 Example Dr, Garland, TX 75041', '100 Example Dr, Garland, TX 75041', 'labeled_text'],
      ['pud', 'false', 'None', 'urar_subject_mls_sheet_hoa_workflow_proxy'],
    ]) await client.query(`INSERT INTO app.assignment_document_field_candidates
      (document_id, field_key, normalized_value, confirmed_value, raw_value, review_status, extraction_method)
      VALUES ($1, $2, $3, $3, $4, 'confirmed', $5)`, [documentId, key, value, raw, method]);
    const scoped = await readCustomSubjectDocuments(client, { accountId, assignmentFileId });
    assert.equal(scoped[0].subject_context.censusGeography.status, 'matched');
    const applied = mergeCustomSubjectApplication({ projection: projectCustomSubjectDocuments(scoped), reviewedDocumentId: documentId });
    assert.equal(applied.subject.property_location.census_tract, '12.34');
    assert.equal(applied.assignmentDetails.pud, false);
    assert.equal(applied.assignmentDetails.hoa_dues_amount, null);
    await client.query('UPDATE app.assignment_files SET assignment_details = $1::jsonb WHERE id = $2', [JSON.stringify(applied.assignmentDetails), assignmentFileId]);
    for (const [key, value] of [['report.subject_identification', applied.subject], ['report.subject_evidence', applied.evidence]]) {
      await client.query(`INSERT INTO app.custom_appraisal_sections (assignment_file_id, section_key, section_value, revision)
        VALUES ($1, $2, $3::jsonb, 1)`, [assignmentFileId, key, JSON.stringify(value)]);
    }
    const input = { accountId, assignmentFileId, documentIds: [documentId], includeDocuments: false, formId: 'FNMA-1004-0911' };
    const documents = await readSfrepDocuments(client, input);
    const preview = previewSfrepDocuments(documents, input);
    assert.equal(preview.fields.find(field => field.fieldId === 'CensusTract').value, '12.34');
    assert.equal(preview.fields.some(field => ['PropertyTypePUDCheckBox', 'AssessmentAmount'].includes(field.fieldId)), false);
    // Exercise the production SQL snapshot, not a direct document fixture: the
    // optional attachment selection must not erase the base contract's label.
    const baseBytes = Buffer.from('%PDF-1.4 Synthetic base contract fixture');
    const base = await client.query(`INSERT INTO app.assignment_documents
      (account_id, assignment_file_id, document_type, title, file_name, content_type, content, checksum_sha256, file_size_bytes, processing_status)
      VALUES ($1, $2, 'purchase_contract', 'Contract.pdf', 'Contract.pdf', 'application/pdf', $3, $4, $5, 'reviewed') RETURNING id`,
    [accountId, assignmentFileId, baseBytes, createHash('sha256').update(baseBytes).digest('hex'), baseBytes.length]);
    const baseId = Number(base.rows[0].id);
    for (const [key, value] of [
      ['subject_property_address', '100 Example Dr, Garland, TX 75041'],
      ['contract_date', '2026-08-25'], ['contract_price', '282500'], ['earnest_money', '2600'],
      ['down_payment', '8475'], ['loan_amount', '274025'], ['seller_concessions', '0'],
    ]) await client.query(`INSERT INTO app.assignment_document_field_candidates
      (document_id, field_key, normalized_value, confirmed_value, raw_value, review_status, extraction_method)
      VALUES ($1, $2, $3, $3, $3, 'confirmed', 'labeled_text')`, [baseId, key, value]);
    const addendumBytes = Buffer.from('%PDF-1.4 Synthetic financing addendum fixture');
    await client.query(`INSERT INTO app.assignment_documents
      (account_id, assignment_file_id, document_type, title, file_name, content_type, content, checksum_sha256, file_size_bytes, processing_status)
      VALUES ($1, $2, 'purchase_contract', 'Thhird PArty Financing.pdf', 'Thhird PArty Financing.pdf',
        'application/pdf', $3, $4, $5, 'reviewed')`,
    [accountId, assignmentFileId, addendumBytes, createHash('sha256').update(addendumBytes).digest('hex'), addendumBytes.length]);
    const fieldsOnly = { ...input, documentIds: [], includeDocuments: false };
    for (const formId of ['FNMA-1004-0911', 'FNMA-2055-0911']) {
      const mapped = previewSfrepDocuments(await readSfrepDocuments(client, fieldsOnly), { ...fieldsOnly, formId });
      assert.equal(mapped.fields.find(field => field.fieldId === 'StreetAddress')?.value, '100 Example Dr');
      assert.equal(mapped.fields.find(field => field.fieldId === 'AnalyzedContractYesCheckBox')?.value, 'true');
      assert.equal(mapped.fields.find(field => field.fieldId === 'SalePriceAmount')?.value, '282500.00');
      assert.match(mapped.fields.find(field => field.fieldId === 'AnalyzedContractDescription')?.value || '', /purchase price of \$282,500/);
      assert.equal(mapped.pdfAddenda.length, 0);
    }
    await client.query("UPDATE core.account_census_geographies SET status = 'review_required' WHERE account_id = $1", [accountId]);
    const changed = previewSfrepDocuments(await readSfrepDocuments(client, input), input);
    assert.notEqual(changed.preview_digest, preview.preview_digest);
    assert.equal(changed.fields.some(field => field.fieldId === 'CensusTract'), false);
  } finally {
    if (client) {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
    await pool.end();
  }
});
