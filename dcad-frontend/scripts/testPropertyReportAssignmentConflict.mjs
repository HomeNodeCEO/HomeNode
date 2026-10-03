import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { executeTrustedRepositoryExpression, readTrustedRepositoryTypeScript } from './trustedRepositoryModuleHarness.mjs';
import { assignmentDraftFromDetail, cloneEditorValue } from '../src/lib/propertyReportAssignment.ts';
import { CUSTOM_APPRAISAL_AUTOSAVE_MESSAGES, captureAssignmentSaveSelection, customAppraisalDraftsMatch,
  isVisibleManualAssignmentSave, reconcileCustomAppraisalDraft } from '../src/lib/customAppraisalAutosave.ts';
import { preserveNewerReportSections } from '../src/lib/propertyReportDocumentApplication.ts';
import { customAssignmentFileMatches } from '../src/lib/customAssignmentNavigation.ts';

const { ast } = readTrustedRepositoryTypeScript(new URL('../src/pages/PropertyReport.tsx', import.meta.url));
let saveExpression;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'saveAssignmentDetails') saveExpression = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(saveExpression, 'execute the actual parent save handler');
const SUBJECT = 'report.subject_identification', RECEIPT = 'report.subject_evidence';
const saved = (value, revision) => ({ value, revision, last_applied_session_id: null, updated_at: '2026-10-03T03:00:00Z' });
const file = (id = 7, account = 'SYNTHETIC') => ({ id, account_id: account, revision: 2, file_number: 'Synthetic',
  assignment_details: { lender_client_name: 'Baseline Bank' }, custom_appraisal_sections: {
    [SUBJECT]: saved({ owner: { owner_name: 'Older Owner' } }, 1), [RECEIPT]: saved({ owner_name: 'older receipt' }, 1),
  } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function harness() {
  let active = file(), files = [active, file(8)], conflictKeys = [], message = '';
  const reload = deferred(), queue = [], calls = [];
  const fileRef = { current: active }, generation = { current: 1 };
  const savedDraft = { current: assignmentDraftFromDetail(active.assignment_details) };
  const draft = { current: { ...savedDraft.current, lender_client_name: 'Local Bank' } };
  const environment = {
    accountId: 'SYNTHETIC', assignmentSaveInFlightRef: { current: null }, assignmentDraftRef: draft,
    assignmentSavedDraftRef: savedDraft, activeAssignmentFileRef: fileRef, selectionGenerationRef: generation,
    assignmentDirtyRef: { current: true }, assignmentFirstDirtyAtRef: { current: null },
    saveAssignmentDetailsRef: { current: () => assert.fail('conflicting lender edits must not auto-retry') },
    cloneEditorValue, assignmentDraftFromDetail, captureAssignmentSaveSelection, customAppraisalDraftsMatch,
    isVisibleManualAssignmentSave, reconcileCustomAppraisalDraft, preserveNewerReportSections,
    customAssignmentFileMatches, CUSTOM_APPRAISAL_AUTOSAVE_MESSAGES,
    assignmentValidationErrors: () => [], editorKeyForSave: () => 'test-key', editorCredentialForRequest: () => 'test-key',
    forgetEditorCredential: () => assert.fail('no auth failure'), setSavingAssignmentFile() {}, setAssignmentAutosaveState() {},
    setAssignmentDirty() {}, setLastAssignmentSavedAt() {}, setAssignmentDraft(value) { draft.current = value; },
    setAssignmentSaveMessage(value) { message = value; }, setAssignmentConflictKeys(value) { conflictKeys = value; },
    setActiveAssignmentFile(update) { queue.push(() => { active = typeof update === 'function' ? update(active) : update; }); },
    setAssignmentFiles(update) { queue.push(() => { files = typeof update === 'function' ? update(files) : update; }); },
    updateAssignmentFile: async () => { calls.push('save'); throw new Error('assignment_file_revision_conflict'); },
    getAssignmentFiles: async () => { calls.push('reload'); return reload.promise; },
    window: { setTimeout: () => assert.fail('conflicting edits must remain under review') },
  };
  const save = executeTrustedRepositoryExpression(saveExpression, environment);
  return { save, reload, calls, generation, fileRef, draft,
    get active() { return active; }, get files() { return files; }, get conflictKeys() { return conflictKeys; }, get message() { return message; },
    acknowledge(next, updateRef = true) { active = next; files = files.map(item => item.id === next.id ? next : item); if (updateRef) fileRef.current = next; },
    commit() { queue.splice(0).forEach(apply => apply()); },
  };
}

for (const updateRef of [false, true]) {
  for (const timing of ['before response', 'after response']) {
  test(`parent conflict reload retains newer acknowledged Subject and protected receipt at deferred setter execution (${timing}, ref updated: ${updateRef})`, async () => {
    const h = harness(), remote = { ...file(), revision: 3, assignment_details: { lender_client_name: 'Remote Bank' } };
    const pending = h.save({ requireCompletion: false });
    await Promise.resolve(); await Promise.resolve(); assert.deepEqual(h.calls, ['save', 'reload']);
    const corrected = { ...file(), custom_appraisal_sections: {
      [SUBJECT]: saved({ owner: { owner_name: '' }, urar_subject: { borrower_name: 'Reviewed Borrower' } }, 2),
      [RECEIPT]: saved({ borrower_name: 'new protected receipt' }, 2),
      'report.land_details': saved({ land_detail: [] }, 4),
    } };
    if (timing === 'before response') h.acknowledge(corrected, updateRef);
    h.reload.resolve({ account_id: 'SYNTHETIC', files: [remote, file(8)] });
    assert.equal(await pending, false);
    if (timing === 'after response') h.acknowledge(corrected, updateRef);
    h.commit();
    for (const current of [h.active, h.files[0], h.fileRef.current]) {
      assert.deepEqual(current.custom_appraisal_sections, corrected.custom_appraisal_sections);
      assert.equal(current.assignment_details.lender_client_name, 'Remote Bank');
      assert.equal(current.revision, 3);
    }
    assert.equal(h.files[1].id, 8); assert.equal(h.files[1].custom_appraisal_sections[SUBJECT].revision, 1);
    assert.equal(h.draft.current.lender_client_name, 'Local Bank');
    assert.ok(h.conflictKeys.includes('lender_client_name'));
  });
  }
}

test('parent conflict queued setters cannot hydrate a later A-to-B-to-A selection', async () => {
  const h = harness(), pending = h.save({ requireCompletion: false });
  h.reload.resolve({ account_id: 'SYNTHETIC', files: [{ ...file(), revision: 3, assignment_details: { lender_client_name: 'Remote Bank' } }] });
  await pending;
  const reselected = { ...file(), revision: 9 };
  h.generation.current += 2; h.acknowledge(reselected); h.commit();
  assert.equal(h.active, reselected); assert.equal(h.files[0], reselected); assert.equal(h.fileRef.current, reselected);
});

for (const invalid of ['envelope account', 'file account', 'file ID']) {
  test(`parent conflict reload rejects ${invalid} mismatch`, async () => {
    const h = harness(), original = h.active, pending = h.save({ requireCompletion: false });
    const remote = { ...file(invalid === 'file ID' ? 9 : 7, invalid === 'file account' ? 'OTHER' : 'SYNTHETIC'), revision: 3 };
    h.reload.resolve({ account_id: invalid === 'envelope account' ? 'OTHER' : 'SYNTHETIC', files: [remote] });
    assert.equal(await pending, false); h.commit();
    assert.equal(h.active, original); assert.equal(h.fileRef.current, original);
  });
}
