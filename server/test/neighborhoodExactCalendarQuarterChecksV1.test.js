import assert from 'node:assert/strict';
import test from 'node:test';
import { exactDecimalDistributionFromSortedPagesV1 as distribution,
  isIssuedExactDecimalPagedDistributionV1 as issued,
  parseExactDecimalPagedObservationV1 as scaled } from '../src/services/neighborhoodAssessment/exactDecimalPagedDistributionV1.js';
import { checkExactCalendarQuarterAreasV1 as checkQuarters, getExactCalendarQuarterCheckV1Profile,
  EXACT_CALENDAR_QUARTER_CHECK_V1_POLICY as P } from '../src/services/neighborhoodAssessment/neighborhoodExactCalendarQuarterChecksV1.js';

const subject = value => ({ state: 'observed', exact_value: value, unit: 'reported_sqft' });
async function calculated(values, extra = {}) {
  const sorted = [...values].sort((a, b) => scaled(a) < scaled(b) ? -1 : scaled(a) > scaled(b) ? 1 : 0);
  return distribution({ counts: { member_count: values.length + (extra.missing ?? 0), observed_count: values.length,
    missing_count: extra.missing ?? 0, invalid_count: 0, conflicting_count: 0, unsupported_count: 0 },
  pages: function* () { for (let start = 0; start < sorted.length; start += 1000) yield sorted.slice(start, start + 1000); } });
}
const input = (entries, extra = {}) => ({ effective_date: '2026-10-09',
  observation_period: { start_date: '2026-01-01', end_date: '2026-03-31' }, subject_area: subject('100'),
  quarter_distributions: entries.map(([quarter, d]) => ({ quarter, distribution: d })), ...extra });

test('exact 5% boundaries have no float epsilon or display rounding, and the 50-row target is separate', async () => {
  for (const [value, within] of [['105', true], ['95', true], ['105.000000000001', false], ['94.999999999999', false],
    ['104.999999999999', true], ['95.000000000001', true]]) {
    const d = await calculated(Array(50).fill(value)), actual = checkQuarters(input([['2026-Q1', d]]));
    assert.equal(actual.quarters[0].within_tolerance, within); assert.equal(actual.meets_observed_row_target, true);
    assert.equal(actual.state, within ? 'meets_numerical_review_targets' : 'quarterly_area_mismatch_or_unavailable');
    assert.equal(actual.authority, 'not_established'); assert.equal(actual.transaction_eligibility, 'not_established');
    assert.equal(actual.report_update, 'none'); assert(Object.isFrozen(actual.quarters[0]));
    if (value === '105' || value === '95') assert.deepEqual(actual.quarters[0].deviation_percent, { numerator: '5', denominator: '1' });
  }
  const d = await calculated(Array(49).fill('100'), { missing: 100 });
  const actual = checkQuarters(input([['2026-Q1', d]]));
  assert.equal(actual.member_row_count, 149); assert.equal(actual.observed_row_count, 49);
  assert.equal(actual.quarters[0].within_tolerance, true); assert.equal(actual.state, 'insufficient_observed_rows');
});

test('cross-year clipped partial intervals and empty quarters remain explicit; other quarters cannot hide a missing one', async () => {
  const a = await calculated(Array(50).fill('100')), empty = await calculated([], { missing: 7 });
  const actual = checkQuarters(input([['2025-Q4', a], ['2026-Q1', empty], ['2026-Q2', a]], {
    observation_period: { start_date: '2025-12-15', end_date: '2026-04-02' } }));
  assert.deepEqual(actual.quarters.map(q => [q.quarter, q.start_date, q.end_date]),
    [['2025-Q4', '2025-12-15', '2025-12-31'], ['2026-Q1', '2026-01-01', '2026-03-31'], ['2026-Q2', '2026-04-01', '2026-04-02']]);
  assert.equal(actual.observed_row_count, 100); assert.equal(actual.member_row_count, 107);
  assert.equal(actual.every_calendar_quarter_within_tolerance, false);
  assert.equal(actual.quarters[1].median_current_cad_reported_residential_area, null);
  assert.equal(actual.quarters[1].within_tolerance, null); assert.equal(actual.quarters[1].state, 'no_observed_area');
  assert.equal(actual.state, 'quarterly_area_mismatch_or_unavailable');
  assert.equal(actual.area_basis, 'current_CAD_reported_residential_area_reported_sqft_NOT_verified_at_sale_GLA');
});

test('actual kernel identity is required, but explicitly remains mathematical DATA rather than selection or source authority', async () => {
  const d = await calculated(['100']); assert.equal(issued(d), true);
  assert.equal(issued({ ...d }), false); assert.equal(issued(JSON.parse(JSON.stringify(d))), false);
  for (const fake of [{ ...d }, JSON.parse(JSON.stringify(d)), Object.freeze({ distribution_version: 1 }), null]) {
    assert.throws(() => checkQuarters(input([['2026-Q1', fake]])), /quarter_receipt/);
  }
  for (const entries of [[], [['2026-Q2', d]], [['2026-Q1', d], ['2026-Q2', d]]]) {
    assert.throws(() => checkQuarters(input(entries)), /quarters|quarter_receipt/);
  }
  assert.equal(checkQuarters(input([['2026-Q1', d]])).population_verification, 'not_established');
});

