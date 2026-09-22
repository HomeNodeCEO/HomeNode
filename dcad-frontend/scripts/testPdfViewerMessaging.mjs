import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const viewerHtml = await readFile(
  new URL('../pdfjs-viewer.html', import.meta.url),
  'utf8',
);
const viewerSource = await readFile(
  new URL('../src/pdfjs-viewer.ts', import.meta.url),
  'utf8',
);
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const viteSource = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');

test('PDF export messages require the same-origin parent window', () => {
  assert.match(
    viewerSource,
    /event\.source === window\.parent\s*&&\s*event\.origin === window\.location\.origin/,
  );
  assert.equal(
    [...viewerSource.matchAll(/data\.type\s*!==\s*['"]SAVE_PDF['"]/g)].length,
    1,
    'the PDF.js export handler remains covered',
  );
  assert.equal(
    [...viewerSource.matchAll(/isTrustedParentMessage\(event\).*SAVE_PDF/g)].length,
    1,
    'the SAVE_PDF handler must apply the trusted-parent guard',
  );
});

test('PDF bytes and errors are never posted to a wildcard origin', () => {
  assert.doesNotMatch(viewerSource, /window\.parent\.postMessage\([^;]*,\s*['"]\*['"]\s*\)/s);
  assert.match(
    viewerSource,
    /window\.parent\.postMessage\(message,\s*window\.location\.origin\)/,
  );
  assert.doesNotMatch(viewerSource, /error:\s*String\s*\(/);
  assert.match(viewerSource, /error:\s*['"]pdf_export_failed['"]/);
});

test('PDF.js code and worker are bundled from one pinned first-party dependency', () => {
  assert.equal(packageJson.dependencies['pdfjs-dist'], '6.3.289');
  assert.match(viewerHtml, /src=["']\/src\/pdfjs-viewer\.ts["']/);
  assert.match(viewerSource, /from ["']pdfjs-dist["']/);
  assert.match(viewerSource, /pdf\.worker\.mjs\?url["']/);
  assert.match(viteSource, /pdfViewer:\s*fileURLToPath\(new URL\(['"]\.\/pdfjs-viewer\.html['"]/);
  assert.doesNotMatch(`${viewerHtml}\n${viewerSource}`, /https?:\/\/|cdn\.jsdelivr\.net|unpkg\.com/);
});
