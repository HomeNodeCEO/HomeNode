import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const apiSource = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
const historyApiSource = await readFile(
  new URL('../src/lib/appraisalHistoryApi.ts', import.meta.url),
  'utf8',
);
const componentSource = await readFile(
  new URL('../src/components/PreviousAppraisalFiles.tsx', import.meta.url),
  'utf8',
);

test('appraisal history uses bounded cursor pagination', () => {
  assert.match(historyApiSource, /\{ cursor: cursor \|\| undefined \}/);
  assert.doesNotMatch(historyApiSource, /\?cursor=/);
  assert.match(apiSource, /next_cursor: string \| null/);
  assert.match(componentSource, /getPreviousAppraisalFiles\(accountId, nextCursor\)/);
  assert.match(componentSource, /new Map\(current\.map\(\(file\) => \[file\.id, file\]\)\)/);
  assert.match(componentSource, /generation !== loadGeneration\.current/);
  assert.match(componentSource, /Load older files/);
});
