import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment,
  canonicalAssessmentJson } from '../../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodAssessmentRepository, prepareNeighborhoodPublication }
  from '../../src/services/neighborhoodAssessment/assessmentRepository.js';
import { reportedObservationAssessmentFixture } from '../fixtures/reportedObservationAssessmentFixture.js';
import { NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';

const copy = value => JSON.parse(JSON.stringify(value));
const json = canonicalAssessmentJson;
const populationSql = `INSERT INTO app.neighborhood_assessment_populations
  (assessment_id,revision,population_id,member_unit,member_count,unique_property_count,property_link_count,
   completeness,member_set_sha256,population) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`;
const memberSql = `INSERT INTO app.neighborhood_assessment_members
  (assessment_id,revision,population_id,member_id,member_unit,account_ids,member_data)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`;
async function population(client, assessment, value, properties = null, links = null) {
  return client.query(populationSql, [assessment.id, assessment.revision, value.id, value.member_unit, value.member_count,
    properties, links, value.completeness, value.member_set_sha256, json(value)]);
}
async function member(client, assessment, value) {
  return client.query(memberSql, [assessment.id, assessment.revision, value.population_id, value.member_id,
    value.member_unit, value.account_ids, json(value.member_data)]);
}
async function rawAttachment(client, value) {
  return client.query(`INSERT INTO app.neighborhood_assessment_attachments
    (attachment_id,attachment_revision,assessment_id,assessment_revision,report_file_id,organization_id,workflow_type,
     custom_assignment_file_id,uad_workfile_id,application_identity_sha256,binding_digest_sha256,mapped_suggestions,attachment)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]',$12::jsonb)`,
  [value.attachment_id, value.attachment_revision, value.assessment_id, value.assessment_revision, value.report_file_id,
    value.scope.organization_id, value.workflow_type, value.custom_assignment_file_id, value.uad_workfile_id,
    value.application_identity_sha256, value.binding_digest_sha256, json(value)]);
}
async function sandbox(client, action, rejection) {
  await client.query('SAVEPOINT reported_observation_probe');
  try {
    if (rejection) await assert.rejects(action(), rejection);
    else await action();
  } finally { await client.query('ROLLBACK TO SAVEPOINT reported_observation_probe'); }
}

/** Actual migrated PostgreSQL oracle, invoked only after the ordinary isolated
 * native harness guard/fixtures. No connection creation, migration or cleanup.
 * Publication is real; adversarial direct-SQL probes are explicitly rollback
 * contained and do NOT pretend SQL recomputes JavaScript canonical hashes.
 */
export async function checkReportedObservationDatabase({ pool, identity, uad, databaseName }) {
  assert.match(databaseName, /^[a-z][a-z0-9_]*_test$/);
  const probe = await pool.connect();
  let effectiveDate;
  try {
    assert.equal(probe.getTransactionStatus(), 'I');
    verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      probe.connection?.stream?.remoteAddress, databaseName);
    effectiveDate = (await probe.query('SELECT effective_date::text FROM app.appraisal_subject_snapshots WHERE id=$1',
      [identity.scope.subject_snapshot_id])).rows[0].effective_date;
    assert.equal((await probe.query(`SELECT count(*)::integer AS n FROM pg_constraint
      WHERE conrelid='app.neighborhood_assessment_populations'::regclass
        AND conname='neighborhood_observation_population_v2_check'`)).rows[0].n, 1);
  } finally { probe.release(); }
  const fixture = reportedObservationAssessmentFixture({ scope: identity.scope, effectiveDate, accountIds: identity.accounts.slice(0, 2) });
  const input = buildNeighborhoodAssessment(fixture.input);
  const prepared = prepareNeighborhoodPublication(input, fixture.members, fixture.sources);
  assert.equal(prepared.assessment.contract_version, 2);
  const repository = createNeighborhoodAssessmentRepository(pool);
  const request = { operation_id: randomUUID(), effective_date: effectiveDate, data_cutoff: effectiveDate,
    input_signature_sha256: input.input_signature_sha256, payload: { synthetic: true, profile: 'reported-observations-v2' } };
  const { job } = await repository.enqueue(identity.scope, request);
  const claims = await repository.claim();
  assert.equal(claims.length, 1); assert.equal(claims[0].id, job.id);
  const published = await repository.publish(claims[0], input, fixture.members, fixture.sources);
  assert.equal(published.promoted, true);
  const assessment = published.assessment;
  assert.deepEqual(await repository.getCurrent(identity.scope), assessment);
  const stored = (await pool.query(`SELECT member_unit,member_count::text,unique_property_count,property_link_count,population
    FROM app.neighborhood_assessment_populations WHERE assessment_id=$1 AND revision=$2 ORDER BY population_id`,
  [assessment.id, assessment.revision])).rows;
  assert.equal(stored.length, assessment.populations.length);
  for (const row of stored) {
    assert.equal(row.unique_property_count, null); assert.equal(row.property_link_count, null);
    assert.equal(Object.hasOwn(row.population, 'unique_property_count'), false);
    assert.equal(Object.hasOwn(row.population, 'property_link_count'), false);
    const expected = fixture.members.filter(value => value.population_id === row.population.id);
    assert.equal(row.population.unique_account_count, new Set(expected.flatMap(value => value.account_ids)).size);
    assert.equal(row.population.account_link_count, expected.reduce((total, value) => total + value.account_ids.length, 0));
    const page = await repository.getMembers(identity.scope, { assessment_id: assessment.id, revision: assessment.revision,
      population_id: row.population.id, limit: 100 });
    assert.equal(page.members.length, expected.length);
  }
  const checks = ['actual v2 enqueue/claim/publication/reopen preserves account/source-record units and exact JSON counts with NULL legacy property columns'];
  const client = await pool.connect();
  try {
    assert.equal(client.getTransactionStatus(), 'I');
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='8s'");
    // This is a genuine v2 published assessment and builder. Direct INSERT
    // exercises the storage guard, not an unimplemented application mapper.
    const attachment = buildNeighborhoodAttachment(assessment, { ...fixture.target, scope: identity.scope,
      attachment_id: randomUUID(), report_file_id: identity.customReportId, custom_assignment_file_id: identity.customId,
      uad_workfile_id: null, workflow_type: 'custom_appraisal', effective_date: effectiveDate, data_cutoff: effectiveDate });
    await rawAttachment(client, attachment);
    await sandbox(client, () => rawAttachment(client, { ...attachment, attachment_id: randomUUID(),
      workflow_type: 'uad_3_6', custom_assignment_file_id: null, uad_workfile_id: uad.workfileId,
      report_file_id: uad.reportFileId }), /neighborhood_observation_custom_only/);
    await sandbox(client, () => rawAttachment(client, { ...attachment, attachment_id: randomUUID(),
      custom_assignment_file_id: identity.customId + 1000000 }), /target_mismatch|foreign key/);
    checks.push('actual v2 Custom attachment accepted; UAD v2 and a different assignment rejected');
    for (const table of ['revisions', 'populations', 'members', 'sources']) {
      await sandbox(client, () => client.query(`DELETE FROM app.neighborhood_assessment_${table} WHERE assessment_id=$1`,
        [assessment.id]), /immutable/);
    }
    await sandbox(client, () => client.query("UPDATE app.neighborhood_assessment_members SET member_data='{}' WHERE assessment_id=$1",
      [assessment.id]), /immutable/);
    checks.push('published v2 source/member/population/revision evidence remains immutable');
    const raw = () => ({ ...copy(assessment), revision: assessment.revision + 1,
      input_signature_sha256: assessmentEvidenceDigest({ synthetic: randomUUID() }),
      evidence_digest_sha256: assessmentEvidenceDigest({ synthetic_tamper_fixture: randomUUID() }) });
    const insertRevision = value => client.query(`INSERT INTO app.neighborhood_assessment_revisions
      (assessment_id,revision,input_signature_sha256,evidence_digest_sha256,assessment) VALUES($1,$2,$3,$4,$5::jsonb)`,
    [value.id, value.revision, value.input_signature_sha256, value.evidence_digest_sha256, json(value)]);
    const insertSources = async (value, sources = prepared.sources) => {
      for (const source of sources) await client.query(`INSERT INTO app.neighborhood_assessment_sources
        (assessment_id,revision,source_id,source_revision,content_sha256,source_snapshot,source_payload)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [value.id, value.revision, source.snapshot.id,
        source.snapshot.revision, source.snapshot.content_sha256, json(source.snapshot), json(source.payload)]);
    };
    const stage = async (value, members = fixture.members, sources = prepared.sources) => {
      await insertRevision(value); await insertSources(value, sources);
      for (const item of value.populations) await population(client, value, item);
      for (const item of members) await member(client, value, item);
    };
    const commitRevision = value => client.query(`UPDATE app.neighborhood_assessment_revisions SET publication_status='published',
      published_at=clock_timestamp() WHERE assessment_id=$1 AND revision=$2`, [value.id, value.revision]);
    await sandbox(client, async () => { const value = raw(); value.contract_version = 99; await insertRevision(value); },
      /neighborhood_contract_version_unsupported/);
    await sandbox(client, async () => { const value = raw(); value.methodology.configuration.profile_id = 'uninstalled';
      await insertRevision(value); }, /neighborhood_observation_profile_mismatch/);
    await sandbox(client, async () => { const value = raw(); value.contract_version = 1; await insertRevision(value);
      await population(client, value, value.populations[0]); }, /neighborhood_member_contract_version_mismatch/);
    await sandbox(client, async () => { const value = raw(); await insertRevision(value);
      await population(client, value, { ...value.populations[0], member_unit: 'property', kind: 'competitive_stock' }); },
    /neighborhood_member_contract_version_mismatch/);
    checks.push('unknown profile/version and v1/v2 mixed population units fail during staging');
    const accountMember = fixture.members.find(value => value.member_unit === 'account');
    const sourceMember = fixture.members.find(value => value.member_unit === 'source_record');
    assert.ok(accountMember); assert.ok(sourceMember);
    await sandbox(client, async () => { const value = raw(); await insertRevision(value);
      for (const item of value.populations) await population(client, value, item);
      await member(client, value, { ...accountMember, member_id: accountMember.member_id + '-wrong' }); },
    /neighborhood_account_member_identity_mismatch/);
    for (const ids of [[identity.accounts[0], identity.accounts[0]], Array.from({ length: 1001 }, (_, i) => 'SYNTHETIC-' + i)]) {
      await sandbox(client, async () => { const value = raw(); await insertRevision(value);
        for (const item of value.populations) await population(client, value, item);
        await member(client, value, { ...sourceMember, account_ids: ids }); }, /check constraint/);
    }
    checks.push('account identity is exact and source records reject duplicate or more-than-1000 full account interests');
    for (const patch of [{ unique_property_count: null }, { property_link_count: 2 },
      { unique_account_count: '1' }, { unique_account_count: -1 }, { unique_account_count: 1.5 },
      { unique_account_count: null }, { account_link_count: 9007199254740992 },
      { provider_coverage: 'complete' }, { completeness_basis: 'city_inventory' }, { kind: 'transactions' }]) {
      await sandbox(client, async () => { const value = raw(); await insertRevision(value);
        await population(client, value, { ...value.populations[0], ...patch }); }, /check constraint/);
    }
    await sandbox(client, async () => { const value = raw(); await insertRevision(value);
      await population(client, value, value.populations[0], 0, 0); }, /check constraint/);
    await sandbox(client, async () => { const value = raw(); await insertRevision(value);
      const missing = copy(value.populations[0]); delete missing.account_link_count;
      await population(client, value, missing); }, /check constraint/);
    checks.push('legacy counter aliases, malformed account counts and misleading completeness fail storage checks');
    await sandbox(client, async () => { const value = raw(); const sales = value.populations.find(item => item.member_unit === 'source_record');
      assert.ok(sales.unique_account_count > 1); sales.unique_account_count -= 1;
      await stage(value); await commitRevision(value); }, /neighborhood_exact_account_counts_mismatch/);
    await sandbox(client, async () => { const value = raw(); const sales = value.populations.find(item => item.member_unit === 'source_record');
      sales.completeness = 'incomplete'; sales.reasons = ['synthetic_incomplete']; sales.unique_account_count -= 1;
      await stage(value); await commitRevision(value); }, /neighborhood_exact_account_counts_mismatch/);
    await sandbox(client, async () => { const value = raw(); await stage(value, fixture.members.slice(1));
      await commitRevision(value); }, /neighborhood_exact_member_counts_mismatch/);
    await sandbox(client, async () => { const value = raw(); await stage(value, fixture.members, prepared.sources.slice(1));
      await commitRevision(value); }, /neighborhood_source_manifest_mismatch/);
    await sandbox(client, async () => { const value = raw(); await insertRevision(value);
      const sources = copy(prepared.sources); sources[0].snapshot.scope.account_id += '-foreign';
      await insertSources(value, sources); }, /neighborhood_private_source_scope_mismatch/);
    checks.push('publication reconciles all account links/unique counts and refuses missing members or source manifests');
    const legacy = (await client.query(`SELECT
      app.neighborhood_valid_member_accounts(ARRAY['A','B'],'canonical_transaction') AS package,
      app.neighborhood_valid_member_accounts(ARRAY['A','B'],'property') AS property,
      app.neighborhood_valid_member_accounts(ARRAY['A','B'],'allocated_property_sale') AS allocated,
      app.neighborhood_valid_member_accounts(ARRAY['A','B'],'listing') AS listing,
      app.neighborhood_valid_member_accounts(ARRAY['A','B'],'source_record') AS source_record`)).rows[0];
    assert.deepEqual(legacy, { package: true, property: false, allocated: false, listing: false, source_record: true });
    checks.push('original v1 canonical-package and one-account property/listing/allocation predicates stay distinct from v2 source records');
  } finally {
    await client.query('ROLLBACK'); client.release();
  }
  assert.deepEqual(await repository.getCurrent(identity.scope), assessment);
  return { checks };
}
