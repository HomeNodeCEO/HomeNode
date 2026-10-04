import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyInstalledPackage, verifyMobileToolchain } from '../scripts/verify-toolchain.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'homenode-toolchain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules', 'fixture-dependency');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }));
  const code = 'module.exports = "reviewed patched source";\n';
  writeFileSync(path.join(packageRoot, 'index.js'), code);
  const integrity = { version: '1.0.0', files: { 'index.js': createHash('sha256').update(code).digest('hex') } };
  return { root, packageRoot, integrity, consumer: createRequire(path.join(root, 'package.json')) };
}

test('installed toolchain inspection reports all four real Expo/Metro dependency paths', () => {
  const evidence = verifyMobileToolchain();
  assert.equal(evidence.packages.length, 4);
  assert.equal(new Set(evidence.packages.map((entry) => entry.consumer)).size, 4);
  assert.equal(evidence.packages.filter((entry) => entry.name === 'braces').length, 2);
  assert.equal(evidence.packages.filter((entry) => entry.name === 'node-forge').length, 2);
  assert.equal(evidence.releaseApproved, false);
  assert.match(evidence.lockfileSha256, /^[a-f0-9]{64}$/);
});

test('installed package inspection accepts reviewed bytes and reports the resolved path', (t) => {
  const { root, consumer, integrity } = fixture(t);
  const result = verifyInstalledPackage(consumer, 'fixture-dependency', integrity, root);
  assert.equal(result.resolvedPackage, 'node_modules/fixture-dependency/package.json');
  assert.deepEqual(result.files, integrity.files);
});

test('installed package inspection rejects missing or modified patched files', (t) => {
  const { root, consumer, integrity, packageRoot } = fixture(t);
  writeFileSync(path.join(packageRoot, 'index.js'), 'module.exports = "unpatched";\n');
  assert.throws(() => verifyInstalledPackage(consumer, 'fixture-dependency', integrity, root), /integrity mismatch/);
  rmSync(path.join(packageRoot, 'index.js'));
  assert.throws(() => verifyInstalledPackage(consumer, 'fixture-dependency', integrity, root), { code: 'ENOENT' });
});

test('installed package inspection rejects unreviewed versions', (t) => {
  const { root, consumer, integrity, packageRoot } = fixture(t);
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '2.0.0' }));
  assert.throws(() => verifyInstalledPackage(consumer, 'fixture-dependency', integrity, root), /Unexpected.*version/);
});

test('a nested unpatched copy cannot be hidden by a valid top-level dependency', (t) => {
  const { root, integrity } = fixture(t);
  const consumerRoot = path.join(root, 'node_modules', 'fixture-consumer');
  const shadowRoot = path.join(consumerRoot, 'node_modules', 'fixture-dependency');
  mkdirSync(shadowRoot, { recursive: true });
  writeFileSync(path.join(shadowRoot, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }));
  writeFileSync(path.join(shadowRoot, 'index.js'), 'module.exports = "unpatched nested copy";\n');
  const consumer = createRequire(path.join(consumerRoot, 'package.json'));
  assert.throws(() => verifyInstalledPackage(consumer, 'fixture-dependency', integrity, root), /integrity mismatch/);
});
