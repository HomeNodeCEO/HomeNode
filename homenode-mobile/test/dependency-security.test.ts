import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(mobileRoot, '..');
const expoRequire = createRequire(require.resolve('expo/package.json'));
const expoCliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const metroRoot = path.dirname(expoCliRequire.resolve('metro/package.json'));
const imageSizeModule = require.resolve('image-size', { paths: [metroRoot] });

const malformedImages = {
  heifZeroSizedBox: new Uint8Array([
    0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
    0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x24, 0x6d, 0x65, 0x74, 0x61,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x08, 0x69, 0x70, 0x72, 0x70,
    0x00, 0x00, 0x00, 0x14, 0x69, 0x70, 0x63, 0x6f,
    0x00, 0x00, 0x00, 0x00, 0x69, 0x73, 0x70, 0x65,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]),
  icnsZeroSizedEntry: new Uint8Array([
    0x69, 0x63, 0x6e, 0x73,
    0x00, 0x00, 0x00, 0x10,
    0x69, 0x73, 0x33, 0x32,
    0x00, 0x00, 0x00, 0x00,
  ]),
  jxlZeroSizedPartialStream: new Uint8Array([
    0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20,
    0x0d, 0x0a, 0x87, 0x0a,
    0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
    0x6a, 0x78, 0x6c, 0x20, 0x00, 0x00, 0x00, 0x00,
    0x6a, 0x78, 0x6c, 0x20,
    0x00, 0x00, 0x00, 0x00, 0x6a, 0x78, 0x6c, 0x70,
    0x00, 0x00, 0x00, 0x00,
  ]),
};

test('patched image-size rejects malformed boxes without blocking the build process', () => {
  for (const [name, payload] of Object.entries(malformedImages)) {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        'const imageSize=require(process.argv[1]);try{imageSize(Buffer.from(process.argv[2],"base64"));}catch{}',
        imageSizeModule,
        Buffer.from(payload).toString('base64'),
      ],
      { cwd: mobileRoot, encoding: 'utf8', timeout: 1_500 },
    );
    assert.notEqual(
      (result.error as NodeJS.ErrnoException | undefined)?.code,
      'ETIMEDOUT',
      `${name} blocked the Node.js event loop`,
    );
    assert.equal(result.status, 0, `${name} probe failed: ${result.stderr}`);
  }
});

test('Expo xcode tooling resolves the patched uuid release', () => {
  const xcodeRoot = path.dirname(expoCliRequire.resolve('xcode/package.json'));
  const uuidPackage = require(
    require.resolve('uuid/package.json', { paths: [xcodeRoot] }),
  ) as { version: string };
  assert.equal(uuidPackage.version, '11.1.1');
  const xcode = require(xcodeRoot) as {
    project: (filename: string) => {
      hash: { project: { objects: Record<string, unknown> } };
      generateUuid: () => string;
    };
  };
  const project = xcode.project('synthetic.pbxproj');
  project.hash = { project: { objects: {} } };
  assert.match(project.generateUuid(), /^[A-F0-9]{24}$/);
});

test('dependency security gates reject moderate or higher findings', () => {
  const workflow = readFileSync(
    path.join(repositoryRoot, '.github/workflows/dependency-security.yml'),
    'utf8',
  );

  assert.match(workflow, /fail-on-severity:\s*moderate/);
  assert.equal(
    (workflow.match(/npm audit --package-lock-only --audit-level=moderate/g) ?? []).length,
    1,
  );
  assert.equal(
    (workflow.match(/^\s*run:\s+pnpm audit --fetch-timeout=300000 --audit-level=moderate\s*$/gm) ?? []).length,
    1,
  );
  assert.doesNotMatch(workflow, /audit-level=high|fail-on-severity:\s*high/);
});
