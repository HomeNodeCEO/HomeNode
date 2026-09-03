import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const indexHtmlUrl = new URL('../index.html', import.meta.url);
const applicationCssUrl = new URL('../src/index.css', import.meta.url);
const legacyCssUrl = new URL('../src/styles/base44-main.css', import.meta.url);

test('the application loads only its generated Tailwind v4 stylesheet', async () => {
  const [indexHtml, applicationCss] = await Promise.all([
    readFile(indexHtmlUrl, 'utf8'),
    readFile(applicationCssUrl, 'utf8'),
  ]);

  assert.doesNotMatch(indexHtml, /base44-main\.css/);
  assert.equal((applicationCss.match(/@import\s+["']tailwindcss["']/g) || []).length, 1);
  await assert.rejects(access(legacyCssUrl), { code: 'ENOENT' });
});

test('property-detail compatibility rules survive removal of the duplicate bundle', async () => {
  const applicationCss = await readFile(applicationCssUrl, 'utf8');

  assert.match(applicationCss, /\.ownership-grid\s*>\s*div\s*\{/);
  assert.match(applicationCss, /background-color:\s*#f4f7fa/);
  assert.match(applicationCss, /border-radius:\s*0\.75rem/);
  assert.match(applicationCss, /\.ownership-grid \.addl-info-section \.space-y-3 > div:last-child\s*\{/);
  assert.match(applicationCss, /display:\s*none/);
});
