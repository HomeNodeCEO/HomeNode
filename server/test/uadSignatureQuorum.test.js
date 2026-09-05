import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateUadSignatureQuorum } from "../src/modules/uad/signatureQuorum.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const APPRAISER_ID = "10000000-0000-4000-8000-000000000001";
const SUPERVISOR_ID = "10000000-0000-4000-8000-000000000002";
const DIGEST = "a".repeat(64);

function signature(signerRole, signerUserId, overrides = {}) {
  return {
    revision_number: 7,
    signer_role: signerRole,
    signer_user_id: signerUserId,
    workfile_input_digest_sha256: DIGEST,
    ...overrides,
  };
}

const supervisedWorkfile = {
  assigned_appraiser_user_id: APPRAISER_ID,
  supervisory_appraiser_user_id: SUPERVISOR_ID,
};

const options = { revisionNumber: 7, inputDigest: DIGEST };

test("duplicate appraiser signatures cannot satisfy a supervised UAD quorum", () => {
  const quorum = evaluateUadSignatureQuorum(supervisedWorkfile, [
    signature("appraiser", APPRAISER_ID),
    signature("appraiser", APPRAISER_ID),
  ], options);
  assert.equal(quorum.complete, false);
  assert.equal(quorum.appraiser_signed, true);
  assert.equal(quorum.supervisory_appraiser_signed, false);
  assert.deepEqual(quorum.missing_roles, ["supervisory_appraiser"]);
});

test("signatures count only for their exact assigned identities and current snapshot", () => {
  const wrongSupervisor = evaluateUadSignatureQuorum(supervisedWorkfile, [
    signature("appraiser", APPRAISER_ID),
    signature("supervisory_appraiser", "10000000-0000-4000-8000-000000000099"),
  ], options);
  assert.equal(wrongSupervisor.complete, false);

  const staleSupervisor = evaluateUadSignatureQuorum(supervisedWorkfile, [
    signature("appraiser", APPRAISER_ID),
    signature("supervisory_appraiser", SUPERVISOR_ID, { revision_number: 6 }),
    signature("supervisory_appraiser", SUPERVISOR_ID, {
      workfile_input_digest_sha256: "b".repeat(64),
    }),
  ], options);
  assert.equal(staleSupervisor.complete, false);
});

test("the exact appraiser and supervisor satisfy a supervised UAD quorum", () => {
  const quorum = evaluateUadSignatureQuorum(supervisedWorkfile, [
    signature("appraiser", APPRAISER_ID),
    signature("supervisory_appraiser", SUPERVISOR_ID),
  ], options);
  assert.equal(quorum.complete, true);
  assert.deepEqual(quorum.missing_roles, []);
});

test("an unsupervised assignment requires only its exact assigned appraiser", () => {
  const quorum = evaluateUadSignatureQuorum({
    assigned_appraiser_user_id: APPRAISER_ID,
    supervisory_appraiser_user_id: null,
  }, [signature("appraiser", APPRAISER_ID)], options);
  assert.equal(quorum.complete, true);
  assert.equal(quorum.supervisory_appraiser_required, false);
});

test("signing and package creation share identity-bound quorum enforcement", () => {
  const certifications = fs.readFileSync(
    path.resolve(directory, "../src/modules/uad/certifications.js"),
    "utf8",
  );
  const packages = fs.readFileSync(
    path.resolve(directory, "../src/modules/uad/uadPackageArtifacts.js"),
    "utf8",
  );
  assert.doesNotMatch(certifications, /count\(\*\)::integer AS count[\s\S]{0,400}uad_signatures/);
  assert.match(certifications, /uad_signature_existing_snapshot_mismatch/);
  assert.match(certifications, /idempotent: replay/);
  assert.match(certifications, /evaluateUadSignatureQuorum/);
  assert.match(packages, /assigned_appraiser_user_id, supervisory_appraiser_user_id/);
  assert.match(packages, /uad_package_supervisory_signature_missing/);
  assert.match(packages, /evaluateUadSignatureQuorum/);
});