test('subject missing/invalid/conflicting/unsupported remains unavailable after validating every quarter, never zero or an invented unit', async () => {
  const d = await calculated(Array(50).fill('100'));
  for (const state of ['missing', 'invalid', 'conflicting', 'unsupported']) {
    const actual = checkQuarters(input([['2026-Q1', d]], { subject_area: { state, exact_value: null, unit: null } }));
    assert.equal(actual.state, 'subject_unavailable'); assert.equal(actual.every_calendar_quarter_within_tolerance, null);
    assert.equal(actual.meets_observed_row_target, true); assert.equal(actual.quarters[0].deviation_percent, null);
    assert.throws(() => checkQuarters(input([['2026-Q1', { ...d }]], { subject_area: { state, exact_value: null, unit: null } })), /quarter_receipt/);
  }
  for (const bad of [subject('0'), subject('-1'), subject('1.0'), { ...subject('100'), unit: 'ft2' },
    { state: 'missing', exact_value: '100', unit: null }, { state: 'absent', exact_value: null, unit: null }]) {
    assert.throws(() => checkQuarters(input([['2026-Q1', d]], { subject_area: bad })), /exact_/);
  }
});

test('large exact subject/median values and fractional even medians retain exact rational deviation', async () => {
  const d = await calculated(['9007199254740993.000000000001', '9007199254740993.000000000002']);
  const actual = checkQuarters(input([['2026-Q1', d]], { subject_area: subject('9007199254740993') }));
  assert.equal(actual.quarters[0].median_current_cad_reported_residential_area, '9007199254740993.0000000000015');
  assert.equal(actual.quarters[0].within_tolerance, true);
  assert.deepEqual(actual.quarters[0].deviation_percent, { numerator: '1', denominator: '60047995031606620000000000' });
});

test('closed DATA refuses getters/proxies/holes/then, wrong or future periods, and cancellation without side effects', async () => {
  const d = await calculated(['100']); let effects = 0;
  const getter = {}; Object.defineProperty(getter, 'start_date', { enumerable: true, get() { effects++; return '2026-01-01'; } });
  getter.end_date = '2026-03-31';
  const proxy = new Proxy({}, { get() { effects++; throw Error('trap'); }, ownKeys() { effects++; throw Error('trap'); } });
  for (const patch of [{ observation_period: getter }, { observation_period: proxy }, { subject_area: proxy },
    { quarter_distributions: proxy }, { quarter_distributions: Array(1) }, { extra: 1 },
    { observation_period: { start_date: '2026-04-01', end_date: '2026-03-31' } },
    { observation_period: { start_date: '2026-01-01', end_date: '2026-10-10' } },
    { observation_period: { start_date: '2026-02-30', end_date: '2026-03-31' } }]) {
    assert.throws(() => checkQuarters(input([['2026-Q1', d]], patch)), /exact_calendar|assessment/);
  }
  const entries = [{ quarter: '2026-Q1', distribution: d }]; Object.defineProperty(entries, 'then', { get() { effects++; } });
  assert.throws(() => checkQuarters(input([], { quarter_distributions: entries })), /quarters/);
  assert.throws(() => checkQuarters(input([['2026-Q1', d]]), { signal: proxy }), /options/);
  const c = new AbortController(); c.abort();
  assert.throws(() => checkQuarters(input([['2026-Q1', d]]), { signal: c.signal }), /cancelled/);
  assert.equal(effects, 0);
});

test('all nested DATA is detached before callbacks and ending budget failures never deliver a result', async () => {
  const d = await calculated(Array(50).fill('100')), request = input([['2026-Q1', d]]); let visits = 0;
  const actual = checkQuarters(request, { checkBudget() {
    visits++; request.subject_area.exact_value = '1000'; request.observation_period.start_date = '2026-04-01';
    request.quarter_distributions[0].quarter = '2026-Q4';
  } });
  assert.equal(actual.subject_area.exact_value, '100'); assert.equal(actual.quarters[0].quarter, '2026-Q1');
  assert.equal(actual.state, 'meets_numerical_review_targets'); assert.equal(visits, 3);
  let ending = 0;
  assert.throws(() => checkQuarters(input([['2026-Q1', d]]), { checkBudget() { if (++ending === 3) throw Error('ending_deadline'); } }), /ending_deadline/);
});

test('the exact existing 100-quarter and 250000-row numerical bounds refuse one over without widening live limits', async () => {
  const empty = await calculated([]), entries = [];
  for (let year = 2000; year <= 2024; year++) for (let q = 1; q <= 4; q++) entries.push([`${year}-Q${q}`, empty]);
  const actual = checkQuarters(input(entries, { observation_period: { start_date: '2000-01-01', end_date: '2024-12-31' } }));
  assert.equal(actual.quarters.length, P.maximum_quarters); assert.equal(actual.state, 'insufficient_observed_rows');
  assert.throws(() => checkQuarters(input(entries, { observation_period: { start_date: '2000-01-01', end_date: '2025-01-01' } })), /quarter_limit/);
  const fullMissing = await distribution({ counts: { member_count: P.maximum_member_rows, observed_count: 0,
    missing_count: P.maximum_member_rows, invalid_count: 0, conflicting_count: 0, unsupported_count: 0 }, pages: () => [] });
  const oneMissing = await calculated([], { missing: 1 });
  assert.throws(() => checkQuarters(input([['2026-Q1', fullMissing], ['2026-Q2', oneMissing]],
    { observation_period: { start_date: '2026-01-01', end_date: '2026-06-30' } })), /member_limit/);
  assert.equal(Object.isFrozen(getExactCalendarQuarterCheckV1Profile().definition_blob), true);
});
