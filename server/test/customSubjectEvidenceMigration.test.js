import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { REPORT_MANUAL_SECTION_KEYS } from '../src/modules/accounts/reportManualValuesRouter.js';
import { validateReportManualSection } from '../src/util/reportManualValues.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const migration = read('../migrations/20261028_custom_subject_evidence.sql');
const previous = read('../migrations/20261007_assignment_scoped_report_sections.sql');
const registry = read('../src/database/mobileMigrations.js');
const keySets = sql => [...sql.matchAll(/CHECK\s*\(section_key IN\s*\(([^]*?)\)\)/g)]
  .map(match => [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]).sort());

test('Subject receipt migration extends both exact key constraints without changing any prior migration', () => {
  const priorSets = keySets(previous), nextSets = keySets(migration);
  assert.equal(priorSets.length, 2);
  assert.equal(nextSets.length, 2);
  for (let index = 0; index < 2; index += 1) {
    assert.deepEqual(nextSets[index], [...priorSets[index], 'report.subject_evidence'].sort());
  }
  for (const table of ['custom_appraisal_sections', 'custom_appraisal_section_history']) {
    assert.match(migration, new RegExp(`ALTER TABLE app\\.${table}\\s+DROP CONSTRAINT IF EXISTS ${table}_section_key_check`));
    assert.match(migration, new RegExp(`ALTER TABLE app\\.${table}\\s+ADD CONSTRAINT ${table}_section_key_check`));
  }
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|SCHEMA|DATABASE)|DELETE\s+FROM|TRUNCATE|UPDATE\s+|INSERT\s+INTO/i);
});

test('follow-on receipt migration follows its prerequisite in the ordinary checksummed application registry', () => {
  const list = registry.match(/const MIGRATIONS = Object\.freeze\(\[([^]*?)\]\);/)[1];
  const names = [...list.matchAll(/"([^\"]+)"/g)].map(match => match[1]);
  assert.ok(names.indexOf('20261007_assignment_scoped_report_sections.sql') < names.indexOf('20261028_custom_subject_evidence.sql'));
  assert.equal(names.filter(name => name === '20261028_custom_subject_evidence.sql').length, 1);
});

test('database permission to store receipts does not grant the manual API permission to forge them', () => {
  assert.equal(REPORT_MANUAL_SECTION_KEYS.has('report.subject_evidence'), false);
  assert.throws(() => validateReportManualSection('report.subject_evidence', { version: 1, fields: {} }), /invalid_report_section_value/);
});
