import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createCustomCohortSubjectRepository } from '../../src/services/neighborhoodAssessment/customCohortSubjectRepository.js';

// The caller creates an isolated synthetic identity using ordinary migrations
// inside the existing CI-only, verified child database. No production env/DDL.
export async function checkCustomCohortSubjectDatabase(pool, identity) {
  const scope = { organization_id: identity.scope.organization_id, report_file_id: identity.customReportId,
    assignment_file_id: String(identity.customId), account_id: identity.scope.account_id };
  const scopeJson = JSON.stringify(scope);
  const seed = await pool.connect();
  try {
    await seed.query('BEGIN');
    await seed.query(`INSERT INTO app.custom_appraisal_workfiles (assignment_file_id,canonical_file_name)
      VALUES ($1,$2)`, [scope.assignment_file_id, `synthetic-cohort-${randomUUID()}`]);
    await seed.query(`UPDATE app.appraisal_subject_snapshots SET subject_data=$2::jsonb, source_manifest=$3::jsonb
      WHERE id=$1`, [identity.scope.subject_snapshot_id,
      JSON.stringify({ custom_property_snapshot: { account: { account_id: scope.account_id, address: 'Synthetic Café 🏠' },
        improvement: { living_area_sqft: 2000 } }, retained_extra: { never: 'discard' } }), '{"fixture":"retained"}']);
    await seed.query(`INSERT INTO app.custom_appraisal_sections (assignment_file_id,section_key,section_value)
      VALUES ($1,'report.property_characteristics','{"main_improvement":{"living_area_sqft":2100.00},"reviewer_note":"original"}')`, [scope.assignment_file_id]);
    await seed.query('COMMIT');
  } catch (error) { await seed.query('ROLLBACK'); throw error; }
  finally { seed.release(); }

  const client = await pool.connect();
  let ref;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='8s'");
    const repo = createCustomCohortSubjectRepository(client, scopeJson);
    ref = await repo.capture();
    const retained = await repo.load(ref);
    assert.equal(retained.effective_date, '2024-06-30');
    const sections = JSON.parse(retained.original_sections.pg_reads_json);
    assert.deepEqual(sections.map(s => [s.section_key, s.row_state, s.row?.assignment_file_id ?? null]), [
      ['report.land_details', 'absent', null], ['report.property_characteristics', 'present', scope.assignment_file_id],
      ['report.subject_identification', 'absent', null],
    ]);
    assert.match(sections[1].row.section_value.pg_text, /2100\.00/);
    assert.equal(retained.material.assignment_sections.property_characteristics.projection.main_improvement.value.living_area_sqft.value, 2100);
    assert.equal(retained.material.retained_public.improvement.value.living_area_sqft.value, 2000);
    assert.equal(retained.snapshot.subject_data.retained_extra.never, 'discard');
    assert.match(retained.original_snapshot.pg_row_json, /Café 🏠/);
    assert.deepEqual(await repo.capture(), ref);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',
      [scope.organization_id])).rows[0].n, 5);
    await assert.rejects(createCustomCohortSubjectRepository(client, JSON.stringify({ ...scope, organization_id: randomUUID() })).load(ref), /not_found/);
    await assert.rejects(createCustomCohortSubjectRepository(client, JSON.stringify({ ...scope, account_id: identity.accounts[1] })).capture(), /not_found/);

    // A new current snapshot and edited physical data do not replace history.
    const nextSnapshot = randomUUID();
    await client.query(`INSERT INTO app.appraisal_subject_snapshots
      (id,appraisal_case_id,snapshot_version,effective_date,subject_data)
      VALUES ($1,$2,2,'2024-07-01','{"custom_property_snapshot":{}}')`, [nextSnapshot, identity.scope.appraisal_case_id]);
    await client.query('UPDATE app.report_files SET subject_snapshot_id=$2 WHERE id=$1', [scope.report_file_id, nextSnapshot]);
    await client.query(`UPDATE app.custom_appraisal_sections SET section_value='{"main_improvement":{"living_area_sqft":5000}}'
      WHERE assignment_file_id=$1 AND section_key='report.property_characteristics'`, [scope.assignment_file_id]);
    assert.deepEqual(await repo.load(ref), retained);
    await assert.rejects(repo.capture(), /effective_date_unresolved/);
    await client.query('UPDATE app.appraisal_cases SET effective_date=NULL WHERE id=$1', [identity.scope.appraisal_case_id]);
    const nextRef = await repo.capture();
    assert.notEqual(nextRef.content_sha256, ref.content_sha256);
    assert.equal((await repo.load(nextRef)).effective_date, '2024-07-01');
    assert.deepEqual(await repo.load(ref), retained);
    await client.query("UPDATE app.custom_appraisal_workfiles SET status='archived' WHERE assignment_file_id=$1", [scope.assignment_file_id]);
    await assert.rejects(repo.capture(), /protected_workfile/);
    assert.deepEqual(await repo.load(ref), retained);
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
  const observer = await pool.connect();
  try {
    await assert.rejects(createCustomCohortSubjectRepository(observer, scopeJson).load(ref), /missing_evidence/);
    assert.equal((await observer.query('SELECT subject_snapshot_id FROM app.report_files WHERE id=$1', [scope.report_file_id])).rows[0].subject_snapshot_id,
      identity.scope.subject_snapshot_id, 'rollback must preserve original core pointer');
  } finally { observer.release(); }

  // Real two-client contention: each established fence refuses immediately,
  // rather than stalling behind an editor or reversing its locks indefinitely.
  const lockQueries = [
    ['SELECT id FROM app.assignment_files WHERE id=$1 FOR UPDATE', scope.assignment_file_id],
    ['SELECT assignment_file_id FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1 FOR UPDATE', scope.assignment_file_id],
    ['SELECT id FROM app.report_files WHERE id=$1 FOR UPDATE', scope.report_file_id],
    ['SELECT id FROM app.appraisal_cases WHERE id=$1 FOR UPDATE', identity.scope.appraisal_case_id],
    ['SELECT id FROM app.appraisal_subject_snapshots WHERE id=$1 FOR UPDATE', identity.scope.subject_snapshot_id],
    ["SELECT assignment_file_id FROM app.custom_appraisal_sections WHERE assignment_file_id=$1 AND section_key='report.property_characteristics' FOR UPDATE", scope.assignment_file_id],
  ];
  const holder = await pool.connect();
  let contender;
  try {
    contender = await pool.connect();
    for (const [sql, id] of lockQueries) {
      await holder.query('BEGIN'); await contender.query('BEGIN');
      try {
        await holder.query(sql, [id]);
        await contender.query("SET LOCAL statement_timeout='2s'");
        const start = performance.now();
        await assert.rejects(createCustomCohortSubjectRepository(contender, scopeJson).capture(), error => error.code === '55P03');
        assert.ok(performance.now() - start < 1500, 'NOWAIT must win before the statement-timeout backstop');
      } finally { await contender.query('ROLLBACK'); await holder.query('ROLLBACK'); }
    }
  } finally { contender?.release(); holder.release(); }
}
