import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateTemporaryAuditException, runAudits } from '../scripts/temporary-audit-exception.mjs';
import { verifyPatchedAuditEvidence, verifyPatchedDependencyGraph } from '../scripts/verify-patched-audit-graph.mjs';

const evidence = { visitedPackages: 2, packages: [{ name: 'node-forge' }, { name: 'braces' }], checkedPaths: 2 };
const reviewed = { todayUtc: '2026-10-06', verifyEvidence: () => evidence };
const finding = (version, dependencyPath) => ({ version, paths: [dependencyPath], bundled: false });
const forge = { github_advisory_id: 'GHSA-86w9-cpqp-85rv', module_name: 'node-forge', severity: 'high',
  findings: [finding('1.4.0', '.>expo>@expo/cli>node-forge')] };
const braces = { github_advisory_id: 'GHSA-vfj7-8cjw-p6xm', module_name: 'braces', severity: 'high',
  findings: [finding('3.0.3', '.>expo>@expo/cli>@expo/metro-file-map>micromatch>braces')] };
const sourceMap = { github_advisory_id: 'GHSA-68fv-2mgg-jv7q', module_name: 'source-map-js', severity: 'high',
  findings: [finding('1.2.1', '.>source-map-js')] };

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

test('patched-advisory recognition expires on the existing deadline and requires installed evidence', () => {
  assert.equal(evaluateTemporaryAuditException(reviewed, [forge]), evidence);
  assert.equal(evaluateTemporaryAuditException({ ...reviewed, todayUtc: '2026-10-19' }, [forge]), evidence);
  for (const todayUtc of ['2026-10-20', '', '2026-99-99', '2026-02-30', undefined]) {
    assert.throws(() => evaluateTemporaryAuditException({ ...reviewed, todayUtc }, [forge]), /expired|valid date/);
  }
  assert.throws(() => evaluateTemporaryAuditException({ todayUtc: '2026-10-06' }, [forge]), /Missing installed/);
  assert.throws(() => evaluateTemporaryAuditException({ ...reviewed, verifyEvidence: () => ({}) }, [forge]), /Incomplete/);
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

test('an unfixed critical shell-quote finding still blocks the mobile audit', () => {
  const shellQuote = { github_advisory_id: 'GHSA-pqg4-j6r4-53mv', module_name: 'shell-quote',
    severity: 'critical', findings: [finding('1.10.0', '.>react-native>react-devtools-core>shell-quote')] };
  assert.throws(() => runAudits(reviewed, () => auditResult([forge, braces, shellQuote])), /GHSA-pqg4-j6r4-53mv/);
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

test('failed installed evidence is blocking, while a clean raw audit needs no recognition', () => {
  assert.throws(() => runAudits({ ...reviewed, verifyEvidence: () => { throw new Error('altered patch'); } },
    () => auditResult([forge, braces])), /altered patch/);
  runAudits(() => { throw new Error('patch evidence should not be inspected'); }, () => auditResult([]));
  assert.throws(() => runAudits(reviewed, () => auditResult([{ ...forge, severity: 'critical' }])), /Unreviewed/);
});

function installedFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'homenode-audit-graph-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const code = 'module.exports = "reviewed security patch";\n';
  const hash = createHash('sha256').update(code).digest('hex');
  const expected = {
    'node-forge': { version: '1.4.0', files: { 'index.js': hash } },
    braces: { version: '3.0.3', files: { 'index.js': hash } },
  };
  const put = (directory, name, version, dependencies = {}, bytes = code) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version, dependencies }));
    writeFileSync(path.join(directory, 'index.js'), bytes);
  };
  put(root, 'fixture-project', '1.0.0', { 'fixture-owner': '1.0.0', braces: '3.0.3' });
  const owner = path.join(root, 'node_modules/fixture-owner');
  put(owner, 'fixture-owner', '1.0.0', { 'node-forge': '1.4.0' });
  put(path.join(root, 'node_modules/node-forge'), 'node-forge', '1.4.0');
  const nested = path.join(owner, 'node_modules/node-forge');
  put(nested, 'node-forge', '1.4.0');
  put(path.join(root, 'node_modules/braces'), 'braces', '3.0.3');
  const reported = [{ ...forge, findings: [finding('1.4.0', '.>fixture-owner>node-forge')] },
    { ...braces, findings: [finding('3.0.3', '.>braces')] }];
  return { root, expected, put, nested, reported };
}

