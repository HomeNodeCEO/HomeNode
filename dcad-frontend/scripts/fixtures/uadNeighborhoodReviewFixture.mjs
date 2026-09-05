import assert from "node:assert/strict";

import { uadNeighborhoodReviewFixture as backendFixture } from "../../../server/test/fixtures/uadNeighborhoodReviewFixture.js";
import {
  buildUadNeighborhoodCandidate,
  prepareUadNeighborhoodApply,
  buildUadNeighborhoodReceipt,
} from "../../../server/src/modules/uad/neighborhoodReview.js";

// Synthetic presentation fixtures only. They exercise real server mapping and
// preflight/receipt contracts; this file performs no persistence or requests.
export function uadNeighborhoodReviewFixture({ zeroSales = false, reuseKeys = [], conflictKeys = [] } = {}) {
  const backend = backendFixture({ zeroSales });
  const initial = prepareUadNeighborhoodApply(backend);
  assert.equal(initial.status, "ready");
  for (const row of backend.existing_values) {
    const suggestion = backend.candidate.suggestions.find(item => item.target_key === row.target_key);
    if (reuseKeys.includes(row.target_key)) Object.assign(row, {
      populated: true, value: suggestion.value,
      provenance_digest: initial.acceptance_manifest.provenance_digest,
    });
    if (conflictKeys.includes(row.target_key)) Object.assign(row, {
      populated: true, value: suggestion.value,
      // Equal value with manual provenance is deliberately a real conflict.
      provenance_digest: "manual-appraiser-value",
    });
  }
  const plan = prepareUadNeighborhoodApply(backend);
  const context = {
    workfileId: backend.target.uad_workfile_id, reportFileId: backend.target.report_file_id,
    revision: backend.target.editor_revision, specificationRelease: backend.target.specification_release,
    sessionKey: "synthetic-editor-session-a", dirty: false, canApply: true,
    status: backend.target.status, signedAt: backend.target.signed_at, hasSignatures: backend.target.has_signatures,
  };
  const preview = {
    preview_version: 1,
    binding_digest_sha256: backend.candidate.attachment.binding_digest_sha256,
    candidate: structuredClone(backend.candidate),
    members: backend.candidate.suggestions.map(item => {
      const conflict = plan.conflicts.find(conflict => conflict.target_key === item.target_key);
      return { id: item.id,
        state: conflict ? "conflict" : reuseKeys.includes(item.target_key) ? "reuse" : "new",
        reason: conflict ? conflict.code : reuseKeys.includes(item.target_key) ? "Accepted source and value retained." : null };
    }),
    blocking_issues: plan.conflicts.filter(conflict => !conflict.target_key).map(conflict => conflict.code),
  };
  return { backend, context, preview, plan };
}

export function prepareSyntheticAcceptance(fixture, command) {
  assert.equal(command.workfileId, fixture.backend.target.uad_workfile_id);
  const plan = prepareUadNeighborhoodApply({ ...fixture.backend, request: command.body });
  assert.equal(plan.status, "ready", JSON.stringify(plan));
  const acceptedRevision = fixture.backend.target.editor_revision + 1;
  const receipt = buildUadNeighborhoodReceipt(fixture.backend.candidate, plan, acceptedRevision);
  return { plan, receipt, result: {
    status: "applied", workfile_id: fixture.backend.target.uad_workfile_id,
    candidate_digest_sha256: fixture.backend.candidate.candidate_digest_sha256,
    application_group_id: fixture.backend.candidate.group.id,
    accepted_revision: acceptedRevision, current_revision: acceptedRevision,
    applied_count: plan.acceptance_manifest.applied.length,
    reused_count: plan.acceptance_manifest.reused.length,
  } };
}

export function acceptedUadNeighborhoodReviewFixture(options) {
  const fixture = uadNeighborhoodReviewFixture(options);
  const { backend } = fixture;
  const { receipt } = prepareSyntheticAcceptance(fixture, { workfileId: fixture.context.workfileId, body: backend.request });
  backend.existing_values = backend.existing_values.map(row => {
    const item = backend.candidate.suggestions.find(item => item.target_key === row.target_key);
    return item ? { ...row, populated: true, value: item.value,
      provenance_digest: fixture.plan.acceptance_manifest.provenance_digest } : row;
  });
  backend.target.editor_revision++;
  backend.target.attachment_revision++;
  backend.accepted_receipt = receipt;
  backend.candidate = buildUadNeighborhoodCandidate(backend);
  backend.request = { ...backend.request, expected_revision: backend.target.editor_revision,
    expected_binding_digest_sha256: backend.candidate.attachment.binding_digest_sha256 };
  fixture.plan = prepareUadNeighborhoodApply(backend);
  assert.equal(fixture.plan.status, "already_applied");
  fixture.context.revision = backend.target.editor_revision;
  fixture.preview = { ...fixture.preview, binding_digest_sha256: backend.candidate.attachment.binding_digest_sha256,
    candidate: structuredClone(backend.candidate),
    members: backend.candidate.suggestions.map(item => ({ id: item.id, state: "reuse", reason: "Previously accepted source and value retained." })) };
  fixture.result = { status: "already_applied", workfile_id: fixture.context.workfileId,
    candidate_digest_sha256: backend.candidate.candidate_digest_sha256, application_group_id: backend.candidate.group.id,
    accepted_revision: receipt.core_receipt.accepted_editor_revision, current_revision: backend.target.editor_revision,
    applied_count: 0, reused_count: backend.candidate.suggestions.length };
  return fixture;
}
