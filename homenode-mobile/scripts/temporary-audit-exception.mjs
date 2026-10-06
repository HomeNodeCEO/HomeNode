import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPatchedAuditEvidence } from './verify-patched-audit-graph.mjs';

const mobileRoot = fileURLToPath(new URL('../', import.meta.url));
const deadline = '2026-10-19';
const auditArgs = ['audit', '--fetch-timeout=300000', '--audit-level=moderate', '--json'];
const reviewedAdvisories = new Map([
  ['GHSA-86w9-cpqp-85rv', 'node-forge'],
  ['GHSA-vfj7-8cjw-p6xm', 'braces'],
]);

export function evaluateTemporaryAuditException({ todayUtc, verifyEvidence }, advisories) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayUtc ?? '') ||
      !Number.isFinite(Date.parse(todayUtc)) ||
      new Date(todayUtc).toISOString().slice(0, 10) !== todayUtc || todayUtc > deadline) {
    throw new Error('temporary patched-advisory review expired or has no valid date');
  }
  if (typeof verifyEvidence !== 'function') throw new Error('Missing installed patch evidence verifier');
  // Every reachable installed copy is checked, because registry audit paths can
  // be truncated. Every reported path is additionally resolved from its owner.
  const evidence = verifyEvidence(advisories);
  if (!Number.isSafeInteger(evidence?.visitedPackages) || evidence.visitedPackages <= 0 ||
      !Array.isArray(evidence.packages) || evidence.packages.length === 0 ||
      !Number.isSafeInteger(evidence.checkedPaths) || evidence.checkedPaths <= 0) {
    throw new Error('Incomplete installed patch evidence');
  }
  return evidence;
}

export function runAudits(contextProvider, auditRunner) {
  // One unfiltered JSON response is the source of truth. pnpm's --ignore flag
  // previously returned success with a third advisory, so never use it here.
  const result = auditRunner(auditArgs);
  let report;
  try { report = JSON.parse(result.stdout); } catch {
    throw new Error('Unparseable raw audit response or registry failure');
  }
  if (result.signal || ![0, 1].includes(result.status)) throw new Error('Raw audit ended abnormally');
  if (!report || typeof report.advisories !== 'object' || report.advisories === null ||
      Array.isArray(report.advisories) || typeof report.metadata?.vulnerabilities !== 'object' ||
      Object.hasOwn(report, 'error') || Object.hasOwn(report, 'error_code') || Object.hasOwn(report, 'code')) {
    throw new Error('Incomplete raw audit response or registry failure');
  }
  const advisories = Object.values(report.advisories);
  const counts = report.metadata.vulnerabilities;
  const severities = ['info', 'low', 'moderate', 'high', 'critical'];
  if (severities.some((severity) => !Number.isSafeInteger(counts[severity]) || counts[severity] < 0 ||
      counts[severity] !== advisories.filter((item) => item?.severity === severity).length) ||
      advisories.some((item) => !item || !['moderate', 'high', 'critical'].includes(item.severity) ||
        !Array.isArray(item.findings) || item.findings.length === 0)) {
    throw new Error('Raw audit counts or findings are inconsistent');
  }
  if (advisories.length === 0) {
    if (result.status !== 0) throw new Error('Raw audit failed without findings');
    return;
  }
  if (result.status !== 1) throw new Error('Raw audit reported findings but did not exit with findings status');
  const unknown = advisories.filter((item) => reviewedAdvisories.get(item.github_advisory_id) !== item.module_name ||
    item.severity !== 'high');
  if (unknown.length) {
    throw new Error(`Unreviewed advisories remain: ${unknown.map((item) => item.github_advisory_id || item.module_name).join(', ')}`);
  }
  const context = typeof contextProvider === 'function' ? contextProvider() : contextProvider;
  const evidence = evaluateTemporaryAuditException(context, advisories);
  console.log(JSON.stringify({ patchedAuditEvidence: evidence }));
  console.warn(`::warning::Verified local patches for ${advisories.length} upstream advisories; review expires ${deadline}. Raw registry findings remain visible.`);
}

function main() {
  runAudits(() => ({
    todayUtc: new Date().toISOString().slice(0, 10),
    verifyEvidence: verifyPatchedAuditEvidence,
  }), (args) => {
    const result = spawnSync('pnpm', args, { cwd: mobileRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { status: result.status, signal: result.signal, stdout: result.stdout || '' };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(`Mobile patched audit denied: ${error.message}`);
    process.exitCode = 1;
  }
}
