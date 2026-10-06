import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedNearbySchoolContext, SCHOOL_SOURCE_URL } from '../src/lib/nearbySchoolContext.ts';
import { createNeighborhoodSchoolTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import { refreshNeighborhoodSummaryTemplate, neighborhoodSummaryTemplate } from '../src/lib/neighborhoodSummaryTemplate.ts';
import { assignmentDraftFromDetail } from '../src/lib/propertyReportAssignment.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import * as summaryBuilder from '../src/lib/subjectNeighborhoodSummary.ts';
import * as summaryHelpers from '../src/lib/neighborhoodSummaryTemplate.ts';
const school = (account_id = 'A', assignment_file_id = '1') => ({ status: 'available', account_id, assignment_file_id,
  source: { provider: 'Texas Education Agency', school_year: '2024-2025', url: SCHOOL_SOURCE_URL },
  school: { name: 'Nearby Example School', distance_miles: 0.7 }, captured_at: '2026-10-06T12:00:00Z',
  interpretation: 'approximate_nearby_amenity_not_attendance_or_travel_time' });
test('nearby-school metadata is exact-file-bound and retained through draft hydration', () => {
  assert.deepEqual(checkedNearbySchoolContext(school(), 'A', '1'), school());
  for (const value of [school('B'), school('A', '2'), { ...school(), source: { ...school().source, url: 'http://localhost' } },
    { ...school(), interpretation: 'assigned_school' }, { ...school(), school: { name: 'X', distance_miles: 6 } }])
    assert.equal(checkedNearbySchoolContext(value, 'A', '1'), null);
  const original = school(), saved = assignmentDraftFromDetail({ subject_neighborhood_summary_school: original });
  assert.deepEqual(saved.subject_neighborhood_summary_school, school());
  assert.notEqual(saved.subject_neighborhood_summary_school, original);
});
test('school arrival fills only the generated placeholder without erasing selected medians or manual prose', () => {
  const input = { subdivision: 'Example Park', city: 'Example', effectiveDate: '2026-08-31', locationType: 'suburban' };
  const group = { summary: { selected: { stock: { metrics: { year_built: { count: 30, median: 1960 } } } } } };
  const baseline = neighborhoodSummaryTemplate(input, group);
  const updated = refreshNeighborhoodSummaryTemplate(baseline, baseline, { ...input, nearbySchool: school().school.name }, null);
  assert.match(updated, /Nearby Example School/); assert.match(updated, /past 66 years/);
  assert.match(updated, /\[verify 5-10 minutes\]/);
  assert.equal(refreshNeighborhoodSummaryTemplate('My description.', baseline, { ...input, nearbySchool: 'Example' }, null), null);
});
test('optional lookup uses the existing bounded authenticated transport and rejects large or foreign responses', async () => {
  const abort = new AbortController(), calls = [];
  const read = createNeighborhoodSchoolTransport({ urlFor: p => p, request: async (url, init) => {
    calls.push([url, init]); return new Response(JSON.stringify(school()), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(await read('A', '1', { signal: abort.signal }), school());
  assert.equal(calls[0][0], '/api/accounts/A/neighborhood-summary-school?assignment_file_id=1');
  assert.equal(calls[0][1].signal, abort.signal); assert.equal(calls[0][1].method, 'GET');
  const large = createNeighborhoodSchoolTransport({ urlFor: p => p, request: async () => new Response('x'.repeat(4097), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(large('A', '1', { signal: abort.signal }), /too large/);
  assert.throws(() => read('A', '0', { signal: abort.signal }), /Invalid/);
});
test('draft lookup runs once, is not tied to selection, and late previous-file responses are discarded', async () => {
  let cells = [], cursor = 0, effects = [], current, props, result;
  const calls = [], resolves = [];
  const Hook = loadTrustedRepositoryCommonJs(new URL('../src/hooks/useNearbySchool.ts', import.meta.url), key => {
    if (key === 'react') return {
      useState(v) { const i = cursor++; cells[i] ??= { value: v }; return [cells[i].value, value => { cells[i].value = value; }]; },
      useEffect(fn, deps) { const i = cursor++; if (!cells[i] || !deps.every((v, j) => Object.is(v, cells[i].deps[j]))) {
        effects.push(() => { cells[i]?.cleanup?.(); cells[i] = { deps, cleanup: fn() }; });
      } },
    };
    if (key === '@/lib/api') return { fetchWithApplicationAuthentication() {}, makeUrl() {} };
    if (key === '@/features/neighborhood/customCohortPreviewTransport') return { createNeighborhoodSchoolTransport: () => (account, file, io) => {
      calls.push({ account, file, io }); return new Promise(resolve => resolves.push(resolve));
    } };
    if (key === '@/lib/nearbySchoolContext') return { checkedNearbySchoolContext };
    throw new Error(`Unexpected import ${key}`);
  }).useNearbySchool;
  const render = () => { cursor = 0; result = Hook(...props); effects.splice(0).forEach(fn => fn()); return result; };
  props = ['A', 1, true, undefined]; render(); render(); assert.equal(calls.length, 1);
  props = ['B', 2, true, undefined]; render(); assert.equal(calls[0].io.signal.aborted, true);
  resolves[0](school()); await Promise.resolve(); await Promise.resolve(); assert.equal(render(), null);
  resolves[1](school('B', '2')); await Promise.resolve(); await Promise.resolve();
  current = render(); assert.equal(current.school.name, 'Nearby Example School');
  props = ['B', 2, true, current]; assert.deepEqual(render(), current); assert.equal(calls.length, 2);
  props = ['C', 3, false, undefined]; assert.equal(render(), null); assert.equal(calls.length, 2);
  for (const cell of cells) cell?.cleanup?.();
});

test('summary hook retains exact-file provenance even for a reused public cache timestamp and guards earlier appraisal years', () => {
  const context = school('A', '2');
  const Hook = loadTrustedRepositoryCommonJs(new URL('../src/hooks/useSubjectNeighborhoodSummary.ts', import.meta.url), key => {
    if (key === 'react') return { useRef: () => ({ current: null }), useEffect: fn => fn() };
    if (key === '@/lib/subjectNeighborhoodSummary') return summaryBuilder;
    if (key === '@/lib/neighborhoodSummaryTemplate') return summaryHelpers;
    if (key === './useNearbySchool') return { useNearbySchool: () => context };
    throw new Error(`Unexpected import ${key}`);
  }).useSubjectSummary;
  for (const year of ['2026', '2020']) {
    let draft = { subject_neighborhood_summary: 'My description.', subject_neighborhood_summary_school: school('A', '1') };
    let writes = 0;
    const result = Hook('A', { id: 2, effective_date: `${year}-08-31`, workfile: { status: 'draft' },
      assignment_details: { subject_neighborhood_summary: 'My description.' } },
    { subdivision: 'Example Park', city: 'Example' }, 1960, null,
    fn => { draft = fn(draft); writes++; }, draft, () => {});
    assert.equal(draft.subject_neighborhood_summary_school.assignment_file_id, '2'); assert.equal(writes, 1);
    assert.equal(draft.subject_neighborhood_summary, 'My description.');
    assert.equal(result.summaryInput.nearbySchool, 'Nearby Example School');
    assert.equal(result.summaryInput.nearbySchoolSourceEndYear, 2025);
    const generated = neighborhoodSummaryTemplate(result.summaryInput, null);
    assert.match(generated, year === '2026' ? /schooling such as Nearby Example School/ : /\[nearby school — verify\]/);
  }
});
