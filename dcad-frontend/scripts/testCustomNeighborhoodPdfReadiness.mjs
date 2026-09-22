import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { executeTrustedRepositoryExpression, readTrustedRepositoryTypeScript } from './trustedRepositoryModuleHarness.mjs';
import { selectCustomAssignmentFile, CUSTOM_ASSIGNMENT_REQUEST_ERROR } from '../src/lib/customAssignmentNavigation.ts';
import { customNeighborhoodPdfReadinessErrors as readiness,
  customNeighborhoodBrowserPrintReadinessErrors as printReadiness } from '../src/features/neighborhood/customNeighborhoodPdfReadiness.ts';
import { matchCustomNeighborhoodAcceptedResponse as match } from '../src/features/neighborhood/customNeighborhoodAcceptedState.ts';
import { neighborhoodBoundaryReadinessErrors as legacyErrors } from '../src/lib/neighborhoodCharacteristics.ts';
import { buildNeighborhoodAssessment } from '../../server/src/services/neighborhoodAssessment/contract.js';
import { buildNeighborhoodApplicationReceipt } from '../../server/src/services/neighborhoodAssessment/applicationGroup.js';
import { prepareCustomNeighborhoodAcceptanceSnapshot } from '../../server/src/services/neighborhoodAssessment/customAcceptanceSnapshot.js';
import { buildCustomNeighborhoodReportCandidate, prepareCustomNeighborhoodReportApply,
  projectCustomNeighborhoodReportSection } from '../../server/src/services/neighborhoodAssessment/customReportMapping.js';
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from '../../server/test/fixtures/neighborhoodAssessmentFixture.js';
import { reportedObservationReportFixture } from '../../server/test/fixtures/reportedObservationReportFixture.js';

// Both fixtures use the actual five-part catalog, Apply plan, receipt, saved
// snapshot and projector before the browser matcher. No raw JSON blob is treated
// as acceptance authority; these synthetic fixtures grant no source/auth rights.
function v1Fixture() {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const target = neighborhoodTargetFixture('custom_appraisal');
  const candidate = buildCustomNeighborhoodReportCandidate({ assessment, target });
  assert.equal(candidate.status, 'ready');
  const plan = prepareCustomNeighborhoodReportApply({ assessment, target,
    existing_values: candidate.suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    request: { selected_ids: candidate.suggestions.map(item => item.id), binding_digest_sha256: candidate.attachment.binding_digest_sha256 },
    current_application_identity_sha256: candidate.attachment.application_identity_sha256, current_editor_revision: target.editor_revision });
  assert.equal(plan.status, 'ready');
  const operationId = 'abcdef01-0000-4000-8000-000000000001';
  const saved = prepareCustomNeighborhoodAcceptanceSnapshot({ assessment, attachment: candidate.attachment,
    mappedSuggestions: candidate.suggestions, operationId, actorUserId: 'abcdef02-0000-4000-8000-000000000002',
    receipt: buildNeighborhoodApplicationReceipt(plan, target.editor_revision + 1) });
  const section = { value: structuredClone(saved.section_value), revision: saved.section_value.accepted_editor_revision };
  const expected = { organization_id: assessment.scope.organization_id, report_file_id: target.report_file_id,
    assignment_file_id: target.custom_assignment_file_id, account_id: assessment.scope.account_id };
  const projected = projectCustomNeighborhoodReportSection({ section: section.value, expected });
  assert.equal(projected.status, 'ready');
  const response = { ok: true, account_id: expected.account_id, neighborhood: { status: 'accepted',
    account_id: expected.account_id, assignment_file_id: expected.assignment_file_id, report_file_id: expected.report_file_id,
    report_projection: projected, acceptance: { organizationId: expected.organization_id,
      assignmentFileId: expected.assignment_file_id, reportFileId: expected.report_file_id,
      acceptedEditorRevision: section.revision, operationId, attachmentId: section.value.attachment_id,
      attachmentRevision: section.value.attachment_revision, snapshot: saved } } };
  return { assessment, section, response, match: { response, section,
    accountId: expected.account_id, assignmentFileId: expected.assignment_file_id } };
}

