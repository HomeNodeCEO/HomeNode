import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  appendMeasuredWall,
  closeSketchArea,
  createBlankSketchDocument,
  liveSketchSummary,
  recalculateSketchArea,
} from '../src/lib/sketchGeometry.ts';

test('desktop measured walls close and calculate net GLA', () => {
  let vertices = [];
  vertices = appendMeasuredWall(vertices, 40, 0);
  vertices = appendMeasuredWall(vertices, 30, 90);
  vertices = appendMeasuredWall(vertices, 40, 180);
  vertices = closeSketchArea(vertices);
  const document = createBlankSketchDocument('11111111-1111-4111-8111-111111111111');
  document.areas[0] = recalculateSketchArea({ ...document.areas[0], vertices });
  const summary = liveSketchSummary(document, document.areas[0].id);
  assert.equal(document.areas[0].calculation.closed, true);
  assert.equal(document.areas[0].calculation.reported_area_sqft, 1200);
  assert.equal(summary.grossIncludedSqft, 1200);
  assert.equal(summary.netGlaSqft, 1200);
  assert.equal(summary.selectedAreaSqft, 1200);
});

test('garage deductions remain visible and reduce net GLA', () => {
  const document = createBlankSketchDocument('11111111-1111-4111-8111-111111111111');
  const main = recalculateSketchArea({
    ...document.areas[0],
    vertices: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }, { x: 0, y: 0 }],
  });
  const garage = recalculateSketchArea({
    ...createBlankSketchDocument('22222222-2222-4222-8222-222222222222').areas[0],
    label: 'Garage deduction',
    classification: 'garage',
    gla_treatment: 'deduction',
    parent_area_id: main.id,
    vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 }],
    position: 2,
  });
  const summary = liveSketchSummary({ ...document, areas: [main, garage] });
  assert.equal(summary.grossIncludedSqft, 1200);
  assert.equal(summary.deductionSqft, 200);
  assert.equal(summary.netGlaSqft, 1000);
  assert.equal(summary.byClassification.garage, 200);
});

test('Custom Appraisal exposes desktop creation and canonical save paths', () => {
  const report = fs.readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
  const editor = fs.readFileSync(new URL('../src/components/MobileSketchReview.tsx', import.meta.url), 'utf8');
  const api = fs.readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  assert.match(report, /Start one on desktop/);
  assert.match(report, /createMobileInspectionSketch/);
  assert.match(report, /expectedRevision === 0/);
  assert.match(editor, /Net GLA/);
  assert.match(editor, /Garage deduction/);
  assert.match(editor, /Add wall/);
  assert.match(editor, /Room marker/);
  assert.match(editor, /photo anchors/);
  assert.match(api, /method: 'POST'/);
});
