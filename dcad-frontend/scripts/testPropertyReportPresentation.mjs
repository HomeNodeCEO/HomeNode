import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activityTypeLabel,
  assignmentDocumentConfirmationBlocked,
  combineEvidenceDiscrepancyCommentary,
  displayValue,
  documentSubjectAddressComparison,
  documentSubjectLocalityFlags,
  reviewedDocumentSubjectDiscrepancyStatement,
  formatBaths,
  formatCensusTract,
  formatDate,
  formatMoney,
  formatNumber,
  formatOwnershipPercent,
  formatReportedBoolean,
  listingTimelineRows,
  parseNumber,
  recordedExemptionRows,
  revalidateEvidenceDiscrepancyDrafts,
  sellerComparisonSummary,
} from '../src/lib/propertyReportPresentation.ts';

test('explicit city and ZIP conflicts are visible in both document centers without changing street-match approval', () => {
  const candidates = [{ field_key: 'subject_property_address', review_status: 'confirmed',
    confirmed_value: '100 Sample Dr, Othercity, TX 75041' },
  { field_key: 'subject_zip', review_status: 'rejected', raw_value: '99999' }];
  assert.deepEqual(documentSubjectLocalityFlags(candidates, '100 Sample Dr, Exampleton, TX, 75041'),
    ['City: document says Othercity; HomeNode subject says Exampleton.']);
  assert.deepEqual(documentSubjectLocalityFlags(candidates, '100 Sample Dr'), []);
});

test('UAD review choice appends multiple source statements to one commentary without duplication or truncation', () => {
  assert.equal(combineEvidenceDiscrepancyCommentary('Existing appraiser comment', ['City differs.', 'ZIP differs.', 'City differs.']),
    'Existing appraiser comment\n\nCity differs.\n\nZIP differs.');
  assert.equal(combineEvidenceDiscrepancyCommentary('Existing appraiser comment\n\nCity differs.', ['City differs.']),
    'Existing appraiser comment\n\nCity differs.');
  assert.equal(combineEvidenceDiscrepancyCommentary('Existing appraiser comment', ['Long statement'], 10), null);
  assert.equal(combineEvidenceDiscrepancyCommentary('  Appraiser text  \n', ['City differs.']),
    '  Appraiser text  \n\nCity differs.');
});

test('UAD discrepancy draft uses only current confirmed locality evidence', () => {
  const document = { document_type: 'mls_sheet', processing_status: 'reviewed', candidates: [
    { field_key: 'subject_city', review_status: 'confirmed', confirmed_value: 'Othercity' },
    { field_key: 'subject_zip', review_status: 'suggested', normalized_value: '99999' },
  ] };
  const address = '100 Sample Dr, Exampleton, TX 75041';
  assert.match(reviewedDocumentSubjectDiscrepancyStatement(document, address), /Othercity/);
  assert.doesNotMatch(reviewedDocumentSubjectDiscrepancyStatement(document, address), /99999/);
  assert.equal(reviewedDocumentSubjectDiscrepancyStatement({ ...document, processing_status: 'review_required' }, address), null);
  assert.equal(reviewedDocumentSubjectDiscrepancyStatement({ ...document, candidates: document.candidates
    .map(candidate => ({ ...candidate, review_status: 'rejected' })) }, address), null);
});

test('changed or deleted UAD evidence invalidates its prepared statement before report insertion', async () => {
  const address = '100 Sample Dr, Exampleton, TX 75041';
  const reviewed = { document_type: 'mls_sheet', processing_status: 'reviewed', candidates: [
    { field_key: 'subject_city', review_status: 'confirmed', confirmed_value: 'Othercity' },
  ] };
  const statement = reviewedDocumentSubjectDiscrepancyStatement(reviewed, address);
  const prepared = { 7: statement, 8: statement, 9: statement };
  const result = await revalidateEvidenceDiscrepancyDrafts(prepared, async id => id === 7 ? reviewed
    : id === 8 ? { ...reviewed, candidates: reviewed.candidates.map(candidate => ({ ...candidate, review_status: 'rejected' })) }
      : null, address);
  assert.deepEqual(result.statements, [statement]);
  assert.deepEqual(result.staleDocumentIds, [8, 9]);
});
import { mergeNonBlankSnapshot } from '../src/lib/reportSnapshotMerge.ts';

test('recorded exemption rows preserve display order and omit entirely blank jurisdictions', () => {
  const rows = recordedExemptionRows({ school: { homestead_exemption: '25000' },
    city: { homestead_exemption: ' ' }, county: { taxable_value: '310000' } });
  assert.deepEqual(rows.map(row => [row.key, row.fallbackLabel]),
    [['school', 'School'], ['county', 'County']]);
});

test('legacy blank report snapshots cannot erase repaired CAD values', () => {
  const merged = mergeNonBlankSnapshot(
    {
      owner_name: 'CURRENT OWNER',
      mailing_address: '100 SAMPLE LN',
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
  assert.equal(merged.mailing_address, '100 SAMPLE LN');
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

test('snapshot merges reject prototype-control keys at every level', () => {
  const hostile = JSON.parse(`{
    "__proto__": {"is_admin": true},
    "constructor": {"prototype": {"polluted": true}},
    "prototype": {"polluted": true},
    "building": {"__proto__": {"is_admin": true}, "gla": 1900}
  }`);
  const merged = mergeNonBlankSnapshot(
    { owner_name: 'CURRENT OWNER', building: { gla: 1840 } },
    hostile,
  );

  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(Object.getPrototypeOf(merged.building), Object.prototype);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(Object.hasOwn(merged, key), false);
    assert.equal(Object.hasOwn(merged.building, key), false);
  }
  assert.equal(merged.is_admin, undefined);
  assert.equal(merged.polluted, undefined);
  assert.equal(merged.building.is_admin, undefined);
  assert.equal(merged.building.gla, 1900);
  assert.equal(Object.prototype.polluted, undefined);
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
    sellerComparisonSummary('Sample Appraisal Services LLC', 'SAMPLE APPRAISAL SERVICES, LLC').matches,
    true,
  );
  const mismatch = sellerComparisonSummary('Alex Sample', 'Taylor Sample');
  assert.equal(mismatch.matches, false);
  assert.match(mismatch.summary, /Review and explain/);
  assert.equal(sellerComparisonSummary('', 'Alex Sample').matches, null);
});

test('engagement addresses tolerate suffix formatting but block a different subject', () => {
  assert.equal(
    documentSubjectAddressComparison(
      '100 Sample Lane, Exampleton, TX 75041',
      '100 SAMPLE LN, EXAMPLETON, TX 75041',
    ).matches,
    true,
  );
  const mismatch = documentSubjectAddressComparison(
    '200 OTHER DR, Exampleton, TX 75041-1234',
    '100 SAMPLE LN, Exampleton, TX 75041',
  );
  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.documentAddress, '200 OTHER DR, Exampleton, TX 75041-1234');
});

test('only engagement-letter mismatches block evidence confirmation', () => {
  assert.equal(
    assignmentDocumentConfirmationBlocked('engagement_letter', false, false),
    true,
  );
  assert.equal(
    assignmentDocumentConfirmationBlocked('engagement_letter', false, true),
    false,
  );
  assert.equal(
    assignmentDocumentConfirmationBlocked('purchase_contract', false, false),
    false,
  );
  assert.equal(
    assignmentDocumentConfirmationBlocked('purchase_contract', true, false),
    false,
  );
});