const unconfirmed = {
  neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  neighborhood_boundary_north: 'Legacy North', neighborhood_boundary_east: 'Legacy East',
  neighborhood_boundary_south: 'Legacy South', neighborhood_boundary_west: 'Legacy West',
  neighborhood_boundary_confirmed: false,
};
const confirmed = { ...unconfirmed, neighborhood_boundary_confirmed: true };
const fixtures = [[1, v1Fixture], [2, reportedObservationReportFixture]];
const evaluate = (f, state, details = {}) => readiness(state, f.match.accountId, f.match.assignmentFileId, details);
const blocked = result => { assert.ok(result.length > 0); assert.ok(result.every(message => typeof message === 'string' && message.length > 0)); };

for (const [version, fixture] of fixtures) {
  test(`matched v${version} accepted group clears only the obsolete legacy boundary gate without editing details`, () => {
    const f = fixture(), state = match(f.match), before = structuredClone(f);
    assert.equal(state.status, 'accepted'); assert.equal(state.assessment.contract_version, version);
    assert.equal(Object.keys(f.section.value.mapped_values).length, 5);
    for (const details of [undefined, null, {}, unconfirmed, confirmed]) {
      const original = structuredClone(details);
      assert.deepEqual(evaluate(f, state, details), []);
      assert.deepEqual(details, original);
    }
    assert.deepEqual(legacyErrors(unconfirmed), ['Review and confirm the imported neighborhood boundary for this appraisal file.']);
    assert.ok(legacyErrors({}).length > 0); assert.deepEqual(f, before);
  });

  for (const [label, mutate] of [
    ['workfile section revision', x => { x.section.revision++; }],
    ['accepted editor revision', x => { x.response.neighborhood.acceptance.acceptedEditorRevision++; }],
    ['projection revision', x => { x.response.neighborhood.report_projection.accepted_editor_revision++; }],
    ['operation identity', x => { x.response.neighborhood.acceptance.operationId = 'other-operation'; }],
    ['attachment identity', x => { x.response.neighborhood.acceptance.attachmentId = 'other-attachment'; }],
    ['whole-section snapshot', x => { x.response.neighborhood.acceptance.snapshot.section_value.extra = 'stale'; }],
    ['account identity', x => { x.response.neighborhood.account_id = 'OTHER'; }],
    ['file identity', x => { x.response.neighborhood.assignment_file_id++; }],
    ['missing section', x => { x.section = undefined; }],
    ['failed accepted response', x => { x.response.ok = false; }],
  ]) test(`v${version} stale or mismatched ${label} cannot bypass the boundary gate`, () => {
    const input = structuredClone(fixture().match); mutate(input);
    const state = match(input);
    assert.equal(state.status, 'unavailable'); assert.equal(state.assessment, null);
    blocked(readiness(state, input.accountId, input.assignmentFileId, confirmed));
  });
}

test('raw workfile sections, response envelopes and assessments never count as matched accepted state', () => {
  const f = reportedObservationReportFixture();
  for (const raw of [f.section, f.section.value, f.response, f.response.neighborhood, f.assessment, null, undefined]) {
    blocked(evaluate(f, raw, confirmed));
  }
});

for (const status of ['loading', 'unavailable', 'unknown']) test(`${status} state fails closed even with complete legacy fields or a retained assessment`, () => {
  const f = reportedObservationReportFixture(), state = match(f.match);
  blocked(evaluate(f, { ...state, status }, confirmed));
});

