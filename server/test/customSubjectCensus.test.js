import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomSubjectCensus, customSubjectCensusSql } from '../src/services/customSubjectCensus.js';
import { mergeCustomSubjectApplication } from '../src/services/customSubjectApplication.js';

const context = (patch = {}) => ({ accountId: 'SYNTHETIC-ACCOUNT', censusGeography: {
  tractCode: '001234', status: 'matched', geoid: '48113001234', vintage: 'Census2020_Current',
  updatedAt: '2026-10-03T19:00:00.123456+00:00', ...patch,
} });
const projection = result => ({ fields: result.field ? [result.field] : [], warnings: result.warnings, conflicts: [], omitted: [] });

test('optional Census relation is checked before including it in the canonical SQL snapshot', async () => {
  let probe;
  const absent = await customSubjectCensusSql({ query: async sql => { probe = sql; return { rows: [{ census_available: false }] }; } });
  assert.match(probe, /to_regclass/);
  assert.deepEqual(absent, { join: '', value: 'NULL' });
  const present = await customSubjectCensusSql({ query: async () => ({ rows: [{ census_available: true }] }) });
  assert.match(present.join, /subject_census.account_id = subject.account_id/);
  assert.match(present.value, /'updatedAt', subject_census.updated_at/);
});

test('matched Census reference proposes a report tract with exact account and source revision provenance', () => {
  const source = context(), before = structuredClone(source);
  const result = buildCustomSubjectCensus(source);
  assert.equal(result.field.key, 'census_tract');
  assert.equal(result.field.value, '12.34');
  assert.equal(result.field.sourceValue, '001234');
  assert.equal(result.field.provenance.kind, 'account_reference');
  assert.equal(result.field.provenance.documentId, null);
  assert.equal(result.field.provenance.candidateId, null);
  assert.deepEqual(result.field.provenance.sourceEvidence, [{ sourceTable: 'core.account_census_geographies',
    accountId: source.accountId, ...source.censusGeography }]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(source, before);
});

for (const [code, expected] of [['000100', '1.00'], ['000001', '0.01'], ['999999', '9999.99']]) {
  test(`six-digit Census code ${code} preserves its decimal suffix`, () => {
    assert.equal(buildCustomSubjectCensus(context({ tractCode: code, geoid: `48113${code}` })).field.value, expected);
  });
}

for (const status of ['review_required', 'pending', 'processing', 'retry', 'failed', '', null, undefined]) {
  test(`Census ${String(status)} never auto-populates`, () => {
    const result = buildCustomSubjectCensus(context({ status }));
    assert.equal(result.field, null);
    assert.ok(result.warnings.length);
  });
}

test('malformed, unbound, or incomplete account Census source never becomes a proposal', () => {
  for (const source of [null, [], {}, { ...context(), accountId: '' }, { ...context(), accountId: 'OTHER\nACCOUNT' },
    { ...context(), accountId: 'X'.repeat(33) }, { ...context(), censusGeography: null },
    ...[{ tractCode: '12.34' }, { tractCode: 1234 }, { tractCode: '000000', geoid: '48113000000' },
      { geoid: '48113999999' }, { geoid: '' }, { geoid: 48113001234 }, { vintage: '' }, { vintage: 'X'.repeat(129) },
      { updatedAt: '' }, { updatedAt: 'today' }, { updatedAt: '2026-10-03' }, { updatedAt: null }].map(context)]) {
    assert.equal(buildCustomSubjectCensus(source).field, null);
  }
});

test('reference receipt changes when account, tract, vintage, status or source revision changes', () => {
  const initial = buildCustomSubjectCensus(context()).field;
  for (const source of [{ ...context(), accountId: 'ANOTHER-ACCOUNT' },
    context({ tractCode: '001235', geoid: '48113001235' }), context({ vintage: 'Census2025_Current' }),
    context({ updatedAt: '2026-10-04T19:00:00Z' })]) {
    assert.notDeepEqual(buildCustomSubjectCensus(source).field.provenance, initial.provenance);
  }
  assert.equal(buildCustomSubjectCensus(context({ status: 'review_required' })).field, null);
});

test('normal merge fills a genuinely absent tract but cannot refill manual blanks or corrections', () => {
  const proposal = projection(buildCustomSubjectCensus(context()));
  const initial = mergeCustomSubjectApplication({ projection: proposal });
  assert.equal(initial.subject.property_location.census_tract, '12.34');
  assert.equal(initial.evidence.fields.census_tract.kind, 'account_reference');
  for (const value of ['', null, '42.50']) {
    const subject = { property_location: { census_tract: value } };
    const next = mergeCustomSubjectApplication({ subject, projection: proposal });
    assert.equal(next.subject.property_location.census_tract, value);
    assert.equal(next.evidence.fields.census_tract, undefined);
    const corrected = mergeCustomSubjectApplication({ ...initial, subject, projection: proposal });
    assert.equal(corrected.subject.property_location.census_tract, value);
    assert.equal(corrected.evidence.fields.census_tract.value, '12.34');
  }
});

test('unavailable or review-required reference marks the existing automatic receipt stale without clearing saved value', () => {
  const initial = mergeCustomSubjectApplication({ projection: projection(buildCustomSubjectCensus(context())) });
  const next = mergeCustomSubjectApplication({ ...initial,
    projection: projection(buildCustomSubjectCensus(context({ status: 'review_required' }))) });
  assert.equal(next.subject.property_location.census_tract, '12.34');
  assert.equal(next.evidence.fields.census_tract.status, 'needs_review');
  assert.equal(initial.evidence.fields.census_tract.status, 'current');
});
