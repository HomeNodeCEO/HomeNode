import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { ensureAssignmentDocumentsSchema } from '../src/services/assignmentDocuments.js';
import { ensureCensusGeographySchema } from '../src/services/censusGeography.js';
import { readCustomSubjectDocuments, projectCustomSubjectDocuments, mergeCustomSubjectApplication } from '../src/services/customSubjectApplication.js';
import { readSfrepDocuments, previewSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';
import { readSfrepPhotos, projectSfrepPhotos } from '../src/services/sfrepPhotoTransfer.js';

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

test('actual PostgreSQL photo export binds the assignment and organization and selects only verified compatible copies', {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let client;
  try {
    const identity = await pool.query('SELECT current_database() AS name');
    assert.match(identity.rows[0].name, /_test$/, 'synthetic integration requires a test database');
    client = await pool.connect();
    await client.query('BEGIN');
    const organizationId = randomUUID(), foreignOrganizationId = randomUUID(), userId = randomUUID();
    for (const id of [organizationId, foreignOrganizationId]) {
      await client.query("INSERT INTO app_auth.organizations (id, legal_name, display_name) VALUES ($1, 'Synthetic SFREP', 'Synthetic SFREP')", [id]);
    }
    await client.query("INSERT INTO app_auth.users (id, email, display_name) VALUES ($1, $2, 'Synthetic SFREP')", [userId, `${userId}@example.test`]);
    const accountId = `SFP${randomUUID().slice(0, 18)}`;
    await client.query("INSERT INTO core.accounts (account_id, address, city, postal_code) VALUES ($1, '100 Example Dr', 'Garland', '75041')", [accountId]);
    const createFile = async () => {
      const assignment = await client.query(`INSERT INTO app.assignment_files (account_id, organization_id, file_number)
        VALUES ($1, $2, $3) RETURNING id`, [accountId, organizationId, `SFREP-SYNTH-${randomUUID()}`]);
      const assignmentFileId = Number(assignment.rows[0].id), reportId = randomUUID(), sessionId = randomUUID();
      await client.query(`INSERT INTO app.report_files (id, organization_id, account_id, workflow_type, file_number, custom_assignment_file_id)
        VALUES ($1, $2, $3, 'custom_appraisal', $4, $5)`, [reportId, organizationId, accountId, `SFREP-SYNTH-${reportId}`, assignmentFileId]);
      await client.query(`INSERT INTO app.inspection_sessions (id, report_file_id, organization_id, appraiser_user_id, base_report_revision)
        VALUES ($1, $2, $3, $4, 1)`, [sessionId, reportId, organizationId, userId]);
      return { assignmentFileId, reportId, sessionId };
    };
    const selected = await createFile(), previous = await createFile();
    const createPhoto = async (file, position, status, organization = organizationId) => {
      const id = randomUUID();
      await client.query(`INSERT INTO app.inspection_photos
        (id, inspection_session_id, report_file_id, organization_id, captured_by_user_id, client_photo_id,
         request_sha256, workflow_type, category, category_source, caption, caption_source, source, position,
         status, verified_at, retention_starts_at, retention_until)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'custom_appraisal', 'Front', 'manual', 'Front exterior — edited label', 'manual', 'camera', $8,
         $9, CASE WHEN $9 IN ('verified', 'excluded') THEN now() END,
         CASE WHEN $9 IN ('verified', 'excluded') THEN now() END,
         CASE WHEN $9 IN ('verified', 'excluded') THEN now() + interval '5 years' END)`,
      [id, file.sessionId, file.reportId, organization, userId, randomUUID(), 'a'.repeat(64), position, status]);
      return id;
    };
    const includedId = await createPhoto(selected, 1, 'verified');
    const pendingId = await createPhoto(selected, 2, 'pending_upload');
    await createPhoto(selected, 3, 'excluded');
    await createPhoto(selected, 4, 'verified', foreignOrganizationId);
    await createPhoto(previous, 1, 'verified');
    const createObject = async (photoId, variant, contentType, checksum = 'b'.repeat(64)) => {
      const id = randomUUID();
      await client.query(`INSERT INTO app.inspection_photo_objects
        (id, photo_id, client_object_id, variant, storage_bucket, object_key, original_file_name, content_type,
         expected_byte_size, byte_size, status, verified_at, checksum_sha256)
        VALUES ($1, $2, $3, $4, 'synthetic-bucket', $5, 'synthetic.jpg', $6, 100, 100, 'verified', now(), $7)`,
      [id, photoId, randomUUID(), variant, `synthetic/${id}`, contentType, checksum]);
      return id;
    };
    await createObject(includedId, 'original', 'image/jpeg');
    const displayId = await createObject(includedId, 'display', 'image/jpeg');
    const input = { accountId, assignmentFileId: selected.assignmentFileId, includePhotos: true };
    const rows = await readSfrepPhotos(client, input);
    assert.deepEqual(rows.map(row => row.id), [includedId, pendingId]);
    assert.equal(rows[0].object_id, displayId);
    assert.equal(rows[1].object_id, null);
    const projected = projectSfrepPhotos(rows, input);
    assert.equal(projected.photos[0].label, 'Front exterior — edited label');
    assert.equal(projected.imageAddenda.length, 1);
    assert.equal(projected.photos[1].included, false);
    assert.deepEqual(await readSfrepPhotos(client, { ...input, accountId: 'foreign-account' }), []);
    assert.deepEqual(await readSfrepPhotos(client, { ...input, includePhotos: false }), []);
    // Old verified records without a stored checksum cannot be mislabeled as
    // export-ready. Prefer a valid original, then visibly exclude if neither copy qualifies.
    await client.query('UPDATE app.inspection_photo_objects SET checksum_sha256 = NULL WHERE id = $1', [displayId]);
    assert.equal((await readSfrepPhotos(client, input))[0].variant, 'original');
    await client.query('UPDATE app.inspection_photo_objects SET checksum_sha256 = NULL WHERE photo_id = $1', [includedId]);
    const unavailable = projectSfrepPhotos(await readSfrepPhotos(client, input), input);
    assert.equal(unavailable.photos[0].included, false);
    assert.equal(unavailable.imageAddenda.length, 0);
    await client.query('UPDATE app.report_files SET organization_id = $1 WHERE id = $2', [foreignOrganizationId, selected.reportId]);
    assert.deepEqual(await readSfrepPhotos(client, input), []);
  } finally {
    if (client) {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
    await pool.end();
  }
});
