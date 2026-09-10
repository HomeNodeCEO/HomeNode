import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkCustomCohortReportedProposalDatabase } from './customCohortReportedProposalDatabaseChecks.js';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { deriveCustomCohortRecordedProximity } from '../../src/services/neighborhoodAssessment/customCohortRecordedProximity.js';
import { buildCustomCohortPocketRecommendation } from '../../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';

/** A fresh migrated synthetic database only, verified by the existing native
 * fixture. Reuse its current-date capture and accepted report; do not reset an
 * existing account, patch retained evidence or fabricate source authorization.
 * The tested catalog operations themselves must remain read-only. */
export async function checkCustomCohortRecordedProximityDatabase({ pool, databaseName }) {
  const fixture = await checkCustomCohortReportedProposalDatabase({ pool, databaseName,
    discovery: { profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' } });
  const target = fixture.synthetic_target, contextRef = fixture.context_ref;
  const auth = { userId: target.actor_user_id, organizations: [{ organizationId: target.organization_id, roles: ['appraiser'] }] };
  const input = { auth, accountId: target.account_id, assignmentFileId: target.assignment_file_id,
    contextRef, selection: { revision: 1, pockets: [] } };
  const scope = json({ organization_id: target.organization_id, report_file_id: target.report_file_id,
    assignment_file_id: target.assignment_file_id, account_id: target.account_id });
  const readState = async () => {
    const result = await pool.query(`SELECT jsonb_build_object(
      'workfile',(SELECT to_jsonb(w) FROM app.custom_appraisal_workfiles w WHERE assignment_file_id=$1),
      'sections',(SELECT jsonb_agg(to_jsonb(s) ORDER BY section_key) FROM app.custom_appraisal_workfile_sections s WHERE assignment_file_id=$1),
      'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM app.custom_appraisal_workfile_section_history h WHERE assignment_file_id=$1),
      'acceptances',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM app.custom_neighborhood_acceptances a WHERE assignment_file_id=$1)) AS state`,
    [target.assignment_file_id]);
    return createHash('sha256').update(json(result.rows[0].state)).digest('hex');
  };
  const before = await readState(), checks = [];
  let client = await pool.connect(), retained, measured;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL TIME ZONE 'UTC'");
    const header = await createCustomCohortContextRepository(client, scope).get(json(contextRef));
    retained = (await loadCustomCohortCaptureInputs(client, scope, Object.fromEntries(
      ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'].map(key => [key, header.body[key]])))).retained_inputs;
    measured = await deriveCustomCohortRecordedProximity((sql, values) => client.query(sql, values),
      { context_ref: contextRef, retained_inputs: retained });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  assert.equal(measured.status, 'available');
  assert.deepEqual(measured.counts, { accounts: 3, parcels: 3, observed_accounts: 3, unknown_accounts: 0 });
  assert.ok(measured.accounts.find(row => row.account_id === target.account_id).distance_miles < .001);
  const far = measured.accounts.find(row => row.account_id === fixture.expanded_account_id);
  assert.ok(far.distance_miles > 3.99 && far.distance_miles < 4.01);
  const base = { context_ref: contextRef, retained_inputs: retained,
    selection: { revision: 1, included_recorded_group_ids: [] } };
  const old = buildCustomCohortPocketRecommendation(base), next = buildCustomCohortPocketRecommendation({ ...base, recorded_proximity: measured });
  assert.equal(old.policy.revision, 1); assert.equal(next.policy.revision, 2);
  assert.ok(Math.abs(next.all.similarity.known_weight_percent - old.all.similarity.known_weight_percent - 100 / 30) < .0002);
  assert.deepEqual(next.properties.map(row => row.factors.gla), old.properties.map(row => row.factors.gla));
  checks.push('actual native subject and four-mile representative parcel distances use retained EWKB; only proximity adds known weight');

  const calls = [], exposures = [];
  let nativeSeen = false, revokeAfterNative = false, timeoutNative = false;
  const observed = { async connect() {
    const raw = await pool.connect();
    return { release: error => raw.release(error), async query(config) {
      const text = typeof config === 'string' ? config : config.text; calls.push(text);
      if (text.includes('custom-cohort-recorded-proximity:distances')) {
        nativeSeen = true;
        if (timeoutNative) {
          await raw.query("SET LOCAL statement_timeout='1ms'");
          return raw.query('SELECT pg_sleep(0.02)'); // Genuine aborted PG transaction, bounded to 20ms.
        }
      }
      return raw.query(config);
    } };
  } };
  const owner = createCustomCohortContextCapture({ pool: observed,
    authorizeMarketData: async (_client, principal, context, _purpose, options) => {
      assert.equal(principal.userId, target.actor_user_id); assert.equal(context.target.report_file_id, target.report_file_id);
      assert.equal(context.scope.organization_id, target.organization_id); exposures.push(options.exposure);
      return revokeAfterNative && nativeSeen ? { allowed: false }
        : { allowed: true, decision_id: 'synthetic-retained-native', policy_revision: 'native-v1' };
    } });
  const start = calls.length;
  const catalog = await owner.catalog({ ...input, includeRecommendation: true });
  assert.equal(catalog.recommendation.policy.revision, 2);
  assert.deepEqual(catalog.recommendation.recorded_proximity.counts, measured.counts);
  assert.equal(catalog.recommendation.recorded_proximity.radius_metres, '8046.72');
  assert.equal(catalog.recommendation.all.factor_coverage.proximity.observed_count, 3);
  assert.deepEqual(exposures, ['report_observation_catalog', 'report_observation_summary', 'report_observation_catalog', 'report_observation_summary']);
  assert.ok(calls.slice(start).some(sql => sql.includes('custom-cohort-recorded-proximity:distances')));
  // The final unchanged target/rights fence locks its existing row with SELECT
  // FOR UPDATE NOWAIT. That is not an UPDATE statement or a report mutation.
  assert.ok(!calls.slice(start).some(sql => /neighborhood-(cache|membership|closure):|\b(?:INSERT|UPDATE|DELETE)\b/i
    .test(sql.replace(/\bFOR UPDATE(?: NOWAIT)?\b/gi, ''))));
  assert.ok(calls.slice(start).includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.equal(await readState(), before);
  checks.push('actual authorized catalog includes compact v2 proximity in an isolated read-only computation, without fresh source reads or report writes');

  const changed = await owner.catalog({ ...input, includeRecommendation: true,
    selection: { revision: 2, pockets: catalog.catalog.pockets.map(pocket => ({ id: pocket.id, label: pocket.label, account_ids: pocket.account_ids })) } });
  assert.deepEqual({ ...changed.recommendation, binding: null }, { ...catalog.recommendation, binding: null });
  nativeSeen = false;
  await owner.catalog(input);
  await owner.present(input, { includeMap: false });
  assert.equal(nativeSeen, false, 'ordinary catalog and selection-only preview must not compute proximity');
  checks.push('changing selection does not rebase property scores; requests without recommendations perform no native distance work');

  nativeSeen = false; revokeAfterNative = true;
  await assert.rejects(owner.catalog({ ...input, includeRecommendation: true }), /market_data_access_denied/);
  assert.equal(nativeSeen, true); assert.equal(await readState(), before);
  revokeAfterNative = false; nativeSeen = false; timeoutNative = true;
  await assert.rejects(owner.catalog({ ...input, includeRecommendation: true }));
  timeoutNative = false;
  const recovered = await owner.catalog({ ...input, includeRecommendation: true });
  assert.deepEqual(recovered.recommendation, catalog.recommendation);
  assert.equal(await readState(), before);
  checks.push('post-computation source revocation and genuine PostgreSQL timeout cannot publish a partial recommendation; fresh explicit retry succeeds with unchanged report');
  return { checks, fixture, native_proximity: { basis: measured.basis, counts: measured.counts, far_distance_miles: far.distance_miles },
    accepted_state_sha256: before };
}
