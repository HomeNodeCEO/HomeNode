import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  clearPropertyTaxSaveOperationId,
  getOrCreatePropertyTaxSaveOperationId,
} from '../src/lib/propertyTaxSaveOperation.ts';

function withLocalStorage(run) {
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
    run(values);
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    else delete globalThis.localStorage;
  }
}

test('Property Tax saves retain one operation ID until the response is confirmed', () => {
  withLocalStorage(() => {
    const first = getOrCreatePropertyTaxSaveOperationId('ACCOUNT-1', 'file-1', 7);
    const retry = getOrCreatePropertyTaxSaveOperationId('ACCOUNT-1', 'file-1', 7);
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(retry, first);
    assert.notEqual(getOrCreatePropertyTaxSaveOperationId('ACCOUNT-1', 'file-1', 8), first);

    clearPropertyTaxSaveOperationId('ACCOUNT-1', 'file-1', 7, crypto.randomUUID());
    assert.equal(getOrCreatePropertyTaxSaveOperationId('ACCOUNT-1', 'file-1', 7), first);

    clearPropertyTaxSaveOperationId('ACCOUNT-1', 'file-1', 7, first);
    assert.notEqual(getOrCreatePropertyTaxSaveOperationId('ACCOUNT-1', 'file-1', 7), first);
  });
});

test('Property Tax saves replace malformed persisted operation IDs', () => {
  withLocalStorage((values) => {
    values.set('homenode:property-tax-save:ACCOUNT-2:file-2:3', 'malformed');
    const operationId = getOrCreatePropertyTaxSaveOperationId('ACCOUNT-2', 'file-2', 3);
    assert.match(operationId, /^[0-9a-f-]{36}$/);
    assert.notEqual(operationId, 'malformed');
  });
});

test('Property Tax saves normalize a valid persisted operation ID before cleanup', () => {
  withLocalStorage((values) => {
    const key = 'homenode:property-tax-save:ACCOUNT-3:file-3:4';
    const upper = crypto.randomUUID().toUpperCase();
    values.set(key, ` ${upper} `);
    const operationId = getOrCreatePropertyTaxSaveOperationId('ACCOUNT-3', 'file-3', 4);
    assert.equal(operationId, upper.toLowerCase());
    assert.equal(values.get(key), operationId);
    clearPropertyTaxSaveOperationId('ACCOUNT-3', 'file-3', 4, operationId);
    assert.equal(values.has(key), false);
  });
});

test('the Property Tax API submits and retains an operation ID across transient retries', () => {
  const source = fs.readFileSync(new URL('../src/lib/propertyTaxApi.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function updatePropertyTaxProtestFile(');
  const end = source.indexOf('export async function getPropertyTaxDocuments(', start);
  const updateApi = source.slice(start, end);
  assert.match(updateApi, /getOrCreatePropertyTaxSaveOperationId/);
  assert.match(updateApi, /client_operation_id: operationId/);
  assert.match(updateApi, /retryTransient: true/);
  assert.ok(updateApi.indexOf('clearPropertyTaxSaveOperationId') > updateApi.indexOf('await fetchJSON'));
});