for (const [label, mutate] of [
  ['missing assessment', x => { x.assessment = null; }],
  ['empty assessment', x => { x.assessment = {}; }],
  ['wrong assessment account', x => { x.assessment.scope.account_id = 'OTHER'; }],
  ['incomplete geography', x => { x.assessment.geographic_neighborhood.status = 'incomplete'; }],
  ['missing geography', x => { delete x.assessment.geographic_neighborhood; }],
  ['incomplete application group', x => { x.assessment.application_group.status = 'incomplete'; }],
  ['missing application group', x => { delete x.assessment.application_group; }],
  ['unknown contract', x => { x.assessment.contract_version = 3; }],
  ['string contract', x => { x.assessment.contract_version = '2'; }],
]) test(`damaged nominal accepted state with ${label} remains blocked`, () => {
  const f = reportedObservationReportFixture(), state = structuredClone(match(f.match)); mutate(state);
  blocked(evaluate(f, state, confirmed));
});

for (const status of ['accepted', 'legacy', 'signed']) test(`${status} readiness cannot leak across account/file changes or missing targets`, () => {
  const f = reportedObservationReportFixture(), state = { ...match(f.match), status };
  for (const [accountId, fileId] of [[f.match.accountId, f.match.assignmentFileId + 1], ['OTHER', f.match.assignmentFileId],
    [undefined, f.match.assignmentFileId], ['', f.match.assignmentFileId], [f.match.accountId, undefined],
    [f.match.accountId, null], [f.match.accountId, 0], [f.match.accountId, String(f.match.assignmentFileId)]]) {
    blocked(readiness(state, accountId, fileId, confirmed));
  }
});

test('only explicitly matched no-acceptance state uses exactly the unchanged legacy boundary rules', () => {
  const f = reportedObservationReportFixture(), input = structuredClone(f.match);
  input.section = undefined; input.response.neighborhood.status = 'not_accepted'; input.response.neighborhood.acceptance = null;
  const state = match(input); assert.equal(state.status, 'legacy');
  for (const details of [undefined, null, {}, unconfirmed, confirmed,
    { ...confirmed, neighborhood_boundary_north: '', neighborhood_boundary_west: ' ' },
    { ...confirmed, neighborhood_boundary_geometry: null }]) {
    const before = structuredClone(details);
    assert.deepEqual(evaluate(f, state, details), legacyErrors(details));
    assert.deepEqual(details, before);
  }
  blocked(evaluate(f, state)); assert.deepEqual(evaluate(f, state, confirmed), []);
});

test('exact signed workfile state leaves immutable PDF handling to the server', () => {
  const f = reportedObservationReportFixture();
  const state = { accountId: f.match.accountId, assignmentFileId: f.match.assignmentFileId,
    status: 'signed', assessment: null, message: '' };
  assert.deepEqual(evaluate(f, state), []);
});

for (const [version, fixture] of fixtures) test(`v${version} accepted server PDF readiness never enables the legacy HTML browser-print fallback`, () => {
  const f = fixture(), state = match(f.match);
  for (const details of [{}, unconfirmed, confirmed]) {
    assert.deepEqual(evaluate(f, state, details), []);
    const errors = printReadiness(state, f.match.accountId, f.match.assignmentFileId, details);
    blocked(errors); assert.match(errors.join(' '), /Download the PDF.*HTML preview does not contain/);
  }
});

test('legacy browser print keeps its exact prior boundary checks while unresolved accepted reads stay blocked', () => {
  const f = reportedObservationReportFixture(), input = structuredClone(f.match);
  input.section = undefined; input.response.neighborhood.status = 'not_accepted'; input.response.neighborhood.acceptance = null;
  const legacy = match(input); assert.equal(legacy.status, 'legacy');
  for (const details of [{}, unconfirmed, confirmed]) {
    assert.deepEqual(printReadiness(legacy, input.accountId, input.assignmentFileId, details), legacyErrors(details));
  }
  for (const state of [null, { ...legacy, status: 'loading' }, { ...legacy, status: 'unavailable' },
    { ...legacy, assignmentFileId: legacy.assignmentFileId + 1 }]) {
    blocked(printReadiness(state, input.accountId, input.assignmentFileId, confirmed));
  }
});

