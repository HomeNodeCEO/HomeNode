import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, canonicalAssessmentJson }
  from '../src/services/neighborhoodAssessment/contract.js';
import { neighborhoodMemberSetDigest, prepareNeighborhoodPublication }
  from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { NEIGHBORHOOD_CI_IDENTITY_SQL, prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { projectionPublicationFixture, runNeighborhoodRevisionContractProjectionDatabaseChecks,
  runProjectionMigrationContentionChecks, runProjectionRowLockChecks }
  from './helpers/neighborhoodRevisionContractProjectionDatabaseChecks.js';

const databaseName = 'neighborhood_projection_test';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const copy = value => JSON.parse(JSON.stringify(value));
const identity = () => ({
  id: '40000000-0000-4000-8000-000000000019',
  scope: {
    organization_id: '10000000-0000-4000-8000-000000000019',
    appraisal_case_id: '20000000-0000-4000-8000-000000000019',
    subject_snapshot_id: '30000000-0000-4000-8000-000000000019',
    account_id: 'SYNTHETIC-PROJECTION-1',
  },
  accounts: ['SYNTHETIC-PROJECTION-1', 'SYNTHETIC-PROJECTION-2', 'SYNTHETIC-PROJECTION-3', 'SYNTHETIC-PROJECTION-4'],
});
const sourceInputs = prepared => prepared.sources.map(source => ({ id: source.snapshot.id, payload: source.payload }));

for (const version of [1, 2]) {
  test(`projection v${version} fixture has complete native units and independently verifiable hashes`, () => {
    const input = identity(), before = copy(input);
    const prepared = projectionPublicationFixture(input, version), assessment = prepared.assessment;
    assert.deepEqual(input, before, 'fixture construction must not mutate caller identity');
    assert.equal(assessment.contract_version, version);
    assert.equal(assessment.id, input.id);
    assert.deepEqual(assessment.scope, input.scope);
    assert.equal(assessment.revision, 1);
    assert.equal(assessment.effective_date, '2024-06-30');
    assert.equal(assessment.data_cutoff, '2024-06-30');
    assert.equal(assessment.application_group.status, 'ready');
    assert.equal(Object.hasOwn(assessment, 'contract_version_jsonb'), false);
    assert.equal(prepared.members.length, version === 1 ? 7 : 3);
    assert.deepEqual([...new Set(prepared.members.map(member => member.member_unit))].sort(),
      version === 1 ? ['canonical_transaction', 'property'] : ['account', 'source_record']);
    assert.equal(prepared.sources.length, 3);
    for (const population of assessment.populations) {
      const members = prepared.members.filter(member => member.population_id === population.id);
      assert.equal(population.member_count, members.length);
      assert.equal(population.member_set_sha256, neighborhoodMemberSetDigest(members.map(member => member.member_id)));
    }
    for (const source of prepared.sources) {
      assert.equal(source.snapshot.content_sha256, assessmentEvidenceDigest(source.payload));
    }
    const { evidence_digest_sha256: evidenceDigest, generated_at: ignoredGeneratedAt, ...evidence } = assessment;
    assert.equal(evidenceDigest, assessmentEvidenceDigest(evidence));
    assert.match(assessment.input_signature_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(buildNeighborhoodAssessment(assessment), assessment);
    assert.deepEqual(projectionPublicationFixture(input, version), prepared, 'same inputs produce the same prepared publication');
  });

  test(`projection v${version} revisions have distinct signatures and reverify after JSON round trip`, () => {
    const input = identity();
    const first = projectionPublicationFixture(input, version);
    const second = projectionPublicationFixture(input, version, 2);
    assert.equal(second.assessment.id, first.assessment.id);
    assert.equal(second.assessment.revision, 2);
    assert.equal(second.assessment.application_group.revision, 2);
    assert.notEqual(second.assessment.input_signature_sha256, first.assessment.input_signature_sha256);
    assert.notEqual(second.assessment.evidence_digest_sha256, first.assessment.evidence_digest_sha256);
    for (const prepared of [first, second]) {
      const reopened = JSON.parse(canonicalAssessmentJson(prepared));
      const verified = prepareNeighborhoodPublication(reopened.assessment, reopened.members, sourceInputs(reopened));
      assert.deepEqual(verified, prepared);
      assert.equal(canonicalAssessmentJson(verified), canonicalAssessmentJson(prepared));
      assert.ok(Object.isFrozen(verified) && Object.isFrozen(verified.assessment));
    }
  });

  test(`projection v${version} fixture reverification rejects changed retained member and source content`, () => {
    const prepared = projectionPublicationFixture(identity(), version);
    const changedMembers = copy(prepared.members);
    changedMembers[0].member_data.synthetic_probe = true;
    assert.throws(() => prepareNeighborhoodPublication(prepared.assessment, changedMembers, sourceInputs(prepared)),
      /member_content_mismatch/);
    const changedSources = copy(sourceInputs(prepared));
    changedSources[0].payload.synthetic_probe = true;
    assert.throws(() => prepareNeighborhoodPublication(prepared.assessment, prepared.members, changedSources),
      /source_content_mismatch/);
  });
}

test('projection fixture refuses unsupported contract versions without database work', () => {
  for (const version of [undefined, null, '1', '2', 0, 3, true, {}]) {
    assert.throws(() => projectionPublicationFixture(identity(), version), { code: 'ERR_ASSERTION' });
  }
});

test('projection native helper denies invalid database names before connecting', async () => {
  let connections = 0;
  const pool = { connect: async () => { connections += 1; throw new Error('unexpected connection'); } };
  for (const invalid of [undefined, null, '', 'production', 'neighborhood', 'UPPER_test', 'projection-test',
    '../projection_test', 'projection_test;SELECT 1', 'projection_test\n']) {
    await assert.rejects(runNeighborhoodRevisionContractProjectionDatabaseChecks({ pool, databaseName: invalid }),
      { code: 'ERR_ASSERTION' });
  }
  assert.equal(connections, 0);
});

// This fake permits only the actual connection identity query. It cannot model
// PostgreSQL, execute fixtures, or serve as native migration/concurrency evidence.
function guardOnlyPool({ actualIdentity = { database_name: databaseName, server_address: '127.0.0.1' },
  remoteAddress = '127.0.0.1', transactionStatus = 'I', identityError } = {}) {
  const observed = { connections: 0, releases: 0, queries: [] };
  const client = {
    connection: { stream: { remoteAddress } },
    getTransactionStatus: () => transactionStatus,
    query: async sql => {
      observed.queries.push(sql);
      assert.equal(sql, NEIGHBORHOOD_CI_IDENTITY_SQL, 'no SQL may follow a rejected connection guard');
      if (identityError) throw identityError;
      return { rows: actualIdentity === null ? [] : [actualIdentity] };
    },
    release: () => { observed.releases += 1; },
  };
  return { observed, pool: { connect: async () => { observed.connections += 1; return client; } } };
}

test('projection native helper rejects actual database/socket/server mismatches and releases the client', async () => {
  const cases = [
    { actualIdentity: { database_name: 'different_test', server_address: '127.0.0.1' } },
    { actualIdentity: { database_name: 'production', server_address: '127.0.0.1' } },
    { actualIdentity: { database_name: databaseName, server_address: '203.0.113.12' } },
    { actualIdentity: { database_name: databaseName, server_address: null } },
    { actualIdentity: null },
    { remoteAddress: '203.0.113.12' },
    { remoteAddress: '192.168.1.12' },
    { remoteAddress: null },
  ];
  for (const options of cases) {
    const { pool, observed } = guardOnlyPool(options);
    await assert.rejects(runNeighborhoodRevisionContractProjectionDatabaseChecks({ pool, databaseName }),
      /Neighborhood CI database connection identity mismatch/);
    assert.deepEqual(observed, { connections: 1, releases: 1, queries: [NEIGHBORHOOD_CI_IDENTITY_SQL] });
  }
});

test('projection native helper releases non-idle or identity-query-failed clients before fixture SQL', async () => {
  for (const transactionStatus of ['T', 'E']) {
    const { pool, observed } = guardOnlyPool({ transactionStatus });
    await assert.rejects(runNeighborhoodRevisionContractProjectionDatabaseChecks({ pool, databaseName }),
      { code: 'ERR_ASSERTION' });
    assert.deepEqual(observed, { connections: 1, releases: 1, queries: [] });
  }
  const identityError = new Error('synthetic identity query failure');
  const { pool, observed } = guardOnlyPool({ identityError });
  await assert.rejects(runNeighborhoodRevisionContractProjectionDatabaseChecks({ pool, databaseName }),
    error => error === identityError);
  assert.deepEqual(observed, { connections: 1, releases: 1, queries: [NEIGHBORHOOD_CI_IDENTITY_SQL] });
});

// Failure injection only. This fake explicitly refuses fixture, lock and
// migration SQL; it verifies ownership/error handling, not database semantics.
const initialSettingsSql = "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout";
function oracleFailurePool(options = [{}, {}]) {
  const observed = { connections: 0, clients: options.map(() => ({ queries: [], releases: [], status: 'I' })) };
  const clients = options.map((option, index) => {
    const record = observed.clients[index];
    return {
      connection: { stream: { remoteAddress: option.remoteAddress ?? '127.0.0.1' } },
      getTransactionStatus: () => record.status,
      query: async sql => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        record.queries.push(normalized);
        if (normalized === NEIGHBORHOOD_CI_IDENTITY_SQL) {
          if (option.identityError) throw option.identityError;
          return { rows: [option.actualIdentity ?? { database_name: databaseName, server_address: '127.0.0.1' }] };
        }
        if (normalized === initialSettingsSql) {
          if (option.settingsError) {
            if (option.settingsFailureStatus) record.status = option.settingsFailureStatus;
            throw option.settingsError;
          }
          return { rows: [{ lock_timeout: '0', statement_timeout: '8s' }] };
        }
        if (normalized === 'BEGIN') {
          record.status = option.beginError ? 'E' : 'T';
          if (option.beginError) throw option.beginError;
          return { rows: [] };
        }
        if (normalized === 'ROLLBACK') {
          if (option.rollbackError) throw option.rollbackError;
          record.status = 'I';
          return { rows: [] };
        }
        assert.fail('Failure-path fake must never execute fixture, lock or migration SQL');
      },
      release: error => { record.releases.push(error); },
    };
  });
  return { observed, pool: { connect: async () => {
    const index = observed.connections++;
    assert.ok(index < clients.length, 'only the expected connections may be acquired');
    if (options[index].connectError) throw options[index].connectError;
    return clients[index];
  } } };
}
const oracleCases = [
  { name: 'migration contention', run: (pool, name) =>
    runProjectionMigrationContentionChecks(pool, name, '-- Unreachable migration in failure-only test.') },
  { name: 'row lock', run: (pool, name) => runProjectionRowLockChecks(pool, name) },
];
const assertReleases = (observed, expected) => {
  assert.equal(observed.clients.length, expected.length);
  for (const [index, errors] of expected.entries()) {
    assert.equal(observed.clients[index].releases.length, errors.length, `client ${index + 1} release count`);
    for (const [releaseIndex, error] of errors.entries()) {
      assert.equal(observed.clients[index].releases[releaseIndex], error, `client ${index + 1} release error identity`);
    }
  }
};

for (const oracle of oracleCases) {
  test(`projection ${oracle.name} oracle rejects invalid database names before acquisition`, async () => {
    const { pool, observed } = oracleFailurePool();
    for (const invalid of [undefined, null, '', 'production', 'projection-test', 'UPPER_test']) {
      await assert.rejects(oracle.run(pool, invalid), { code: 'ERR_ASSERTION' });
    }
    assert.equal(observed.connections, 0);
    assertReleases(observed, [[], []]);
  });

  test(`projection ${oracle.name} oracle preserves a first-connect failure without releasing unowned clients`, async () => {
    const primary = new Error('synthetic first connection failure');
    const { pool, observed } = oracleFailurePool([{ connectError: primary }, {}]);
    await assert.rejects(oracle.run(pool, databaseName), error => error === primary);
    assert.equal(observed.connections, 1);
    assertReleases(observed, [[], []]);
    assert.deepEqual(observed.clients.map(client => client.queries), [[], []]);
  });

  test(`projection ${oracle.name} oracle releases the first client when the second acquisition fails`, async () => {
    const primary = new Error('synthetic second connection failure');
    const { pool, observed } = oracleFailurePool([{}, { connectError: primary }]);
    await assert.rejects(oracle.run(pool, databaseName), error => error === primary);
    assert.equal(observed.connections, 2);
    assertReleases(observed, [[undefined], []]);
    assert.deepEqual(observed.clients.map(client => client.queries.filter(query => query !== 'ROLLBACK')),
      [[NEIGHBORHOOD_CI_IDENTITY_SQL], []]);
  });

  test(`projection ${oracle.name} oracle verifies each actual identity and releases every acquired client on mismatch`, async () => {
    for (const index of [0, 1]) {
      for (const invalid of [
        { actualIdentity: { database_name: 'different_test', server_address: '127.0.0.1' } },
        { actualIdentity: { database_name: databaseName, server_address: '203.0.113.12' } },
        { remoteAddress: '203.0.113.12' },
      ]) {
        const options = [{}, {}]; options[index] = invalid;
        const { pool, observed } = oracleFailurePool(options);
        await assert.rejects(oracle.run(pool, databaseName), /Neighborhood CI database connection identity mismatch/);
        assert.equal(observed.connections, index + 1);
        assertReleases(observed, index === 0 ? [[undefined], []] : [[undefined], [undefined]]);
        for (const client of observed.clients.slice(0, index + 1)) {
          assert.deepEqual(client.queries.filter(query => query !== 'ROLLBACK'), [NEIGHBORHOOD_CI_IDENTITY_SQL]);
        }
      }
    }
  });

  test(`projection ${oracle.name} oracle rolls back a failed BEGIN and releases both owned clients`, async () => {
    const primary = new Error('synthetic first BEGIN failure');
    const { pool, observed } = oracleFailurePool([{ beginError: primary }, {}]);
    await assert.rejects(oracle.run(pool, databaseName), error => error === primary);
    assert.equal(observed.connections, 2);
    assertReleases(observed, [[undefined], [undefined]]);
    assert.deepEqual(observed.clients[0].queries, [NEIGHBORHOOD_CI_IDENTITY_SQL, 'BEGIN', 'ROLLBACK']);
    assert.ok(observed.clients.every(client => client.status === 'I'));
  });

  test(`projection ${oracle.name} oracle destroys a rollback-failed client and retains primary plus cleanup errors`, async () => {
    const primary = new Error('synthetic first BEGIN failure');
    const cleanup = new Error('synthetic rollback failure');
    const { pool, observed } = oracleFailurePool([{ beginError: primary, rollbackError: cleanup }, {}]);
    await assert.rejects(oracle.run(pool, databaseName), error => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(primary), 'original operation error is retained by identity');
      assert.ok(error.errors.includes(cleanup), 'rollback error is retained by identity');
      return true;
    });
    assert.equal(observed.connections, 2);
    assertReleases(observed, [[cleanup], [undefined]]);
    assert.deepEqual(observed.clients[0].queries, [NEIGHBORHOOD_CI_IDENTITY_SQL, 'BEGIN', 'ROLLBACK']);
  });
}

