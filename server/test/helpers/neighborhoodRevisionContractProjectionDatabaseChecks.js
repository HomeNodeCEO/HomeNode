import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, canonicalAssessmentJson }
  from '../../src/services/neighborhoodAssessment/contract.js';
import { neighborhoodMemberContentDigest, neighborhoodMemberSetDigest, prepareNeighborhoodPublication }
  from '../../src/services/neighborhoodAssessment/assessmentRepository.js';
import { neighborhoodAssessmentFixture } from '../fixtures/neighborhoodAssessmentFixture.js';
import { reportedObservationAssessmentFixture } from '../fixtures/reportedObservationAssessmentFixture.js';
import { NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';

const json = canonicalAssessmentJson;
const date = '2024-06-30';
const copy = value => JSON.parse(JSON.stringify(value));
const migrationUrl = new URL('../../migrations/20261019_neighborhood_revision_contract_projection.sql', import.meta.url);
const previousUrl = new URL('../../migrations/20261017_neighborhood_reported_observations.sql', import.meta.url);
const body = (sql, name) => {
  const marker = `CREATE OR REPLACE FUNCTION app.${name}()`;
  assert.equal(sql.split(marker).length, 2);
  const start = sql.indexOf(marker), end = sql.indexOf('END $$;', start);
  assert.ok(end > start);
  return sql.slice(start, end + 7);
};
const settings = async client => (await client.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
  current_setting('statement_timeout') AS statement_timeout`)).rows[0];
async function checkedClient(pool, databaseName) {
  const client = await pool.connect();
  try {
    assert.equal(client.getTransactionStatus(), 'I');
    verifyNeighborhoodCiConnection((await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      client.connection?.stream?.remoteAddress, databaseName);
    return client;
  } catch (error) { client.release(); throw error; }
}
async function probe(client, action, rejection) {
  await client.query('SAVEPOINT contract_projection_probe');
  try {
    if (rejection) await assert.rejects(action, rejection);
    else await action();
  } finally { await client.query('ROLLBACK TO SAVEPOINT contract_projection_probe'); }
}
async function identityFixture(client) {
  const organization_id = randomUUID(), actor = randomUUID(), appraisal_case_id = randomUUID(), subject_snapshot_id = randomUUID();
  const accounts = Array.from({ length: 4 }, () => `guard-${randomUUID()}`);
  const scope = { organization_id, appraisal_case_id, subject_snapshot_id, account_id: accounts[0] };
  await client.query(`INSERT INTO app_auth.organizations(id,legal_name,display_name)
    VALUES($1,'Synthetic projection guard','Synthetic projection guard')`, [organization_id]);
  await client.query(`INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic projection reviewer')`,
    [actor, `${actor}@example.test`]);
  for (const account of accounts) await client.query(`INSERT INTO core.accounts(account_id,address,city)
    VALUES($1,'Synthetic projection fixture','Dallas')`, [account]);
  await client.query(`INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date,created_by_user_id)
    VALUES($1,$2,$3,$4,$5)`, [appraisal_case_id, organization_id, accounts[0], date, actor]);
  await client.query(`INSERT INTO app.appraisal_subject_snapshots
    (id,appraisal_case_id,snapshot_version,effective_date,subject_data,created_by_user_id)
    VALUES($1,$2,1,$3,'{"synthetic":true}',$4)`, [subject_snapshot_id, appraisal_case_id, date, actor]);
  const id = randomUUID();
  await client.query(`INSERT INTO app.neighborhood_assessments
    (id,organization_id,appraisal_case_id,subject_snapshot_id,account_id) VALUES($1,$2,$3,$4,$5)`,
  [id, organization_id, appraisal_case_id, subject_snapshot_id, accounts[0]]);
  return { id, scope, accounts };
}

