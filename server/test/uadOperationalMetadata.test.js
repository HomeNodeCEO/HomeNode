import assert from "node:assert/strict";
import test from "node:test";

import { listUadAssets } from "../src/modules/uad/assets.js";
import { getLatestUadXmlArtifact } from "../src/modules/uad/uadArtifacts.js";
import { getLatestUadPdfArtifact } from "../src/modules/uad/uadPdfArtifacts.js";
import { getLatestUadSubmissionPackage } from "../src/modules/uad/uadPackageArtifacts.js";
import {
  boundedUadVerificationError,
  publicUadArtifactMetadata,
  publicUadAssetCaptureMetadata,
  uadUploadFailureMetadata,
} from "../src/modules/uad/operationalMetadata.js";

test("UAD upload failure metadata contains only a stable code", () => {
  assert.deepEqual(uadUploadFailureMetadata(), {
    upload_error: "uad_object_upload_failed",
  });
});

test("historical UAD artifact responses redact provider errors and cleanup keys", () => {
  const stored = {
    input_digest_sha256: "a".repeat(64),
    page_count: 9,
    upload_error: "private-url=https://private.example/token-secret",
    cleanup_pending_object_keys: ["private/staging-object"],
  };
  const response = publicUadArtifactMetadata(stored);
  assert.deepEqual(response, {
    input_digest_sha256: "a".repeat(64),
    page_count: 9,
    upload_error: "uad_object_upload_failed",
  });
  assert.equal(stored.upload_error, "private-url=https://private.example/token-secret");
  assert.deepEqual(publicUadArtifactMetadata(null), {});
});

test("UAD asset verification preserves known validation codes and hides provider text", () => {
  const stored = {
    expected_byte_size: 42,
    camera: { id: "camera-1" },
    verification_error: "https://private.example/token-secret",
  };
  assert.deepEqual(publicUadAssetCaptureMetadata(stored), {
    expected_byte_size: 42,
    camera: { id: "camera-1" },
    verification_error: "invalid_uad_uploaded_asset",
  });
  assert.equal(stored.verification_error, "https://private.example/token-secret");
  assert.equal(boundedUadVerificationError(new Error("invalid_uad_asset_byte_size")),
    "invalid_uad_asset_byte_size");
  assert.equal(boundedUadVerificationError({
    get message() { throw new Error("private message getter"); },
  }), "invalid_uad_uploaded_asset");
});

test("UAD artifact and asset readers mask historical operational errors", async () => {
  const workfileId = "20000000-0000-4000-8000-000000000001";
  const privateUrl = "https://private.example/token-secret";
  const metadata = {
    input_digest_sha256: "a".repeat(64),
    upload_error: privateUrl,
    cleanup_pending_object_keys: ["private/staging-object"],
  };
  const artifact = (type) => ({
    id: `artifact-${type}`,
    workfile_id: workfileId,
    revision_number: 1,
    artifact_type: type,
    generation_status: "failed",
    metadata,
  });
  const pool = {
    async query(sql) {
      const statement = String(sql);
      if (statement.includes("FROM appraisal.uad_workfiles")) {
        return { rows: [{ id: workfileId, current_revision: 1, status: "ready" }] };
      }
      if (statement.includes("FROM appraisal.uad_generated_artifacts")) {
        if (statement.includes("artifact_type = 'xml'")) return { rows: [artifact("xml")] };
        if (statement.includes("artifact_type = 'pdf'")) return { rows: [artifact("pdf")] };
        return { rows: [artifact("images_manifest"), artifact("submission_package")] };
      }
      if (statement.includes("FROM appraisal.uad_validation_runs")) return { rows: [] };
      if (statement.includes("FROM appraisal.uad_assets")) {
        return { rows: [{ id: "asset-1", status: "rejected", capture_metadata: {
          expected_byte_size: 42,
          verification_error: privateUrl,
        } }] };
      }
      throw new Error(`unexpected UAD reader query: ${statement}`);
    },
  };
  const [xml, pdf, submission, assets] = await Promise.all([
    getLatestUadXmlArtifact(pool, null, workfileId),
    getLatestUadPdfArtifact(pool, null, workfileId),
    getLatestUadSubmissionPackage(pool, null, workfileId),
    listUadAssets(pool, workfileId),
  ]);
  for (const item of [xml.artifact, pdf.artifact, submission.manifest, submission.package]) {
    assert.equal(item.metadata.upload_error, "uad_object_upload_failed");
    assert.equal(item.metadata.input_digest_sha256, "a".repeat(64));
    assert.equal("cleanup_pending_object_keys" in item.metadata, false);
  }
  assert.equal(assets[0].capture_metadata.verification_error, "invalid_uad_uploaded_asset");
  assert.equal(JSON.stringify({ xml, pdf, submission, assets }).includes(privateUrl), false);
  assert.equal(metadata.upload_error, privateUrl, "read redaction must not rewrite stored rows");
});