test('projection migration contention oracle releases both clients after initial settings failure', async () => {
  const primary = new Error('synthetic initial settings failure');
  const { pool, observed } = oracleFailurePool([{}, { settingsError: primary }]);
  await assert.rejects(runProjectionMigrationContentionChecks(pool, databaseName, '-- Unreachable migration.'),
    error => error === primary);
  assert.equal(observed.connections, 2);
  assertReleases(observed, [[undefined], [undefined]]);
  assert.deepEqual(observed.clients.map(client => client.queries.filter(query => query !== 'ROLLBACK')),
    [[NEIGHBORHOOD_CI_IDENTITY_SQL], [NEIGHBORHOOD_CI_IDENTITY_SQL, initialSettingsSql]]);
});

test('projection outer native helper releases its client and preserves an initial settings error', async () => {
  const primary = new Error('synthetic outer initial settings failure');
  const { pool, observed } = oracleFailurePool([{ settingsError: primary }]);
  await assert.rejects(runNeighborhoodRevisionContractProjectionDatabaseChecks({ pool, databaseName }),
    error => error === primary);
  assert.equal(observed.connections, 1);
  assertReleases(observed, [[undefined]]);
  assert.deepEqual(observed.clients[0].queries, [NEIGHBORHOOD_CI_IDENTITY_SQL, initialSettingsSql]);
});

