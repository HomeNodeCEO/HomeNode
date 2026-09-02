import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildPropertyTaxSummary,
  readPropertyTaxWorkspace,
  resolvePropertyTaxAnalysisContext,
} from '../src/lib/propertyTaxWorkspace.ts';

const protestPage = fs.readFileSync(
  new URL('../src/pages/PropertyTaxProtest.tsx', import.meta.url),
  'utf8',
);
const canonicalReview = fs.readFileSync(
  new URL('../src/components/PropertyTaxWorkfileReview.tsx', import.meta.url),
  'utf8',
);
const packetWorkspace = fs.readFileSync(
  new URL('../src/components/PropertyTaxPacketWorkspace.tsx', import.meta.url),
  'utf8',
);
const comparableGrid = fs.readFileSync(
  new URL('../src/components/PropertyTaxComparableGrid.tsx', import.meta.url),
  'utf8',
);
const evidenceDocuments = fs.readFileSync(
  new URL('../src/components/PropertyTaxEvidenceDocumentCenter.tsx', import.meta.url),
  'utf8',
);
const propertyTaxComparableAnalysis = fs.readFileSync(
  new URL('../src/lib/propertyTaxComparableAnalysis.ts', import.meta.url),
  'utf8',
);
const sharedComparableAnalysis = fs.readFileSync(
  new URL('../src/lib/sharedComparableAnalysis.ts', import.meta.url),
  'utf8',
);

const forbiddenCrossWorkflowReferences = [
  'loadAssignmentFiles',
  'loadCustomAppraisalWorkfile',
  'saveCustomAppraisalWorkfileSection',
  'readAppraisalReportDraft',
  'AppraisalReportSalesDraft',
];

test('the protest workspace has no Custom Appraisal persistence dependency', () => {
  for (const reference of forbiddenCrossWorkflowReferences) {
    assert.doesNotMatch(protestPage, new RegExp(reference));
    assert.doesNotMatch(canonicalReview, new RegExp(reference));
    assert.doesNotMatch(packetWorkspace, new RegExp(reference));
    assert.doesNotMatch(propertyTaxComparableAnalysis, new RegExp(reference));
    assert.doesNotMatch(comparableGrid, new RegExp(reference));
    assert.doesNotMatch(evidenceDocuments, new RegExp(reference));
  }
  assert.match(protestPage, /PropertyTaxWorkfileReview/);
  assert.match(protestPage, /onFileChange=\{setCanonicalFile\}/);
  assert.match(protestPage, /readPropertyTaxWorkspace/);
  assert.match(protestPage, /!canonicalFile && <ComparableGridUnavailable/);
  assert.match(protestPage, /No Property Tax file loaded yet/);
  assert.match(protestPage, /← Close Report/);
  assert.doesNotMatch(canonicalReview, /Canonical mobile workfile|Only mobile changes|mobile assignment picker|Verified mobile photo index/);
  assert.match(canonicalReview, /Canonical Property Tax file/);
  assert.match(canonicalReview, /Desktop Property Tax workspace/);
  assert.match(canonicalReview, /revisionSourceLabel="Property Tax"/);
  assert.match(protestPage, /latest_tax_year/);
  assert.match(protestPage, /neighborhood_code/);
  assert.doesNotMatch(comparableGrid, /Save a tax year and DCAD neighborhood code/);
  assert.doesNotMatch(comparableGrid, /disabled=\{loadingRecommendations \|\| !subject\}/);
  assert.ok(
    canonicalReview.indexOf('<PropertyTaxComparableGrid')
      < canonicalReview.indexOf('{groups.map'),
    'the comparable grid should appear before the detailed workfile field groups',
  );
});

test('analysis context uses the latest database fields without overwriting explicit workfile values', () => {
  const databaseDefaults = {
    loaded: true,
    taxYear: 2026,
    neighborhoodCode: 'DB-NBHD-10',
  };
  const inherited = resolvePropertyTaxAnalysisContext({}, databaseDefaults, 2030);
  assert.equal(inherited.taxYear, 2026);
  assert.equal(inherited.neighborhoodCode, 'DB-NBHD-10');
  assert.equal(inherited.taxYearSource, 'database');
  assert.equal(inherited.neighborhoodCodeSource, 'database');
  assert.equal(inherited.warnings.length, 2);

  const explicit = resolvePropertyTaxAnalysisContext({
    valuation: { tax_year: 2025 },
    subject: { district_neighborhood_code: 'SAVED-NBHD-5' },
  }, databaseDefaults, 2030);
  assert.equal(explicit.taxYear, 2025);
  assert.equal(explicit.neighborhoodCode, 'SAVED-NBHD-5');
  assert.equal(explicit.taxYearSource, 'workfile');
  assert.equal(explicit.neighborhoodCodeSource, 'workfile');
  assert.deepEqual(explicit.warnings, []);
});

test('missing database context falls back without blocking and remains flagged', () => {
  const context = resolvePropertyTaxAnalysisContext({}, {
    loaded: true,
    taxYear: null,
    neighborhoodCode: '',
  }, 2027);
  assert.equal(context.taxYear, 2027);
  assert.equal(context.neighborhoodCode, '');
  assert.equal(context.taxYearSource, 'system');
  assert.equal(context.neighborhoodCodeSource, 'missing');
  assert.match(context.warnings.join(' '), /continue without neighborhood filtering/);
});

test('the shared calculation boundary contains no workflow persistence identity', () => {
  assert.doesNotMatch(sharedComparableAnalysis, /tax_protest_file_id/);
  assert.doesNotMatch(sharedComparableAnalysis, /assignmentFileId/);
  assert.doesNotMatch(sharedComparableAnalysis, /workfile_data/);
  assert.doesNotMatch(sharedComparableAnalysis, /localStorage|fetch\(/);
});

test('the canonical adapter reads only the selected protest workfile values', () => {
  const snapshot = readPropertyTaxWorkspace({
    subject: {
      condition_rating: 'C4',
      quality_rating: 'Q3',
    },
    condition: {
      repair_cost_to_cure: 12_500,
      repair_cost_to_cure_notes: 'Roof repair estimate.',
    },
    valuation: {
      tax_year: 2026,
      district_appraised_value: 500_000,
      requested_market_value: 455_000,
    },
    analysis: {
      sales_comparison_notes: 'Three competitive sales support the requested value.',
      adjustment_notes: 'Adjustments are market supported.',
    },
  });

  assert.equal(snapshot.conditionRating, 'C4');
  assert.equal(snapshot.repairCostToCure, 12_500);
  assert.equal(snapshot.districtAppraisedValue, 500_000);
  assert.equal(snapshot.salesComparisonNotes, 'Three competitive sales support the requested value.');
});

test('the summary is deterministic and does not invent missing protest evidence', () => {
  const snapshot = readPropertyTaxWorkspace({
    valuation: {
      district_appraised_value: 500_000,
      requested_market_value: 455_000,
    },
    analysis: {
      sales_comparison_notes: 'Selected comparable sales support the requested value.',
    },
  });
  const summary = buildPropertyTaxSummary({ subject: '123 Main Street', snapshot });

  assert.match(summary, /123 Main Street/);
  assert.match(summary, /\$500,000/);
  assert.match(summary, /\$455,000/);
  assert.match(summary, /Selected comparable sales support the requested value/);
  assert.doesNotMatch(summary, /31,900|789 Elm|101 Oak/);
});