test('legacy browser print does not silently truncate an entered neighborhood summary', () => {
  const f = reportedObservationReportFixture(), input = structuredClone(f.match);
  input.section = undefined; input.response.neighborhood.status = 'not_accepted'; input.response.neighborhood.acceptance = null;
  const legacy = match(input);
  const details = { ...confirmed, subject_neighborhood_summary: 'Appraiser-reviewed neighborhood text' };
  assert.deepEqual(readiness(legacy, input.accountId, input.assignmentFileId, details), []);
  assert.match(printReadiness(legacy, input.accountId, input.assignmentFileId, details).join(' '), /complete neighborhood summary/);
});

test('signed server PDF remains available but even confirmed legacy fields cannot enable unsigned HTML printing', () => {
  const f = reportedObservationReportFixture(), state = { accountId: f.match.accountId,
    assignmentFileId: f.match.assignmentFileId, status: 'signed', assessment: null, message: '' };
  for (const details of [{}, unconfirmed, confirmed]) {
    assert.deepEqual(evaluate(f, state, details), []);
    const errors = printReadiness(state, f.match.accountId, f.match.assignmentFileId, details);
    blocked(errors); assert.match(errors.join(' '), /immutable signed PDF.*not the signed report/);
  }
});

const { text: pageSource, ast: pageAst } = readTrustedRepositoryTypeScript(
  new URL('../src/pages/AppraisalReport.tsx', import.meta.url));
function expression(predicate, environment) {
  const matches = [];
  function visit(node) { const found = predicate(node); if (found) matches.push(found); ts.forEachChild(node, visit); }
  visit(pageAst); assert.equal(matches.length, 1, 'exactly one actual page expression is required');
  // Execute the actual page expression with controlled dependencies. This is a
  // handler/effect regression harness, not a copied implementation or browser.
  return executeTrustedRepositoryExpression(matches[0], environment);
}
const variable = (name, environment) => expression(node =>
  ts.isVariableDeclaration(node) && node.name.getText(pageAst) === name ? node.initializer : null, environment);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function downloadHarness({ fixture = reportedObservationReportFixture(), state = match(fixture.match),
  details = {}, assignmentLoading = false, missingFile = false, credential = 'synthetic-editor-key', error } = {}) {
  const requests = [], blockers = [], alerts = [], credentials = [], generating = [], downloads = [], revoked = [], forgotten = [];
  const propertyId = fixture.match.accountId;
  const assignmentFile = missingFile ? null : { id: fixture.match.assignmentFileId, assignment_details: details };
  const pdfNeighborhoodErrors = variable('pdfNeighborhoodErrors', { customNeighborhoodPdfReadinessErrors: readiness,
    acceptedNeighborhood: state, propertyId, assignmentFile, neighborhoodDetails: details });
  const blob = { synthetic: 'server PDF bytes' };
  const env = { assignmentLoading, assignmentFile, pdfNeighborhoodErrors, propertyId,
    setPrintBlocker: value => blockers.push(value), setPdfGenerating: value => generating.push(value),
    requestEditorCredential: message => { credentials.push(message); return credential; },
    forgetEditorCredential: () => forgotten.push(true),
    api: { downloadCustomAppraisalReportPdf: async (...args) => {
      requests.push(args); if (error) throw error; return { blob, fileName: 'exact-saved-file.pdf' };
    } },
    URL: { createObjectURL: value => { assert.equal(value, blob); return 'blob:synthetic-pdf'; },
      revokeObjectURL: value => revoked.push(value) },
    document: { createElement: tag => { assert.equal(tag, 'a'); return {
      click() { downloads.push({ href: this.href, fileName: this.download }); }, remove() {},
    }; }, body: { appendChild() {} } },
    window: { alert: message => alerts.push(message), setTimeout: (callback, delay) => { assert.equal(delay, 0); callback(); } },
  };
  return { requests, blockers, alerts, credentials, generating, downloads, revoked, forgotten, pdfNeighborhoodErrors,
    run: () => variable('downloadServerReport', env)() };
}

