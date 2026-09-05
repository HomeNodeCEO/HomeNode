import { createHash, randomUUID } from 'node:crypto';
import { assessmentDate, assessmentEvidenceDigest, buildNeighborhoodAssessment, canonicalAssessmentJson } from './contract.js';
import { assertNeighborhoodJsonbStorage } from './jsonbStorage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const copy = value => {
  const result = JSON.parse(canonicalAssessmentJson(value));
  assertNeighborhoodJsonbStorage(result);
  return result;
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function fail(code) { throw Object.assign(new Error(`neighborhood_${code}`), { code: `neighborhood_${code}` }); }
function objectCopy(value, name) {
  const result = copy(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail(`invalid_${name}`);
  return result;
}
function text(value, name, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`invalid_${name}`);
  return value;
}
function uuid(value, name) { if (!UUID.test(text(value, name, 36))) fail(`invalid_${name}`); return value.toLowerCase(); }
function hash(value, name) { if (!HASH.test(text(value, name, 64))) fail(`invalid_${name}`); return value; }
function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`invalid_${name}`);
  return value;
}
function scopeOf(value) {
  return { organization_id: uuid(value?.organization_id, 'organization_id'), appraisal_case_id: uuid(value?.appraisal_case_id, 'appraisal_case_id'),
    subject_snapshot_id: uuid(value?.subject_snapshot_id, 'subject_snapshot_id'), account_id: text(value?.account_id, 'account_id', 100) };
}
const scopeValues = scope => [scope.organization_id, scope.appraisal_case_id, scope.subject_snapshot_id, scope.account_id];
const one = (result, code) => { if (result.rowCount !== 1 || result.rows.length !== 1) fail(code); return result.rows[0]; };
const affected = (result, code) => { if (result.rowCount !== 1) fail(code); };

/** Streams the canonical sorted ID array, so exact large member sets do not need
 * one oversized summary JSON document. The digest agrees with contract fixtures.
 */
export function neighborhoodMemberSetDigest(ids) {
  if (!Array.isArray(ids) || ids.length > 100_000) fail('member_limit');
  const sorted = ids.map(id => text(id, 'member_id')).sort(compare);
  if (new Set(sorted).size !== sorted.length) fail('duplicate_member');
  const digest = createHash('sha256').update('[');
  sorted.forEach((id, index) => { if (index) digest.update(','); digest.update(canonicalAssessmentJson(id)); });
  return digest.update(']').digest('hex');
}

function normalizedMember(value) {
  const row = objectCopy(value, 'member');
  if (Object.keys(row).some(key => !['population_id', 'member_id', 'member_unit', 'account_ids', 'member_data'].includes(key))) fail('member_field');
  text(row.population_id, 'population_id', 200); text(row.member_id, 'member_id');
  if (!['property', 'canonical_transaction', 'allocated_property_sale', 'listing'].includes(row.member_unit)) fail('member_unit');
  if (!Array.isArray(row.account_ids) || row.account_ids.length < 1 || row.account_ids.length > 1000 ||
      (row.member_unit !== 'canonical_transaction' && row.account_ids.length !== 1)) fail('member_accounts');
  row.account_ids = row.account_ids.map(id => text(id, 'member_account', 100)).sort(compare);
  if (new Set(row.account_ids).size !== row.account_ids.length ||
      (row.member_unit === 'property' && row.account_ids[0] !== row.member_id)) fail('member_accounts');
  row.member_data = objectCopy(row.member_data, 'member_data');
  const refs = row.member_data.source_refs;
  if (!Array.isArray(refs) || refs.length > 1000 || new Set(refs).size !== refs.length) fail('member_sources');
  row.member_data.source_refs = refs.map(id => text(id, 'member_source', 200)).sort(compare);
  return row;
}

