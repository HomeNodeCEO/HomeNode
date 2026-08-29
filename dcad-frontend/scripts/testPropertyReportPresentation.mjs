import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activityTypeLabel,
  displayValue,
  formatBaths,
  formatCensusTract,
  formatDate,
  formatMoney,
  formatNumber,
  formatOwnershipPercent,
  formatReportedBoolean,
  listingTimelineRows,
  parseNumber,
  sellerComparisonSummary,
} from '../src/lib/propertyReportPresentation.ts';
import { mergeNonBlankSnapshot } from '../src/lib/reportSnapshotMerge.ts';

test('legacy blank report snapshots cannot erase repaired CAD values', () => {
  const merged = mergeNonBlankSnapshot(
    {
      owner_name: 'CURRENT OWNER',
      mailing_address: '1402 AARON PL',
      parties: [{ owner_name: 'CURRENT OWNER', ownership_percent: 100 }],
      building: { building_class: 'CLASS 17', gla: 1840 },
    },
    {
      owner_name: '',
      mailing_address: '   ',
      parties: [],
      building: { building_class: '', gla: null },
    },
  );

  assert.equal(merged.owner_name, 'CURRENT OWNER');
  assert.equal(merged.mailing_address, '1402 AARON PL');
  assert.equal(merged.parties.length, 1);
  assert.equal(merged.building.building_class, 'CLASS 17');
  assert.equal(merged.building.gla, 1840);
});

test('nonblank assignment values still override source values', () => {
  const merged = mergeNonBlankSnapshot(
    { building_class: 'CLASS 17', stories: 1, has_pool: true },
    { building_class: 'APPRAISER CLASS', stories: 0, has_pool: false },
  );
  assert.deepEqual(merged, {
    building_class: 'APPRAISER CLASS',
    stories: 0,
    has_pool: false,
  });
});

test('report values retain their established formatting', () => {
  assert.equal(displayValue(''), 'Not reported');
  assert.equal(parseNumber('$292,315'), 292315);
  assert.equal(formatMoney(292315), '$292,315');
  assert.equal(formatNumber(177.13787, '/SF'), '177.14/SF');
  assert.equal(formatOwnershipPercent('33.3333'), '33.333%');
  assert.equal(formatDate('2026-08-26'), 'Aug 26, 2026');
  assert.equal(formatCensusTract('190123'), '1901.23');
  assert.equal(formatCensusTract('190100'), '1901');
  assert.equal(formatReportedBoolean('n'), 'No');
  assert.equal(formatBaths({ baths_full: 2, baths_half: 1 }), '2 full / 1 half');
});

test('listing history merges matching source records and sorts newest first', () => {
  const rows = listingTimelineRows([
    { listing_id: 'A', record_type: 'listing', listing_date: '2025-01-01', list_price: 200000 },
    { listing_id: 'A', record_type: 'closed_sale', closing_date: '2025-02-01', sale_price: 195000 },
    { listing_id: 'B', record_type: 'listing', listing_date: '2026-01-01', list_price: 250000 },
    { record_type: 'cad_transfer', closing_date: '2026-02-01' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].listing_id, 'B');
  assert.equal(rows[1].sale_price, 195000);
  assert.equal(activityTypeLabel('closed_sale'), 'Closed Sale');
});

test('seller comparison is order-insensitive but still flags real differences', () => {
  assert.equal(
    sellerComparisonSummary('Freeman Appraisal Services LLC', 'FREEMAN APPRAISAL SERVICES, LLC').matches,
    true,
  );
  const mismatch = sellerComparisonSummary('Jordan Freeman', 'Alex Freeman');
  assert.equal(mismatch.matches, false);
  assert.match(mismatch.summary, /Review and explain/);
  assert.equal(sellerComparisonSummary('', 'Jordan Freeman').matches, null);
});