for (const [version, fixture] of fixtures) test(`actual download handler requests v${version} accepted PDF once for the exact account, file and credential`, async () => {
  const f = fixture(), h = downloadHarness({ fixture: f, details: unconfirmed }); await h.run();
  assert.deepEqual(h.requests, [[f.match.accountId, f.match.assignmentFileId, 'synthetic-editor-key']]);
  assert.equal(h.credentials.length, 1); assert.deepEqual(h.generating, [true, false]);
  assert.deepEqual(h.downloads, [{ href: 'blob:synthetic-pdf', fileName: 'exact-saved-file.pdf' }]);
  assert.deepEqual(h.revoked, ['blob:synthetic-pdf']); assert.deepEqual(h.alerts, []); assert.deepEqual(h.blockers, ['']);
});

for (const kind of ['loading', 'missing', 'mismatch', 'unavailable']) test(`actual download handler refuses ${kind} neighborhood state before credentials or API`, async () => {
  const f = reportedObservationReportFixture(), accepted = match(f.match);
  const state = kind === 'missing' ? null : kind === 'mismatch'
    ? { ...accepted, assignmentFileId: accepted.assignmentFileId + 1 } : { ...accepted, status: kind };
  const h = downloadHarness({ fixture: f, state, details: confirmed }); await h.run();
  assert.deepEqual(h.requests, []); assert.deepEqual(h.credentials, []); assert.deepEqual(h.generating, []);
  assert.deepEqual(h.downloads, []); assert.deepEqual(h.alerts, h.blockers);
  assert.equal(h.blockers[0], `PDF E&O check: ${h.pdfNeighborhoodErrors.join(' ')}`);
});

test('actual download handler preserves exact legacy errors and permits a confirmed legacy boundary', async () => {
  const f = reportedObservationReportFixture(), input = structuredClone(f.match);
  input.section = undefined; input.response.neighborhood.status = 'not_accepted'; input.response.neighborhood.acceptance = null;
  const state = match(input); assert.equal(state.status, 'legacy');
  for (const details of [{}, unconfirmed, confirmed]) {
    const h = downloadHarness({ fixture: f, state, details }); await h.run();
    const errors = legacyErrors(details); assert.deepEqual(h.pdfNeighborhoodErrors, errors);
    assert.equal(h.requests.length, errors.length ? 0 : 1);
    if (errors.length) assert.deepEqual(h.blockers, [`PDF E&O check: ${errors.join(' ')}`]);
  }
});

for (const message of ['synthetic_source_access_denied', '401 invalid_editor_key']) test(`actual server PDF error is surfaced without a synthetic download: ${message}`, async () => {
  const h = downloadHarness({ error: new Error(message) }); await h.run();
  assert.equal(h.requests.length, 1); assert.deepEqual(h.downloads, []); assert.equal(h.blockers.at(-1), message);
  assert.deepEqual(h.generating, [true, false]); assert.equal(h.forgotten.length, message.startsWith('401') ? 1 : 0);
});

test('actual assignment loading, missing-file and cancelled-credential guards remain ahead of the PDF API', async () => {
  for (const [options, expected] of [
    [{ assignmentLoading: true }, 'Assignment-file checks are still loading. Try again in a moment.'],
    [{ missingFile: true }, 'Create or select an appraisal file before generating the report PDF.'],
    [{ credential: '' }, ''],
  ]) {
    const h = downloadHarness(options); await h.run(); assert.deepEqual(h.requests, []);
    assert.deepEqual(h.generating, []); assert.equal(h.blockers.at(-1), expected);
    assert.equal(h.credentials.length, Object.hasOwn(options, 'credential') ? 1 : 0);
  }
});