function* memberBatches(members) {
  let encoded = [], bytes = 2, storageBytes = 2;
  for (const member of members) {
    const row = canonicalAssessmentJson(member);
    const size = Buffer.byteLength(row);
    const storageSize = assertNeighborhoodJsonbStorage(member);
    if (storageSize + 2 > 2_000_000) fail('member_row_storage_bytes');
    if (size + 2 > 1_500_000) fail('member_row_bytes');
    if (encoded.length && (encoded.length === 250 || bytes + size + 1 > 1_400_000 || storageBytes + storageSize + 2 > 2_000_000)) {
      yield `[${encoded.join(',')}]`; encoded = []; bytes = 2; storageBytes = 2;
    }
    encoded.push(row); bytes += size + 1; storageBytes += storageSize + 2;
  }
  if (encoded.length) yield `[${encoded.join(',')}]`;
}

/** Bind exactly the rows that are stored, including their captured facts, not
 * merely their IDs. Add this digest in a versioned population-member capture
 * source before constructing/enqueuing the assessment. The source metadata is
 * supplied by the caller; this helper invents no provenance or capture dates.
 */
export function neighborhoodMemberContentDigest(members) {
  if (!Array.isArray(members) || members.length > 100_000) fail('member_limit');
  const rows = members.map(normalizedMember).sort((a, b) => compare(a.population_id, b.population_id) || compare(a.member_id, b.member_id));
  const digest = createHash('sha256').update('[');
  let bytes = 0;
  rows.forEach((row, index) => {
    if (index && row.population_id === rows[index - 1].population_id && row.member_id === rows[index - 1].member_id) fail('duplicate_member');
    const encoded = canonicalAssessmentJson(row); bytes += Buffer.byteLength(encoded);
    if (bytes > 32_000_000) fail('publication_bytes');
    if (index) digest.update(','); digest.update(encoded);
  });
  return digest.update(']').digest('hex');
}

export function prepareNeighborhoodPublication(assessmentInput, members, sources) {
  const assessment = buildNeighborhoodAssessment(assessmentInput);
  let storageBytes = assertNeighborhoodJsonbStorage(assessment);
  if (!Array.isArray(members) || members.length > 100_000 || !Array.isArray(sources) || sources.length > 1000) fail('publication_limit');
  const populations = new Map(assessment.populations.map(item => [item.id, { item, members: [], rows: [], accounts: new Set(), links: 0 }]));
  const sourceIds = new Set(assessment.source_snapshots.map(source => source.id));
  let bytes = 0;
  const accountLinks = { count: 0 };
  const normalizedMembers = members.map(member => {
    const row = normalizedMember(member);
    const encoded = canonicalAssessmentJson(row);
    if (Buffer.byteLength(encoded) + 2 > 1_500_000) fail('member_row_bytes');
    bytes += Buffer.byteLength(encoded);
    if (bytes > 32_000_000) fail('publication_bytes');
    const rowStorageBytes = assertNeighborhoodJsonbStorage(row);
    if (rowStorageBytes + 2 > 2_000_000) fail('member_row_storage_bytes');
    storageBytes += rowStorageBytes;
    if (storageBytes > 64_000_000) fail('publication_storage_bytes');
    const population = populations.get(row.population_id);
    if (!population || row.member_unit !== population.item.member_unit) fail('member_population');
    accountLinks.count += row.account_ids.length;
    if (accountLinks.count > 250_000) fail('member_links_limit');
    const refs = row.member_data?.source_refs;
    if (!Array.isArray(refs) || refs.length > 1000 || refs.some(id => !sourceIds.has(id) || !population.item.source_refs.includes(id)) || new Set(refs).size !== refs.length ||
        (population.item.completeness === 'complete' && !refs.length)) fail('member_sources');
    population.members.push(row.member_id);
    population.rows.push(row);
    row.account_ids.forEach(id => population.accounts.add(id));
    population.links += row.account_ids.length;
    return row;
  }).sort((a, b) => compare(a.population_id, b.population_id) || compare(a.member_id, b.member_id));
  for (const { item, members: ids, accounts, links } of populations.values()) {
    const memberDigest = neighborhoodMemberSetDigest(ids);
    if (item.completeness === 'complete' && (item.member_count !== ids.length || item.unique_property_count !== accounts.size ||
        item.property_link_count !== links || item.member_set_sha256 !== memberDigest)) fail('population_membership_mismatch');
    if (item.member_count !== null && item.member_count !== ids.length) fail('population_member_count');
    if (item.member_set_sha256 !== null && item.member_set_sha256 !== memberDigest) fail('population_member_digest');
  }
  const bySource = new Map();
  for (const source of sources) {
    if (!sourceIds.has(source?.id) || bySource.has(source.id)) fail('publication_source');
    const payload = objectCopy(source.payload, 'source_payload');
    bytes += Buffer.byteLength(canonicalAssessmentJson(payload));
    if (bytes > 64_000_000) fail('publication_bytes');
    storageBytes += assertNeighborhoodJsonbStorage(payload);
    if (storageBytes > 64_000_000) fail('publication_storage_bytes');
    bySource.set(source.id, { id: source.id, payload, digest: assessmentEvidenceDigest(payload) });
  }
  const normalizedSources = assessment.source_snapshots.map(snapshot => {
    const source = bySource.get(snapshot.id);
    if (!source || source.digest !== snapshot.content_sha256) fail('source_content_mismatch');
    return { snapshot, payload: source.payload };
  });
  for (const { item, rows } of populations.values()) {
    const captures = item.source_refs.map(id => bySource.get(id)?.payload).filter(payload =>
      payload?.capture_type === 'neighborhood_population_members_v1' && payload.population_id === item.id);
    if (captures.length !== 1 || captures[0].member_unit !== item.member_unit ||
        captures[0].member_content_sha256 !== neighborhoodMemberContentDigest(rows)) fail('member_content_mismatch');
  }
  return freeze({ assessment, members: normalizedMembers, sources: normalizedSources });
}

