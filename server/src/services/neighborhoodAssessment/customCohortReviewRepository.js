import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from './contract.js';
import { prepareCohortDecisionCommandV1 } from './cohortDecisionCommand.js';
import { createNeighborhoodCohortBlobRepository, prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextScope } from './customCohortContextContract.js';
import { createCustomCohortContextRepository } from './customCohortContextRepository.js';
import { createCustomCohortSubjectRepository } from './customCohortSubjectRepository.js';
import { loadCustomCohortCaptureInputs } from './customCohortCaptureInputs.js';
import { createCustomCohortDecisionEvidenceResolver } from './customCohortDecisionEvidence.js';

const SAVEPOINT = 'custom_cohort_review_append';
const STATE_SAVEPOINT = 'custom_cohort_review_state';
export const CUSTOM_COHORT_REVIEW_STATE_LIMITS = Object.freeze({
  heads: 5000, record_utf8_bytes: 128_000, aggregate_record_utf8_bytes: 16 * 1024 * 1024,
  output_utf8_bytes: 20 * 1024 * 1024, context_input_utf8_bytes: 2048,
});
const STATE_LIMITS = CUSTOM_COHORT_REVIEW_STATE_LIMITS;
const MAX = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TARGET = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'];
const DEPS = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'];
const frozen = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
};
const same = (a, b) => json(a) === json(b);
function fail(reason) {
  throw Object.assign(new Error(`custom_cohort_review_${reason}`), { code: 'CUSTOM_COHORT_REVIEW_INVALID', reason });
}
function check(ok, reason) { if (!ok) fail(reason); }
function uuid(value) { check(typeof value === 'string' && UUID.test(value), 'identity'); return value; }
function unsigned(value, positive = false) {
  check(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= MAX && (!positive || value !== '0'), 'state_input');
  return BigInt(value);
}
function stateDigest(binding, heads) {
  // Stream the canonical identity body; each envelope is already content-bound.
  // Do not force a potentially 20 MiB record graph through the 1.5 MiB canonicalizer.
  const hash = createHash('sha256').update(`{"binding":${json(binding)},"domain":"custom-cohort-review-state-v1","heads":[`);
  heads.forEach(({ fact_key_sha256, decision_ref, generation }, index) => {
    if (index) hash.update(',');
    hash.update(json({ fact_key_sha256, decision_ref, generation }));
  });
  return hash.update(']}').digest('hex');
}
function one(result) {
  check(result?.rowCount === 1 && result.rows?.length === 1 && result.rows[0], 'storage_conflict');
  return result.rows[0];
}
function optional(result) {
  if (result?.rowCount === 0 && result.rows?.length === 0) return null;
  return one(result);
}
function commandOf(text) {
  const parsed = prepareCohortDecisionCommandV1(text);
  check(parsed.status === 'syntax_valid', 'command');
  check(parsed.command.target_ref.workflow_type === 'custom_appraisal', 'target');
  return parsed.command;
}
function factKey(command) {
  return assessmentEvidenceDigest({ domain: 'custom-cohort-review-fact-slot-v1',
    subject_ref: command.subject_ref, kind: command.claim.kind, qualifier: command.claim.qualifier });
}
function envelope(actor, command, observation) {
  check(BigInt(command.expected_generation) < MAX, 'generation_limit');
  const body = { review_record_version: 1, purpose: 'retained_reviewer_command', authority: 'not_established',
    actor_user_id: actor, generation: String(BigInt(command.expected_generation) + 1n),
    fact_key_sha256: factKey(command), command, claim_observation: observation };
  const text = json(body);
  check(Buffer.byteLength(text) <= 128_000, 'record_limit');
  return { body: frozen(body), text, ref: prepareNeighborhoodCohortBlob(text) };
}

/** Immutable review-command persistence, NOT a supported-fact issuer or HTTP API.
 * The caller must authorize the original authenticated principal with BOTH
 * existing Custom workflow/assignment write policies and independently authorize
 * retained source access before calling (including retries). Actor is supplied
 * separately by that owner, never taken from command JSON or a display name.
 * This repository reopens actual retained bytes, checks current material/draft
 * fences and serializes review generations. It grants no permission, eligibility,
 * source truth, signing or Apply authority. Caller owns finite deadlines and the
 * outer READ COMMITTED transaction and must COMMIT before reporting durability.
 */
