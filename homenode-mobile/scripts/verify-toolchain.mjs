import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mobileRoot = fileURLToPath(new URL('../', import.meta.url));
const expected = JSON.parse(readFileSync(new URL('./toolchain-integrity.json', import.meta.url), 'utf8'));
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

// Resolve from each real consumer, not an unrelated top-level or stale store copy.
// This verifies the reviewed patched files, not every file in these packages.
export function verifyInstalledPackage(consumer, name, integrity, root = mobileRoot) {
  const packageFile = realpathSync(consumer.resolve(`${name}/package.json`));
  const packageRoot = path.dirname(packageFile);
  const metadata = JSON.parse(readFileSync(packageFile, 'utf8'));
  if (metadata.name !== name || metadata.version !== integrity.version) {
    throw new Error(`Unexpected ${name} version; expected ${integrity.version}. Review the toolchain manifest.`);
  }
  const files = {};
  for (const [file, expectedHash] of Object.entries(integrity.files)) {
    const actualHash = sha256(readFileSync(path.join(packageRoot, file)));
    if (actualHash !== expectedHash) {
      throw new Error(`Toolchain integrity mismatch: ${name}/${file}. Restore the frozen patched install.`);
    }
    files[file] = actualHash;
  }
  return {
    name, version: metadata.version,
    resolvedPackage: path.relative(root, packageFile).split(path.sep).join('/'),
    files,
  };
}

export function verifyMobileToolchain() {
  const project = createRequire(path.join(mobileRoot, 'package.json'));
  const expo = createRequire(project.resolve('expo/package.json'));
  const cli = createRequire(expo.resolve('@expo/cli/package.json'));
  const signing = createRequire(cli.resolve('@expo/code-signing-certificates'));
  const consumers = [
    ['expo > @expo/cli', cli, 'node-forge'],
    ['expo > @expo/cli > @expo/code-signing-certificates', signing, 'node-forge'],
    ...['@expo/metro-file-map', 'metro-file-map'].map((name) => {
      const fileMap = createRequire(cli.resolve(`${name}/package.json`));
      return [`expo > @expo/cli > ${name} > micromatch`,
        createRequire(fileMap.resolve('micromatch/package.json')), 'braces'];
    }),
  ];
  return {
    schemaVersion: 1,
    scope: 'project-resolved Expo/Metro patched files only',
    node: process.version,
    lockfileSha256: sha256(readFileSync(path.join(mobileRoot, 'pnpm-lock.yaml'))),
    packages: consumers.map(([consumer, resolve, name]) => ({
      consumer, ...verifyInstalledPackage(resolve, name, expected[name]),
    })),
    releaseApproved: false,
    limitations: 'Does not clear advisories or attest global EAS tools, browser bundles, native artifacts, or OTA releases.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(verifyMobileToolchain(), null, 2));
  } catch (error) {
    console.error(`Mobile toolchain verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
