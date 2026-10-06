import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const deadline = '2026-10-19';
const reviewedLockfileSha256 = '0155ed6bfd92df1c836a2c9b4c6813bcf6fd2f07868820b38ae1507f646b49da';
const auditArgs = ['audit', '--fetch-timeout=300000', '--audit-level=moderate', '--json'];
const reviewedAdvisories = new Map([
  ['GHSA-86w9-cpqp-85rv', 'node-forge'],
  ['GHSA-vfj7-8cjw-p6xm', 'braces'],
]);

const allowedFiles = new Map([
  [1130, new Set([
    'dcad-frontend/scripts/testCustomCohortControlledWorkspace.mjs',
    'dcad-frontend/scripts/testCustomCohortRecordedProximity.mjs',
    'dcad-frontend/scripts/testCustomNeighborhoodWorkspaceHost.mjs',
    'dcad-frontend/scripts/testCustomWorkspaceCityDiscovery.mjs',
    'dcad-frontend/scripts/testCustomWorkspaceDiscovery.mjs',
    'dcad-frontend/src/features/neighborhood/components/CustomCohortWorkspace.tsx',
    'dcad-frontend/src/features/neighborhood/components/CustomNeighborhoodWorkspaceHost.tsx',
    'dcad-frontend/src/features/neighborhood/customCohortPocketRecommendation.ts',
    'dcad-frontend/src/features/neighborhood/customWorkspaceDiscovery.ts',
    'server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js',
    'server/src/services/neighborhoodAssessment/customCohortRecordedProximity.js',
    'server/src/services/neighborhoodAssessment/selectorInputProfile.js',
    'server/test/customCohortContextCapture.test.js',
    'server/test/customCohortPocketRecommendationV2.test.js',
    'server/test/customCohortRecordedProximity.test.js',
    'server/test/customCohortRecordedProximityPresentation.test.js',
    'server/test/customWorkspaceCheckpointV3.test.js',
    'server/test/customWorkspaceCheckpointV4.test.js',
    'server/test/fixtures/customCohortDiscoveryExpansionFixture.js',
    'server/test/helpers/customCohortDiscoveryDatabaseChecks.js',
    'server/test/helpers/neighborhoodSpatialMembershipDatabaseChecks.js',
    'server/test/neighborhoodDiscoveryExpansion.test.js',
    'server/test/neighborhoodSpatialStream.test.js',
  ])],
  [1131, new Set([
    '.github/workflows/dependency-security.yml',
    'dcad-frontend/package-lock.json',
    'homenode-mobile/package.json',
    'homenode-mobile/pnpm-lock.yaml',
    'homenode-mobile/pnpm-workspace.yaml',
    'homenode-mobile/scripts/temporary-audit-exception.mjs',
    'homenode-mobile/test/dependency-security.test.ts',
    'homenode-mobile/test/temporary-audit-exception.test.mjs',
  ])],
]);

export function evaluateTemporaryAuditException({
  eventName, ref, prNumber, commitMessage, todayUtc, lockfileSha256, changedPaths,
}) {
  if (todayUtc > deadline) return 'temporary exception expired';
  if (lockfileSha256 !== reviewedLockfileSha256) return 'mobile lockfile differs from the reviewed graph';
  let authorizedPr;
  if (eventName === 'pull_request' && ref.startsWith('refs/pull/')) {
    authorizedPr = Number(prNumber);
  } else if (eventName === 'push' && ref === 'refs/heads/main') {
    const merge = /^Merge pull request #(1130|1131)\b/.exec(commitMessage || '');
    authorizedPr = merge ? Number(merge[1]) : undefined;
  }
  const permitted = allowedFiles.get(authorizedPr);
  if (!permitted) return 'event is not an approved web-only pull request or merge';
  if (!changedPaths.length || changedPaths.some((file) => !permitted.has(file))) {
    return 'change includes a file outside the approved pull request scope';
  }
  return null;
}

export function runAudits(contextProvider, auditRunner) {
  // One unfiltered JSON response is the source of truth. pnpm's --ignore flag
  // returned success while a third, unignored advisory was present, so never
  // infer safety from a second filtered command's exit status.
  const result = auditRunner(auditArgs);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error('Unparseable raw audit response or registry failure');
  }
  if (result.signal || ![0, 1].includes(result.status)) {
    throw new Error('Raw audit ended abnormally');
  }
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
  const unknown = advisories.filter((item) => reviewedAdvisories.get(item.github_advisory_id) !== item.module_name);
  if (unknown.length) {
    throw new Error(`Unreviewed advisories remain: ${unknown.map((item) => item.github_advisory_id || item.module_name).join(', ')}`);
  }
  const context = typeof contextProvider === 'function' ? contextProvider() : contextProvider;
  const refusal = evaluateTemporaryAuditException(context);
  if (refusal) throw new Error(refusal);
  console.warn(`::warning::Temporary exception for ${advisories.length} reviewed Expo/Metro advisories; expires ${deadline}.`);
}

function collectContext() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const ref = process.env.GITHUB_REF || '';
  const baseSha = process.env.AUDIT_BASE_SHA || '';
  const headSha = process.env.AUDIT_HEAD_SHA || '';
  if (![baseSha, headSha].every((sha) => /^[0-9a-f]{40}$/.test(sha))) {
    throw new Error('Missing exact Git comparison SHAs for mobile audit exception');
  }
  const range = eventName === 'pull_request' ? `${baseSha}...${headSha}` : `${baseSha}..${headSha}`;
  const changedPaths = execFileSync('git', ['diff', '--name-only', '--no-renames', range], {
    cwd: repositoryRoot, encoding: 'utf8', timeout: 30_000,
  }).trim().split(/\r?\n/).filter(Boolean);
  const lockfileSha256 = createHash('sha256').update(readFileSync(path.join(repositoryRoot, 'homenode-mobile/pnpm-lock.yaml'))).digest('hex');
  return {
    eventName, ref,
    prNumber: process.env.AUDIT_PR_NUMBER,
    commitMessage: process.env.AUDIT_COMMIT_MESSAGE,
    todayUtc: new Date().toISOString().slice(0, 10),
    lockfileSha256,
    changedPaths,
  };
}

function main() {
  runAudits(collectContext, (args) => {
    const result = spawnSync('pnpm', args, {
      cwd: path.join(repositoryRoot, 'homenode-mobile'), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { status: result.status, signal: result.signal, stdout: result.stdout || '' };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`Mobile audit exception denied: ${error.message}`);
    process.exitCode = 1;
  }
}
