import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
// Exercise the actual lint tool's dependency, not a separately installed copy.
const eslintRequire = createRequire(require.resolve('@eslint/eslintrc'));
const yaml = eslintRequire('js-yaml');

test('lint YAML parser counts empty merge sources toward its work budget', () => {
  // Bounded regression for GHSA-2883-xcg3-v3hh: no large stress-test payload.
  const input = `empty: &empty {}\nvalue:\n  <<: [${Array(16).fill('*empty').join(', ')}]\n`;
  assert.throws(() => yaml.load(input, { maxTotalMergeKeys: 4 }), /merge|limit/i);
});

test('lint YAML parser retains ordinary merge behavior below its work budget', () => {
  const input = 'defaults: &defaults { color: gold }\nvalue:\n  <<: *defaults\n  label: purple\n';
  assert.deepEqual(yaml.load(input, { maxTotalMergeKeys: 4 }), {
    defaults: { color: 'gold' }, value: { color: 'gold', label: 'purple' },
  });
});
