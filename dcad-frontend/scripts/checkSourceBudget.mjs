import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const budgetUrl = new URL('../quality-budget.json', import.meta.url);
const budget = JSON.parse(await readFile(budgetUrl, 'utf8'));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

let failed = false;
for (const [relativePath, maximumBytes] of Object.entries(budget.sourceFiles)) {
  const source = await readFile(resolve(repositoryRoot, relativePath), 'utf8');
  const bytes = Buffer.byteLength(source.replace(/\r\n/g, '\n'), 'utf8');
  if (bytes > maximumBytes) {
    console.error(`${relativePath}: ${bytes} bytes exceeds ${maximumBytes} byte source budget`);
    failed = true;
  } else {
    console.log(`${relativePath}: ${bytes}/${maximumBytes} byte source budget`);
  }
}

if (failed) process.exitCode = 1;