export function createCustomCohortReviewRepository(client, scopeJson) {
  check(typeof client?.query === 'function' && typeof client.release === 'function', 'caller_client_required');
  const scope = prepareCustomCohortContextScope(scopeJson), values = TARGET.map(key => scope[key]);
  const query = client.query.bind(client), blobs = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
  const contexts = createCustomCohortContextRepository(client, scopeJson);
  const subjects = createCustomCohortSubjectRepository(client, scopeJson);
  function sameScope(row) { check(TARGET.every(key => row[key] === scope[key]), 'operation_conflict'); }
  function sameTarget(command) {
    check(command.target_ref.report_file_id === scope.report_file_id
      && command.target_ref.workflow_target_id === scope.assignment_file_id, 'target');
  }
  const projection = `organization_id::text,report_file_id::text,assignment_file_id::text,account_id,
    context_id::text,context_revision::text,context_sha256,operation_id::text,generation::text,
    fact_key_sha256,actor_user_id::text,predecessor_operation_id::text,predecessor_content_sha256,
    content_sha256,canonical_utf8_bytes::text`;
  const operation = async id => optional(await query(`/* custom-cohort-review:operation */
    SELECT ${projection} FROM app.custom_neighborhood_review_commands
    WHERE organization_id=$1 AND operation_id=$2`, [scope.organization_id, uuid(id)]));
  function decode(row, text) {
    sameScope(row);
    check(text !== null, 'missing_record');
    const stored = JSON.parse(text), command = commandOf(json(stored.command));
    const rebuilt = envelope(uuid(stored.actor_user_id), command, stored.claim_observation);
    check(rebuilt.text === text && same(rebuilt.ref, { content_sha256: row.content_sha256,
      canonical_utf8_bytes: row.canonical_utf8_bytes }), 'stored_record_mismatch');
    sameTarget(command);
    check(row.operation_id === command.operation_id && row.actor_user_id === stored.actor_user_id
      && row.generation === rebuilt.body.generation && row.fact_key_sha256 === rebuilt.body.fact_key_sha256
      && same(command.expected_context, { context_id: row.context_id, context_revision: row.context_revision, context_sha256: row.context_sha256 })
      && same(command.expected_predecessor, row.predecessor_operation_id === null ? null : {
        decision_id: row.predecessor_operation_id, decision_sha256: row.predecessor_content_sha256 }), 'stored_record_mismatch');
    return { body: rebuilt.body, text, ref: rebuilt.ref };
  }
  function checkStudy(record, context) {
    check(context !== null, 'missing_context');
    check(same(record.body.command.study_ref, { study_id: context.body.context_id, definition_revision: '1',
      definition_sha256: context.body.study_input.content_sha256 }), 'stored_record_mismatch');
  }
  async function read(row) {
    sameScope(row);
    const record = decode(row, await blobs.get(row.content_sha256, row.canonical_utf8_bytes));
    checkStudy(record, await contexts.get(json(record.body.command.expected_context)));
    return record;
  }
  function receipt(record, status) {
    return frozen({ status, authority: 'not_established', durability: 'caller_transaction',
      decision_ref: { decision_id: record.body.command.operation_id, decision_sha256: record.ref.content_sha256 },
      generation: record.body.generation, record: record.body });
  }
  const latestFact = (contextId, key) => query(`/* custom-cohort-review:fact */
    SELECT operation_id::text,content_sha256,generation::text FROM app.custom_neighborhood_review_commands reviews
    WHERE organization_id=$1 AND context_id=$2 AND fact_key_sha256=$3 ORDER BY reviews.generation DESC LIMIT 1`,
  [scope.organization_id, contextId, key]);
  async function append(commandJson, actorUserId) {
    const actor = uuid(actorUserId), command = commandOf(commandJson);
    sameTarget(command); check(BigInt(command.expected_generation) < MAX, 'generation_limit');
    // SAVEPOINT rejects implicit autocommit before any target/evidence read.
    await query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const header = await contexts.get(json(command.expected_context));
      check(header !== null, 'missing_context');
      const retained = await loadCustomCohortCaptureInputs(client, scopeJson,
        Object.fromEntries(DEPS.map(key => [key, header.body[key]])));
      // The existing owner requires READ COMMITTED, locks the real target and
      // material rows, rejects signed/archive state and compares actual inputs.
      const current = await subjects.compareCurrent(retained.subject_reference);
      check(current.status === 'matched', 'stale_subject');
      const actorRow = optional(await query(`/* custom-cohort-review:actor */
        SELECT id::text FROM app_auth.users WHERE id=$1 AND active=true FOR SHARE NOWAIT`, [actor]));
      check(actorRow?.id === actor, 'actor_unavailable');
      const ref = command.expected_context;
      const locked = one(await query(`/* custom-cohort-review:context-lock */
        SELECT context_id::text FROM app.neighborhood_custom_cohort_contexts
        WHERE organization_id=$1 AND report_file_id=$2 AND assignment_file_id=$3::bigint AND account_id=$4
          AND context_id=$5 AND context_revision=$6::smallint AND context_sha256=$7 FOR UPDATE NOWAIT`,
      [...values, ref.context_id, ref.context_revision, ref.context_sha256]));
      check(locked.context_id === ref.context_id, 'context_mismatch');
      // Exact operation replay precedes stale-generation rejection. It returns
      // the original history/diagnostic, never re-applies it or regenerates a
      // previously saved diagnostic using a later implementation revision.
      const previous = await operation(command.operation_id);
      if (previous) {
        const stored = await read(previous);
        check(stored.body.actor_user_id === actor && same(stored.body.command, command), 'operation_conflict');
        await query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        return receipt(stored, 'reused');
      }
      const bound = createCustomCohortDecisionEvidenceResolver({ context_header_json: header.header_blob.canonical_json,
        expected: { context_ref: ref, target: scope, observation_period: retained.study.observation_period },
        retained_inputs: retained.retained_inputs, selection: { revision: 1, included_recorded_group_ids: [] } }).bindCommand(commandJson);
      check(bound.status === 'bound' && same(bound.command, command), 'evidence_binding');
      const record = envelope(actor, command, bound.claim_observation);
      // These statements execute AFTER the context lock, so a committed writer
      // cannot be hidden by the lock statement's earlier READ COMMITTED snapshot.
      const head = optional(await query(`/* custom-cohort-review:head */
        SELECT generation::text FROM app.custom_neighborhood_review_commands reviews
        WHERE organization_id=$1 AND context_id=$2 ORDER BY reviews.generation DESC LIMIT 1`, [scope.organization_id, ref.context_id]));
      check((head?.generation ?? '0') === command.expected_generation, 'generation_conflict');
      const fact = optional(await latestFact(ref.context_id, record.body.fact_key_sha256));
      check(same(command.expected_predecessor, fact ? { decision_id: fact.operation_id, decision_sha256: fact.content_sha256 } : null),
        'predecessor_conflict');
      for (const reference of command.claim.decision_refs) {
        const row = await operation(reference.decision_id);
        check(row && row.context_id === ref.context_id && row.content_sha256 === reference.decision_sha256
          && BigInt(row.generation) <= BigInt(command.expected_generation), 'decision_reference');
        const stored = await read(row), latest = one(await latestFact(ref.context_id, stored.body.fact_key_sha256));
        check(latest.operation_id === reference.decision_id && latest.content_sha256 === reference.decision_sha256, 'superseded_decision_reference');
      }
      await blobs.put(record.text);
      const predecessor = command.expected_predecessor;
      const inserted = one(await query(`/* custom-cohort-review:insert */
        INSERT INTO app.custom_neighborhood_review_commands
          (organization_id,report_file_id,assignment_file_id,account_id,context_id,context_revision,context_sha256,
            operation_id,generation,fact_key_sha256,actor_user_id,predecessor_operation_id,predecessor_content_sha256,
            content_sha256,canonical_utf8_bytes)
        VALUES ($1,$2,$3::bigint,$4,$5,$6::smallint,$7,$8,$9::bigint,$10,$11,$12,$13,$14,$15::integer)
        RETURNING ${projection}`, [...values, ref.context_id, ref.context_revision, ref.context_sha256, command.operation_id,
      record.body.generation, record.body.fact_key_sha256, actor, predecessor?.decision_id ?? null,
      predecessor?.decision_sha256 ?? null, record.ref.content_sha256, record.ref.canonical_utf8_bytes]));
      const checked = await read(inserted);
      check(checked.text === record.text, 'stored_record_mismatch');
      await query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return receipt(checked, 'stored');
    } catch (error) {
      try { await query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`); await query(`RELEASE SAVEPOINT ${SAVEPOINT}`); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'custom_cohort_review_rollback_failed'); }
      throw error;
    }
  }
  /** Complete current reviewer-command heads at this exact context generation.
   * The shared lock excludes append until the caller ends its transaction.
   * Original diagnostics/unknown corrections are preserved, not reinterpreted.
   * Supporting decision refs may name subsequently superseded history; this is
   * not a resolved supported-fact graph, material-freshness check or permission.
   * The record-byte bound excludes the separately bounded fixed context blobs.
   */
  async function getCurrent(contextJson, expectedGeneration) {
    check(typeof contextJson === 'string'
      && Buffer.byteLength(contextJson) <= STATE_LIMITS.context_input_utf8_bytes, 'state_input');
    const ref = prepareCustomCohortContextReference(contextJson);
    const expected = unsigned(expectedGeneration);
    const scopeValues = [...values, ref.context_id, ref.context_revision, ref.context_sha256];
    const where = `organization_id=$1 AND report_file_id=$2 AND assignment_file_id=$3::bigint AND account_id=$4
      AND context_id=$5 AND context_revision=$6::smallint AND context_sha256=$7`;
    const transaction = async () => {
      const state = one(await query(`/* custom-cohort-review:state-transaction */
        SELECT txid_current()::text AS transaction_id,current_setting('transaction_isolation') AS isolation`));
      check(state.isolation === 'read committed' && typeof state.transaction_id === 'string'
        && /^[1-9][0-9]{0,19}$/.test(state.transaction_id), 'caller_transaction_required');
      return state.transaction_id;
    };
    // An autocommit SELECT cannot safely hold a context lock across statements.
    await query(`SAVEPOINT ${STATE_SAVEPOINT}`);
    try {
      const started = await transaction();
      const locked = optional(await query(`/* custom-cohort-review:state-context-lock */
        SELECT organization_id::text,report_file_id::text,assignment_file_id::text,account_id,
          context_id::text,context_revision::text,context_sha256
        FROM app.neighborhood_custom_cohort_contexts WHERE ${where} FOR SHARE NOWAIT`, scopeValues));
      check(locked !== null, 'missing_context'); sameScope(locked);
      check(same(ref, { context_id: locked.context_id, context_revision: locked.context_revision,
        context_sha256: locked.context_sha256 }), 'context_mismatch');
      // Separate statements AFTER the lock use fresh READ COMMITTED snapshots.
      const summary = one(await query(`/* custom-cohort-review:state-summary */
        WITH heads AS (
          SELECT DISTINCT ON (fact_key_sha256) generation,canonical_utf8_bytes
          FROM app.custom_neighborhood_review_commands WHERE ${where}
          ORDER BY fact_key_sha256,generation DESC
        ) SELECT count(*)::text AS head_count,COALESCE(sum(canonical_utf8_bytes),0)::text AS record_utf8_bytes,
          COALESCE(max(generation),0)::text AS generation FROM heads`, scopeValues));
      check(unsigned(summary.generation) === expected, 'generation_conflict');
      const count = unsigned(summary.head_count), bytes = unsigned(summary.record_utf8_bytes);
      check(count <= BigInt(STATE_LIMITS.heads) && bytes <= BigInt(STATE_LIMITS.aggregate_record_utf8_bytes), 'state_limit');
      check((count === 0n) === (expected === 0n) && (count === 0n) === (bytes === 0n), 'stored_record_mismatch');
      const result = await query(`/* custom-cohort-review:state-heads */
        SELECT DISTINCT ON (reviews.fact_key_sha256) ${projection}
        FROM app.custom_neighborhood_review_commands reviews WHERE ${where}
        ORDER BY reviews.fact_key_sha256,reviews.generation DESC LIMIT $8::integer`, [...scopeValues, STATE_LIMITS.heads + 1]);
      check(Array.isArray(result?.rows) && result.rows.length <= STATE_LIMITS.heads, 'state_limit');
      check(result.rowCount === Number(count) && result.rows.length === Number(count), 'stored_record_mismatch');
      const rows = result.rows, keys = new Set(), operations = new Set(), digests = new Set(), generations = new Set();
      let actualBytes = 0n, maximum = 0n;
      for (const row of rows) {
        sameScope(row);
        check(same(ref, { context_id: row.context_id, context_revision: row.context_revision,
          context_sha256: row.context_sha256 }), 'context_mismatch');
        uuid(row.operation_id); uuid(row.actor_user_id);
        check(typeof row.fact_key_sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.fact_key_sha256)
          && typeof row.content_sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.content_sha256), 'stored_record_mismatch');
        const generation = unsigned(row.generation, true), size = unsigned(row.canonical_utf8_bytes, true);
        check(generation <= expected, 'stored_record_mismatch');
        check(size <= BigInt(STATE_LIMITS.record_utf8_bytes), 'state_limit');
        check(!keys.has(row.fact_key_sha256) && !operations.has(row.operation_id)
          && !digests.has(row.content_sha256) && !generations.has(row.generation), 'stored_record_mismatch');
        keys.add(row.fact_key_sha256); operations.add(row.operation_id); digests.add(row.content_sha256); generations.add(row.generation);
        if (row.predecessor_operation_id === null) check(row.predecessor_content_sha256 === null, 'stored_record_mismatch');
        else {
          uuid(row.predecessor_operation_id);
          check(row.predecessor_operation_id !== row.operation_id && typeof row.predecessor_content_sha256 === 'string'
            && /^[a-f0-9]{64}$/.test(row.predecessor_content_sha256), 'stored_record_mismatch');
        }
        actualBytes += size; if (generation > maximum) maximum = generation;
      }
      check(actualBytes === bytes && maximum === expected, 'stored_record_mismatch');
      // Validate the one context/header/dependency set once, not once per head.
      const context = await contexts.get(contextJson); check(context !== null, 'missing_context');
      const records = new Map();
      if (rows.length) {
        const references = rows.map(({ content_sha256, canonical_utf8_bytes }) => ({ content_sha256,
          canonical_utf8_bytes: Number(canonical_utf8_bytes) }));
        const loaded = await query(`/* custom-cohort-review:state-blobs */
          SELECT requested.content_sha256,requested.canonical_utf8_bytes::text AS canonical_utf8_bytes,
            CASE WHEN b.canonical_utf8_bytes=requested.canonical_utf8_bytes
              AND octet_length(b.canonical_utf8)=requested.canonical_utf8_bytes
              THEN b.canonical_utf8 ELSE NULL END AS canonical_utf8
          FROM jsonb_to_recordset($2::jsonb) AS requested(content_sha256 text,canonical_utf8_bytes integer)
          LEFT JOIN app.neighborhood_cohort_evidence_blobs b
            ON b.organization_id=$1 AND b.content_sha256=requested.content_sha256`, [scope.organization_id, json(references)]);
        check(Array.isArray(loaded?.rows) && loaded.rowCount === rows.length && loaded.rows.length === rows.length,
          'stored_record_mismatch');
        const expectedRows = new Map(rows.map(row => [row.content_sha256, row]));
        for (const blob of loaded.rows) {
          const row = expectedRows.get(blob.content_sha256);
          check(row && !records.has(blob.content_sha256) && blob.canonical_utf8_bytes === row.canonical_utf8_bytes,
            'stored_record_mismatch');
          check(typeof blob.canonical_utf8 === 'string', 'missing_record');
          check(Buffer.byteLength(blob.canonical_utf8) === Number(row.canonical_utf8_bytes), 'stored_record_mismatch');
          let actual;
          try { actual = prepareNeighborhoodCohortBlob(blob.canonical_utf8); }
          catch { fail('stored_record_mismatch'); }
          check(same(actual, { content_sha256: row.content_sha256, canonical_utf8_bytes: row.canonical_utf8_bytes }),
            'stored_record_mismatch');
          const record = decode(row, blob.canonical_utf8); checkStudy(record, context);
          records.set(blob.content_sha256, record);
        }
      }
      const heads = rows.map(row => ({ fact_key_sha256: row.fact_key_sha256,
        decision_ref: { decision_id: row.operation_id, decision_sha256: row.content_sha256 },
        generation: row.generation, record: records.get(row.content_sha256).body }))
        .sort((a, b) => a.fact_key_sha256 < b.fact_key_sha256 ? -1 : a.fact_key_sha256 > b.fact_key_sha256 ? 1 : 0);
      const binding = { target: scope, context_ref: ref, generation: expectedGeneration };
      const output = { review_state_version: 1, status: 'current', authority: 'not_established', durability: 'caller_transaction',
        binding, head_count: heads.length, heads, state_sha256: stateDigest(binding, heads) };
      check(Buffer.byteLength(JSON.stringify(output)) <= STATE_LIMITS.output_utf8_bytes, 'state_limit');
      check(await transaction() === started, 'caller_transaction_required');
      await query(`RELEASE SAVEPOINT ${STATE_SAVEPOINT}`);
      return frozen(output);
    } catch (error) {
      try { await query(`ROLLBACK TO SAVEPOINT ${STATE_SAVEPOINT}`); await query(`RELEASE SAVEPOINT ${STATE_SAVEPOINT}`); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'custom_cohort_review_state_rollback_failed'); }
      throw error;
    }
  }
  return Object.freeze({ append, getCurrent,
    async getOperation(operationId) {
      const row = await operation(operationId);
      if (!row || !TARGET.every(key => row[key] === scope[key])) return null;
      return receipt(await read(row), 'retained');
    },
  });
}
