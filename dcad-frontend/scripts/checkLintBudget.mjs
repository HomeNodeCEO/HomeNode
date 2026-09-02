import { readFile } from 'node:fs/promises';
import { ESLint } from 'eslint';

const budgetUrl = new URL('../quality-budget.json', import.meta.url);
const budget = JSON.parse(await readFile(budgetUrl, 'utf8'));
const eslint = new ESLint();
const results = await eslint.lintFiles(['src']);
const errors = results.reduce((total, result) => total + result.errorCount, 0);
const warnings = results.reduce((total, result) => total + result.warningCount, 0);
const explicitAnyEslint = new ESLint({
  overrideConfig: {
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
});
const explicitAnyResults = await explicitAnyEslint.lintFiles(['src']);
const explicitAny = explicitAnyResults.reduce(
  (total, result) => total + result.messages.filter(
    (message) => message.ruleId === '@typescript-eslint/no-explicit-any',
  ).length,
  0,
);
const maximumErrors = budget.eslint.maximumErrors;
const maximumWarnings = budget.eslint.maximumWarnings;
const maximumExplicitAny = budget.eslint.maximumExplicitAny;

if (
  errors > maximumErrors
  || warnings > maximumWarnings
  || explicitAny > maximumExplicitAny
) {
  const formatter = await eslint.loadFormatter('stylish');
  console.error(await formatter.format(results));
  console.error(
    `ESLint debt increased: ${errors} errors / ${warnings} warnings; ` +
      `${explicitAny} explicit-any annotations; budget is ${maximumErrors} errors / ` +
      `${maximumWarnings} warnings / ${maximumExplicitAny} explicit-any annotations.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `ESLint quality gate passed: ${errors}/${maximumErrors} errors, ` +
      `${warnings}/${maximumWarnings} warnings, and ` +
      `${explicitAny}/${maximumExplicitAny} explicit-any annotations.`,
  );
}
