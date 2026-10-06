import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateTemporaryAuditException, runAudits } from '../scripts/temporary-audit-exception.mjs';

const reviewed = {
  eventName: 'pull_request',
  ref: 'refs/pull/1130/merge',
  prNumber: '1130',
  todayUtc: '2026-10-05',
  lockfileSha256: '24aa5dede3605d5dbf38609153f1984188c8299218f2c864a3f406a13efe90c1',
  changedPaths: ['dcad-frontend/src/features/neighborhood/customWorkspaceDiscovery.ts'],
};

test('permits the exact neighborhood PR and its main merge only', () => {
  assert.equal(evaluateTemporaryAuditException(reviewed), null);
  assert.equal(evaluateTemporaryAuditException({
    ...reviewed, eventName: 'push', ref: 'refs/heads/main',
    commitMessage: 'Merge pull request #1130 from HomeNodeCEO/agent/neighborhood-one-two-mile-20261005',
  }), null);
  assert.match(evaluateTemporaryAuditException({ ...reviewed, prNumber: '1132' }), /not an approved/);
  assert.match(evaluateTemporaryAuditException({ ...reviewed, eventName: 'schedule' }), /not an approved/);
  assert.match(evaluateTemporaryAuditException({
    ...reviewed, eventName: 'push', ref: 'refs/heads/main', commitMessage: 'Unrelated release #1130',
  }), /not an approved/);
});

test('permits only the audited policy and frontend lockfile PR scope', () => {
  const policy = { ...reviewed, ref: 'refs/pull/1131/merge', prNumber: '1131', changedPaths: [
    '.github/workflows/dependency-security.yml',
    'dcad-frontend/package-lock.json',
    'homenode-mobile/scripts/temporary-audit-exception.mjs',
  ] };
  assert.equal(evaluateTemporaryAuditException(policy), null);
  assert.match(evaluateTemporaryAuditException({
    ...policy, changedPaths: [...policy.changedPaths, 'homenode-mobile/pnpm-lock.yaml'],
  }), /outside the approved/);
  assert.match(evaluateTemporaryAuditException({
    ...policy, changedPaths: [...policy.changedPaths, 'homenode-mobile/src/auth.ts'],
  }), /outside the approved/);
  assert.match(evaluateTemporaryAuditException({ ...policy, changedPaths: [] }), /outside the approved/);
});

test('expires and rejects a changed dependency graph on any event', () => {
  assert.equal(evaluateTemporaryAuditException({ ...reviewed, todayUtc: '2026-10-19' }), null);
  assert.match(evaluateTemporaryAuditException({ ...reviewed, todayUtc: '2026-10-20' }), /expired/);
  assert.match(evaluateTemporaryAuditException({ ...reviewed, lockfileSha256: 'changed' }), /lockfile differs/);
});

test('runs the raw audit first and ignores exactly two advisories only for approved scope', () => {
  const calls = [];
  runAudits(reviewed, (args) => {
    calls.push(args);
    return calls.length === 1 ? 1 : 0;
  });
  assert.deepEqual(calls, [
    ['audit', '--fetch-timeout=300000', '--audit-level=moderate'],
    ['audit', '--fetch-timeout=300000', '--audit-level=moderate',
      '--ignore', 'GHSA-86w9-cpqp-85rv', '--ignore', 'GHSA-vfj7-8cjw-p6xm'],
  ]);
});

test('other advisories and registry failures remain blocking', () => {
  const calls = [];
  assert.throws(() => runAudits(reviewed, (args) => {
    calls.push(args);
    return 1;
  }), /Unignored vulnerability or audit registry failure/);
  assert.equal(calls.length, 2);
});

test('unapproved scope never reaches the filtered audit', () => {
  const calls = [];
  assert.throws(() => runAudits({ ...reviewed, changedPaths: ['homenode-mobile/package.json'] }, (args) => {
    calls.push(args);
    return 1;
  }), /outside the approved/);
  assert.equal(calls.length, 1);
  runAudits(() => { throw new Error('scope should not be inspected'); }, (args) => {
    calls.push(args);
    return 0;
  });
  assert.equal(calls.length, 2);
});
