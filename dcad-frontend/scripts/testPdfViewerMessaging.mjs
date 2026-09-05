import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const viewerSource = await readFile(
  new URL('../public/pdfjs-viewer.html', import.meta.url),
  'utf8',
);

test('PDF export messages require the same-origin parent window', () => {
  assert.match(
    viewerSource,
    /event\.source === window\.parent\s*&&\s*event\.origin === window\.location\.origin/,
  );
  assert.equal(
    [...viewerSource.matchAll(/type\s*===\s*['"]SAVE_PDF['"]/g)].length,
    2,
    'both the PDF.js and fallback handlers remain covered',
  );
  assert.equal(
    [...viewerSource.matchAll(/isTrustedParentMessage\((?:e|ev)\).*SAVE_PDF/g)].length,
    2,
    'every SAVE_PDF handler must apply the trusted-parent guard',
  );
});

test('PDF bytes and errors are never posted to a wildcard origin', () => {
  assert.doesNotMatch(viewerSource, /window\.parent\.postMessage\([^;]*,\s*['"]\*['"]\s*\)/s);
  assert.match(
    viewerSource,
    /window\.parent\.postMessage\(message,\s*window\.location\.origin\)/,
  );
  assert.doesNotMatch(viewerSource, /error:\s*String\s*\(/);
  assert.match(viewerSource, /error:\s*['"]pdf_export_unavailable['"]/);
  assert.match(viewerSource, /error:\s*['"]pdf_export_failed['"]/);
});