async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '8s'`);
    await client.query(`SET LOCAL lock_timeout = '3s'`);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function verifyScope(client, scope, effectiveDate = null) {
  const row = one(await client.query(`/* neighborhood:scope */
    SELECT c.effective_date::text AS case_date, s.effective_date::text AS snapshot_date,
           COALESCE(s.effective_date, c.effective_date)::text AS effective_date
      FROM app.appraisal_cases c JOIN app.appraisal_subject_snapshots s ON s.appraisal_case_id = c.id
     WHERE c.organization_id = $1 AND c.id = $2 AND s.id = $3 AND c.account_id = $4
     FOR SHARE OF c, s`, scopeValues(scope)), 'scope_mismatch');
  if (row.case_date && row.snapshot_date && row.case_date !== row.snapshot_date) fail('effective_date_conflict');
  if (!row.effective_date) fail('effective_date_unresolved');
  if (effectiveDate !== null && row.effective_date !== effectiveDate) fail('effective_date_conflict');
  return row;
}

async function lockedHead(client, id) {
  return one(await client.query('/* neighborhood:lock-head */ SELECT * FROM app.neighborhood_assessments WHERE id=$1 FOR UPDATE', [id]), 'assessment_not_found');
}
function claimValues(claim) { return [uuid(claim?.id, 'job_id'), uuid(claim?.claim_token, 'claim_token'), integer(claim?.attempts, 'attempts', 1, 10)]; }
const fence = `id=$1 AND claim_token=$2 AND attempts=$3 AND status='running' AND lease_expires_at > clock_timestamp()`;

/** No route/auth middleware, provider calls, DDL, or implicit job startup.
 * Entry points receive scope from an already-authorized owner adapter. The
 * relational checks below are additional integrity checks, not user permissions.
 */
export function createNeighborhoodAssessmentRepository(pool) {
  if (typeof pool?.connect !== 'function' || typeof pool?.query !== 'function') fail('invalid_pool');
  return {
    async enqueue(scopeInput, request) {
      const scope = scopeOf(scopeInput);
      const operationId = uuid(request?.operation_id, 'operation_id');
      const effectiveDate = assessmentDate(request?.effective_date);
      const cutoff = assessmentDate(request?.data_cutoff, 'data_cutoff');
      if (cutoff > effectiveDate) fail('data_cutoff');
      const inputSignature = hash(request?.input_signature_sha256, 'input_signature');
      const payload = objectCopy(request?.payload, 'request_payload');
      const maxAttempts = integer(request?.max_attempts ?? 3, 'max_attempts', 1, 10);
      const requestDigest = assessmentEvidenceDigest({ scope, effective_date: effectiveDate, data_cutoff: cutoff, input_signature_sha256: inputSignature, payload, max_attempts: maxAttempts });
      return transaction(pool, async client => {
        await verifyScope(client, scope, effectiveDate);
        await client.query(`/* neighborhood:ensure-head */ INSERT INTO app.neighborhood_assessments
          (id, organization_id, appraisal_case_id, subject_snapshot_id, account_id) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (organization_id,appraisal_case_id,subject_snapshot_id,account_id) DO NOTHING`, [randomUUID(), ...scopeValues(scope)]);
        const head = one(await client.query(`/* neighborhood:head-for-scope */ SELECT * FROM app.neighborhood_assessments
          WHERE organization_id=$1 AND appraisal_case_id=$2 AND subject_snapshot_id=$3 AND account_id=$4 FOR UPDATE`, scopeValues(scope)), 'assessment_not_found');
        const previous = await client.query(`/* neighborhood:request-operation */ SELECT * FROM app.neighborhood_assessment_requests
          WHERE assessment_id=$1 AND operation_id=$2`, [head.id, operationId]);
        if (previous.rows.length) {
          const operation = one(previous, 'request_conflict');
          if (operation.request_digest_sha256 !== requestDigest) fail('request_conflict');
          const job = one(await client.query(`/* neighborhood:request-job */ SELECT * FROM app.neighborhood_assessment_jobs
            WHERE assessment_id=$1 AND id=$2`, [head.id, operation.job_id]), 'job_not_found');
          return { job, reused: operation.job_reused, operation_id: operationId,
            request_generation: operation.request_generation, replayed: true };
        }
        const generation = integer(head.request_generation + 1, 'request_generation', 1, 2_147_483_647);
        const recordOperation = async (job, reused) => {
          affected(await client.query(`/* neighborhood:record-request */ INSERT INTO app.neighborhood_assessment_requests
            (assessment_id,operation_id,request_digest_sha256,job_id,request_generation,job_reused)
            VALUES ($1,$2,$3,$4,$5,$6)`, [head.id, operationId, requestDigest, job.id, generation, reused]), 'request_not_recorded');
          return { job, reused, operation_id: operationId, request_generation: generation, replayed: false };
        };
        const existing = await client.query('/* neighborhood:deduplicate */ SELECT * FROM app.neighborhood_assessment_jobs WHERE assessment_id=$1 AND input_signature_sha256=$2', [head.id, inputSignature]);
        if (existing.rows.length) {
          const job = existing.rows[0];
          if (job.request_digest_sha256 !== requestDigest) fail('request_conflict');
          affected(await client.query(`/* neighborhood:reuse-intent */ UPDATE app.neighborhood_assessments
            SET request_generation=$2,requested_job_id=$3,
              current_revision=CASE WHEN $4::integer IS NOT NULL THEN $4 ELSE current_revision END,
              updated_at=clock_timestamp() WHERE id=$1`,
          [head.id, generation, job.id, job.status === 'succeeded' ? job.result_revision : null]), 'head_changed');
          return recordOperation(job, true);
        }
        const job = one(await client.query(`/* neighborhood:enqueue */ INSERT INTO app.neighborhood_assessment_jobs
          (id,assessment_id,input_signature_sha256,request_digest_sha256,request_payload,effective_date,data_cutoff,request_generation,max_attempts)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING *`,
        [randomUUID(), head.id, inputSignature, requestDigest, canonicalAssessmentJson(payload), effectiveDate, cutoff, generation, maxAttempts]), 'job_not_created');
        affected(await client.query(`/* neighborhood:request-pointer */ UPDATE app.neighborhood_assessments
          SET request_generation=$2,requested_job_id=$3,updated_at=clock_timestamp() WHERE id=$1`, [head.id, generation, job.id]), 'head_changed');
        return recordOperation(job, false);
      });
    },

    async claim({ limit = 1, lease_seconds = 120 } = {}) {
      integer(limit, 'claim_limit', 1, 10); integer(lease_seconds, 'lease_seconds', 15, 900);
      return transaction(pool, async client => {
        await client.query(`/* neighborhood:exhausted */ WITH expired AS (
          SELECT id FROM app.neighborhood_assessment_jobs WHERE status='running' AND lease_expires_at<=clock_timestamp()
            AND attempts>=max_attempts ORDER BY lease_expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
        ) UPDATE app.neighborhood_assessment_jobs j
          SET status='failed',claim_token=NULL,lease_expires_at=NULL,last_error_code='attempts_exhausted',updated_at=clock_timestamp()
          FROM expired WHERE j.id=expired.id`, [limit]);
        return (await client.query(`/* neighborhood:claim */ WITH due AS (
          SELECT id FROM app.neighborhood_assessment_jobs
           WHERE attempts<max_attempts AND ((status IN ('queued','retry') AND run_after<=clock_timestamp())
             OR (status='running' AND lease_expires_at<=clock_timestamp()))
           ORDER BY run_after,id LIMIT $1 FOR UPDATE SKIP LOCKED
        ) UPDATE app.neighborhood_assessment_jobs j
          SET status='running',attempts=attempts+1,claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+$2*interval '1 second',updated_at=clock_timestamp()
          FROM due WHERE j.id=due.id RETURNING j.*`, [limit, lease_seconds])).rows;
      });
    },

    async heartbeat(claim, { lease_seconds = 120, checkpoint = {} } = {}) {
      integer(lease_seconds, 'lease_seconds', 15, 900);
      const values = [...claimValues(claim), lease_seconds, canonicalAssessmentJson(objectCopy(checkpoint, 'checkpoint'))];
      return transaction(pool, async client => {
        affected(await client.query(`/* neighborhood:heartbeat */ UPDATE app.neighborhood_assessment_jobs
          SET lease_expires_at=clock_timestamp()+$4*interval '1 second',checkpoint=$5::jsonb,updated_at=clock_timestamp()
          WHERE ${fence} RETURNING id`, values), 'claim_lost');
      });
    },

    async fail(claim, errorCode, { retry_seconds = 60 } = {}) {
      if (!/^[a-z][a-z0-9_]{0,99}$/.test(errorCode)) fail('invalid_error_code');
      integer(retry_seconds, 'retry_seconds', 1, 3600);
      const values = [...claimValues(claim), errorCode, retry_seconds];
      return transaction(pool, async client => {
        affected(await client.query(`/* neighborhood:failure */ UPDATE app.neighborhood_assessment_jobs
          SET status=CASE WHEN attempts<max_attempts THEN 'retry' ELSE 'failed' END,claim_token=NULL,lease_expires_at=NULL,
            run_after=clock_timestamp()+$5*interval '1 second',last_error_code=$4,updated_at=clock_timestamp()
          WHERE ${fence} RETURNING id`, values), 'claim_lost');
      });
    },

    async cancel(scopeInput, jobId, { expected_request_generation: expectedGeneration } = {}) {
      const scope = scopeOf(scopeInput); jobId = uuid(jobId, 'job_id');
      integer(expectedGeneration, 'expected_request_generation', 1, 2_147_483_647);
      return transaction(pool, async client => {
        await verifyScope(client, scope);
        const head = one(await client.query(`/* neighborhood:head-by-job */ SELECT h.* FROM app.neighborhood_assessments h
          JOIN app.neighborhood_assessment_jobs j ON j.assessment_id=h.id WHERE j.id=$5
          AND h.organization_id=$1 AND h.appraisal_case_id=$2 AND h.subject_snapshot_id=$3 AND h.account_id=$4 FOR UPDATE OF h`, [...scopeValues(scope), jobId]), 'job_not_found');
        if (head.request_generation !== expectedGeneration || head.requested_job_id !== jobId) fail('intent_conflict');
        const result = await client.query(`/* neighborhood:cancel */ UPDATE app.neighborhood_assessment_jobs
          SET status='cancelled',claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND assessment_id=$2 AND status IN ('queued','retry','running') RETURNING id`, [jobId, head.id]);
        return { cancelled: result.rowCount === 1 };
      });
    },

    async publish(claim, assessmentInput, members, sources) {
      const prepared = prepareNeighborhoodPublication(assessmentInput, members, sources);
      const scope = scopeOf(prepared.assessment.scope);
      const values = claimValues(claim);
      return transaction(pool, async client => {
        await verifyScope(client, scope, prepared.assessment.effective_date);
        const lookup = one(await client.query('/* neighborhood:job-head */ SELECT assessment_id FROM app.neighborhood_assessment_jobs WHERE id=$1', [values[0]]), 'job_not_found');
        const head = await lockedHead(client, lookup.assessment_id);
        if (canonicalAssessmentJson(scopeOf(head)) !== canonicalAssessmentJson(scope)) fail('scope_mismatch');
        const job = one(await client.query(`/* neighborhood:publication-fence */ SELECT *,effective_date::text AS effective_date,
          data_cutoff::text AS data_cutoff FROM app.neighborhood_assessment_jobs WHERE ${fence} FOR UPDATE`, values), 'claim_lost');
        if (job.input_signature_sha256 !== prepared.assessment.input_signature_sha256 ||
            String(job.effective_date).slice(0, 10) !== prepared.assessment.effective_date ||
            String(job.data_cutoff).slice(0, 10) !== prepared.assessment.data_cutoff) fail('job_input_mismatch');
        const revision = integer(head.next_revision, 'next_revision', 1, 2_147_483_646);
        const assessment = buildNeighborhoodAssessment({ ...prepared.assessment, id: head.id, revision });
        await client.query(`/* neighborhood:revision */ INSERT INTO app.neighborhood_assessment_revisions
          (assessment_id,revision,input_signature_sha256,evidence_digest_sha256,assessment,publication_status)
          VALUES ($1,$2,$3,$4,$5::jsonb,'staging')`, [head.id, revision, assessment.input_signature_sha256, assessment.evidence_digest_sha256, canonicalAssessmentJson(assessment)]);
        for (const { snapshot, payload } of prepared.sources) {
          await client.query(`/* neighborhood:source */ INSERT INTO app.neighborhood_assessment_sources
            (assessment_id,revision,source_id,source_revision,content_sha256,source_snapshot,source_payload)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
          [head.id, revision, snapshot.id, snapshot.revision, snapshot.content_sha256, canonicalAssessmentJson(snapshot), canonicalAssessmentJson(payload)]);
        }
        for (const population of assessment.populations) {
          await client.query(`/* neighborhood:population */ INSERT INTO app.neighborhood_assessment_populations
            (assessment_id,revision,population_id,member_unit,member_count,unique_property_count,property_link_count,completeness,member_set_sha256,population)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [head.id, revision, population.id, population.member_unit, population.member_count, population.unique_property_count,
            population.property_link_count, population.completeness, population.member_set_sha256, canonicalAssessmentJson(population)]);
        }
        for (const batch of memberBatches(prepared.members)) {
          await client.query(`/* neighborhood:members */ INSERT INTO app.neighborhood_assessment_members
            (assessment_id,revision,population_id,member_id,member_unit,account_ids,member_data)
            SELECT $1,$2,population_id,member_id,member_unit,account_ids,member_data FROM jsonb_to_recordset($3::jsonb)
              AS item(population_id text,member_id text,member_unit text,account_ids text[],member_data jsonb)`,
          [head.id, revision, batch]);
        }
        affected(await client.query(`/* neighborhood:publish */ UPDATE app.neighborhood_assessment_revisions
          SET publication_status='published',published_at=clock_timestamp()
          WHERE assessment_id=$1 AND revision=$2 AND publication_status='staging'`, [head.id, revision]), 'publication_conflict');
        // A -> B -> A reuses immutable job A but advances the head's intent.
        // Its original creation generation must not invalidate that new intent.
        const promoted = head.requested_job_id === job.id;
        affected(await client.query(`/* neighborhood:promote */ UPDATE app.neighborhood_assessments SET next_revision=$2,
          current_revision=CASE WHEN requested_job_id=$3 THEN $4 ELSE current_revision END,
          updated_at=clock_timestamp() WHERE id=$1 AND next_revision=$4`, [head.id, revision + 1, job.id, revision]), 'publication_conflict');
        affected(await client.query(`/* neighborhood:finish */ UPDATE app.neighborhood_assessment_jobs
          SET status='succeeded',result_revision=$4,claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE ${fence}`, [...values, revision]), 'claim_lost');
        return { assessment, promoted };
      });
    },

    async getCurrent(scopeInput) {
      const scope = scopeOf(scopeInput);
      return transaction(pool, async client => {
        await verifyScope(client, scope);
        const result = await client.query(`/* neighborhood:current */ SELECT r.assessment FROM app.neighborhood_assessments h
          JOIN app.neighborhood_assessment_revisions r ON r.assessment_id=h.id AND r.revision=h.current_revision AND r.publication_status='published'
          WHERE h.organization_id=$1 AND h.appraisal_case_id=$2 AND h.subject_snapshot_id=$3 AND h.account_id=$4`, scopeValues(scope));
        return result.rows[0]?.assessment ?? null;
      });
    },

    async getJob(scopeInput, jobId) {
      const scope = scopeOf(scopeInput); uuid(jobId, 'job_id');
      return transaction(pool, async client => {
        await verifyScope(client, scope);
        const result = await client.query(`/* neighborhood:job-status */ SELECT j.id,j.assessment_id,j.status,j.attempts,j.max_attempts,
          j.request_generation,j.result_revision,j.last_error_code,j.run_after,j.updated_at
          FROM app.neighborhood_assessment_jobs j JOIN app.neighborhood_assessments h ON h.id=j.assessment_id
          WHERE h.organization_id=$1 AND h.appraisal_case_id=$2 AND h.subject_snapshot_id=$3 AND h.account_id=$4 AND j.id=$5`, [...scopeValues(scope), jobId]);
        return result.rows[0] ?? null;
      });
    },

    async getMembers(scopeInput, { assessment_id, revision, population_id, after = null, limit = 250 }) {
      const scope = scopeOf(scopeInput); uuid(assessment_id, 'assessment_id'); integer(revision, 'revision', 1, 2_147_483_647);
      text(population_id, 'population_id'); if (after !== null) text(after, 'after'); integer(limit, 'member_page_limit', 1, 500);
      return transaction(pool, async client => {
        await verifyScope(client, scope);
        const result = await client.query(`/* neighborhood:member-page */ SELECT m.member_id,m.member_unit,m.account_ids,m.member_data
          FROM app.neighborhood_assessment_members m JOIN app.neighborhood_assessments h ON h.id=m.assessment_id
          JOIN app.neighborhood_assessment_revisions r ON r.assessment_id=m.assessment_id AND r.revision=m.revision AND r.publication_status='published'
          WHERE h.organization_id=$1 AND h.appraisal_case_id=$2 AND h.subject_snapshot_id=$3 AND h.account_id=$4
            AND m.assessment_id=$5 AND m.revision=$6 AND m.population_id=$7 AND ($8::text IS NULL OR m.member_id COLLATE "C">$8 COLLATE "C")
          ORDER BY m.member_id COLLATE "C" LIMIT $9`, [...scopeValues(scope), assessment_id, revision, population_id, after, limit + 1]);
        const rows = result.rows.slice(0, limit);
        return { members: rows, next_cursor: result.rows.length > limit ? rows.at(-1).member_id : null };
      });
    },
  };
}
