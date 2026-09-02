import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the shared JSON request helper has an unknown-safe response boundary', async () => {
  const source = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bas any\b|:\s*any\b|<any>|Record<string,\s*any>/);
  assert.match(source, /fetchJSON<T = unknown>/);
  assert.match(source, /const body: unknown = isJson/);
  assert.match(source, /responseErrorMessage\(body, res\.status\)/);
  assert.match(source, /error instanceof Error && error\.name === 'AbortError'/);
});
