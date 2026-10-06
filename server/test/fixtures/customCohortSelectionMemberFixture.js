import { denseMemberWorkFixture } from './customCohortDenseMemberWorkFixture.js';
import { buildCustomCohortObservationPreview } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPreview, inspectCustomCohortPreviewMembers } from '../../src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';

/** Actual row mapping -> numeric kernel -> public page over synthetic accounts.
 * No SQL/source-grant/production capacity or latency claim is established here. */
export async function selectionMemberFixture({ accountId = 'R-001', assignmentFileId = '9007199254740993',
  contextRef = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) },
  revision = 1, empty = false, accountCount = 3 } = {}) {
  const input = await denseMemberWorkFixture({ accountCount, saleCount: accountCount,
    pockets: accounts => empty ? [] : [{ id: 'discovery:selected', label: 'Selected observations',
      account_ids: accounts.slice(0, accountCount - 1) }] });
  input.context_ref = contextRef; input.selection.revision = revision;
  const preview = buildCustomCohortObservationPreview(input), expected = { context_ref: contextRef, selection_revision: revision };
  const summary = presentCustomCohortPreview({ preview, expected });
  const selection_ref = { selection_version: 1, selection_revision: revision, selection_sha256: summary.binding.selection_sha256,
    manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '750000' } };
  const population = { group: 'selected', kind: 'stock' }, page = { limit: 1, after_member_id: null };
  const request = { assignment_file_id: assignmentFileId, context_ref: contextRef, selection_ref, population, page };
  const resultFor = (p = population, q = page) => ({ status: 'members', authority: 'not_established',
    target: { account_id: accountId, assignment_file_id: assignmentFileId }, context_ref: contextRef, selection_ref,
    selection_revision: revision, subject_freshness: 'matched',
    page: inspectCustomCohortPreviewMembers({ preview, expected, population: p, page: q }),
    apply: { status: 'blocked', reasons: ['observation_preview_only'] } });
  return { request, result: resultFor(), resultFor, summary, accounts: preview.all.account_ids,
    selected: preview.selected.account_ids };
}
