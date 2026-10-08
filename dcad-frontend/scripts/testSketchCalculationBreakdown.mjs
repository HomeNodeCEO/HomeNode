import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/SketchCalculationBreakdown.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const exports = {};
runInNewContext(compiled, { exports, require }, { timeout: 1000 });
const Component = exports.default;
function fixture() {
  return { precision_note: 'Keep full precision.', areas: [{
    area_id: 'first', label: 'First floor', level_label: 'Level 1', classification: 'above_grade_finished', gla_treatment: 'included', status: 'ready',
    calculated_area_sqft: 375, reported_area_sqft: 375, displayed_row_rounding_difference_sqft: 0, angled_walls: [],
    sections: [{ label: 'A', shape: 'rectangle', formula: '25 x 15', calculated_area_sqft: 375, vertices: [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 15 }, { x: 0, y: 15 }] }],
  }], summary: { all_breakdowns_ready: true, levels: [{ level_label: 'Level 1', gross_included_sqft: 375, deduction_sqft: 0, net_gla_sqft: 375 }], gross_included_sqft: 375, deduction_sqft: 0, net_gla_sqft: 375, net_calculated_sqft: 375 } };
}
function render(breakdown, dirty = false) { return renderToStaticMarkup(React.createElement(Component, { breakdown, dirty, revision: 7 })); }

test('saved calculation breakdown displays the matched section diagram, formulas and revision', () => {
  const html = render(fixture());
  assert.match(html, /saved revision 7/);
  assert.match(html, /<svg/);
  assert.match(html, /25 x 15/);
  assert.match(html, /375\.00/);
  assert.match(html, /Included in GLA/);
  assert.match(html, /PDF exhibit/);
});

test('incoming calculations cannot replace or pretend to include unsaved desktop edits', () => {
  const breakdown = fixture();
  const snapshot = JSON.stringify(breakdown);
  assert.match(render(breakdown, true), /Unsaved desktop edits are preserved/);
  assert.equal(JSON.stringify(breakdown), snapshot);
  const editor = readFileSync(new URL('../src/components/MobileSketchReview.tsx', import.meta.url), 'utf8');
  assert.match(editor, /breakdown=\{sketch.calculation_breakdown\}/);
  assert.match(editor, /if \(dirty\) \{\s*setPendingSketch\(sketch\)/);
});

test('older API responses remain usable during rollout and incomplete sketches remain explicit', () => {
  assert.equal(render(undefined), '');
  const breakdown = fixture();
  breakdown.areas[0] = { ...breakdown.areas[0], status: 'pending', reason: 'Close the outline.', sections: [] };
  breakdown.summary.all_breakdowns_ready = false;
  const html = render(breakdown);
  assert.match(html, /Close the outline/);
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /Incomplete or unavailable areas/);
});

test('labels are escaped and the view introduces no additional network calls', () => {
  const breakdown = fixture();
  breakdown.areas[0].label = '<script>alert(1)</script>';
  const html = render(breakdown);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(source, /fetch\(|setInterval\(|saveDraft\(/);
});
