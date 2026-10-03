import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import { customAssignmentFileMatches } from '../src/lib/customAssignmentNavigation.ts';

const ACCOUNT = 'SYNTHETIC-ACCOUNT';
const SECTION = 'report.subject_identification';
const RECEIPT = 'report.subject_evidence';
const savedValue = (value, revision = 3) => ({ value, revision, reviewer: null, notes: null, updated_at: '2026-10-03T00:00:00Z' });
const file = (id, account = ACCOUNT, value = `File ${id}`) => ({ id, account_id: account, file_number: `SYNTHETIC-${id}`,
  custom_appraisal_sections: { [SECTION]: savedValue({ property_location: { address: value } }) } });
const result = (value = 'Saved correction', revision = 4) => ({ manual_values: { [SECTION]: savedValue({ property_location: { address: value } }, revision) } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const sameDeps = (a, b) => a?.length === b?.length && a.every((value, index) => Object.is(value, b[index]));

function harness({ props: overrides = {}, save = async () => result(), reload = async () => {}, conflict = async () => ({ account_id: ACCOUNT, files: [file(7)] }), deferSetters = false } = {}) {
  const cells = [], effects = [], calls = [], alerts = [], lateWrites = [], queuedSetters = [];
  let cursor = 0, dirty = false, unmounted = false, editor;
  let props = { accountId: ACCOUNT, activeAssignmentFile: file(7), baseDetail: { report_manual_values: {} }, ...overrides };
  let files = [props.activeAssignmentFile, file(8)].filter(Boolean);
  const react = {
    useState(initial) {
      const id = cursor++; cells[id] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cells[id].value, update => {
        if (unmounted) lateWrites.push(id);
        const next = typeof update === 'function' ? update(cells[id].value) : update;
        if (!Object.is(next, cells[id].value)) { cells[id].value = next; dirty = true; }
      }];
    },
    useRef(initial) { const id = cursor++; cells[id] ??= { current: initial }; return cells[id]; },
    useMemo(factory, deps) { const id = cursor++; if (!cells[id] || !sameDeps(cells[id].deps, deps)) cells[id] = { value: factory(), deps }; return cells[id].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useLayoutEffect(fn, deps) {
      const id = cursor++, old = cells[id];
      if (old && sameDeps(old.deps, deps)) return;
      const cell = { deps, cleanup: old?.cleanup }; cells[id] = cell;
      effects.push(() => { cell.cleanup?.(); cell.cleanup = fn(); });
    },
  };
  const api = {
    updatePropertyReportSections: (...args) => { calls.push({ name: 'save', args }); return save(...args); },
    getAssignmentFiles: (...args) => { calls.push({ name: 'conflict', args }); return conflict(...args); },
  };
  const manual = loadTrustedRepositoryCommonJs(new URL('../src/hooks/useManualReportSections.ts', import.meta.url), name => {
    assert.ok(['react', '@/lib/api'].includes(name), `unexpected dependency ${name}`);
    return name === 'react' ? react : api;
  }, { environment: { window: { alert: value => alerts.push(value) } } });
  const { useAssignmentScopedReportSections: useSections } = loadTrustedRepositoryCommonJs(new URL('../src/hooks/useAssignmentScopedReportSections.ts', import.meta.url), name => {
    const imports = {
      react, '@/lib/api': api, '@/hooks/useManualReportSections': manual,
      '@/lib/customAssignmentNavigation': { customAssignmentFileMatches },
      '@/lib/legacyDcadDetail': { applyReportManualValues: (base, values, options) => ({ ...base, report_manual_values: values, overlayOptions: options }) },
    };
    assert.ok(Object.hasOwn(imports, name), `unexpected dependency ${name}`); return imports[name];
  });
  const applySetter = fn => { if (deferSetters) queuedSetters.push(fn); else fn(); };
  const setActiveAssignmentFile = update => applySetter(() => {
    if (unmounted) lateWrites.push('active');
    const current = props.activeAssignmentFile;
    const next = typeof update === 'function' ? update(current) : update;
    if (next !== current) { props = { ...props, activeAssignmentFile: next }; dirty = true; }
  });
  const setAssignmentFiles = update => applySetter(() => {
    if (unmounted) lateWrites.push('files');
    files = typeof update === 'function' ? update(files) : update;
  });
  const getEditorKey = () => 'synthetic-editor-key';
  const onReload = async () => { calls.push({ name: 'reload', args: [] }); await reload(); };
  const onCredentialRejected = () => calls.push({ name: 'credentialRejected', args: [] });
  function render(patch = {}, runEffects = true) {
    assert.equal(unmounted, false); props = { ...props, ...patch }; cursor = 0; dirty = false;
    editor = useSections({ ...props, setActiveAssignmentFile, setAssignmentFiles, getEditorKey, onReload, onCredentialRejected });
    if (runEffects) effects.splice(0).forEach(fn => fn());
  }
  function flush() { let count = 0; while (dirty && !unmounted) { assert.ok(++count < 30, 'render settles'); render(); } }
  render(); flush();
  return {
    calls, alerts, lateWrites, render, flush,
    get editor() { return editor; }, get active() { return props.activeAssignmentFile; }, get files() { return files; },
    open(key = SECTION) { editor.editSection(key); flush(); },
    async settle() { for (let count = 0; count < 35; count++) { await Promise.resolve(); flush(); } },
    commitSetters() { queuedSetters.splice(0).forEach(fn => fn()); flush(); },
    cleanup() { if (unmounted) return; unmounted = true; cells.forEach(cell => cell?.cleanup?.()); },
  };
}

test('manual save sends exact assignment and captured revision, hydrates only that file, and closes its session', async t => {
  const response = result(); response.manual_values[RECEIPT] = savedValue({ forged: true });
  const h = harness({ save: async () => response }); t.after(h.cleanup); h.open();
  const key = h.editor.editingSessionKey;
  assert.ok(key); const edited = { property_location: { address: 'Manual correction' } };
  await h.editor.saveEditedSection(edited); await h.settle();
  assert.deepEqual(h.calls[0].args, [ACCOUNT, { [SECTION]: edited }, 'synthetic-editor-key', 7, { [SECTION]: 3 }]);
  assert.equal(h.active.custom_appraisal_sections[SECTION].value.property_location.address, 'Saved correction');
  assert.equal(h.files[1].custom_appraisal_sections[SECTION].value.property_location.address, 'File 8');
  assert.equal(Object.hasOwn(h.active.custom_appraisal_sections, RECEIPT), false);
  assert.equal(h.editor.editingSection, null); assert.equal(h.editor.savingSection, false);
  h.open(); assert.notEqual(h.editor.editingSessionKey, key);
  await h.editor.saveEditedSection({}); assert.equal(h.calls.filter(call => call.name === 'save')[1].args[4][SECTION], 4);
});

test('duplicate manual saves are rejected synchronously before React rerenders', async t => {
  const pending = deferred(), h = harness({ save: () => pending.promise }); t.after(h.cleanup); h.open();
  const save = h.editor.saveEditedSection;
  const first = save({ a: 1 }), duplicate = save({ a: 2 }); h.flush();
  assert.equal(h.calls.filter(call => call.name === 'save').length, 1); assert.equal(h.editor.savingSection, true);
  pending.resolve(result()); await Promise.all([first, duplicate]); await h.settle();
  assert.equal(h.editor.savingSection, false);
});

for (const transition of ['assignment', 'account', 'A-B-A', 'read-only', 'unmount', 'selection epoch']) {
  for (const outcome of ['success', '401 failure', '409 conflict', 'ordinary failure']) {
    test(`manual save ignores stale ${outcome} after ${transition}`, async t => {
      const pending = deferred(), generation = { current: 1 };
      const h = harness({ props: { selectionGenerationRef: generation }, save: () => pending.promise }); t.after(h.cleanup); h.open();
      const operation = h.editor.saveEditedSection({ property_location: { address: 'Old draft' } }); h.flush();
      if (transition === 'unmount') h.cleanup();
      else if (transition === 'selection epoch') generation.current += 1;
      else if (transition === 'read-only') { h.render({ readOnly: true }); h.flush(); }
      else {
        h.render(transition === 'account' ? { accountId: 'OTHER', activeAssignmentFile: file(7, 'OTHER') } : { activeAssignmentFile: file(8) }); h.flush();
        if (transition === 'A-B-A') { h.render({ activeAssignmentFile: file(7) }); h.flush(); }
        assert.equal(h.editor.editingSection, null);
      }
      const before = h.calls.length, current = h.active;
      if (outcome === 'success') pending.resolve(result('Old response'));
      else pending.reject(new Error(outcome));
      await operation; await h.settle();
      assert.equal(h.active, current); assert.equal(h.calls.length, before);
      assert.deepEqual(h.alerts, []); assert.deepEqual(h.lateWrites, []);
    });
  }
}

test('stale edit, save, and cancel callbacks cannot affect the next assignment before layout cleanup', async t => {
  const h = harness(); t.after(h.cleanup); h.open(); const old = h.editor;
  h.render({ activeAssignmentFile: file(8) }, false);
  assert.equal(h.editor.editingSection, null, 'old editor is hidden synchronously');
  old.editSection(SECTION); old.cancelEditingSection(); await old.saveEditedSection({});
  assert.equal(h.calls.length, 0); h.flush(); h.open();
  const currentKey = h.editor.editingSessionKey; old.cancelEditingSection(); h.flush();
  assert.equal(h.editor.editingSessionKey, currentKey);
});

test('old save cleanup cannot close or unlock a newer assignment save', async t => {
  const first = deferred(), second = deferred(); let requests = 0;
  const h = harness({ save: () => ++requests === 1 ? first.promise : second.promise }); t.after(h.cleanup); h.open();
  const one = h.editor.saveEditedSection({}); h.flush(); h.render({ activeAssignmentFile: file(8) }); h.flush(); h.open();
  const key = h.editor.editingSessionKey, two = h.editor.saveEditedSection({}); h.flush();
  first.resolve(result('Wrong A')); await one; await h.settle();
  assert.equal(h.editor.savingSection, true); assert.equal(h.editor.editingSessionKey, key);
  assert.equal(h.active.custom_appraisal_sections[SECTION].value.property_location.address, 'File 8');
  second.resolve(result('Saved B')); await two; await h.settle();
  assert.equal(h.active.custom_appraisal_sections[SECTION].value.property_location.address, 'Saved B');
});

test('returning to a file with a pending save cannot start a second editing session', async t => {
  const pending = deferred(), h = harness({ save: () => pending.promise }); t.after(h.cleanup); h.open();
  const operation = h.editor.saveEditedSection({}); h.flush(); h.render({ activeAssignmentFile: file(8) }); h.flush();
  h.render({ activeAssignmentFile: file(7) }); h.flush(); h.open();
  assert.equal(h.editor.editingSection, null); assert.equal(h.editor.savingSection, true);
  pending.resolve(result()); await operation; await h.settle(); h.open(); assert.ok(h.editor.editingSection);
});

for (const transition of ['assignment', 'A-B-A', 'read-only', 'unmount', 'cancel', 'selection epoch']) {
  test(`conflict reload cannot hydrate or alert after ${transition}`, async t => {
    const pending = deferred(), generation = { current: 1 };
    const h = harness({ props: { selectionGenerationRef: generation }, save: async () => { throw new Error('409 report_section_revision_conflict'); }, conflict: () => pending.promise });
    t.after(h.cleanup); h.open(); const operation = h.editor.saveEditedSection({}); await h.settle();
    assert.equal(h.calls.filter(call => call.name === 'conflict').length, 1);
    if (transition === 'unmount') h.cleanup();
    else if (transition === 'cancel') { h.editor.cancelEditingSection(); h.flush(); }
    else if (transition === 'selection epoch') generation.current++;
    else if (transition === 'read-only') { h.render({ readOnly: true }); h.flush(); }
    else {
      h.render({ activeAssignmentFile: file(8) }); h.flush();
      if (transition === 'A-B-A') { h.render({ activeAssignmentFile: file(7) }); h.flush(); }
    }
    const current = h.active;
    pending.resolve({ account_id: ACCOUNT, files: [file(7, ACCOUNT, 'Stale conflict result')] }); await operation; await h.settle();
    assert.equal(h.active, current); assert.deepEqual(h.alerts, []); assert.deepEqual(h.lateWrites, []);
  });
}

for (const mismatch of ['envelope account', 'file account', 'file ID', 'request failed']) {
  test(`conflict reload fails closed on ${mismatch}`, async t => {
    const h = harness({ save: async () => { throw new Error('409 report_section_revision_conflict'); }, conflict: async () => {
      if (mismatch === 'request failed') throw new Error('network failed');
      return { account_id: mismatch === 'envelope account' ? 'OTHER' : ACCOUNT,
        files: [file(mismatch === 'file ID' ? 8 : 7, mismatch === 'file account' ? 'OTHER' : ACCOUNT, 'Wrong')] };
    } });
    t.after(h.cleanup); h.open(); const current = h.active; await h.editor.saveEditedSection({}); await h.settle();
    assert.equal(h.active, current); assert.equal(h.editor.editingSection, null);
    assert.match(h.alerts[0], /Reload the assignment/); assert.doesNotMatch(h.alerts[0], /latest assignment revision was loaded/);
  });
}

test('successful current conflict reload adopts only matching-account files and their latest revisions', async t => {
  const latest = file(7, ACCOUNT, 'Latest revision'); latest.custom_appraisal_sections[SECTION].revision = 8;
  const h = harness({ save: async () => { throw new Error('409'); }, conflict: async () => ({ account_id: ACCOUNT, files: [latest, file(9, 'OTHER')] }) });
  t.after(h.cleanup); h.open(); await h.editor.saveEditedSection({}); await h.settle();
  assert.equal(h.active, latest); assert.equal(h.files.length, 1); assert.equal(h.editor.editingSection, null);
  assert.match(h.alerts[0], /latest assignment revision was loaded/);
  h.open(); await h.editor.saveEditedSection({}); assert.equal(h.calls.filter(call => call.name === 'save')[1].args[4][SECTION], 8);
});

test('queued save hydration rechecks exact identity when React executes setters later', async t => {
  const h = harness({ deferSetters: true }); t.after(h.cleanup); h.open(); await h.editor.saveEditedSection({}); await h.settle();
  h.render({ activeAssignmentFile: file(8) }); h.flush(); const current = h.active;
  h.commitSetters(); assert.equal(h.active, current); assert.equal(h.files[1].custom_appraisal_sections[SECTION].value.property_location.address, 'File 8');
});

for (const outcome of ['save', 'conflict']) {
  test(`queued current ${outcome} hydration survives the acknowledged editor closing`, async t => {
    const latest = file(7, ACCOUNT, 'Latest acknowledged value'); latest.custom_appraisal_sections[SECTION].revision = 8;
    const h = harness({ deferSetters: true,
      save: async () => { if (outcome === 'conflict') throw new Error('409'); return result('Latest acknowledged value', 8); },
      conflict: async () => ({ account_id: ACCOUNT, files: [latest] }),
    });
    t.after(h.cleanup); h.open(); await h.editor.saveEditedSection({}); await h.settle();
    assert.equal(h.editor.editingSection, null);
    h.commitSetters();
    assert.equal(h.active.custom_appraisal_sections[SECTION].value.property_location.address, 'Latest acknowledged value');
    assert.equal(h.files[0].custom_appraisal_sections[SECTION].revision, 8);
  });
}

for (const responseRevision of [4, 5]) {
  test(`manual save revision ${responseRevision} cannot replace an equal or newer applied revision`, async t => {
    const pending = deferred(), h = harness({ save: () => pending.promise }); t.after(h.cleanup); h.open();
    const operation = h.editor.saveEditedSection({}); h.flush();
    const newer = file(7, ACCOUNT, 'Newer document application'); newer.custom_appraisal_sections[SECTION].revision = 5;
    h.render({ activeAssignmentFile: newer }); h.flush();
    pending.resolve(result('Delayed manual save', responseRevision)); await operation; await h.settle();
    assert.equal(h.active.custom_appraisal_sections[SECTION].value.property_location.address, 'Newer document application');
    assert.equal(h.active.custom_appraisal_sections[SECTION].revision, 5);
  });
}

for (const transition of ['assignment', 'A-B-A', 'read-only', 'unmount', 'selection epoch']) {
  for (const outcome of ['success', 'failure']) {
    test(`manual save reload ${outcome} has no stale cleanup or alert after ${transition}`, async t => {
      const pending = deferred(), generation = { current: 1 };
      const h = harness({ props: { selectionGenerationRef: generation }, reload: () => pending.promise }); t.after(h.cleanup); h.open();
      const operation = h.editor.saveEditedSection({}); await h.settle();
      assert.equal(h.calls.filter(call => call.name === 'reload').length, 1);
      if (transition === 'unmount') h.cleanup();
      else if (transition === 'selection epoch') generation.current++;
      else if (transition === 'read-only') { h.render({ readOnly: true }); h.flush(); }
      else {
        h.render({ activeAssignmentFile: file(8) }); h.flush();
        if (transition === 'A-B-A') { h.render({ activeAssignmentFile: file(7) }); h.flush(); }
        else h.open();
      }
      const current = h.active, editingKey = transition === 'selection epoch' ? null : h.editor.editingSessionKey;
      if (outcome === 'success') pending.resolve(); else pending.reject(new Error('401 late reload failure'));
      await operation; await h.settle();
      assert.equal(h.active, current); assert.equal(h.editor.editingSessionKey, editingKey);
      assert.equal(h.calls.filter(call => call.name === 'credentialRejected').length, 0);
      assert.deepEqual(h.alerts, []); assert.deepEqual(h.lateWrites, []);
    });
  }
}

test('conflict reload retains a newer document-applied section and its server-only receipt', async t => {
  const pending = deferred();
  const h = harness({ save: async () => { throw new Error('409'); }, conflict: () => pending.promise }); t.after(h.cleanup); h.open();
  const operation = h.editor.saveEditedSection({}); await h.settle();
  const current = file(7, ACCOUNT, 'Newer application'); current.custom_appraisal_sections[SECTION].revision = 8;
  current.custom_appraisal_sections[RECEIPT] = savedValue({ originalDocumentId: 123 }, 2);
  h.render({ activeAssignmentFile: current }); h.flush();
  const older = file(7, ACCOUNT, 'Old conflict snapshot'); older.custom_appraisal_sections[SECTION].revision = 7;
  pending.resolve({ account_id: ACCOUNT, files: [older] }); await operation; await h.settle();
  assert.equal(h.active.custom_appraisal_sections[SECTION].value.property_location.address, 'Newer application');
  assert.equal(h.active.custom_appraisal_sections[SECTION].revision, 8);
  assert.deepEqual(h.active.custom_appraisal_sections[RECEIPT], current.custom_appraisal_sections[RECEIPT]);
  assert.equal(Object.hasOwn(h.editor.detail.report_manual_values, RECEIPT), false);
});

test('server-only receipts are excluded from both base and selected-file UI manual values', t => {
  const selected = file(7); selected.custom_appraisal_sections[RECEIPT] = savedValue({ candidateId: 123 });
  const h = harness({ props: { activeAssignmentFile: selected, baseDetail: { report_manual_values: { [RECEIPT]: savedValue({ secret: true }) } } } }); t.after(h.cleanup);
  assert.equal(Object.hasOwn(h.editor.detail.report_manual_values, RECEIPT), false);
  assert.equal(h.editor.detail.overlayOptions.explicitSubjectValues, true);
  h.render({ activeAssignmentFile: file(7, 'OTHER') }); h.flush();
  assert.equal(Object.hasOwn(h.editor.detail.report_manual_values, SECTION), false);
  assert.equal(h.editor.detail.overlayOptions.explicitSubjectValues, false);
  h.render({ activeAssignmentFile: { ...file(8), custom_appraisal_sections: {} } }); h.flush();
  assert.equal(h.editor.detail.overlayOptions.explicitSubjectValues, false);
});

test('read-only sections cannot open or save, and unknown server-only sections are never editable', async t => {
  const h = harness({ props: { readOnly: true } }); t.after(h.cleanup); h.open();
  assert.equal(h.editor.editingSection, null); await h.editor.saveEditedSection({}); assert.equal(h.calls.length, 0);
  h.render({ readOnly: false }); h.flush(); h.open(RECEIPT); assert.equal(h.editor.editingSection, null);
});
