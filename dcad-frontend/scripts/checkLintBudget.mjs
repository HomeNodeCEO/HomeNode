import { readFile } from 'node:fs/promises';
import { ESLint } from 'eslint';

const budgetUrl = new URL('../quality-budget.json', import.meta.url);
const budget = JSON.parse(await readFile(budgetUrl, 'utf8'));
const eslint = new ESLint();
const results = await eslint.lintFiles(['src']);
const errors = results.reduce((total, result) => total + result.errorCount, 0);
const warnings = results.reduce((total, result) => total + result.warningCount, 0);
const maximumErrors = budget.eslint.maximumErrors;
const maximumWarnings = budget.eslint.maximumWarnings;

if (errors > maximumErrors || warnings > maximumWarnings) {
  const formatter = await eslint.loadFormatter('stylish');
  console.error(await formatter.format(results));
  console.error(
    `ESLint debt increased: ${errors} errors / ${warnings} warnings; ` +
      `budget is ${maximumErrors} errors / ${maximumWarnings} warnings.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `ESLint quality gate passed: ${errors}/${maximumErrors} errors and ` +
      `${warnings}/${maximumWarnings} warnings.`,
  );
}
