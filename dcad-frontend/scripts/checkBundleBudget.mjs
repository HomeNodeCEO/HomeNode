import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const DIST = resolve('dist');
const limits = {
  javascript: 300 * 1024,
  stylesheet: 550 * 1024,
};

const html = await readFile(resolve(DIST, 'index.html'), 'utf8');
const entryScript = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
const entryStylesheet = html.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];

if (!entryScript || !entryStylesheet) {
  throw new Error('bundle_budget_entry_assets_not_found');
}

async function verify(label, assetPath, maximumBytes) {
  const bytes = (await stat(resolve(DIST, assetPath.replace(/^\//, '')))).size;
  const maximumKiB = Math.round(maximumBytes / 1024);
  const actualKiB = Math.round(bytes / 1024);
  if (bytes > maximumBytes) {
    throw new Error(`${label}_bundle_exceeds_budget:${actualKiB}KiB>${maximumKiB}KiB`);
  }
  console.log(`${label}: ${actualKiB} KiB / ${maximumKiB} KiB budget`);
}

await verify('initial_javascript', entryScript, limits.javascript);
await verify('initial_stylesheet', entryStylesheet, limits.stylesheet);
