import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { evaluateTemporaryAuditException, runAudits } from '../scripts/temporary-audit-exception.mjs';

const reviewed = {
  eventName: 'pull_request',
  ref: 'refs/pull/1130/merge',
  prNumber: '1130',
  todayUtc: '2026-10-05',
  lockfileSha256: '0155ed6bfd92df1c836a2c9b4c6813bcf6fd2f07868820b38ae1507f646b49da',
  changedPaths: ['dcad-frontend/src/features/neighborhood/customWorkspaceDiscovery.ts'],
};

const forge = { github_advisory_id: 'GHSA-86w9-cpqp-85rv', module_name: 'node-forge', severity: 'high', findings: [{ version: '1.4.0' }] };
const braces = { github_advisory_id: 'GHSA-vfj7-8cjw-p6xm', module_name: 'braces', severity: 'high', findings: [{ version: '3.0.3' }] };
const sourceMap = { github_advisory_id: 'GHSA-68fv-2mgg-jv7q', module_name: 'source-map-js', severity: 'high', findings: [{ version: '1.2.1' }] };

test('Expo and Expo CLI resolve the patched source-map-js release', () => {
  const project = createRequire(new URL('../package.json', import.meta.url));
  const expo = createRequire(project.resolve('expo/package.json'));
  const cli = createRequire(expo.resolve('@expo/cli/package.json'));
  for (const consumer of [expo, cli]) {
    const metroConfig = createRequire(consumer.resolve('@expo/metro-config/package.json'));
    const postcss = createRequire(metroConfig.resolve('postcss/package.json'));
    assert.equal(postcss('source-map-js/package.json').version, '1.2.2');
  }
});

function auditResult(items, status = items.length ? 1 : 0) {
  const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const item of items) vulnerabilities[item.severity] += 1;
  return { status, stdout: JSON.stringify({
    advisories: Object.fromEntries(items.map((item, index) => [index, item])),
    metadata: { vulnerabilities },
  }) };
}

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
    'homenode-mobile/pnpm-lock.yaml',
    'homenode-mobile/pnpm-workspace.yaml',
  ] };
  assert.equal(evaluateTemporaryAuditException(policy), null);
  assert.match(evaluateTemporaryAuditException({
    ...policy, changedPaths: [...policy.changedPaths, 'homenode-mobile/src/auth.ts'],
  }), /outside the approved/);
  assert.match(evaluateTemporaryAuditException({ ...policy, changedPaths: [] }), /outside the approved/);
  assert.match(evaluateTemporaryAuditException({
    ...reviewed, changedPaths: [...reviewed.changedPaths, 'homenode-mobile/pnpm-lock.yaml'],
  }), /outside the approved/);
});

test('expires and rejects a changed dependency graph on any event', () => {
  assert.equal(evaluateTemporaryAuditException({ ...reviewed, todayUtc: '2026-10-19' }), null);
  assert.match(evaluateTemporaryAuditException({ ...reviewed, todayUtc: '2026-10-20' }), /expired/);
  assert.match(evaluateTemporaryAuditException({ ...reviewed, lockfileSha256: 'changed' }), /lockfile differs/);
});

test('accepts exactly the two reviewed advisories from one raw JSON audit', () => {
  const calls = [];
  runAudits(reviewed, (args) => {
    calls.push(args);
    return auditResult([forge, braces]);
  });
  assert.deepEqual(calls, [['audit', '--fetch-timeout=300000', '--audit-level=moderate', '--json']]);
});

test('third source-map-js high advisory fails even with both reviewed advisories', () => {
  assert.throws(() => runAudits(reviewed, () => auditResult([forge, braces, sourceMap])), /GHSA-68fv-2mgg-jv7q/);
});

test('another advisory under a reviewed package and a moderate finding also fail', () => {
  assert.throws(() => runAudits(reviewed, () => auditResult([
    forge, { ...braces, github_advisory_id: 'GHSA-unknown-braces' },
  ])), /GHSA-unknown-braces/);
  assert.throws(() => runAudits(reviewed, () => auditResult([
    forge, { ...sourceMap, severity: 'moderate' },
  ])), /GHSA-68fv-2mgg-jv7q/);
});

test('malformed, incomplete, inconsistent, or failed raw audits never pass', () => {
  assert.throws(() => runAudits(reviewed, () => ({ status: 1, stdout: 'registry unavailable' })), /Unparseable/);
  assert.throws(() => runAudits(reviewed, () => ({ status: 1, stdout: '{}' })), /Incomplete/);
  const inconsistent = auditResult([forge]);
  const parsed = JSON.parse(inconsistent.stdout);
  parsed.metadata.vulnerabilities.high = 2;
  assert.throws(() => runAudits(reviewed, () => ({ ...inconsistent, stdout: JSON.stringify(parsed) })), /inconsistent/);
  parsed.metadata.vulnerabilities.high = 0;
  parsed.metadata.vulnerabilities.moderate = 1;
  assert.throws(() => runAudits(reviewed, () => ({ ...inconsistent, stdout: JSON.stringify(parsed) })), /inconsistent/);
  parsed.metadata.vulnerabilities.high = 2;
  parsed.metadata.vulnerabilities.moderate = -1;
  assert.throws(() => runAudits(reviewed, () => ({ ...inconsistent, stdout: JSON.stringify(parsed) })), /inconsistent/);
  const errorReport = JSON.parse(auditResult([forge]).stdout);
  errorReport.error = 'registry unavailable';
  assert.throws(() => runAudits(reviewed, () => ({ ...inconsistent, stdout: JSON.stringify(errorReport) })), /Incomplete/);
  assert.throws(() => runAudits(reviewed, () => auditResult([forge], 2)), /abnormally/);
  assert.throws(() => runAudits(reviewed, () => auditResult([forge], null)), /abnormally/);
  assert.throws(() => runAudits(reviewed, () => ({ ...auditResult([forge]), signal: 'SIGKILL' })), /abnormally/);
  assert.throws(() => runAudits(reviewed, () => auditResult([], 1)), /failed without findings/);
  assert.throws(() => runAudits(reviewed, () => auditResult([forge], 0)), /findings status/);
});

test('unapproved scope is rejected and clean raw audit needs no exception', () => {
  const calls = [];
  assert.throws(() => runAudits({ ...reviewed, changedPaths: ['homenode-mobile/package.json'] }, (args) => {
    calls.push(args);
    return auditResult([forge, braces]);
  }), /outside the approved/);
  assert.equal(calls.length, 1);
  runAudits(() => { throw new Error('scope should not be inspected'); }, (args) => {
    calls.push(args);
    return auditResult([]);
  });
  assert.equal(calls.length, 2);
});