test('actual page keeps browser-print class/fallback separate from PDF handler and toolbar blockers', () => {
  assert.ok(/appraisal-report-shell \$\{browserPrintErrors\.length \? "report-print-blocked" : ""\}/.test(pageSource), 'browser print owns the blocked class');
  assert.ok(/<div>\{browserPrintErrors\.join\(" "\)\}<\/div>/.test(pageSource), 'browser print owns the printed fallback explanation');
  const toolbarLabel = values => expression(node => ts.isJsxExpression(node)
    && node.expression?.getText(pageAst).startsWith('pdfNeighborhoodErrors.length') ? node.expression : null, values);
  assert.equal(toolbarLabel({ pdfNeighborhoodErrors: [], pdfGenerating: false, assignmentFile: { workfile: { status: 'draft' } } }), 'Download Draft PDF');
  assert.equal(toolbarLabel({ pdfNeighborhoodErrors: [], pdfGenerating: false, assignmentFile: { workfile: { status: 'signed' } } }), 'Download Signed PDF');
  assert.equal(toolbarLabel({ pdfNeighborhoodErrors: ['blocked'], pdfGenerating: false, assignmentFile: { workfile: { status: 'draft' } } }), 'Complete Boundary Review');
  assert.ok(/\(printBlocker \|\| pdfNeighborhoodErrors\.length > 0\)/.test(pageSource), 'toolbar error visibility follows PDF readiness');
  assert.ok(/PDF E&O check: \$\{pdfNeighborhoodErrors\.join\(" "\)\}/.test(pageSource), 'PDF error message reports PDF blockers');
  const f = reportedObservationReportFixture();
  blocked(variable('browserPrintErrors', { customNeighborhoodBrowserPrintReadinessErrors: printReadiness,
    acceptedNeighborhood: match(f.match), propertyId: f.match.accountId,
    assignmentFile: { id: f.match.assignmentFileId }, neighborhoodDetails: confirmed }));
});

for (const status of ['accepted', 'signed']) test(`actual ${status} preview note describes the server-PDF-only limitation rather than a false legacy E&O error`, () => {
  const f = reportedObservationReportFixture(), state = { ...match(f.match), status };
  for (const details of [unconfirmed, confirmed]) {
    const pdfNeighborhoodErrors = evaluate(f, state, details), browserPrintErrors = printReadiness(state,
      f.match.accountId, f.match.assignmentFileId, details);
    const serverPdfOnly = variable('serverPdfOnly', { pdfNeighborhoodErrors, acceptedNeighborhood: state });
    assert.equal(serverPdfOnly, true);
    const note = expression(node => ts.isJsxExpression(node)
      && node.expression?.getText(pageAst).startsWith('serverPdfOnly') ? node.expression : null,
    { serverPdfOnly, browserPrintErrors, neighborhoodBoundaryErrors: legacyErrors(details) });
    assert.equal(note, browserPrintErrors.join(' ')); assert.doesNotMatch(note, /E&O review incomplete|reviewed and confirmed/);
  }
  assert.ok(/<strong>Browser print unavailable\.<\/strong>/.test(pageSource));
  assert.equal(variable('serverPdfOnly', { pdfNeighborhoodErrors: ['unverified'], acceptedNeighborhood: state }), false);
});

