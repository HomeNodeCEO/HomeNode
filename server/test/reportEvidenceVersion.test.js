import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReportEvidenceVersion,
  buildVerifiedPhotoVersion,
} from "../src/services/reportEvidenceVersion.js";

const verifiedPhoto = {
  id: "10000000-0000-4000-8000-000000000001",
  position: 1,
  revision: 2,
  status: "verified",
  updated_at: "2026-08-20T12:00:00.000Z",
};

test("evidence token changes only after photo verification", () => {
  const empty = buildReportEvidenceVersion();
  const pending = buildReportEvidenceVersion({
    photoRows: [{ ...verifiedPhoto, revision: 1, status: "pending_upload" }],
  });
  const verified = buildReportEvidenceVersion({ photoRows: [verifiedPhoto] });
  assert.equal(pending.evidence_version, empty.evidence_version);
  assert.notEqual(verified.evidence_version, empty.evidence_version);
  assert.equal(verified.verified_photo_count, 1);
});

test("verified photo token is stable and reacts to revision or removal", () => {
  const initial = buildVerifiedPhotoVersion([verifiedPhoto]);
  assert.equal(buildVerifiedPhotoVersion([verifiedPhoto]), initial);
  assert.notEqual(buildVerifiedPhotoVersion([{ ...verifiedPhoto, revision: 3 }]), initial);
  assert.notEqual(buildVerifiedPhotoVersion([]), initial);
});

test("evidence token reacts to committed sketch revisions without exposing geometry", () => {
  const revisionOne = buildReportEvidenceVersion({
    sketch: { revision: 1, review_status: "draft", updated_at: "2026-08-20T12:00:00.000Z" },
  });
  const revisionTwo = buildReportEvidenceVersion({
    sketch: { revision: 2, review_status: "appraiser_confirmed", updated_at: "2026-08-20T12:01:00.000Z" },
  });
  assert.notEqual(revisionOne.evidence_version, revisionTwo.evidence_version);
  assert.equal(revisionTwo.sketch_revision, 2);
  assert.equal(revisionTwo.sketch_review_status, "appraiser_confirmed");
  assert.deepEqual(Object.keys(revisionTwo).sort(), [
    "evidence_version",
    "photo_version",
    "sketch_review_status",
    "sketch_revision",
    "sketch_updated_at",
    "verified_photo_count",
  ]);
});
