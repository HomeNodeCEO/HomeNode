import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAssignmentSalesMatchFixtureIdentity as verify,
  prepareAssignmentSalesMatchCandidatesFixture as prepare } from './helpers/assignmentSalesMatchCandidatesDatabaseChecks.js';

const CHILD = 'neighborhood_0123456789abcdef0123456789abcdef_test';
// Plain arguments exercise guard branches only. These tests never mutate
// process.env, set CI flags, open a socket, or run a native database helper.
const environment = () => ({ NODE_ENV: 'test', CI: 'true', GITHUB_ACTIONS: 'true',
  DATABASE_URL: 'postgresql://fixture:synthetic@127.0.0.1:5432/fixture_parent_test' });
const row = (server_address = '172.18.0.2', database_name = CHILD) => ({ server_address, database_name });
const options = () => ({ databaseName: CHILD, remoteAddress: '127.0.0.1', environment: environment() });

for (const server of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) test(`existing direct loopback fixture remains supported: ${server}`, () => {
  assert.doesNotThrow(() => verify(row(server, 'candidate_fixture_test'), { databaseName: 'candidate_fixture_test', environment: {} }));
});
for (const server of ['172.17.0.2', '172.31.255.2', '10.20.0.3', '192.168.20.3', '::ffff:172.18.0.2', 'fd00::2']) {
  test(`isolated configured CI child permits actual loopback socket to private Docker server: ${server}`, () => {
    assert.doesNotThrow(() => verify(row(server), options()));
  });
}
for (const remoteAddress of ['::1', '::ffff:127.0.0.1', '127.0.0.2']) test(`existing harness loopback socket semantics preserved: ${remoteAddress}`, () => {
  assert.doesNotThrow(() => verify(row(), { ...options(), remoteAddress }));
});
for (const [key, values] of Object.entries({ NODE_ENV: [undefined, 'production', 'Test'], CI: [undefined, 'false', true, 'TRUE'],
  GITHUB_ACTIONS: [undefined, 'false', true, 'TRUE'] })) {
  for (const value of values) test(`private bridge denied without exact ${key}=${String(value)} guard`, () => {
    const configured = environment(); configured[key] = value;
    assert.throws(() => verify(row(), { ...options(), environment: configured }));
  });
}
for (const DATABASE_URL of [undefined, '', 'not-a-url',
  'postgresql://fixture:synthetic@production.example/fixture_parent_test',
  'postgresql://fixture:synthetic@172.18.0.2/fixture_parent_test',
  'postgresql://fixture:synthetic@127.0.0.1/production',
  'postgresql://fixture:synthetic@127.0.0.1/fixture_parent_test?host=production.example',
  'postgresql://fixture:synthetic@127.0.0.1/fixture_parent_test#override',
  'https://127.0.0.1/fixture_parent_test']) {
  test('configured non-loopback/non-test/overridden database URL cannot authorize private bridge fixture', () => {
    assert.throws(() => verify(row(), { ...options(), environment: { ...environment(), DATABASE_URL } }));
  });
}
for (const databaseName of ['production', 'fixture_parent_test', 'arbitrary_test', 'neighborhood_not_a_nonce_test',
  'neighborhood_0123456789abcdef0123456789abcdefg_test', 'neighborhood_0123456789abcdef0123456789abcde_test',
  'neighborhood_0123456789ABCDEF0123456789ABCDEF_test', 'neighborhood_0123456789abcdef0123456789abcdef_test;SELECT']) {
  test(`only exact bootstrap child names admitted for private bridge: ${databaseName}`, () => {
    assert.throws(() => verify(row('172.18.0.2', databaseName), { ...options(), databaseName }));
  });
}
test('the configured parent remains forbidden even if it happens to have a valid child-style name', () => {
  assert.throws(() => verify(row(), { ...options(), environment: { ...environment(),
    DATABASE_URL: `postgresql://fixture:synthetic@localhost/${CHILD}` } }));
});
for (const server of ['8.8.8.8', '172.16.0.1/32', '172.32.0.1', '192.169.0.1', '2001:4860::1', null, undefined, 'localhost', '']) {
  test(`CI never admits public, malformed or unknown PostgreSQL server address: ${String(server)}`, () => {
    assert.throws(() => verify({ database_name: CHILD, server_address: server }, options()));
  });
}
for (const remoteAddress of [undefined, null, '172.18.0.1', '8.8.8.8', 'localhost', '127.0.0.1/32', '']) {
  test(`actual client socket must be observed loopback, not inferred from config: ${String(remoteAddress)}`, () => {
    assert.throws(() => verify(row(), { ...options(), remoteAddress }));
  });
}
test('a supplied nonloopback socket also rejects otherwise-direct loopback server observations', () => {
  assert.throws(() => verify(row('127.0.0.1'), { ...options(), remoteAddress: '203.0.113.1' }));
});
test('exact database equality remains mandatory in local and CI paths', () => {
  for (const server of ['127.0.0.1', '172.18.0.2']) {
    assert.throws(() => verify(row(server, 'some_other_test'), options()));
  }
});
test('fixture setup rejects an explicit foreign client socket before savepoint or DDL', async () => {
  const calls = [];
  await assert.rejects(prepare(async sql => {
    calls.push(sql); return { rows: [{ ...row('127.0.0.1'), read_only: 'off', isolation: 'read committed' }] };
  }, { databaseName: CHILD, remoteAddress: '203.0.113.5' }));
  assert.equal(calls.length, 1); assert.match(calls[0], /current_database/);
  assert.doesNotMatch(calls[0], /SAVEPOINT|CREATE|ALTER|INSERT/);
});
