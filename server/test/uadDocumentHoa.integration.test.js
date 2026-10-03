import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createUadWorkfile } from '../src/modules/uad/workfiles.js';
import { saveUadSection } from '../src/modules/uad/editor.js';
import { applyConfirmedUadDocumentCandidate } from '../src/modules/uad/documentEvidence.js';

test('reviewed MLS HOA/PUD applies atomically to retained UAD identity and preserves manual decisions in PostgreSQL', {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const accountId = `HOA${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  let created = false;
  try {
    const database = await pool.query('SELECT current_database() AS name');
    assert.match(database.rows[0].name, /_test$/, 'Only an isolated synthetic test database is allowed');
    await pool.query(`INSERT INTO core.accounts (account_id, county, address, city, postal_code, legal_description)
      VALUES ($1, 'Test County', '100 Test Lane', 'Garland', '75044', 'LOT 1 BLOCK A')`, [accountId]);
    created = true;
    const workfile = await createUadWorkfile(pool, accountId, { file_number: `UAD-HOA-${randomUUID()}` });
    const snapshot = await pool.query('SELECT subject_data FROM appraisal.uad_subject_snapshots WHERE workfile_id = $1', [workfile.id]);
    assert.equal(snapshot.rows[0].subject_data.account.account_id, accountId);
    assert.equal(snapshot.rows[0].subject_data.account.address, '100 Test Lane');
    // Existing reports must use their retained subject, not today's live CAD edit.
    await pool.query("UPDATE core.accounts SET address = '900 Different Road' WHERE account_id = $1", [accountId]);
    const report = await pool.query('SELECT id FROM app.report_files WHERE uad_workfile_id = $1', [workfile.id]);
    const content = Buffer.from('%PDF-1.4 synthetic MLS HOA test\n%%EOF');
    const doc = await pool.query(`INSERT INTO app.assignment_documents (
      account_id, uad_workfile_id, report_file_id, document_type, title, file_name, content_type,
      content, checksum_sha256, file_size_bytes, processing_status)
      VALUES ($1, $2, $3, 'mls_sheet', 'Synthetic HOA MLS', 'synthetic-hoa.pdf', 'application/pdf', $4, $5, $6, 'reviewed') RETURNING id`,
    [accountId, workfile.id, report.rows[0].id, content, createHash('sha256').update(content).digest('hex'), content.length]);
    const documentId = Number(doc.rows[0].id);
    let candidateId;
    for (const [field, value] of Object.entries({ subject_street_address: '100 Test Lane', subject_city: 'Garland',
      pud: 'true', hoa_dues_amount: '1200', hoa_frequency: 'per_year' })) {
      const candidate = await pool.query(`INSERT INTO app.assignment_document_field_candidates
        (document_id, field_key, raw_value, normalized_value, confirmed_value, review_status, reviewer, reviewed_at)
        VALUES ($1, $2, $3, $3, $3, 'confirmed', 'Synthetic Reviewer', now()) RETURNING id`, [documentId, field, value]);
      if (field === 'pud') candidateId = Number(candidate.rows[0].id);
    }
    const fields = async () => (await pool.query(`SELECT field_context, uad_uid, value, source_type, source_reference
      FROM appraisal.uad_field_values WHERE workfile_id = $1 AND entity_id IS NULL
      AND (field_context, uad_uid) IN (('subject', '0100.0026'), ('project_association_dues', '2500.0007'))
      ORDER BY field_context`, [workfile.id])).rows;
    const revision = async () => Number((await pool.query('SELECT current_revision FROM appraisal.uad_workfiles WHERE id = $1', [workfile.id])).rows[0].current_revision);
    const auditCount = async () => Number((await pool.query('SELECT count(*) FROM appraisal.uad_audit_events WHERE workfile_id = $1', [workfile.id])).rows[0].count);
    const apply = (databasePool = pool) => applyConfirmedUadDocumentCandidate(databasePool, workfile.id, documentId, candidateId);
    const before = { fields: await fields(), revision: await revision(), audits: await auditCount() };
    assert.deepEqual(before.fields, []);
    let attempts = 0;
    const failingPool = { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect(); attempts += 1;
      return { release: client.release.bind(client), query: async (sql, params) => {
        if (sql.trim().startsWith('INSERT INTO appraisal.uad_field_values') && params?.[3] === 'project_association_dues') {
          throw new Error('synthetic-second-section-failure');
        }
        return client.query(sql, params);
      } };
    } };
    await assert.rejects(apply(failingPool), /synthetic-second-section-failure/);
    assert.deepEqual({ fields: await fields(), revision: await revision(), audits: await auditCount() }, before);
    assert.equal(attempts, 1, 'No blind retry can overwrite a newer appraiser revision');

    const applications = await Promise.all([apply(), apply(), apply()]);
    assert.equal(applications.reduce((sum, result) => sum + result.changed_field_count, 0), 2);
    assert.equal(new Set(applications.map(result => result.current_revision)).size, 1);
    const applied = await fields();
    assert.deepEqual(applied.map(row => [row.field_context, row.value]), [['project_association_dues', 100], ['subject', true]]);
    assert.ok(applied.every(row => row.source_type === 'document' && row.source_reference.includes(`assignment_document:${documentId}:hoa_project:`)));
    assert.equal(new Set(applied.map(row => row.source_reference)).size, 1);

    await saveUadSection(pool, workfile.id, 'subject', { expected_revision: await revision(), save_reason: 'autosave',
      values: [{ context_key: 'subject', uid: '0100.0026', value: false }] });
    const manualFalse = await fields();
    assert.equal((await apply()).applied, false);
    assert.deepEqual(await fields(), manualFalse);
    await saveUadSection(pool, workfile.id, 'subject', { expected_revision: await revision(), save_reason: 'autosave',
      values: [{ context_key: 'subject', uid: '0100.0026', value: true }] });
    await saveUadSection(pool, workfile.id, 'project_information', { expected_revision: await revision(), save_reason: 'autosave',
      values: [{ context_key: 'project_association_dues', uid: '2500.0007', value: null }] });
    const manualBlank = await fields();
    assert.equal(manualBlank[0].value, null);
    assert.equal(manualBlank[0].source_type, 'appraiser');
    assert.equal((await apply()).applied, false);
    await pool.query("UPDATE app.assignment_document_field_candidates SET confirmed_value = 'false' WHERE id = $1", [candidateId]);
    assert.equal((await apply()).applied, false);
    assert.deepEqual(await fields(), manualBlank, 'PUD and manual blank dues remain coherent as one protected group');

    await pool.query("UPDATE appraisal.uad_workfiles SET status = 'signed', signed_at = now() WHERE id = $1", [workfile.id]);
    await assert.rejects(apply(), /status_locked/);
    assert.deepEqual(await fields(), manualBlank);
  } finally {
    try {
      if (created) {
        await pool.query('DELETE FROM app.assignment_documents WHERE account_id = $1', [accountId]);
        await pool.query('UPDATE app.report_files SET subject_snapshot_id = NULL, previous_report_file_id = NULL WHERE account_id = $1', [accountId]);
        await pool.query('DELETE FROM app.appraisal_subject_snapshots WHERE appraisal_case_id IN (SELECT id FROM app.appraisal_cases WHERE account_id = $1)', [accountId]);
        await pool.query('DELETE FROM app.report_files WHERE account_id = $1', [accountId]);
        await pool.query('DELETE FROM app.appraisal_cases WHERE account_id = $1', [accountId]);
        await pool.query('DELETE FROM appraisal.uad_workfiles WHERE account_id = $1', [accountId]);
        await pool.query('DELETE FROM core.accounts WHERE account_id = $1', [accountId]);
      }
    } finally { await pool.end(); }
  }
});
