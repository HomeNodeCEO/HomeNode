import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { executeTrustedRepositoryExpression, readTrustedRepositoryTypeScript } from './trustedRepositoryModuleHarness.mjs';
import { assignmentDraftFromDetail, cloneEditorValue } from '../src/lib/propertyReportAssignment.ts';
import { CUSTOM_APPRAISAL_AUTOSAVE_MESSAGES, captureAssignmentSaveSelection, customAppraisalDraftsMatch,
  isVisibleManualAssignmentSave, reconcileCustomAppraisalDraft } from '../src/lib/customAppraisalAutosave.ts';
import { documentApplicationWarnings, mergeDocumentApplication, preserveNewerReportSections } from '../src/lib/propertyReportDocumentApplication.ts';
import { customAssignmentFileMatches } from '../src/lib/customAssignmentNavigation.ts';
import { createAssignmentDraftAcknowledgement } from '../src/lib/assignmentDraftAcknowledgement.ts';

const { ast } = readTrustedRepositoryTypeScript(new URL('../src/pages/PropertyReport.tsx', import.meta.url));
const expressions = new Map();
let draftLayoutEffect;
function visit(node) {
  if (ts.isVariableDeclaration(node)) expressions.set(node.name.getText(ast), node.initializer);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect'
    && node.arguments[0]?.getText(ast).includes('assignmentRenderedDraftRef.current')) draftLayoutEffect = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(draftLayoutEffect, 'execute the actual committed draft/ref synchronization');
