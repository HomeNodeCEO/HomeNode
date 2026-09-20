import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const port = Number(process.env.HOMENODE_LAYOUT_TEST_PORT || 4178);
const origin = `http://127.0.0.1:${port}`;

await access(viteBin);

const preview = spawn(process.execPath, [
  viteBin,
  'preview',
  '--host',
  '127.0.0.1',
  '--port',
  String(port),
  '--strictPort',
], {
  cwd: frontendRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let previewOutput = '';
preview.stdout.on('data', chunk => { previewOutput += chunk; });
preview.stderr.on('data', chunk => { previewOutput += chunk; });

async function waitForPreview() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) {
      throw new Error(`Vite preview exited early (${preview.exitCode}).\n${previewOutput}`);
    }
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The preview listener is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Vite preview did not become ready.\n${previewOutput}`);
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

let browser;
try {
  await waitForPreview();
  const playwright = await import(
    process.env.HOMENODE_PLAYWRIGHT_MODULE_URL || 'playwright'
  );
  const { chromium } = playwright;
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: true,
  });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const pageErrors = [];
  page.on('pageerror', error => { pageErrors.push(String(error?.stack || error)); });
  page.on('console', message => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('dialog', dialog => { void dialog.dismiss(); });
  await page.route('**/api/**', async route => {
    const requestUrl = new URL(route.request().url());
    const pathname = requestUrl.pathname;
    if (pathname === '/api/auth/status') {
      return json(route, { configured: false, required: false });
    }
    if (pathname === '/api/accounts/LAYOUT-TEST') {
      return json(route, {
        account: {
          account_id: 'LAYOUT-TEST',
          address: '1 Layout Test Way',
          county: 'Dallas',
          subdivision: 'LAYOUT TEST',
          latest_tax_year: 2026,
        },
        owner_parties: [],
        primary_improvements: null,
        housing_profile: null,
        sales_history: [],
        property_activity_history: [],
        report_manual_values: {},
      });
    }
    if (pathname === '/api/accounts/LAYOUT-TEST/assignment-files') {
      return json(route, {
        account_id: 'LAYOUT-TEST',
        files: [],
        latest_file: null,
        legacy_assignment_details: null,
      });
    }
    if (pathname === '/api/accounts/LAYOUT-TEST/photos') {
      return json(route, { photos: [] });
    }
    if (pathname === '/api/accounts/LAYOUT-TEST/zoning-evidence') {
      return json(route, {
        ok: true,
        account_id: 'LAYOUT-TEST',
        evidence: {
          account: { account_id: 'LAYOUT-TEST', address: '1 Layout Test Way', city: null, county: 'Dallas' },
          jurisdiction: null,
          review_required: true,
          review_reason: 'browser_test_fixture',
          documents: [],
          automatic_result: null,
          verification: null,
        },
      });
    }
    return json(route, {});
  });

  await page.goto(`${origin}/report/LAYOUT-TEST`, { waitUntil: 'domcontentloaded' });
  const documentsTitle = page.getByText('Document Evidence Center', { exact: true });
  const subjectTitle = page.getByText('Subject and Assignment', { exact: true });
  await documentsTitle.waitFor({ state: 'visible' });
  await subjectTitle.waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
  const hydratedBodyText = (await page.locator('body').innerText()).slice(0, 2_000);
  assert.equal(
    await subjectTitle.count(),
    1,
    `Subject and Assignment disappeared after hydration. Browser errors:\n${pageErrors.join('\n')}\nPage:\n${hydratedBodyText}`,
  );

  const documentsBox = await documentsTitle.boundingBox();
  const subjectBox = await subjectTitle.boundingBox();
  assert.ok(documentsBox && subjectBox, 'both report section titles must have rendered geometry');
  assert.ok(
    documentsBox.y < subjectBox.y,
    `Document Evidence Center must render above Subject and Assignment (${documentsBox.y} !< ${subjectBox.y})`,
  );
  assert.equal(await page.getByText('Subject Identification', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Assignment Details', { exact: true }).count(), 0);
  assert.equal(await documentsTitle.count(), 1);
  assert.equal(await subjectTitle.count(), 1);
  console.log('Rendered Property Report order verified.');
} finally {
  await browser?.close();
  if (preview.exitCode === null) preview.kill();
}
