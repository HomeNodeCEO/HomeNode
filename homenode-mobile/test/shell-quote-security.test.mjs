import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// Resolve from the React Native consumer so a separate top-level copy cannot
// make these checks pass while Expo still loads the vulnerable dependency.
const require = createRequire(import.meta.url);
const reactNative = createRequire(require.resolve('react-native/package.json'));
const devtools = createRequire(reactNative.resolve('react-devtools-core/package.json'));
const shellQuote = devtools('shell-quote');

test('React Native resolves the reviewed shell-quote release', () => {
  assert.equal(devtools('shell-quote/package.json').version, '1.11.0');
  assert.equal(shellQuote.quote(['echo', 'hello world']), "echo 'hello world'");
});

test('tokens after a shell comment reject every supported line terminator', () => {
  for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(
      () => shellQuote.quote(['echo', 'ok', { comment: 'note' }, `value${terminator}id;#`]),
      { name: 'TypeError', message: /line terminators/ },
    );
  }
  assert.equal(shellQuote.quote(['echo', 'ok', { comment: 'note' }]), 'echo ok #note');
});