test('projection outer native helper destroys a rollback-failed client while retaining both original errors', async () => {
  const primary = new Error('synthetic outer initial settings failure');
  const cleanup = new Error('synthetic outer rollback failure');
  const { pool, observed } = oracleFailurePool([{ settingsError: primary, settingsFailureStatus: 'E', rollbackError: cleanup }]);
  await assert.rejects(runNeighborhoodRevisionContractProjectionDatabaseChecks({ pool, databaseName }), error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.includes(primary));
    assert.ok(error.errors.includes(cleanup));
    return true;
  });
  assert.equal(observed.connections, 1);
  assertReleases(observed, [[cleanup]]);
  assert.deepEqual(observed.clients[0].queries, [NEIGHBORHOOD_CI_IDENTITY_SQL, initialSettingsSql, 'ROLLBACK']);
});

test('projection migration: real PostgreSQL generated storage, publication, upgrade and locking', {
  skip: !process.env.DATABASE_URL, timeout: 360_000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase();
  const { default: pg } = await import('pg'); // Actual target guards precede driver import and connection.
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 3, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'neighborhood_contract_projection_integration' });
  try {
    const result = await runNeighborhoodRevisionContractProjectionDatabaseChecks({ pool, databaseName: target.databaseName });
    assert.match(result.retained_staging_assessment_id, uuid);
    assert.ok(Array.isArray(result.checks) && result.checks.length >= 7);
    assert.equal(new Set(result.checks).size, result.checks.length);
    for (const expected of [/populated v1\/v2 staging\/published upgrade/, /v1 original publication\/reopen hashes/,
      /v2 original publication\/reopen hashes/, /preexisting-definition rejection/, /subsequent SQL statement/,
      /migration contention/, /child FOR SHARE waits/]) {
      assert.ok(result.checks.some(check => typeof check === 'string' && expected.test(check)), String(expected));
    }
  } finally { await pool.end(); }
});
