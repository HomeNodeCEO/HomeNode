import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('PropertyReport.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name, environment) {
  const matches = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) matches.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(matches.length, 1);
  // Execute the actual handler AST, not a copied implementation. Only synthetic
  // dependencies are provided; the application, network and browser never start.
  const compiled = ts.transpileModule(`return (${matches[0].getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), compiled)(...Object.values(environment));
}
function privateSalesReadOnly(environment) {
  const matches = [];
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'PrivateSalesImportsPanel') {
      const attribute = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(ast) === 'readOnly');
      matches.push(attribute.initializer.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(matches.length, 1);
  const compiled = ts.transpileModule(`return (${matches[0].getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), compiled)(...Object.values(environment));
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture(options = {}) {
  const events = [], messages = [], workMessages = [], files = [];
  const state = { owned: false, live: true, retained: false, readonly: false, privateSalesSaveLock: null };
  const file = { id: 37, file_number: 'QA-37', reviewer: 'Synthetic Reviewer', workfile: { status: 'draft' } };
  const env = {
    accountId: 'QA-0001', activeAssignmentFile: file,
    privateSalesBusyRef: { current: Boolean(options.privateSalesBusy) },
    setPrivateSalesSaveLock: value => { state.privateSalesSaveLock = typeof value === 'function' ? value(state.privateSalesSaveLock) : value; },
    activeAssignmentFileRef: { current: file }, selectionGenerationRef: { current: 1 },
    assignmentAutosaveState: 'idle', assignmentDirty: false, assignmentDirtyRef: { current: Boolean(options.dirty) },
    assignmentDraft: {}, salesComparisonDraft: { comparables: [{}], opinionOfValue: 250000 },
    assignmentDraftRef: { current: {} }, assignmentSaveInFlightRef: { current: null },
    cloneEditorValue: value => structuredClone(value), customAppraisalDraftsMatch: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    marketConditionsDraft: { response: { analyses: [{}] } },
    assignmentValidationErrors: () => [], neighborhoodBoundaryReadinessErrors: () => [],
    setAssignmentSaveMessage: message => messages.push(message),
    setAssignmentChooserOpen: () => events.push('chooser'),
    setSavingAssignmentFile: value => events.push(`saving:${value}`),
    finalizationRequestRef: { current: null },
    setFinalizingAssignmentFile: value => events.push(`finalizing:${value !== null}`),
    setWorkfileStatusMessage: message => workMessages.push(message),
    setActiveAssignmentFile: value => files.push(value),
    setAssignmentFiles: update => { update([file]); },
    editorKeyForSave: () => 'synthetic-key',
    marketWorkfileSaveQueueRef: { current: options.market ?? Promise.resolve() },
    marketWorkfileSaveErrorRef: { current: null },
    saveAssignmentDetails: async () => { events.push('assignment'); return true; },
    getCustomAppraisalWorkfileReadiness: async (...args) => {
      events.push('readiness'); assert.equal(args[0], 'QA-0001'); assert.equal(args[1], 37);
      return options.readiness ? options.readiness : { readiness: { ready: true, warnings: [], warning_codes: [] } };
    },
    signCustomAppraisalWorkfile: async (...args) => {
      events.push('sign'); assert.equal(args[0], 'QA-0001'); assert.equal(args[1], 37);
      assert.deepEqual(args[2], { signed_by: 'Synthetic Reviewer', acknowledged_warning_codes: [] });
      return options.sign ?? { workfile: { workfile_key: 'qa', canonical_file_name: 'qa.pdf', status: 'signed',
        signed_at: '2026-09-09', signed_by: 'Synthetic Reviewer', updated_at: '2026-09-09', checksum_sha256: 'synthetic' } };
    },
    window: { confirm: () => options.confirm !== false, prompt: () => 'Synthetic Reviewer' },
    neighborhoodWorkspace: { beginSaveBarrier() {
      if (state.owned || options.unavailable) return null;
      state.owned = true; state.readonly = true; events.push('barrier');
      return { isCurrent: () => state.live,
        flush: () => { events.push('flush'); return options.flush ?? Promise.resolve(true); },
        retainReadOnly: () => { state.retained = true; events.push('retain'); },
        release: () => { events.push('release'); if (state.live && !state.retained) state.readonly = false; state.owned = false; } };
    } },
  };
  return { env, state, events, messages, workMessages, files,
    save: () => handler('saveCustomAppraisalNow', env)(),
    sign: () => handler('finalizeCustomAppraisalFile', env)() };
}

for (const dirty of [false, true]) test(`Save Everything flush precedes ${dirty ? 'dirty' : 'clean'} success path`, async () => {
  const hold = deferred(), f = fixture({ dirty, flush: hold.promise });
  const pending = f.save();
  assert.deepEqual(f.events, ['barrier', 'flush']); assert.equal(f.state.readonly, true);
  assert.equal(f.messages.some(text => /All current changes are saved/.test(text)), false);
  hold.resolve(true); await pending;
  assert.equal(f.events.includes('assignment'), dirty);
  assert.equal(f.state.readonly, false); assert.equal(f.events.at(-1), 'release');
  if (!dirty) assert.match(f.messages.at(-1), /All current changes are saved/);
});
for (const dirty of [false, true]) test(`uncertain neighborhood save blocks ${dirty ? 'dirty' : 'clean'} report success`, async () => {
  const f = fixture({ dirty, flush: Promise.resolve(false) }); await f.save();
  assert.equal(f.events.includes('assignment'), false); assert.match(f.messages.at(-1), /not confirmed saved/);
  assert.equal(f.messages.some(text => /All current changes are saved/.test(text)), false);
});
test('double Save Everything cannot acquire concurrent completion paths', async () => {
  const hold = deferred(), f = fixture({ flush: hold.promise }); const first = f.save(); await f.save();
  assert.equal(f.events.filter(x => x === 'flush').length, 1); hold.resolve(true); await first;
});

for (const action of ['save', 'sign']) test(`private CSV activity blocks direct ${action} before any save barrier or signing request`, async () => {
  const f = fixture({ dirty: true, privateSalesBusy: true }); await f[action]();
  assert.deepEqual(f.events, []); assert.equal(f.state.privateSalesSaveLock, null);
  assert.match(f.messages.at(-1), /Wait for the private CSV request to finish/);
  f.env.privateSalesBusyRef.current = false; await f[action]();
  assert.ok(f.events.includes('barrier'), 'settled CSV activity permits an explicit new attempt');
});
test('explicit Save Everything prevents new uploads until its owned barrier settles, without changing autosave', async () => {
  const hold = deferred(), f = fixture({ flush: hold.promise }); const pending = f.save();
  assert.equal(f.state.privateSalesSaveLock.accountId, 'QA-0001'); assert.equal(f.state.privateSalesSaveLock.fileId, 37);
  const panel = () => ({ accountId: f.env.accountId, activeAssignmentFile: f.env.activeAssignmentFile,
    finalizingAssignmentFile: null, privateSalesSaveLock: f.state.privateSalesSaveLock });
  assert.equal(privateSalesReadOnly(panel()), true, 'the actual mounted panel receives the save lock');
  assert.equal(privateSalesReadOnly({ ...panel(), accountId: 'OTHER' }), false, 'lock does not apply to another account');
  assert.equal(privateSalesReadOnly({ ...panel(), activeAssignmentFile: { id: 38, workfile: { status: 'draft' } } }), false);
  assert.equal(f.env.assignmentSaveInFlightRef.current, null); hold.resolve(true); await pending;
  assert.equal(f.state.privateSalesSaveLock, null);
  assert.equal(privateSalesReadOnly(panel()), false);
  assert.equal(privateSalesReadOnly({ ...panel(), finalizingAssignmentFile: {} }), true);
  for (const status of ['signed', 'archived', undefined]) assert.equal(privateSalesReadOnly({ ...panel(),
    activeAssignmentFile: { id: 37, workfile: { status } } }), true);
});
test('failed save releases its private-upload lock and late old completion cannot release a newer lock', async () => {
  const failure = fixture({ flush: Promise.resolve(false) }); await failure.save(); assert.equal(failure.state.privateSalesSaveLock, null);
  const hold = deferred(), f = fixture({ flush: hold.promise }); const pending = f.save();
  const newer = { accountId: 'QA-0001', fileId: 99, lease: {} }; f.state.privateSalesSaveLock = newer; f.state.live = false;
  hold.resolve(true); await pending; assert.equal(f.state.privateSalesSaveLock, newer);
});
test('unrelated CSV read activity during finalization does not invalidate the reviewed report', async () => {
  const hold = deferred(), f = fixture({ readiness: hold.promise }); const pending = f.sign(); await tick();
  f.env.privateSalesBusyRef.current = true;
  hold.resolve({ readiness: { ready: true, warnings: [], warning_codes: [] } }); await pending;
  assert.ok(f.events.includes('sign')); assert.equal(f.files[0].workfile.status, 'signed');
});
test('missing bootstrap/controls cannot silently count as a completed save', async () => {
  const f = fixture({ unavailable: true }); await f.save();
  assert.deepEqual(f.events, []); assert.match(f.messages.at(-1), /reload the neighborhood workspace/);
});
for (const invalidate of ['session', 'selection', 'file']) test(`late save after ${invalidate} change publishes no success`, async () => {
  const hold = deferred(), f = fixture({ flush: hold.promise }); const pending = f.save();
  if (invalidate === 'session') f.state.live = false;
  if (invalidate === 'selection') f.env.selectionGenerationRef.current++;
  if (invalidate === 'file') f.env.activeAssignmentFileRef.current = { id: 99 };
  hold.resolve(true); await pending;
  assert.equal(f.messages.some(text => /All current changes are saved/.test(text)), false);
  assert.equal(f.events.includes('assignment'), false);
});
test('selection change while the market queue drains cannot save the next assignment', async () => {
  const hold = deferred(), f = fixture({ dirty: true, market: hold.promise }); const pending = f.save(); await tick();
  f.env.selectionGenerationRef.current++; hold.resolve(); await pending;
  assert.equal(f.events.includes('assignment'), false);
});
test('Save Everything cannot report success when a newer market save was appended', async () => {
  const hold = deferred(), f = fixture({ market: hold.promise }); const pending = f.save(); await tick();
  f.env.marketWorkfileSaveQueueRef.current = Promise.resolve(); hold.resolve(); await pending;
  assert.match(f.messages.at(-1), /Additional market changes/);
  assert.equal(f.messages.some(text => /All current changes are saved/.test(text)), false);
});
test('signing is quiesced before flush and cannot preflight until it settles', async () => {
  const hold = deferred(), f = fixture({ flush: hold.promise }); const pending = f.sign();
  assert.deepEqual(f.events, ['barrier', 'finalizing:true', 'flush']); assert.equal(f.state.readonly, true);
  hold.resolve(true); await pending;
  assert.deepEqual(f.events, ['barrier', 'finalizing:true', 'flush', 'readiness', 'sign', 'retain', 'finalizing:false', 'release']);
  assert.equal(f.state.readonly, true); assert.equal(f.files[0].workfile.status, 'signed');
  assert.equal(f.env.activeAssignmentFileRef.current, f.files[0]);
});

for (const change of ['queue', 'error']) test(`Save Everything rechecks market ${change} after assignment acknowledgment`, async () => {
  const hold = deferred(), f = fixture({ dirty: true });
  f.env.saveAssignmentDetails = async () => {
    f.events.push('assignment'); await hold.promise;
    f.messages.push('All changes saved in the assignment.'); return true;
  };
  const pending = f.save(); await tick(); await tick();
  assert.equal(f.events.includes('assignment'), true);
  if (change === 'queue') f.env.marketWorkfileSaveQueueRef.current = Promise.resolve();
  else f.env.marketWorkfileSaveErrorRef.current = 'Synthetic market failure';
  hold.resolve(); await pending;
  assert.match(f.messages.at(-1), change === 'queue' ? /additional market changes are still saving/ : /Synthetic market failure/);
  assert.equal(f.state.readonly, false);
});
test('uncertain save prevents both readiness and signing', async () => {
  const f = fixture({ flush: Promise.resolve(false) }); await f.sign();
  assert.equal(f.events.includes('readiness'), false); assert.equal(f.events.includes('sign'), false);
  assert.equal(f.state.readonly, false); assert.match(f.messages.at(-1), /save recovery/);
});
test('cancelled confirmation releases the same draft generation', async () => {
  const f = fixture({ confirm: false }); await f.sign();
  assert.equal(f.events.includes('readiness'), true); assert.equal(f.events.includes('sign'), false);
  assert.equal(f.state.readonly, false); assert.equal(f.state.retained, false);
});
test('failed readiness does not sign and releases draft editing', async () => {
  const f = fixture({ readiness: { readiness: { ready: false, blocker_messages: ['Synthetic blocker'] } } });
  await f.sign(); assert.equal(f.events.includes('sign'), false); assert.equal(f.state.readonly, false);
});
test('file switch during readiness discards preflight and never signs the new target', async () => {
  const hold = deferred(), f = fixture({ readiness: hold.promise }); const pending = f.sign(); await tick();
  assert.equal(f.events.includes('readiness'), true); f.env.selectionGenerationRef.current++;
  hold.resolve({ readiness: { ready: true, warnings: [], warning_codes: [] } }); await pending;
  assert.equal(f.events.includes('sign'), false); assert.deepEqual(f.files, []);
});
test('late signed response cannot replace a different active file', async () => {
  const hold = deferred(), f = fixture({ sign: hold.promise }); const pending = f.sign(); await tick(); await tick();
  assert.equal(f.events.includes('sign'), true); f.state.live = false;
  hold.resolve({ workfile: { status: 'signed' } }); await pending;
  assert.deepEqual(f.files, []); assert.equal(f.state.retained, false);
  assert.equal(f.messages.some(text => /Finalized/.test(text)), false);
  assert.equal(f.events.includes('finalizing:false'), true);
  assert.equal(f.events.includes('saving:false'), false);
});
test('late finalization cannot clear a newer operation indicator', async () => {
  const hold = deferred(), f = fixture({ flush: hold.promise }); const pending = f.sign();
  f.state.live = false; const newer = {}; f.env.finalizationRequestRef.current = newer;
  hold.resolve(true); await pending;
  assert.equal(f.env.finalizationRequestRef.current, newer);
  assert.equal(f.events.includes('finalizing:false'), false);
  assert.equal(f.events.includes('saving:false'), false);
});
for (const stage of ['flush', 'readiness']) for (const changed of ['dirty', 'saved_draft', 'market_queue', 'market_error']) {
  test(`${changed} during held ${stage} stops finalization before signing`, async () => {
    const hold = deferred(), f = fixture(stage === 'flush' ? { flush: hold.promise } : { readiness: hold.promise });
    const pending = f.sign(); await tick();
    if (changed === 'dirty') f.env.assignmentDirtyRef.current = true;
    if (changed === 'saved_draft') f.env.assignmentDraftRef.current = { changed: true };
    if (changed === 'market_queue') f.env.marketWorkfileSaveQueueRef.current = Promise.resolve();
    if (changed === 'market_error') f.env.marketWorkfileSaveErrorRef.current = 'Synthetic save failure';
    hold.resolve(stage === 'flush' ? true : { readiness: { ready: true, warnings: [], warning_codes: [] } });
    await pending; assert.equal(f.events.includes('sign'), false);
    if (stage === 'flush') assert.equal(f.events.includes('readiness'), false);
    assert.match(f.messages.at(-1), /Save Everything, then run finalization again/);
    assert.equal(f.state.readonly, false);
  });
}
test('the exploration host is a single print-hidden sibling, not a DeferredReportSection child', () => {
  const hosts = [];
  function walk(node, ancestors = []) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'CustomNeighborhoodWorkspaceHost') hosts.push([...ancestors, node]);
    ts.forEachChild(node, child => walk(child, [...ancestors, node]));
  }
  walk(ast); assert.equal(hosts.length, 1);
  assert.ok(hosts[0].at(-1).getStart(ast) < source.indexOf('label="Neighborhood Characteristics"'),
    'exploration precedes the neighborhood section and its appraiser-defined map');
  const jsxAncestors = hosts[0].filter(ts.isJsxElement);
  assert.equal(jsxAncestors.some(node => node.openingElement.tagName.getText(ast) === 'DeferredReportSection'), false);
  assert.ok(jsxAncestors.some(node => node.openingElement.attributes.getText(ast).includes('print:hidden')));
  assert.match(source, /VITE_CUSTOM_NEIGHBORHOOD_WORKSPACE_ENABLED === "true"/);
});
