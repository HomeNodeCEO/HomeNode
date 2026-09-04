import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('the shared comparable API carries one exact workflow workfile scope', () => {
  const api = source('../src/lib/api.ts');
  assert.match(api, /assignment_file_id: params\.assignmentFileId \?\? undefined/);
  assert.match(api, /property_tax_file_id: params\.propertyTaxFileId \?\? undefined/);
});

test('Custom Appraisal recommendation callers carry the selected assignment', () => {
  const analysis = source('../src/pages/ComparableSalesAnalysis.tsx');
  const report = source('../src/pages/AppraisalReport.tsx');
  const conditionStudy = source('../src/components/ConditionQualityStudy.tsx');
  assert.match(analysis, /getComparableRecommendations\(\{[\s\S]*?assignmentFileId: activeAssignmentFile\.id/);
  assert.match(analysis, /<ConditionQualityStudy[\s\S]*?assignmentFileId=\{activeAssignmentFile\?\.id \|\| null\}/);
  assert.match(report, /getComparableRecommendations\(\{[\s\S]*?assignmentFileId: assignmentFile\.id/);
  assert.match(conditionStudy, /getComparableRecommendations\(\{[\s\S]*?assignmentFileId,/);
});

test('Property Tax recommendation callers carry the selected protest file', () => {
  const propertyTax = source('../src/components/PropertyTaxComparableGrid.tsx');
  assert.match(
    propertyTax,
    /getComparableRecommendations\(\{[\s\S]*?propertyTaxFileId: file\.tax_protest_file_id/,
  );
});
