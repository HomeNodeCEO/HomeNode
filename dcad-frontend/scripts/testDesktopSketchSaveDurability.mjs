import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  clearDesktopSketchSaveOperationId,
  getOrCreateDesktopSketchSaveOperationId,
  withDesktopSketchSaveOperation,
} from '../src/lib/desktopSketchSaveOperation.ts';

async function withLocalStorage(run) {
  const values = new Map();
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
  try {
    return await run(values);
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    else delete globalThis.localStorage;
  }
}

test('desktop sketch saves retain one operation ID per workflow target and revision', async () => {
  await withLocalStorage(() => {
    const first = getOrCreateDesktopSketchSaveOperationId(
      'custom-appraisal', 'ACCOUNT-1', 41, 7,
    );
    assert.equal(
      getOrCreateDesktopSketchSaveOperationId('custom-appraisal', 'ACCOUNT-1', 41, 7),
      first,
    );
    assert.notEqual(
      getOrCreateDesktopSketchSaveOperationId('property-tax-protest', 'ACCOUNT-1', 41, 7),
      first,
    );
    assert.notEqual(
      getOrCreateDesktopSketchSaveOperationId('custom-appraisal', 'ACCOUNT-1', 41, 8),
      first,
    );

    clearDesktopSketchSaveOperationId(
      'custom-appraisal', 'ACCOUNT-1', 41, 7, crypto.randomUUID(),
    );
    assert.equal(
      getOrCreateDesktopSketchSaveOperationId('custom-appraisal', 'ACCOUNT-1', 41, 7),
      first,
    );
    clearDesktopSketchSaveOperationId('custom-appraisal', 'ACCOUNT-1', 41, 7, first);
    assert.notEqual(
      getOrCreateDesktopSketchSaveOperationId('custom-appraisal', 'ACCOUNT-1', 41, 7),
      first,
    );
  });
});

test('uncertain failures retain the operation while success and conflicts clear it', async () => {
  await withLocalStorage(async () => {
    let uncertainOperationId = '';
    await assert.rejects(
      withDesktopSketchSaveOperation(
        'custom-appraisal', 'ACCOUNT-2', 42, 3,
        async (operationId) => {
          uncertainOperationId = operationId;
          throw new TypeError('offline');
        },
      ),
      /offline/,
    );
    assert.equal(
      getOrCreateDesktopSketchSaveOperationId('custom-appraisal', 'ACCOUNT-2', 42, 3),
      uncertainOperationId,
    );

    const result = await withDesktopSketchSaveOperation(
      'custom-appraisal', 'ACCOUNT-2', 42, 3,
      async (operationId) => {
        assert.equal(operationId, uncertainOperationId);
        return { revision: 4 };
      },
    );
    assert.deepEqual(result, { revision: 4 });
    assert.notEqual(
      getOrCreateDesktopSketchSaveOperationId('custom-appraisal', 'ACCOUNT-2', 42, 3),
      uncertainOperationId,
    );

    const conflictingOperationId = getOrCreateDesktopSketchSaveOperationId(
      'property-tax-protest', 'ACCOUNT-2', 'file-2', 5,
    );
    await assert.rejects(
      withDesktopSketchSaveOperation(
        'property-tax-protest', 'ACCOUNT-2', 'file-2', 5,
        async () => { throw new Error('sketch_operation_conflict'); },
      ),
      /sketch_operation_conflict/,
    );
    assert.notEqual(
      getOrCreateDesktopSketchSaveOperationId('property-tax-protest', 'ACCOUNT-2', 'file-2', 5),
      conflictingOperationId,
    );
  });
});

test('desktop sketch APIs replay transient failures with their retained operation IDs', () => {
  const source = fs.readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const customStart = source.indexOf('export async function updateMobileInspectionSketch(');
  const propertyTaxStart = source.indexOf('export async function updatePropertyTaxInspectionSketch(');
  const nextStart = source.indexOf('/** Load background coordinate coverage', propertyTaxStart);
  const customApi = source.slice(customStart, propertyTaxStart);
  const propertyTaxApi = source.slice(propertyTaxStart, nextStart);

  for (const api of [customApi, propertyTaxApi]) {
    assert.match(api, /withDesktopSketchSaveOperation/);
    assert.match(api, /client_operation_id: operationId/);
    assert.match(api, /retryTransient: true/);
  }
  const helper = fs.readFileSync(
    new URL('../src/lib/desktopSketchSaveOperation.ts', import.meta.url),
    'utf8',
  );
  const lifecycle = helper.slice(helper.indexOf('export async function withDesktopSketchSaveOperation'));
  assert.ok(lifecycle.indexOf('clearDesktopSketchSaveOperationId') > lifecycle.indexOf('await request'));
  assert.match(lifecycle, /sketch_revision_conflict/);
  assert.match(lifecycle, /sketch_operation_conflict/);
  assert.doesNotMatch(customApi, /crypto\.randomUUID/);
  assert.doesNotMatch(propertyTaxApi, /crypto\.randomUUID/);
  assert.match(propertyTaxApi, /expectedRevision:\s*number/);
  assert.match(propertyTaxApi, /expected_revision:\s*expectedRevision/);
  assert.doesNotMatch(propertyTaxApi, /sketch\.revision/);

  const propertyTaxReview = fs.readFileSync(
    new URL('../src/components/PropertyTaxWorkfileReview.tsx', import.meta.url),
    'utf8',
  );
  assert.match(propertyTaxReview, /saveDraft=\{\(draft, expectedRevision\)/);
  assert.match(
    propertyTaxReview,
    /updatePropertyTaxInspectionSketch\([\s\S]*?file\.tax_protest_file_id,[\s\S]*?expectedRevision,[\s\S]*?draft/,
  );
  assert.doesNotMatch(
    propertyTaxReview,
    /updatePropertyTaxInspectionSketch\([\s\S]*?file\.sketch!.*?[\s\S]*?draft/,
  );
});

test('the shared sketch editor treats operation reuse conflicts as reload-required', () => {
  const source = fs.readFileSync(
    new URL('../src/components/MobileSketchReview.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /sketch_revision_conflict/);
  assert.match(source, /sketch_operation_conflict/);
  assert.match(source, /A newer sketch exists\. Reload before saving\./);
});
