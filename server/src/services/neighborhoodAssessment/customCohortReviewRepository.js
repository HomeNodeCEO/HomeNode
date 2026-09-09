import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from './contract.js';
import { prepareCohortDecisionCommandV1 } from './cohortDecisionCommand.js';
import { createNeighborhoodCohortBlobRepository, prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortContextScope } from './customCohortContextContract.js';
import { createCustomCohortContextRepository } from './customCohortContextRepository.js';
import { createCustomCohortSubjectRepository } from './customCohortSubjectRepository.js';
import { loadCustomCohortCaptureInputs } from './customCohortCaptureInputs.js';
import { createCustomCohortDecisionEvidenceResolver } from './customCohortDecisionEvidence.js';

const SAVEPOINT = 'custom_cohort_review_append';
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
  async function read(row) {
    sameScope(row);
    const text = await blobs.get(row.content_sha256, row.canonical_utf8_bytes);
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
    const context = await contexts.get(json(command.expected_context));
    check(context !== null, 'missing_context');
    check(same(command.study_ref, { study_id: context.body.context_id, definition_revision: '1',
      definition_sha256: context.body.study_input.content_sha256 }), 'stored_record_mismatch');
    return { body: rebuilt.body, text, ref: rebuilt.ref };
  }
  function receipt(record, status) {
    return frozen({ status, authority: 'not_established', durability: 'caller_transaction',
      decision_ref: { decision_id: record.body.command.operation_id, decision_sha256: record.ref.content_sha256 },
      generation: record.body.generation, record: record.body });
  }
  const latestFact = (contextId, key) => query(`/* custom-cohort-review:fact */
    SELECT operation_id::text,content_sha256,generation::text FROM app.custom_neighborhood_review_commands
    WHERE organization_id=$1 AND context_id=$2 AND fact_key_sha256=$3 ORDER BY generation DESC LIMIT 1`,
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
        SELECT generation::text FROM app.custom_neighborhood_review_commands
        WHERE organization_id=$1 AND context_id=$2 ORDER BY generation DESC LIMIT 1`, [scope.organization_id, ref.context_id]));
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
  return Object.freeze({ append,
    async getOperation(operationId) {
      const row = await operation(operationId);
      if (!row || !TARGET.every(key => row[key] === scope[key])) return null;
      return receipt(await read(row), 'retained');
    },
  });
}