// Shared by the native oracle and its ordinary, database-free fixture test.
export function projectionPublicationFixture(identity, version, revision = 1) {
  assert.ok(version === 1 || version === 2);
  if (version === 2) {
    const fixture = reportedObservationAssessmentFixture({ scope: identity.scope, effectiveDate: date,
      accountIds: identity.accounts.slice(0, 2) });
    fixture.input.id = identity.id; fixture.input.revision = revision;
    fixture.input.selection.revision = String(revision);
    return prepareNeighborhoodPublication(buildNeighborhoodAssessment(fixture.input), fixture.members, fixture.sources);
  }
  const input = neighborhoodAssessmentFixture();
  input.id = identity.id; input.scope = identity.scope; input.revision = revision;
  input.methodology.configuration.synthetic_revision = revision;
  const sources = [{ id: 'fixture-source', payload: { fixture: 'neighborhood-v1' } }];
  const row = (population_id, member_unit, member_id, account_ids) => ({ population_id, member_unit, member_id, account_ids,
    member_data: { source_refs: ['fixture-source'], synthetic: true } });
  const members = [...identity.accounts.map(id => row('stock-a', 'property', id, [id])),
    row('sales-a', 'canonical_transaction', 'T1', [identity.accounts[0]]),
    row('sales-a', 'canonical_transaction', 'T2', [identity.accounts[0]]),
    row('sales-a', 'canonical_transaction', 'T3', [identity.accounts[1]])];
  for (const population of input.populations) {
    const rows = members.filter(member => member.population_id === population.id);
    population.member_set_sha256 = neighborhoodMemberSetDigest(rows.map(member => member.member_id));
    const id = `population-members:${population.id}`;
    const payload = { capture_type: 'neighborhood_population_members_v1', population_id: population.id,
      member_unit: population.member_unit, member_content_sha256: neighborhoodMemberContentDigest(rows) };
    sources.push({ id, payload });
    input.source_snapshots.push({ ...input.source_snapshots[0], id, content_sha256: assessmentEvidenceDigest(payload) });
    population.source_refs.push(id);
  }
  return prepareNeighborhoodPublication(buildNeighborhoodAssessment(input), members, sources);
}
async function revision(client, assessment, text = json(assessment), generated = false) {
  return client.query(`INSERT INTO app.neighborhood_assessment_revisions
    (assessment_id,revision,input_signature_sha256,evidence_digest_sha256,assessment${generated ? ',contract_version_jsonb' : ''})
    VALUES($1,$2,$3,$4,$5::jsonb${generated ? ",'2'::jsonb" : ''})`,
  [assessment.id, assessment.revision, assessment.input_signature_sha256, assessment.evidence_digest_sha256, text]);
}
async function population(client, assessment, value) {
  return client.query(`INSERT INTO app.neighborhood_assessment_populations
    (assessment_id,revision,population_id,member_unit,member_count,unique_property_count,property_link_count,
      completeness,member_set_sha256,population) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
  [assessment.id, assessment.revision, value.id, value.member_unit, value.member_count,
    value.unique_property_count ?? null, value.property_link_count ?? null, value.completeness, value.member_set_sha256, json(value)]);
}
async function member(client, assessment, value) {
  return client.query(`INSERT INTO app.neighborhood_assessment_members
    (assessment_id,revision,population_id,member_id,member_unit,account_ids,member_data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
  [assessment.id, assessment.revision, value.population_id, value.member_id, value.member_unit, value.account_ids, json(value.member_data)]);
}
async function source(client, assessment, value) {
  return client.query(`INSERT INTO app.neighborhood_assessment_sources
    (assessment_id,revision,source_id,source_revision,content_sha256,source_snapshot,source_payload)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [assessment.id, assessment.revision,
    value.snapshot.id, value.snapshot.revision, value.snapshot.content_sha256, json(value.snapshot), json(value.payload)]);
}
async function stage(client, prepared) {
  await revision(client, prepared.assessment);
  for (const value of prepared.sources) await source(client, prepared.assessment, value);
  for (const value of prepared.assessment.populations) await population(client, prepared.assessment, value);
  for (const value of prepared.members) await member(client, prepared.assessment, value);
}
const promote = (client, assessment) => client.query(`UPDATE app.neighborhood_assessment_revisions
  SET publication_status='published',published_at=clock_timestamp() WHERE assessment_id=$1 AND revision=$2`,
[assessment.id, assessment.revision]);
async function originalRows(client, ids) {
  const output = {};
  for (const table of ['revisions', 'populations', 'members', 'sources']) {
    output[table] = (await client.query(`SELECT (to_jsonb(t)${table === 'revisions' ? " - 'contract_version_jsonb'" : ''})::text AS original
      FROM app.neighborhood_assessment_${table} t WHERE assessment_id=ANY($1::uuid[]) ORDER BY original`, [ids])).rows;
  }
  return output;
}
async function functionDefinitions(client) {
  return (await client.query(`SELECT pg_get_functiondef('app.neighborhood_guard_revision()'::regprocedure) AS revision,
    pg_get_functiondef('app.neighborhood_guard_revision_child()'::regprocedure) AS child`)).rows[0];
}

async function upgradedFixtureChecks(client, identities) {
  const checks = [];
  for (const [index, identity] of identities.entries()) {
    const version = index + 1, staged = projectionPublicationFixture(identity, version, 2), assessment = staged.assessment;
    const key = [assessment.id, assessment.revision];
    assert.equal((await client.query(`SELECT contract_version_jsonb::text AS version
      FROM app.neighborhood_assessment_revisions WHERE assessment_id=$1 AND revision=$2`, key)).rows[0].version, String(version));
    for (const assignment of ["assessment=assessment || '{\"changed\":true}'::jsonb",
      "input_signature_sha256=repeat('a',64)", "evidence_digest_sha256=repeat('b',64)",
      "created_at=created_at + interval '1 second'", 'revision=revision+100']) {
      await probe(client, () => client.query(`UPDATE app.neighborhood_assessment_revisions
        SET publication_status='published',published_at=clock_timestamp(),${assignment}
        WHERE assessment_id=$1 AND revision=$2`, key), /neighborhood_revision_immutable/);
    }
    await probe(client, () => client.query(`UPDATE app.neighborhood_assessment_revisions SET contract_version_jsonb='1'
      WHERE assessment_id=$1 AND revision=$2`, key), { code: '428C9' });
    const fresh = projectionPublicationFixture(identity, version, 3);
    await probe(client, () => revision(client, fresh.assessment, json(fresh.assessment), true), { code: '428C9' });
    for (const value of ['2', null, 99, true, {}]) {
      const changed = { ...copy(fresh.assessment), contract_version: value };
      await probe(client, () => revision(client, changed), /neighborhood_contract_version_unsupported/);
    }
    const absent = copy(fresh.assessment); delete absent.contract_version;
    await probe(client, () => revision(client, absent), /neighborhood_contract_version_unsupported/);
    const foreignScope = copy(fresh.assessment); foreignScope.scope.organization_id = randomUUID();
    await probe(client, () => revision(client, foreignScope), /neighborhood_revision_identity_mismatch/);
    await probe(client, async () => {
      const text = json(fresh.assessment).replace(`"contract_version":${version}`, `"contract_version":${version}.0`);
      assert.notEqual(text, json(fresh.assessment));
      await revision(client, fresh.assessment, text);
      await population(client, fresh.assessment, fresh.assessment.populations[0]);
      assert.equal((await client.query(`SELECT contract_version_jsonb='${version}'::jsonb AS equal
        FROM app.neighborhood_assessment_revisions WHERE assessment_id=$1 AND revision=$2`,
      [fresh.assessment.id, fresh.assessment.revision])).rows[0].equal, true);
    });
    const foreignPopulation = { ...staged.assessment.populations[0], id: 'foreign-unit',
      member_unit: version === 2 ? 'property' : 'account' };
    await probe(client, () => population(client, assessment, foreignPopulation), /neighborhood_member_contract_version_mismatch/);
    const one = staged.members[0];
    for (const table of ['populations', 'members', 'sources']) {
      await probe(client, () => client.query(`UPDATE app.neighborhood_assessment_${table} SET revision=revision+1
        WHERE assessment_id=$1 AND revision=$2`, key), /neighborhood_child_revision_immutable/);
    }
    await probe(client, async () => {
      await client.query(`DELETE FROM app.neighborhood_assessment_members WHERE assessment_id=$1 AND revision=$2
        AND population_id=$3 AND member_id=$4`, [...key, one.population_id, one.member_id]);
      await promote(client, assessment);
    }, /neighborhood_exact_member_counts_mismatch/);
    await probe(client, async () => {
      await client.query(`DELETE FROM app.neighborhood_assessment_sources WHERE assessment_id=$1 AND revision=$2 AND source_id=$3`,
        [...key, staged.sources[0].snapshot.id]);
      await promote(client, assessment);
    }, /neighborhood_source_manifest_mismatch/);
    if (version === 2) {
      const account = staged.members.find(row => row.member_unit === 'account');
      await probe(client, () => member(client, assessment, { ...account, member_id: 'wrong-account' }),
        /neighborhood_account_member_identity_mismatch/);
      const changed = copy(staged.sources[0]); changed.snapshot.id = 'foreign-source';
      changed.snapshot.scope.account_id += '-foreign';
      await probe(client, () => source(client, assessment, changed), /neighborhood_private_source_scope_mismatch/);
      await probe(client, async () => {
        const wrong = copy(fresh.assessment); wrong.methodology.configuration.profile_id = 'wrong';
        await revision(client, wrong);
      }, /neighborhood_observation_profile_mismatch/);
    }
    const before = json(assessment);
    await promote(client, assessment);
    const after = (await client.query(`SELECT assessment,contract_version_jsonb::text AS version,published_at
      FROM app.neighborhood_assessment_revisions WHERE assessment_id=$1 AND revision=$2`, key)).rows[0];
    assert.equal(json(after.assessment), before); assert.equal(after.version, String(version)); assert.ok(after.published_at);
    assert.deepEqual(prepareNeighborhoodPublication(after.assessment, staged.members,
      staged.sources.map(value => ({ id: value.snapshot.id, payload: value.payload }))), staged);
    for (const table of ['revisions', 'populations', 'members', 'sources']) {
      await probe(client, () => client.query(`DELETE FROM app.neighborhood_assessment_${table}
        WHERE assessment_id=$1 AND revision=$2`, key), /immutable/);
    }
    await probe(client, () => client.query(`UPDATE app.neighborhood_assessment_members SET member_data='{}'
      WHERE assessment_id=$1 AND revision=$2`, key), /neighborhood_published_child_immutable/);
    checks.push(`v${version} original publication/reopen hashes, immutable columns, member/source guards and generated-write refusals`);
  }
  return checks;
}

/** Actual PostgreSQL checks. Caller must supply an ordinary migrated, isolated
 * loopback *_test database. The populated predecessor reconstruction changes
 * only the new column/two guards and is always rolled back. One tiny staging
 * fixture is committed solely for a two-session lock oracle and retained in
 * that disposable test database; both race transactions roll back. */
export async function runNeighborhoodRevisionContractProjectionDatabaseChecks({ pool, databaseName }) {
  assert.match(databaseName, /^[a-z][a-z0-9_]*_test$/);
  const [migration, previous] = await Promise.all([readFile(migrationUrl, 'utf8'), readFile(previousUrl, 'utf8')]);
  const timeoutStart = migration.indexOf("SELECT set_config('lock_timeout'");
  const timeoutSql = migration.slice(timeoutStart, migration.indexOf(';', timeoutStart) + 1);
  assert.match(timeoutSql, /^SELECT set_config/);
  const oldFunctions = ['neighborhood_guard_revision_child', 'neighborhood_guard_revision'].map(name => body(previous, name)).join('\n');
  const client = await checkedClient(pool, databaseName), checks = [];
  let reconstructedIds;
  try {
    const initialSettings = await settings(client), installedFunctions = await functionDefinitions(client);
    try {
      await client.query('BEGIN');
      // Approved rollback-only reconstruction. No old column, source or unrelated
      // fixture is dropped/rewritten; a failed assertion restores the live schema.
      await client.query(oldFunctions);
      await client.query('ALTER TABLE app.neighborhood_assessment_revisions DROP COLUMN contract_version_jsonb');
      const identities = [await identityFixture(client), await identityFixture(client)];
      for (const [index, identity] of identities.entries()) {
        for (const number of [1, 2]) {
          const prepared = projectionPublicationFixture(identity, index + 1, number);
          await stage(client, prepared);
          if (number === 1) await promote(client, prepared.assessment);
        }
      }
      const ids = identities.map(value => value.id), originals = await originalRows(client, ids);
      reconstructedIds = ids;
      assert.equal(originals.revisions.length, 4); assert.equal(originals.members.length, 20);
      // Match the real runner: leading SELECT and following DDL are separate SQL
      // statements in one simple-query message, inside a caller-owned transaction.
      await client.query(migration);
      assert.deepEqual(await originalRows(client, ids), originals);
      assert.deepEqual(await functionDefinitions(client), installedFunctions);
      await client.query(migration);
      assert.deepEqual(await originalRows(client, ids), originals);
      assert.deepEqual(await functionDefinitions(client), installedFunctions);
      const counts = (await client.query(`SELECT count(*)::integer AS count,
        bool_and(contract_version_jsonb IS NOT DISTINCT FROM assessment->'contract_version') AS exact
        FROM app.neighborhood_assessment_revisions WHERE assessment_id=ANY($1::uuid[])`, [ids])).rows[0];
      assert.deepEqual(counts, { count: 4, exact: true });
      checks.push('populated v1/v2 staging/published upgrade and repeat preserve every original row byte and exact generated JSONB');
      checks.push(...await upgradedFixtureChecks(client, identities));
    } finally { await client.query('ROLLBACK'); }
    assert.deepEqual(await settings(client), initialSettings);
    assert.deepEqual(await functionDefinitions(client), installedFunctions);
    assert.deepEqual(await originalRows(client, reconstructedIds), { revisions: [], populations: [], members: [], sources: [] });
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout='0'; SET LOCAL statement_timeout='0'");
      await client.query(migration);
      assert.deepEqual(await settings(client), { lock_timeout: '1s', statement_timeout: '30s' });
    } finally { await client.query('ROLLBACK'); }
    assert.deepEqual(await settings(client), initialSettings);
    // Idempotent success also restores settings at the real COMMIT boundary.
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='80ms'; SET LOCAL statement_timeout='900ms'");
    await client.query(migration);
    assert.deepEqual(await settings(client), { lock_timeout: '80ms', statement_timeout: '900ms' });
    await client.query('COMMIT');
    assert.deepEqual(await settings(client), initialSettings);
    // A name collision must not accept ordinary or incorrectly generated data.
    for (const definition of ['jsonb', "jsonb GENERATED ALWAYS AS (assessment->'revision') STORED"]) {
      await client.query('BEGIN');
      try {
        await client.query(oldFunctions);
        await client.query('ALTER TABLE app.neighborhood_assessment_revisions DROP COLUMN contract_version_jsonb');
        await client.query(`ALTER TABLE app.neighborhood_assessment_revisions ADD COLUMN contract_version_jsonb ${definition}`);
        await assert.rejects(client.query(migration), /neighborhood_revision_contract_projection_mismatch/);
      } finally { await client.query('ROLLBACK'); }
      assert.deepEqual(await functionDefinitions(client), installedFunctions);
    }
    checks.push('exact preexisting-definition rejection and caller timeout restoration on COMMIT and ROLLBACK');
    // Prove the leading clamp bounds a subsequent statement in one actual
    // simple-query call, without extending a stricter statement timeout.
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL statement_timeout='50ms'");
      await assert.rejects(client.query(`${timeoutSql}\nSELECT pg_sleep(0.2);`), { code: '57014' });
    } finally { await client.query('ROLLBACK'); }
    assert.deepEqual(await settings(client), initialSettings);
    checks.push('subsequent SQL statement obeys retained stricter timeout and rollback restores session settings');
  } finally {
    if (client.getTransactionStatus() !== 'I') await client.query('ROLLBACK');
    client.release();
  }
  checks.push(...await contentionChecks(pool, databaseName, migration));
  const retained = await rowLockChecks(pool, databaseName);
  checks.push('child FOR SHARE waits for concurrent publication status transition; both contenders roll back');
  return { checks, retained_staging_assessment_id: retained };
}

async function contentionChecks(pool, databaseName, migration) {
  const holder = await checkedClient(pool, databaseName), contender = await checkedClient(pool, databaseName);
  const initial = await settings(contender);
  try {
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE app.neighborhood_assessment_revisions IN ACCESS SHARE MODE');
    await contender.query('BEGIN');
    await contender.query("SET LOCAL lock_timeout='60ms'; SET LOCAL statement_timeout='900ms'");
    // ALTER requires ACCESS EXCLUSIVE even on idempotent replay. Exact SQLSTATE
    // distinguishes lock refusal from statement timeout; no timing threshold.
    await assert.rejects(contender.query(migration), { code: '55P03' });
    await contender.query('ROLLBACK');
    assert.deepEqual(await settings(contender), initial);
    return ['migration contention respects stricter lock timeout without partial DDL or setting leakage'];
  } finally {
    if (contender.getTransactionStatus() !== 'I') await contender.query('ROLLBACK');
    await holder.query('ROLLBACK'); contender.release(); holder.release();
  }
}
async function rowLockChecks(pool, databaseName) {
  const writer = await checkedClient(pool, databaseName), child = await checkedClient(pool, databaseName);
  let prepared, pending;
  try {
    await writer.query('BEGIN');
    const identity = await identityFixture(writer);
    prepared = projectionPublicationFixture(identity, 2);
    await stage(writer, prepared);
    await writer.query('COMMIT'); // This tiny, named synthetic fixture is retained.
    await writer.query('BEGIN');
    await writer.query("SET LOCAL statement_timeout='4s'");
    await promote(writer, prepared.assessment); // Hold the parent tuple lock.
    await child.query('BEGIN');
    await child.query("SET LOCAL statement_timeout='4s'");
    const childPid = (await child.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const value = prepared.members.find(row => row.member_unit === 'source_record');
    pending = member(child, prepared.assessment, { ...value, member_id: 'concurrent-source-record' })
      .then(result => ({ result }), error => ({ error }));
    let blocked = false;
    const deadline = Date.now() + 2500;
    while (!blocked && Date.now() < deadline) {
      blocked = (await writer.query('SELECT $1::integer=ANY(pg_blocking_pids($2)) AS blocked', [writerPid, childPid])).rows[0].blocked;
      if (!blocked) await setImmediate();
    }
    assert.equal(blocked, true, 'actual child parent read must wait on the publication tuple lock');
    await writer.query('ROLLBACK');
    const outcome = await pending; assert.equal(outcome.error, undefined); assert.equal(outcome.result.rowCount, 1);
    await child.query('ROLLBACK');
    const row = (await writer.query(`SELECT publication_status,published_at FROM app.neighborhood_assessment_revisions
      WHERE assessment_id=$1 AND revision=$2`, [prepared.assessment.id, prepared.assessment.revision])).rows[0];
    assert.deepEqual(row, { publication_status: 'staging', published_at: null });
    const actual = (await writer.query(`SELECT count(*)::integer AS n FROM app.neighborhood_assessment_members
      WHERE assessment_id=$1 AND revision=$2`, [prepared.assessment.id, prepared.assessment.revision])).rows[0];
    assert.equal(actual.n, prepared.members.length);
    return prepared.assessment.id;
  } finally {
    if (writer.getTransactionStatus() !== 'I') await writer.query('ROLLBACK');
    if (pending) await pending;
    if (child.getTransactionStatus() !== 'I') await child.query('ROLLBACK');
    writer.release(); child.release();
  }
}