test('checks actual owning paths and all reachable installed patched copies', (t) => {
  const { root, expected, reported } = installedFixture(t);
  const result = verifyPatchedAuditEvidence(reported, root, expected);
  assert.equal(result.visitedPackages, 4);
  assert.equal(result.packages.length, 2);
  assert.equal(result.checkedPaths, 2);
  assert.match(result.packages.find(p => p.name === 'node-forge').resolvedPackage, /fixture-owner\/node_modules\/node-forge/);
});

test('a valid hoisted copy cannot hide an altered nested consumer copy', (t) => {
  const { root, expected, nested, reported } = installedFixture(t);
  writeFileSync(path.join(nested, 'index.js'), 'module.exports = "unpatched";\n');
  assert.throws(() => verifyPatchedAuditEvidence(reported, root, expected), /integrity mismatch/);
});

test('checks an unreported reachable copy beyond a truncated audit path list', (t) => {
  const { root, expected, put, reported } = installedFixture(t);
  const hidden = path.join(root, 'node_modules/fixture-hidden');
  put(root, 'fixture-project', '1.0.0', { 'fixture-owner': '1.0.0', 'fixture-hidden': '1.0.0', braces: '3.0.3' });
  put(hidden, 'fixture-hidden', '1.0.0', { braces: '3.0.3' });
  put(path.join(hidden, 'node_modules/braces'), 'braces', '3.0.3', {}, 'unpatched hidden copy');
  assert.throws(() => verifyPatchedAuditEvidence(reported, root, expected), /integrity mismatch/);
});

test('rejects unexpected versions, missing required dependencies, and unresolved audited paths', (t) => {
  const { root, expected, put, nested, reported } = installedFixture(t);
  put(nested, 'node-forge', '1.3.3');
  assert.throws(() => verifyPatchedDependencyGraph(root, expected), /Unreviewed.*version/);
  rmSync(nested, { recursive: true });
  rmSync(path.join(root, 'node_modules/node-forge'), { recursive: true });
  assert.throws(() => verifyPatchedDependencyGraph(root, expected), /Cannot resolve/);
  put(nested, 'node-forge', '1.4.0');
  assert.throws(() => verifyPatchedAuditEvidence([{ ...forge, findings: [finding('1.4.0', '.>missing-owner>node-forge')] }], root, expected), /Cannot resolve/);
  assert.doesNotThrow(() => verifyPatchedAuditEvidence(reported, root, expected));
});

test('rejects incomplete, malformed, bundled, and unreviewed audit findings', (t) => {
  const { root, expected } = installedFixture(t);
  for (const badFinding of [
    finding('1.3.3', '.>node-forge'), { version: '1.4.0' },
    { ...finding('1.4.0', '.>node-forge'), bundled: true },
    { ...finding('1.4.0', '.>node-forge'), paths: [] },
    finding('1.4.0', '../node-forge'), finding('1.4.0', '.>braces'),
    finding('1.4.0', '.>../node-forge'), finding('1.4.0', '.>>node-forge'),
    { ...finding('1.4.0', '.>node-forge'), paths: [null] },
  ]) {
    assert.throws(() => verifyPatchedAuditEvidence([{ ...forge, findings: [badFinding] }], root, expected), /Unreviewed|Invalid/);
  }
  assert.throws(() => verifyPatchedAuditEvidence([{ ...forge, severity: 'critical' }], root, expected), /Unreviewed/);
});

test('the real frozen Expo graph and every representative consumer path contain the reviewed patches', () => {
  const actual = verifyPatchedAuditEvidence([forge, braces]);
  assert.ok(actual.visitedPackages > 400);
  assert.ok(actual.packages.some(item => item.name === 'node-forge' && item.version === '1.4.0'));
  assert.ok(actual.packages.some(item => item.name === 'braces' && item.version === '3.0.3'));
  assert.equal(actual.checkedPaths, 2);
});
