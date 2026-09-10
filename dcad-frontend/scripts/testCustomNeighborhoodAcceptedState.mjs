import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { customNeighborhoodLegacyAllowed, matchCustomNeighborhoodAcceptedResponse } from '../src/features/neighborhood/customNeighborhoodAcceptedState.ts';

function fixture() {
  const value = { schema_version: 1, operation_id: 'operation-a', attachment_id: 'attachment-a', attachment_revision: 1,
    accepted_editor_revision: 4, mapped_values: { sample: { value: 123 } } };
  return { accountId: 'ACCOUNT_A', assignmentFileId: 7, section: { value, revision: 4 }, response: {
    ok: true, account_id: 'ACCOUNT_A', neighborhood: { status: 'accepted', account_id: 'ACCOUNT_A', assignment_file_id: 7,
      report_file_id: 'report-a', acceptance: { assignmentFileId: 7, reportFileId: 'report-a', organizationId: 'org-a',
        operationId: 'operation-a', attachmentId: 'attachment-a', attachmentRevision: 1, acceptedEditorRevision: 4,
        snapshot: { section_value: structuredClone(value) } }, report_projection: { status: 'ready', operation_id: 'operation-a',
          accepted_editor_revision: 4, assessment: { contract_version: 1, scope: { account_id: 'ACCOUNT_A', organization_id: 'org-a' } } } } } };
}

test('exact workfile section and accepted response display as one group, never legacy', () => {
  const input = fixture(), before = structuredClone(input);
  const result = matchCustomNeighborhoodAcceptedResponse(input);
  assert.equal(result.status, 'accepted'); assert.equal(customNeighborhoodLegacyAllowed(result, 'ACCOUNT_A', 7), false);
  assert.deepEqual(input, before);
});

for (const mutate of [
  input => { input.response.ok = false; },
  input => { input.response.account_id = 'OTHER'; },
  input => { input.response.neighborhood.account_id = 'OTHER'; },
  input => { input.response.neighborhood.assignment_file_id = 8; },
  input => { input.response.neighborhood.acceptance.organizationId = 'other'; },
  input => { input.response.neighborhood.acceptance.reportFileId = 'other'; },
  input => { input.response.neighborhood.acceptance.operationId = 'other'; },
  input => { input.response.neighborhood.acceptance.attachmentId = 'other'; },
  input => { input.response.neighborhood.acceptance.attachmentRevision = 2; },
  input => { input.response.neighborhood.acceptance.acceptedEditorRevision = 5; },
  input => { input.response.neighborhood.acceptance.snapshot.section_value.mapped_values.sample.value = 999; },
  input => { input.response.neighborhood.report_projection.status = 'unavailable'; },
  input => { input.response.neighborhood.report_projection.operation_id = 'other'; },
  input => { input.response.neighborhood.report_projection.accepted_editor_revision = 5; },
  input => { input.response.neighborhood.report_projection.assessment.scope.account_id = 'OTHER'; },
  input => { input.response.neighborhood.report_projection.assessment.contract_version = 2; },
  input => { input.response.neighborhood.status = 'not_accepted'; },
  input => { input.section.revision = 5; },
  input => { input.section.value = null; },
  input => { input.response = null; },
]) {
  test(`mismatched, missing or stale accepted response remains unavailable: ${mutate}`, () => {
    const input = fixture(); mutate(input);
    const result = matchCustomNeighborhoodAcceptedResponse(input);
    assert.equal(result.status, 'unavailable'); assert.equal(result.assessment, null);
    assert.equal(customNeighborhoodLegacyAllowed(result, 'ACCOUNT_A', 7), false);
  });
}

test('key reordering is harmless; missing versus null is not', () => {
  const input = fixture(), stored = input.response.neighborhood.acceptance.snapshot;
  stored.section_value = Object.fromEntries(Object.entries(stored.section_value).reverse());
  assert.equal(matchCustomNeighborhoodAcceptedResponse(input).status, 'accepted');
  stored.section_value.extra = null;
  assert.equal(matchCustomNeighborhoodAcceptedResponse(input).status, 'unavailable');
});

test('legacy processing starts only after matching file load explicitly reports no accepted section', () => {
  for (const status of ['loading', 'accepted', 'unavailable', 'signed']) {
    assert.equal(customNeighborhoodLegacyAllowed({ accountId: 'A', assignmentFileId: 1, status }, 'A', 1), false);
  }
  const legacy = { accountId: 'A', assignmentFileId: 1, status: 'legacy' };
  assert.equal(customNeighborhoodLegacyAllowed(legacy, 'A', 1), true);
  assert.equal(customNeighborhoodLegacyAllowed(legacy, 'A', 2), false);
  assert.equal(customNeighborhoodLegacyAllowed(legacy, 'B', 1), false);
  assert.equal(customNeighborhoodLegacyAllowed(null, 'A', 1), false);
  const input = fixture(); input.section = undefined;
  input.response.neighborhood.status = 'not_accepted'; input.response.neighborhood.acceptance = null;
  assert.equal(matchCustomNeighborhoodAcceptedResponse(input).status, 'legacy');
  input.section = null;
  assert.equal(matchCustomNeighborhoodAcceptedResponse(input).status, 'unavailable');
});

test('integration keeps saved group out of autosave draft and blocks late legacy responses', () => {
  const host = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
  const profile = readFileSync(new URL('../src/hooks/useNeighborhoodProfile.ts', import.meta.url), 'utf8');
  const request = readFileSync(new URL('../src/features/neighborhood/loadCustomNeighborhoodAccepted.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(host, /if \(neighborhoodSection\)/);
  assert.match(host, /void loadCustomNeighborhoodAccepted\(accountId, selectedFile.id, neighborhoodSection\)\.then/);
  assert.doesNotMatch(host, /await loadCustomNeighborhoodAccepted/);
  assert.match(host, /if \(!isCancelled\(\) && acceptedReadGeneration.current === acceptedRead\) setAcceptedNeighborhood\(restored\)/);
  assert.match(host, /enabled: legacyNeighborhoodAllowed/);
  assert.match(host, /<CustomNeighborhoodAcceptedSummary assessment=\{currentAcceptedNeighborhood.assessment\}/);
  assert.doesNotMatch(host, /setAssignmentDraft\([^;]*(?:report_projection|acceptedNeighborhood.assessment)/);
  assert.match(profile, /const isCurrentRequest = \(\) => latestContextRef.current.enabled/);
  assert.match(profile, /if \(!latestContextRef.current.enabled\) return/);
  assert.match(request, /retryTransient: false/);
  assert.match(request, /cache: 'no-store'/);
  assert.doesNotMatch(request, /setInterval|setTimeout|localStorage/);
});
