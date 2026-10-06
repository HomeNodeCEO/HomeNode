import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = fileURLToPath(new URL('../', import.meta.url));
const reviewed = JSON.parse(readFileSync(new URL('./toolchain-integrity.json', import.meta.url), 'utf8'));
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Follow Node's ordered package search from the actual owning package. Reading
// package.json directly also handles packages that do not export that subpath.
function installedPackage(consumer, name, root) {
  if (!packageName.test(name)) throw new Error('Invalid dependency name in audit graph');
  for (const directory of consumer.resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name, 'package.json');
    if (!existsSync(candidate)) continue;
    const file = realpathSync(candidate);
    const relative = path.relative(path.resolve(root, 'node_modules'), file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error(`Cannot resolve installed dependency within this project: ${name}`);
    }
    const metadata = JSON.parse(readFileSync(file, 'utf8'));
    if (!metadata || typeof metadata.name !== 'string' || typeof metadata.version !== 'string') {
      throw new Error(`Invalid installed package metadata: ${name}`);
    }
    return { file, metadata, consumer: createRequire(file) };
  }
  throw Object.assign(new Error(`Cannot resolve installed dependency: ${name}`), { code: 'MODULE_NOT_FOUND' });
}

function inspectPatchedPackage(installed, expected, root) {
  const { file, metadata } = installed;
  const integrity = expected[metadata.name];
  if (!integrity || metadata.version !== integrity.version) {
    throw new Error(`Unreviewed patched package version: ${metadata.name}@${metadata.version}`);
  }
  const files = {};
  for (const [relativeFile, hash] of Object.entries(integrity.files)) {
    const actual = sha256(readFileSync(path.join(path.dirname(file), relativeFile)));
    if (actual !== hash) throw new Error(`Patched audit integrity mismatch: ${metadata.name}/${relativeFile}`);
    files[relativeFile] = actual;
  }
  return { name: metadata.name, version: metadata.version,
    resolvedPackage: path.relative(root, file).split(path.sep).join('/'), files };
}

export function verifyPatchedDependencyGraph(root = mobileRoot, expected = reviewed) {
  const rootFile = path.join(root, 'package.json');
  const queue = [{ file: rootFile, metadata: JSON.parse(readFileSync(rootFile, 'utf8')), consumer: createRequire(rootFile) }];
  const visited = new Set();
  const packages = [];
  for (let index = 0; index < queue.length; index++) {
    const installed = queue[index];
    const identity = realpathSync(installed.file);
    if (visited.has(identity)) continue;
    visited.add(identity);
    if (visited.size > 2_000) throw new Error('Installed audit graph exceeds its review bound');
    if (Object.hasOwn(expected, installed.metadata.name)) {
      packages.push(inspectPatchedPackage(installed, expected, root));
    }
    const { dependencies = {}, optionalDependencies = {}, peerDependencies = {}, devDependencies = {} } = installed.metadata;
    const names = new Set([...Object.keys(dependencies), ...Object.keys(optionalDependencies),
      ...Object.keys(peerDependencies), ...(index === 0 ? Object.keys(devDependencies) : [])]);
    for (const name of names) {
      try {
        queue.push(installedPackage(installed.consumer, name, root));
      } catch (error) {
        const required = Object.hasOwn(dependencies, name) && !Object.hasOwn(optionalDependencies, name) ||
          index === 0 && Object.hasOwn(devDependencies, name);
        if (error.code !== 'MODULE_NOT_FOUND' || required) throw error;
        // Absent optional dependencies and peers cannot supply executable code.
      }
    }
  }
  return { visitedPackages: visited.size, packages };
}

export function verifyPatchedAuditEvidence(advisories, root = mobileRoot, expected = reviewed) {
  const graph = verifyPatchedDependencyGraph(root, expected);
  const copies = new Set(graph.packages.map((item) => item.resolvedPackage));
  const project = createRequire(path.join(root, 'package.json'));
  let checkedPaths = 0;
  for (const advisory of advisories) {
    const integrity = expected[advisory.module_name];
    if (!integrity || advisory.severity !== 'high') throw new Error('Unreviewed patched advisory severity or package');
    for (const finding of advisory.findings) {
      if (finding.version !== integrity.version || finding.bundled !== false ||
          !Array.isArray(finding.paths) || finding.paths.length === 0) {
        throw new Error('Unreviewed audit finding version or missing dependency paths');
      }
      for (const dependencyPath of finding.paths) {
        if (typeof dependencyPath !== 'string') throw new Error('Invalid audit dependency path');
        const chain = dependencyPath.split('>');
        if (chain.shift() !== '.' || chain.length === 0 || chain.length > 64 ||
            chain.at(-1) !== advisory.module_name || chain.some((name) => !packageName.test(name))) {
          throw new Error('Invalid audit dependency path');
        }
        if (++checkedPaths > 10_000) throw new Error('Audit dependency paths exceed their review bound');
        let owner = project;
        let installed;
        for (const name of chain) {
          installed = installedPackage(owner, name, root);
          owner = installed.consumer;
        }
        const evidence = inspectPatchedPackage(installed, expected, root);
        if (!copies.has(evidence.resolvedPackage)) throw new Error('Audit path is outside the verified installed graph');
      }
    }
  }
  return { ...graph, checkedPaths };
}