for (const name of ['recordLenderRevisionRequest', 'saveAssignmentDetails', 'applyConfirmedDocumentApplication']) {
  assert.ok(expressions.get(name), `execute the actual ${name} handler`);
}
const SUBJECT = 'report.subject_identification', RECEIPT = 'report.subject_evidence';
const saved = (value, revision) => ({ value, revision, last_applied_session_id: null, updated_at: '2026-10-03T03:00:00Z' });
const file = (id = 7) => ({ id, account_id: 'SYNTHETIC', revision: 2, file_number: 'Synthetic',
  assignment_details: { lender_client_name: 'Baseline Bank', lender_revision_count: 1 }, custom_appraisal_sections: {
    [SUBJECT]: saved({ owner: { owner_name: 'Older Owner' } }, 1), [RECEIPT]: saved({ owner_name: 'older receipt' }, 1),
  } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness(saveKind = 'recordLenderRevisionRequest') {
  let active = file(), files = [active, file(8)], message = '', autosave = 'pending';
  const request = deferred(), reload = deferred(), queue = [], calls = [], setters = [];
  const fileRef = { current: active }, generation = { current: 1 };
  const savedDraft = { current: assignmentDraftFromDetail(active.assignment_details) };
  const draft = { current: { ...savedDraft.current, lender_client_name: 'Local Bank' } };
  const dirty = { current: true }, conflictKeys = { current: [] };
  let draftState = draft.current;
  const renderedDraft = { current: draftState }, timers = [], retries = [];
  const environment = {
    accountId: 'SYNTHETIC', activeAssignmentFile: active, assignmentDraft: draft.current,
    assignmentDraftRef: draft, assignmentSavedDraftRef: savedDraft, assignmentDirtyRef: dirty,
    assignmentRenderedDraftRef: renderedDraft,
    activeAssignmentFileRef: fileRef, selectionGenerationRef: generation, assignmentConflictKeysRef: conflictKeys,
    assignmentSaveInFlightRef: { current: null }, assignmentFirstDirtyAtRef: { current: null },
    saveAssignmentDetailsRef: { current: options => { retries.push(options); } },
    cloneEditorValue, assignmentDraftFromDetail, captureAssignmentSaveSelection, preserveNewerReportSections,
    customAssignmentFileMatches, mergeDocumentApplication, documentApplicationWarnings, reconcileCustomAppraisalDraft,
    CUSTOM_APPRAISAL_AUTOSAVE_MESSAGES, customAppraisalDraftsMatch, isVisibleManualAssignmentSave,
    useCallback: callback => callback, assignmentValidationErrors: () => [], editorCredentialForRequest: () => 'test-key',
    editorKeyForSave: () => 'test-key', forgetEditorCredential: () => setters.push('forget credential'),
    setSavingAssignmentFile(value) { setters.push(['saving', value]); },
    setAssignmentAutosaveState(value) { setters.push(['autosave', value]); autosave = value; },
    setAssignmentDirty(value) { setters.push(['dirty', value]); },
    setLastAssignmentSavedAt(value) { setters.push(['saved at', value]); },
    setAssignmentDraft(value) { setters.push(['draft', value]); queue.push(() => { draftState = typeof value === 'function' ? value(draftState) : value; }); },
    setAssignmentSaveMessage(value) { setters.push(['message', value]); message = typeof value === 'function' ? value(message) : value; },
    setAssignmentConflictKeys(value) { setters.push(['conflicts', value]); conflictKeys.current = value; },
    setActiveAssignmentFile(update) { queue.push(() => { active = typeof update === 'function' ? update(active) : update; }); },
    setAssignmentFiles(update) { queue.push(() => { files = typeof update === 'function' ? update(files) : update; }); },
    updateAssignmentFile: async (...args) => { calls.push(args); return request.promise; },
    getAssignmentFiles: async () => reload.promise,
    window: { prompt: () => '  Requested correction  ', setTimeout: callback => timers.push(callback) },
  };
  environment.acknowledgeAssignmentDraft = createAssignmentDraftAcknowledgement(environment);
  const commitDraftLayout = () => executeTrustedRepositoryExpression(draftLayoutEffect, { ...environment, assignmentDraft: draftState })();
  const save = executeTrustedRepositoryExpression(expressions.get(saveKind), environment);
  const applyDocument = executeTrustedRepositoryExpression(expressions.get('applyConfirmedDocumentApplication'), environment);
  return { save, applyDocument, request, reload, calls, setters, generation, fileRef, draft, savedDraft, dirty, conflictKeys, retries,
    get active() { return active; }, get files() { return files; }, get message() { return message; },
    get draftState() { return draftState; }, get autosave() { return autosave; },
    edit(patch, updateRef = true) {
      draftState = { ...draftState, ...patch };
      if (updateRef) commitDraftLayout();
      dirty.current = true;
    },
    acknowledge(next, updateRef = true) { active = next; files = files.map(item => item.id === next.id ? next : item); if (updateRef) fileRef.current = next; },
    commit(check) { queue.splice(0).forEach(apply => { apply(); check?.(); }); commitDraftLayout(); },
    flushTimers() { timers.splice(0).forEach(callback => callback()); },
    resolve() { request.resolve({ assignment_file: { ...file(), revision: 3, assignment_details: calls[0][2].assignment_details } }); },
  };
}

for (const updateRef of [false, true]) {
  for (const timing of ['before response', 'after response']) {
    test(`lender revision retains newer Subject and protected receipt at deferred setter execution (${timing}, ref updated: ${updateRef})`, async () => {
      const h = harness(), untouched = h.files[1], pending = h.save();
      const corrected = { ...file(), custom_appraisal_sections: {
        [SUBJECT]: saved({ owner: { owner_name: '' }, urar_subject: { borrower_name: 'Reviewed Borrower' } }, 2),
        [RECEIPT]: saved({ borrower_name: 'new protected receipt' }, 2),
        'report.land_details': saved({ land_detail: [] }, 4),
      } };
      if (timing === 'before response') h.acknowledge(corrected, updateRef);
      h.resolve(); await pending;
      if (timing === 'after response') h.acknowledge(corrected, updateRef);
      h.commit();
      for (const current of [h.active, h.files[0], h.fileRef.current]) {
        assert.deepEqual(current.custom_appraisal_sections, corrected.custom_appraisal_sections);
        assert.equal(current.assignment_details.lender_client_name, 'Local Bank');
        assert.equal(current.assignment_details.lender_revision_count, 2);
        assert.equal(current.assignment_details.lender_revision_note, 'Requested correction');
        assert.equal(current.revision, 3);
      }
      assert.equal(h.files[1], untouched);
      assert.equal(h.calls[0][1], 7); assert.equal(h.calls[0][2].expected_revision, 2);
      assert.equal(h.draft.current.lender_revision_count, 2); assert.equal(h.dirty.current, false);
      assert.match(h.message, /Recorded lender\/client revision request 2/);
      assert.deepEqual(h.setters.at(-1), ['saving', false]);
    });
  }
}

for (const timing of ['before response', 'after response']) {
  test(`lender revision cannot hydrate an A-to-B-to-A selection change ${timing}`, async () => {
    const h = harness(), pending = h.save(), reselected = { ...file(), revision: 9 };
    const selectAgain = () => { h.generation.current += 2; h.acknowledge(reselected); };
    if (timing === 'before response') selectAgain();
    h.resolve(); await pending;
    if (timing === 'after response') selectAgain();
    h.commit();
    assert.equal(h.active, reselected); assert.equal(h.files[0], reselected); assert.equal(h.fileRef.current, reselected);
    if (timing === 'before response') {
      assert.equal(h.draft.current.lender_revision_count, 1); assert.equal(h.dirty.current, true);
      assert.equal(h.message, ''); assert.deepEqual(h.setters, [['saving', true]]);
    }
  });
}

test('lender revision ignores a departed selection even without a generation change', async () => {
  const h = harness(), pending = h.save(), selected = file(8);
  h.acknowledge(selected); h.resolve(); await pending; h.commit();
  assert.equal(h.active, selected); assert.equal(h.fileRef.current, selected);
  assert.deepEqual(h.setters, [['saving', true]]);
});

test('late lender revision errors cannot reset the new selection or forget its credentials', async () => {
  const h = harness(), pending = h.save();
  h.generation.current += 2; h.acknowledge({ ...file(), revision: 9 });
  h.request.reject(new Error('invalid_editor_key')); await pending; h.commit();
  assert.equal(h.message, ''); assert.deepEqual(h.setters, [['saving', true]]);
});

test('current lender revision failures still expose the conflict and release the saving state', async () => {
  const h = harness(), pending = h.save();
  h.request.reject(new Error('assignment_file_revision_conflict')); await pending; h.commit();
  assert.match(h.message, /changed elsewhere.*Reload/);
  assert.equal(h.active.revision, 2); assert.equal(h.dirty.current, true);
  assert.deepEqual(h.setters.at(-1), ['saving', false]);
});

for (const saveKind of ['recordLenderRevisionRequest', 'saveAssignmentDetails']) {
  for (const timing of ['before response', 'after response']) {
    test(`${saveKind} preserves newer document assignment state, draft and conflicts applied ${timing}`, async () => {
      const h = harness(saveKind), pending = h.save();
      if (timing === 'after response') { h.resolve(); await pending; }
      // This document transaction saw the committed save at revision 3, but its
      // newer acknowledgement can reach the report before that save response.
      const remoteDetails = { ...h.calls[0][2].assignment_details, lender_client_name: 'Document Bank' };
      h.applyDocument({ applied: true, account_id: 'SYNTHETIC', assignment_file_id: 7,
        revision: 4, assignment_details: remoteDetails,
        custom_appraisal_sections: { [SUBJECT]: saved({ urar_subject: { borrower_name: 'Document Borrower' } }, 2) },
      });
      const acknowledged = h.fileRef.current, reconciled = cloneEditorValue(h.draft.current);
      const baseline = cloneEditorValue(h.savedDraft.current), conflicts = [...h.conflictKeys.current];
      const dirty = h.dirty.current, autosave = h.autosave, message = h.message;
      if (timing === 'before response') { h.resolve(); await pending; }
      // Model a newer state already committed before an older queued setter runs.
      h.acknowledge(acknowledged);
      h.commit(() => {
        for (const current of [h.active, h.files[0], h.fileRef.current]) {
          assert.equal(current.revision, 4, 'an older queued setter cannot rewind acknowledged assignment state');
        }
      });
      for (const current of [h.active, h.files[0], h.fileRef.current]) {
        assert.equal(current.revision, 4); assert.deepEqual(current.assignment_details, remoteDetails);
        assert.equal(current.custom_appraisal_sections[SUBJECT].revision, 2);
      }
      assert.deepEqual(h.draft.current, reconciled); assert.deepEqual(h.draftState, reconciled);
      assert.deepEqual(h.savedDraft.current, baseline); assert.deepEqual(h.conflictKeys.current, conflicts);
      assert.equal(h.dirty.current, dirty); assert.equal(h.autosave, autosave); assert.equal(h.message, message);
      if (timing === 'before response') {
        assert.ok(conflicts.includes('lender_client_name')); assert.equal(autosave, 'conflict');
        assert.equal(reconciled.lender_client_name, 'Local Bank'); assert.equal(baseline.lender_client_name, 'Document Bank');
      } else {
        assert.deepEqual(conflicts, []); assert.equal(autosave, 'saved');
        assert.equal(reconciled.lender_client_name, 'Document Bank');
      }
    });
  }
}

test('a delayed conflict reload cannot replace a newer document assignment or its draft reconciliation', async () => {
  const h = harness('saveAssignmentDetails'), pending = h.save();
  h.request.reject(new Error('assignment_file_revision_conflict'));
  await Promise.resolve(); await Promise.resolve();
  const remoteDetails = { ...file().assignment_details, lender_client_name: 'Document Bank' };
  h.applyDocument({ applied: true, account_id: 'SYNTHETIC', assignment_file_id: 7,
    revision: 4, assignment_details: remoteDetails,
    custom_appraisal_sections: { [SUBJECT]: saved({ urar_subject: { borrower_name: 'Document Borrower' } }, 2) },
  });
  const reconciled = cloneEditorValue(h.draft.current), baseline = cloneEditorValue(h.savedDraft.current);
  const conflicts = [...h.conflictKeys.current], message = h.message;
  h.reload.resolve({ account_id: 'SYNTHETIC', files: [{ ...file(), revision: 3, assignment_details: { lender_client_name: 'Older Remote Bank' } }] });
  assert.equal(await pending, false); h.commit();
  for (const current of [h.active, h.files[0], h.fileRef.current]) {
    assert.equal(current.revision, 4); assert.deepEqual(current.assignment_details, remoteDetails);
  }
  assert.deepEqual(h.draft.current, reconciled); assert.deepEqual(h.draftState, reconciled);
  assert.deepEqual(h.savedDraft.current, baseline); assert.deepEqual(h.conflictKeys.current, conflicts);
  assert.ok(conflicts.includes('lender_client_name')); assert.equal(h.autosave, 'conflict');
  assert.equal(h.message, message);
});

for (const timing of ['before response', 'after response']) {
  for (const updateRef of [false, true]) {
    test(`lender acknowledgement retains unsent Prepared For and occupancy edits ${timing} (ref synced: ${updateRef})`, async () => {
      const h = harness(), pending = h.save();
      const patch = { lender_client_name: 'Unsent Prepared For', lender_client_address: '99 Unsent Rd', occupancy: 'tenant' };
      if (timing === 'after response') { h.resolve(); await pending; }
      h.edit(patch, updateRef);
      if (timing === 'before response') { h.resolve(); await pending; }
      h.commit();
      for (const draft of [h.draft.current, h.draftState]) {
        for (const [key, value] of Object.entries(patch)) assert.equal(draft[key], value);
        assert.equal(draft.lender_revision_count, 2); assert.equal(draft.lender_revision_note, 'Requested correction');
      }
      assert.equal(h.savedDraft.current.lender_client_name, 'Local Bank');
      assert.equal(h.savedDraft.current.occupancy, ''); assert.equal(h.savedDraft.current.lender_revision_count, 2);
      assert.equal(h.active.assignment_details.lender_client_name, 'Local Bank');
      assert.equal(h.dirty.current, true); assert.equal(h.autosave, 'pending');
      assert.deepEqual(h.conflictKeys.current, []); assert.match(h.message, /Newer edits remain queued/);
    });
  }
}

test('lender acknowledgement retains unresolved conflicts and edits alongside a section-only document confirmation', async () => {
  const h = harness(), pending = h.save();
  h.edit({ occupancy: 'tenant', lender_client_name: 'Unsent Bank' });
  h.conflictKeys.current = ['occupancy'];
  h.applyDocument({ applied: true, account_id: 'SYNTHETIC', assignment_file_id: 7,
    custom_appraisal_sections: { [SUBJECT]: saved({ urar_subject: { borrower_name: 'Document Borrower' } }, 2) },
  });
  h.resolve(); await pending; h.commit();
  assert.equal(h.active.custom_appraisal_sections[SUBJECT].revision, 2);
  assert.equal(h.active.revision, 3); assert.equal(h.draft.current.occupancy, 'tenant');
  assert.equal(h.draftState.lender_client_name, 'Unsent Bank'); assert.equal(h.dirty.current, true);
  assert.deepEqual(h.conflictKeys.current, ['occupancy']); assert.equal(h.autosave, 'conflict');
  assert.match(h.message, /Resolve the concurrent-edit choice/);
});

test('a conflict reload at the acknowledged document revision retains unresolved document choices', async () => {
  const h = harness('saveAssignmentDetails'), pending = h.save();
  h.request.reject(new Error('assignment_file_revision_conflict'));
  await Promise.resolve(); await Promise.resolve();
  const remoteDetails = { ...file().assignment_details, lender_client_name: 'Document Bank' };
  h.applyDocument({ applied: true, account_id: 'SYNTHETIC', assignment_file_id: 7, revision: 4, assignment_details: remoteDetails });
  h.reload.resolve({ account_id: 'SYNTHETIC', files: [{ ...file(), revision: 4, assignment_details: remoteDetails }] });
  assert.equal(await pending, false); h.commit();
  assert.equal(h.active.revision, 4); assert.equal(h.savedDraft.current.lender_client_name, 'Document Bank');
  assert.equal(h.draft.current.lender_client_name, 'Local Bank'); assert.equal(h.dirty.current, true);
  assert.deepEqual(h.conflictKeys.current, ['lender_client_name']); assert.equal(h.autosave, 'conflict');
  assert.equal(h.message, CUSTOM_APPRAISAL_AUTOSAVE_MESSAGES.conflict);
});

for (const failure of ['save failed', 'conflict reload failed']) {
  test(`${failure} cannot resume autosave over newer unresolved document choices`, async () => {
    const h = harness('saveAssignmentDetails'), pending = h.save();
    h.applyDocument({ applied: true, account_id: 'SYNTHETIC', assignment_file_id: 7,
      revision: 4, assignment_details: { ...file().assignment_details, lender_client_name: 'Document Bank' } });
    if (failure === 'conflict reload failed') {
      h.request.reject(new Error('assignment_file_revision_conflict'));
      await Promise.resolve(); await Promise.resolve();
      h.reload.reject(new Error('Reload unavailable'));
    } else h.request.reject(new Error('Save unavailable'));
    assert.equal(await pending, false); h.commit();
    assert.equal(h.active.revision, 4); assert.equal(h.draft.current.lender_client_name, 'Local Bank');
    assert.equal(h.savedDraft.current.lender_client_name, 'Document Bank'); assert.equal(h.dirty.current, true);
    assert.deepEqual(h.conflictKeys.current, ['lender_client_name']); assert.equal(h.autosave, 'conflict');
    assert.equal(h.message, CUSTOM_APPRAISAL_AUTOSAVE_MESSAGES.conflict);
  });
}

for (const saveKind of ['recordLenderRevisionRequest', 'saveAssignmentDetails']) {
  test(`${saveKind} retains queued local edits through newer document application and a delayed save response`, async () => {
    const h = harness(saveKind), pending = h.save();
    h.edit({ lender_client_name: 'Later Bank', occupancy: 'tenant' }, false);
    const remoteDetails = { ...h.calls[0][2].assignment_details, lender_client_name: 'Document Bank' };
    h.applyDocument({ applied: true, account_id: 'SYNTHETIC', assignment_file_id: 7, revision: 4, assignment_details: remoteDetails });
    h.resolve(); await pending; h.commit();
    assert.equal(h.active.revision, 4); assert.equal(h.fileRef.current.revision, 4);
    for (const current of [h.draft.current, h.draftState]) {
      assert.equal(current.lender_client_name, 'Later Bank'); assert.equal(current.occupancy, 'tenant');
      assert.equal(current.lender_revision_count, remoteDetails.lender_revision_count);
      assert.equal(current.lender_revision_note, remoteDetails.lender_revision_note);
    }
    assert.equal(h.savedDraft.current.lender_client_name, 'Document Bank');
    assert.equal(h.dirty.current, true); assert.equal(h.autosave, 'conflict');
    assert.ok(h.conflictKeys.current.includes('lender_client_name'));
  });
}

test('a retained document callback uses the latest committed draft after a completed lender save', async () => {
  const h = harness(), retainedCallback = h.applyDocument;
  h.edit({ lender_client_name: 'Saved Bank' });
  const pending = h.save(); h.resolve(); await pending; h.commit();
  assert.equal(h.draft.current.lender_client_name, 'Saved Bank'); assert.equal(h.dirty.current, false);
  const remoteDetails = { ...h.calls[0][2].assignment_details, lender_client_name: 'Document Bank' };
  retainedCallback({ applied: true, account_id: 'SYNTHETIC', assignment_file_id: 7, revision: 4, assignment_details: remoteDetails });
  h.commit();
  assert.equal(h.draft.current.lender_client_name, 'Document Bank');
  assert.equal(h.draftState.lender_revision_count, 2); assert.equal(h.draftState.lender_revision_note, 'Requested correction');
  assert.equal(h.dirty.current, false); assert.equal(h.autosave, 'saved'); assert.deepEqual(h.conflictKeys.current, []);
});

test('lender response sees committed edits during layout, before passive draft effects can run', async () => {
  const h = harness(), pending = h.save();
  h.edit({ lender_client_name: 'Committed Bank', occupancy: 'tenant' });
  assert.equal(h.draft.current.lender_client_name, 'Committed Bank');
  h.resolve(); await pending; h.commit();
  assert.equal(h.draft.current.lender_client_name, 'Committed Bank'); assert.equal(h.draftState.occupancy, 'tenant');
  assert.equal(h.dirty.current, true); assert.equal(h.autosave, 'pending');
});

test('conflict reload retains queued edits and blocks its retry when the deferred merge discovers a conflict', async () => {
  const h = harness('saveAssignmentDetails'), pending = h.save();
  h.edit({ occupancy: 'tenant' }, false);
  h.request.reject(new Error('assignment_file_revision_conflict'));
  await Promise.resolve(); await Promise.resolve();
  h.reload.resolve({ account_id: 'SYNTHETIC', files: [{ ...file(), revision: 3,
    assignment_details: { lender_client_name: 'Local Bank', occupancy: 'owner' } }] });
  await pending; h.commit(); h.flushTimers();
  assert.equal(h.draft.current.occupancy, 'tenant'); assert.equal(h.draftState.occupancy, 'tenant');
  assert.equal(h.savedDraft.current.occupancy, 'owner'); assert.equal(h.dirty.current, true);
  assert.deepEqual(h.conflictKeys.current, ['occupancy']); assert.equal(h.autosave, 'conflict');
  assert.deepEqual(h.retries, []);
});
