import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSubjectNeighborhoodSummary } from '../src/lib/subjectNeighborhoodSummary.ts';

test('recorded location and subject improvement produce a file-specific editable starting narrative', () => {
  const hardy = buildSubjectNeighborhoodSummary({ address: '513 Hardy Dr', subdivision: 'MONICA PARK 4', city: 'Garland', county: 'Dallas',
    yearBuilt: 1965, housingType: 'detached_single_family' });
  assert.match(hardy, /513 Hardy Dr/);
  assert.match(hardy, /MONICA PARK 4/);
  assert.match(hardy, /Garland, Dallas County/);
  assert.match(hardy, /1965/);
  assert.doesNotMatch(hardy, /Laurel Valley|White Rock|Richardson Independent|White Rock Lake/);
});

test('unknown facts are not invented or copied from the example address', () => {
  const draft = buildSubjectNeighborhoodSummary({ city: 'Duncanville' });
  assert.match(draft, /Duncanville/);
  assert.doesNotMatch(draft, /builder|HOA dues|Lake Highlands Town Center|school district is/i);
});

test('a retrospective file does not imply a later building existed on its effective date', () => {
  const draft = buildSubjectNeighborhoodSummary({ address: '513 Hardy Dr', city: 'Garland',
    yearBuilt: 2025, effectiveDate: '2022-08-31' });
  assert.doesNotMatch(draft, /recorded year built for the subject is 2025/);
  assert.match(draft, /retrospective effective date of 2022-08-31/);
});
