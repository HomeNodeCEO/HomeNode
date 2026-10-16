import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Actual isolated PostgreSQL lock compatibility, using the registered SQL.
 * No production connection, table scan substitute or relaxed timeout. The
 * installation migration has committed before this validation transaction. */
export async function runNeighborhoodSelectionWaitStatusValidationV2DatabaseChecks(pool){
  const sql=await readFile(new URL('../../migrations/20261123_custom_cohort_selection_wait_validate_status_v2.sql',import.meta.url),'utf8'),
    writer=await pool.connect();let validator;
  try{
    validator=await pool.connect();
    await writer.query('BEGIN');
    // Ordinary capture-job DML takes ROW EXCLUSIVE. Validation must coexist
    // with that actual held table lock rather than waiting for all writers.
    await writer.query('LOCK TABLE app.neighborhood_custom_cohort_capture_jobs IN ROW EXCLUSIVE MODE');
    await validator.query('BEGIN');await validator.query("SET LOCAL lock_timeout='1s'");
    await validator.query(sql);
    const locks=(await validator.query(`SELECT mode FROM pg_locks WHERE pid=pg_backend_pid()
      AND relation='app.neighborhood_custom_cohort_capture_jobs'::regclass AND granted ORDER BY mode`)).rows.map(r=>r.mode);
    assert.ok(locks.includes('ShareUpdateExclusiveLock'));assert.ok(!locks.includes('AccessExclusiveLock'));
    const rows=(await validator.query(`SELECT convalidated FROM pg_constraint
      WHERE conrelid='app.neighborhood_custom_cohort_capture_jobs'::regclass
        AND conname='neighborhood_custom_cohort_capture_jobs_status_check'`)).rows;
    assert.deepEqual(rows,[{convalidated:true}]);
    console.info('[native-selection-wait-status-validation-v2]',{actual_registered_validation_sql:true,
      concurrent_capture_job_writer_lock_compatible:true,no_AccessExclusive_validation_lock:true,constraint_validated:true});
  }finally{
    try{if(validator)await validator.query('ROLLBACK').finally(()=>validator.release());}
    finally{await writer.query('ROLLBACK').finally(()=>writer.release());}
  }
}
