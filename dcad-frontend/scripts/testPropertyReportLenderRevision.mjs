import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { executeTrustedRepositoryExpression, readTrustedRepositoryTypeScript } from './trustedRepositoryModuleHarness.mjs';
import { assignmentDraftFromDetail, cloneEditorValue } from '../src/lib/propertyReportAssignment.ts';
import { captureAssignmentSaveSelection } from '../src/lib/customAppraisalAutosave.ts';
import { preserveNewerReportSections } from '../src/lib/propertyReportDocumentApplication.ts';

const { ast } = readTrustedRepositoryTypeScript(new URL('../src/pages/PropertyReport.tsx', import.meta.url));
let saveExpression;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'recordLenderRevisionRequest') saveExpression = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(saveExpression, 'execute the actual lender revision handler');
const SUBJECT = 'report.subject_identification', RECEIPT = 'report.subject_evidence';
const saved = (value, revision) => ({ value, revision, last_applied_session_id: null, updated_at: '2026-10-03T03:00:00Z' });
const file = (id = 7) => ({ id, account_id: 'SYNTHETIC', revision: 2, file_number: 'Synthetic',
  assignment_details: { lender_client_name: 'Baseline Bank', lender_revision_count: 1 }, custom_appraisal_sections: {
    [SUBJECT]: saved({ owner: { owner_name: 'Older Owner' } }, 1), [RECEIPT]: saved({ owner_name: 'older receipt' }, 1),
  } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness() {
  let active = file(), files = [active, file(8)], message = '';
  const request = deferred(), queue = [], calls = [], setters = [];
  const fileRef = { current: active }, generation = { current: 1 };
  const savedDraft = { current: assignmentDraftFromDetail(active.assignment_details) };
  const draft = { current: { ...savedDraft.current, lender_client_name: 'Local Bank' } };
  const dirty = { current: true };
  const environment = {
    accountId: 'SYNTHETIC', activeAssignmentFile: active, assignmentDraft: draft.current,
    assignmentDraftRef: draft, assignmentSavedDraftRef: savedDraft, assignmentDirtyRef: dirty,
    activeAssignmentFileRef: fileRef, selectionGenerationRef: generation,
    cloneEditorValue, assignmentDraftFromDetail, captureAssignmentSaveSelection, preserveNewerReportSections,
    editorKeyForSave: () => 'test-key', forgetEditorCredential: () => setters.push('forget credential'),
    setSavingAssignmentFile(value) { setters.push(['saving', value]); },
    setAssignmentAutosaveState(value) { setters.push(['autosave', value]); },
    setAssignmentDirty(value) { setters.push(['dirty', value]); },
    setLastAssignmentSavedAt(value) { setters.push(['saved at', value]); },
    setAssignmentDraft(value) { setters.push(['draft', value]); draft.current = value; },
    setAssignmentSaveMessage(value) { setters.push(['message', value]); message = value; },
    setAssignmentConflictKeys(value) { setters.push(['conflicts', value]); },
    setActiveAssignmentFile(update) { queue.push(() => { active = typeof update === 'function' ? update(active) : update; }); },
    setAssignmentFiles(update) { queue.push(() => { files = typeof update === 'function' ? update(files) : update; }); },
    updateAssignmentFile: async (...args) => { calls.push(args); return request.promise; },
    window: { prompt: () => '  Requested correction  ' },
  };
  const save = executeTrustedRepositoryExpression(saveExpression, environment);
  return { save, request, calls, setters, generation, fileRef, draft, savedDraft, dirty,
    get active() { return active; }, get files() { return files; }, get message() { return message; },
    acknowledge(next, updateRef = true) { active = next; files = files.map(item => item.id === next.id ? next : item); if (updateRef) fileRef.current = next; },
    commit() { queue.splice(0).forEach(apply => apply()); },
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
