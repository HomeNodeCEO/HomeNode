import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Actual first PostgreSQL validation in the guarded disposable CI database.
 * Replay only the registered installation's exact status-constraint DDL, then
 * commit it WITHOUT validation. This fixture recreates the initial NOT VALID
 * state after normal bootstrap, without changing production migration options.
 * The subsequent registered validation must change false to true while an
 * independent capture-job writer lock is held. No relaxed timeout. */
export async function runNeighborhoodSelectionWaitStatusValidationV2DatabaseChecks(pool){
  const installation=await readFile(new URL('../../migrations/20261123_custom_cohort_selection_wait_v2.sql',import.meta.url),'utf8'),
    sql=await readFile(new URL('../../migrations/20261123_custom_cohort_selection_wait_validate_status_v2.sql',import.meta.url),'utf8'),
    installationDdl=installation.match(/^ALTER TABLE app\.neighborhood_custom_cohort_capture_jobs\r?\n[\s\S]*? NOT VALID;/m)?.[0];
  assert.ok(installationDdl,'the actual registered installation must contain its NOT VALID status DDL');
  assert.doesNotMatch(installationDdl,/VALIDATE CONSTRAINT|CREATE FUNCTION|INSERT INTO|UPDATE app\.|DELETE FROM/);
  const constraintSql=`SELECT convalidated FROM pg_constraint
      WHERE conrelid='app.neighborhood_custom_cohort_capture_jobs'::regclass
        AND conname='neighborhood_custom_cohort_capture_jobs_status_check'`,
    writer=await pool.connect();let validator;
  try{
    const identity=(await writer.query('SELECT current_database() AS database_name')).rows;
    assert.equal(identity.length,1);
    assert.match(identity[0].database_name,/^neighborhood_[a-f0-9]{32}_test$/,
      'installation-only reset requires the independently created disposable CI database');
    // This is fixture installation only. Its ACCESS EXCLUSIVE lock must end
    // before either the simulated ordinary writer or validation transaction.
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='1s'");
    await writer.query(installationDdl);
    assert.deepEqual((await writer.query(constraintSql)).rows,[{convalidated:false}]);
    await writer.query('COMMIT');
    validator=await pool.connect();
    await writer.query('BEGIN');
    // Ordinary capture-job DML takes ROW EXCLUSIVE. Validation must coexist
    // with that actual held table lock rather than waiting for all writers.
    await writer.query('LOCK TABLE app.neighborhood_custom_cohort_capture_jobs IN ROW EXCLUSIVE MODE');
    await validator.query('BEGIN');await validator.query("SET LOCAL lock_timeout='1s'");
    // A prevalidated fixture would make PostgreSQL skip the initial scan.
    // Require the committed installation state immediately before exact SQL.
    assert.deepEqual((await validator.query(constraintSql)).rows,[{convalidated:false}]);
    await validator.query(sql);
    const locks=(await validator.query(`SELECT mode FROM pg_locks WHERE pid=pg_backend_pid()
      AND relation='app.neighborhood_custom_cohort_capture_jobs'::regclass AND granted ORDER BY mode`)).rows.map(r=>r.mode);
    assert.ok(locks.includes('ShareUpdateExclusiveLock'));assert.ok(!locks.includes('AccessExclusiveLock'));
    assert.deepEqual((await validator.query(constraintSql)).rows,[{convalidated:true}]);
    // Restore the bootstrapped fixture's validated state for the remaining
    // native protocols, using the same actual validation transaction.
    await validator.query('COMMIT');
    console.info('[native-selection-wait-status-validation-v2]',{actual_registered_installation_status_ddl:true,
      installation_committed_without_validation:true,convalidated_before:false,convalidated_after:true,
      initial_validation_scan_exercised:true,actual_registered_validation_sql:true,
      concurrent_capture_job_writer_lock_compatible:true,no_AccessExclusive_validation_lock:true,constraint_validated:true});
  }finally{
    try{if(validator)await validator.query('ROLLBACK').finally(()=>validator.release());}
    finally{await writer.query('ROLLBACK').finally(()=>writer.release());}
  }
}
