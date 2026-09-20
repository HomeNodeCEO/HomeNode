import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import {
  appendMeasuredWall,
  closeSketchArea,
  createBlankSketchDocument,
  liveSketchSummary,
  recalculateSketchArea,
} from '../src/lib/sketchGeometry.ts';

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

const requestCalls = [];
globalThis.__desktopSketchRequestCalls = requestCalls;
const apiStubUrl = dataUrl(`
  export function makeUrl(path) { return path; }
  export async function fetchJSON(url, init) {
    globalThis.__desktopSketchRequestCalls.push({ url, init });
    return { ok: true, sketch: { revision: init.method === 'POST' ? 1 : 5 }, report_registry_revision: 2 };
  }
`);
const operationStubUrl = dataUrl(`
  export async function withDesktopSketchSaveOperation(workflow, accountId, targetId, revision, request) {
    return request('11111111-1111-4111-8111-111111111111');
  }
`);
const requestsSource = fs.readFileSync(
  new URL('../src/lib/desktopSketchRequests.ts', import.meta.url),
  'utf8',
).replace(
  /import \{[\s\S]*?\} from '@\/lib\/api';/,
  `import { fetchJSON, makeUrl } from '${apiStubUrl}';`,
).replace(
  /import \{ withDesktopSketchSaveOperation \} from '@\/lib\/desktopSketchSaveOperation';/,
  `import { withDesktopSketchSaveOperation } from '${operationStubUrl}';`,
);
const requestsModule = await import(dataUrl(ts.transpileModule(requestsSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText));

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

test('desktop save dispatches canonical POST and revisioned PATCH requests', async () => {
  requestCalls.length = 0;
  const sketch = { schema_version: '2.1', areas: [], rooms: [] };
  await requestsModule.saveCustomAppraisalSketchDraft({
    accountId: ' ACCOUNT 1 ', assignmentFileId: 42, sketch,
    expectedRevision: 0, editorKey: 'editor-key',
  });
  await requestsModule.saveCustomAppraisalSketchDraft({
    accountId: ' ACCOUNT 1 ', assignmentFileId: 42, sketch,
    expectedRevision: 4, editorKey: 'editor-key',
  });

  assert.equal(requestCalls.length, 2);
  assert.equal(requestCalls[0].url, '/api/accounts/ACCOUNT%201/assignment-files/42/mobile-sketch');
  assert.equal(requestCalls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requestCalls[0].init.body), {
    sketch, reviewer: 'HomeNode appraiser',
    client_operation_id: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(requestCalls[1].url, requestCalls[0].url);
  assert.equal(requestCalls[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(requestCalls[1].init.body), {
    sketch, reviewer: 'HomeNode appraiser', expected_revision: 4,
    client_operation_id: '11111111-1111-4111-8111-111111111111',
  });
});

test('Custom Appraisal exposes desktop creation and canonical save paths', () => {
  const report = fs.readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
  const editor = fs.readFileSync(new URL('../src/components/MobileSketchReview.tsx', import.meta.url), 'utf8');
  const requests = fs.readFileSync(new URL('../src/lib/desktopSketchRequests.ts', import.meta.url), 'utf8');
  assert.match(report, /Start one on desktop/);
  assert.match(report, /saveCustomAppraisalSketchDraft/);
  assert.match(editor, /Net GLA/);
  assert.match(editor, /Garage deduction/);
  assert.match(editor, /Add wall/);
  assert.match(editor, /Room marker/);
  assert.match(editor, /photo anchors/);
  assert.match(requests, /method: 'POST'/);
  assert.match(requests, /expectedRevision === 0/);
  assert.match(requests, /method: 'PATCH'/);
});