function acceptedLoadHarness({ accepted, signed = false, workfile } = {}) {
  const f = reportedObservationReportFixture(), calls = [], states = [], files = [], loading = [];
  const assignment = { id: f.match.assignmentFileId, account_id: f.match.accountId }, generation = { current: 1 };
  const env = { propertyId: f.match.accountId, requestedAssignmentFileId: assignment.id,
    applicationSession: { synthetic: true }, assignmentSelectionGenerationRef: generation,
    selectCustomAssignmentFile, CUSTOM_ASSIGNMENT_REQUEST_ERROR, setPrintBlocker() {},
    loadAssignmentFiles: async accountId => { calls.push(['files', accountId]); return { account_id: accountId, files: [assignment], latest_file: assignment }; },
    loadCustomAppraisalWorkfile: async (...args) => { calls.push(['workfile', ...args]); return workfile ?? {
      account_id: f.match.accountId, workfile: { assignment_file_id: assignment.id, status: signed ? 'signed' : 'draft',
        sections: { neighborhood_assessment: f.section } },
    }; },
    loadCustomNeighborhoodAccepted: async (...args) => { calls.push(['accepted', ...args]); return accepted ? accepted() : match(f.match); },
    setAcceptedNeighborhood: value => states.push(value), setAssignmentFile: value => files.push(value),
    setAssignmentLoading: value => loading.push(value),
    readAppraisalReportDraft: () => null, readMarketConditionsDraft: () => null,
    setDraft() {}, setMarketDraft() {}, setCostDraft() {}, setIncomeDraft() {}, setFinalDraft() {},
  };
  const effect = expression(node => ts.isCallExpression(node) && node.expression.getText(pageAst) === 'useEffect'
    && node.arguments[0]?.getText(pageAst).includes('loadAssignmentFiles(propertyId)') ? node.arguments[0] : null, env);
  const cleanup = effect();
  return { f, calls, states, files, loading, generation, cleanup };
}

test('actual assignment-load effect matches the saved section before admitting accepted PDF readiness', async () => {
  const h = acceptedLoadHarness(); await settle();
  assert.deepEqual(h.calls, [['files', h.f.match.accountId], ['workfile', h.f.match.accountId, h.f.match.assignmentFileId],
    ['accepted', h.f.match.accountId, h.f.match.assignmentFileId, h.f.section]]);
  assert.deepEqual(h.states.map(state => state.status), ['loading', 'accepted']);
  blocked(evaluate(h.f, h.states[0], confirmed)); assert.deepEqual(evaluate(h.f, h.states[1]), []);
  h.cleanup();
});

for (const change of ['selection generation', 'effect cleanup']) test(`actual late accepted load after ${change} cannot enable the previous file`, async () => {
  const wait = deferred(), h = acceptedLoadHarness({ accepted: () => wait.promise }); await settle();
  assert.deepEqual(h.states.map(state => state.status), ['loading']);
  if (change === 'selection generation') h.generation.current++;
  else h.cleanup();
  wait.resolve(match(h.f.match)); await settle();
  assert.deepEqual(h.states.map(state => state.status), ['loading']); h.cleanup();
});

test('actual signed assignment load skips mutable accepted reads; mismatched workfile cannot establish signed state', async () => {
  const signed = acceptedLoadHarness({ signed: true }); await settle();
  assert.deepEqual(signed.states.map(state => state.status), ['signed']);
  assert.equal(signed.calls.some(call => call[0] === 'accepted'), false); signed.cleanup();
  const mismatch = acceptedLoadHarness({ workfile: { account_id: 'OTHER',
    workfile: { assignment_file_id: 999, status: 'signed', sections: {} } } }); await settle();
  assert.deepEqual(mismatch.states, [null]); assert.deepEqual(mismatch.files, [null]);
  assert.equal(mismatch.calls.some(call => call[0] === 'accepted'), false); mismatch.cleanup();
});

test('actual selection layout reset clears accepted state with account/file/session generation changes', () => {
  assert.ok(/useLayoutEffect\(\(\) => \{\s*assignmentSelectionGenerationRef\.current \+= 1;\s*setAssignmentFile\(null\);\s*setAcceptedNeighborhood\(null\);/.test(pageSource));
  assert.ok(/\}, \[applicationSession, propertyId, requestedAssignmentFileId\]\);/.test(pageSource));
});
