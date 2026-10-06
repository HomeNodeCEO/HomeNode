import { denseMemberWorkFixture } from './customCohortDenseMemberWorkFixture.js';
import { buildCustomCohortObservationPreview } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPreview } from '../../src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';

// Real mapping/chunk/numeric/public projection over three synthetic properties.
// This proves transport binding, not SQL, source licensing or report readiness.
export async function selectionSummaryTransportFixture({ accountId = 'R-001', assignmentFileId = '9007199254740993',
  contextRef = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) },
  revision = 1, empty = false } = {}) {
  const input = await denseMemberWorkFixture({ accountCount: 3, saleCount: 3, pockets: accounts => empty ? []
    : [{ id: 'discovery:selected', label: 'Selected observations', account_ids: accounts.slice(0, 2) }] });
  input.context_ref = contextRef; input.selection.revision = revision;
  const preview = buildCustomCohortObservationPreview(input);
  const summary = presentCustomCohortPreview({ preview, expected: { context_ref: contextRef, selection_revision: revision } });
  const selection_ref = { selection_version: 1, selection_revision: revision, selection_sha256: summary.binding.selection_sha256,
    manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '750000' } };
  return { request: { assignment_file_id: assignmentFileId, context_ref: contextRef, selection_ref },
    result: { status: 'preview', authority: 'not_established', target: { account_id: accountId, assignment_file_id: assignmentFileId },
      context_ref: contextRef, selection_ref, selection_revision: revision, subject_freshness: 'matched', summary,
      parcel_map: { status: 'omitted', reason: 'geometry_not_requested' },
      apply: { status: 'blocked', reasons: ['observation_preview_only'] } } };
}
