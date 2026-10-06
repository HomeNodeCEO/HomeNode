import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSubjectNeighborhoodSummary } from '../src/lib/subjectNeighborhoodSummary.ts';
import { neighborhoodSummaryTemplate, refreshNeighborhoodSummaryTemplate } from '../src/lib/neighborhoodSummaryTemplate.ts';
import { assignmentDraftFromDetail } from '../src/lib/propertyReportAssignment.ts';

const input = { subdivision: 'MONICA PARK 4', city: 'Garland', effectiveDate: '2026-08-31', locationType: 'suburban' };
const group = { summary: { effective_date: '2026-08-31', observation_period: { start_date: '2024-09-01', end_date: '2026-08-31' },
  selected: { stock: { metrics: { year_built: { count: 2000, median: 1958 } } } },
  narrative_observations: { basis: 'in_period_single_account_closed_sales',
    observation_period: { start_date: '2024-09-01', end_date: '2026-08-31' },
    metrics: { bedrooms_total: { count: 50, median: 3 }, bathrooms_total_integer: { count: 48, median: 2 } } } } };

test('fixed requested template substitutes exact selected medians, not the subject or median-of-medians', () => {
  const draft = neighborhoodSummaryTemplate(input, group);
  assert.match(draft, /^The subject immediate subdivision is known as Monica Park\./);
  assert.match(draft, /past 68 years \(median year built 1958\) on residential suburban lots/);
  assert.match(draft, /two and single story traditional 3 bedrooms and 2 baths homes/);
  assert.match(draft, /Some properties in the neighborhood may be superior or inferior to the subject which is normal for competing market areas\.$/);
  assert.doesNotMatch(draft, /1,958|Laurel Valley|White Rock|Richardson Independent|subject's recorded/);
});

test('unknown facts remain draft placeholders rather than invented schools, city limits or drive times', () => {
  const draft = buildSubjectNeighborhoodSummary({ ...input, yearBuilt: 1965 });
  assert.match(draft, /\[median age\/year built not available\]/);
  assert.match(draft, /\[nearby school — verify\]/);
  assert.match(draft, /\[within\/outside — verify\]/);
  assert.match(draft, /\[verify 5-10 minutes\]/);
  assert.doesNotMatch(draft, /White Rock Elementary|median year built 1965/);
});

test('rural and urban wording, confirmed nearby school and municipal position use only supplied facts', () => {
  const rural = buildSubjectNeighborhoodSummary({ ...input, locationType: 'rural', medianYearBuilt: 2000,
    includesTownhomes: true, nearbySchool: 'Nearby Example School', insideMunicipalBoundaries: false });
  assert.match(rural, /homes and townhomes/); assert.match(rural, /on residential rural lots/);
  assert.match(rural, /for an "rural" homestead/); assert.match(rural, /located outside the municipal boundaries/);
  assert.match(rural, /schooling such as Nearby Example School/);
  const urban = buildSubjectNeighborhoodSummary({ ...input, locationType: 'urban', insideMunicipalBoundaries: true });
  assert.match(urban, /on residential urban lots/); assert.match(urban, /for an "urban-suburban" homestead/);
  assert.match(urban, /located within the municipal boundaries/);
});

test('future year built and all-date/differently bound MLS medians are never presented as period sale medians', () => {
  const changed = structuredClone(group);
  changed.summary.selected.stock.metrics.year_built.median = 2028;
  changed.summary.narrative_observations.observation_period.end_date = '2027-08-31';
  changed.summary.selected.source_reported = { metrics: { bedrooms_total: { count: 80, median: 9 } } };
  const draft = neighborhoodSummaryTemplate(input, changed);
  assert.match(draft, /\[median age\/year built not available\]/);
  assert.match(draft, /traditional \[not available\] bedrooms and \[not available\] baths/);
  assert.doesNotMatch(draft, /2028|traditional 9 bedrooms/);
});

test('saved baseline survives reload and automatic refresh preserves all manual edits', () => {
  const baseline = buildSubjectNeighborhoodSummary(input);
  const saved = assignmentDraftFromDetail({ subject_neighborhood_summary: baseline,
    subject_neighborhood_summary_template: baseline, subject_neighborhood_summary_review_items: ['travel_times'] });
  assert.equal(saved.subject_neighborhood_summary_template, baseline);
  assert.deepEqual(saved.subject_neighborhood_summary_review_items, ['travel_times']);
  assert.equal(refreshNeighborhoodSummaryTemplate(`${baseline} Appraiser addition.`, baseline, input, group), null);
  assert.equal(refreshNeighborhoodSummaryTemplate('Manually written.', undefined, input, group), null);
  assert.equal(refreshNeighborhoodSummaryTemplate(baseline, baseline, input, group), neighborhoodSummaryTemplate(input, group));
});

test('classification changes while a capture loads preserve previously captured medians', () => {
  const baseline = neighborhoodSummaryTemplate(input, group);
  const next = refreshNeighborhoodSummaryTemplate(baseline, baseline, { ...input, locationType: 'rural' }, null);
  assert.match(next, /past 68 years/); assert.match(next, /traditional 3 bedrooms and 2 baths/);
  assert.match(next, /on residential rural lots/); assert.match(next, /for an "rural" homestead/);
  assert.equal(refreshNeighborhoodSummaryTemplate(next, next, { ...input, locationType: 'rural' }, null), null);
});

test('an assignment save without a case date uses only the current checked preview date', () => {
  const draft = neighborhoodSummaryTemplate({ ...input, effectiveDate: null }, group);
  assert.match(draft, /past 68 years \(median year built 1958\)/);
  const absent = structuredClone(group); delete absent.summary.effective_date;
  assert.match(neighborhoodSummaryTemplate({ ...input, effectiveDate: null }, absent), /\[median age\/year built not available\]/);
  const conflict = neighborhoodSummaryTemplate({ ...input, effectiveDate: '2025-08-31' }, group);
  assert.match(conflict, /\[median age\/year built not available\]/);
  assert.match(conflict, /traditional \[not available\] bedrooms and \[not available\] baths/);
});

test('the retained date also controls nearby-school dataset applicability after saving', () => {
  const school = { ...input, effectiveDate: null, nearbySchool: 'Nearby Example School', nearbySchoolSourceEndYear: 2025 };
  assert.match(neighborhoodSummaryTemplate(school, group), /schooling such as Nearby Example School/);
  const historical = structuredClone(group); historical.summary.effective_date = '2024-08-31';
  assert.match(neighborhoodSummaryTemplate(school, historical), /\[nearby school — verify\]/);
  assert.match(buildSubjectNeighborhoodSummary(school), /\[nearby school — verify\]/);
  const baseline = buildSubjectNeighborhoodSummary(input);
  assert.equal(refreshNeighborhoodSummaryTemplate(baseline, baseline, { ...school, locationType: 'suburban' }, null), null);
  assert.match(refreshNeighborhoodSummaryTemplate(baseline, baseline, { ...school, effectiveDate: '2026-08-31' }, null),
    /schooling such as Nearby Example School/);
});
