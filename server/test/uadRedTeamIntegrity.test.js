import assert from "node:assert/strict";
import test from "node:test";

import { runUadRedTeamIntegrityChecks } from "../src/modules/uad/uadRedTeamIntegrity.js";

const ACCOUNT = "UAD-REDTEAM-SFR-0001";
const WORKFILE_A = "11111111-1111-4111-8111-111111111111";
const WORKFILE_B = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_A = "10000000-0000-4000-8000-000000000001";
const ORGANIZATION_B = "20000000-0000-4000-8000-000000000001";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function integrityFetch({
  allowLostUpdate = false,
  failInitialEditor = false,
  staleProbe = false,
  unsafeObjectKey = false,
} = {}) {
  const state = {
    revision: 5,
    commentary: null,
    editorReads: 0,
    validSectionWrites: 0,
    nextAsset: 1,
    assets: new Map(),
  };
  if (staleProbe) {
    state.assets.set("30000000-0000-4000-8000-000000000099", {
      id: "30000000-0000-4000-8000-000000000099",
      expectedSize: 1,
      contentType: "image/png",
      objectKey: `organizations/${ORGANIZATION_A}/uad/${WORKFILE_A}/assets/stale/probe.png`,
      originalFileName: "size-mismatch.png",
      captureMetadata: { synthetic: true, purpose: "redteam_storage_boundary" },
      status: "pending_upload",
      bytes: null,
    });
  }

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".r2.cloudflarestorage.com")) {
      const asset = state.assets.get(parsed.searchParams.get("asset"));
      if (!asset) return new Response("missing", { status: 404 });
      const contentType = new Headers(init.headers).get("content-type");
      if (contentType !== asset.contentType) return new Response("signature mismatch", { status: 403 });
      asset.bytes = Buffer.from(init.body || []);
      asset.storedType = contentType;
      return new Response(null, { status: 200 });
    }

    const path = parsed.pathname;
    const persona = new Headers(init.headers).get("authorization")?.replace(/^Bearer redteam-token-/, "");
    if (path === `/api/uad/accounts/${ACCOUNT}/workfiles`) {
      return json({ workfiles: [
        {
          id: WORKFILE_A,
          organization_id: ORGANIZATION_A,
          file_number: "HN-REDTEAM-ORG-A-0001",
          current_revision: state.revision,
        },
        {
          id: WORKFILE_B,
          organization_id: ORGANIZATION_B,
          file_number: "HN-REDTEAM-ORG-B-0001",
          current_revision: 1,
        },
      ] });
    }
    if (path === `/api/uad/workfiles/${WORKFILE_A}/editor`) {
      state.editorReads += 1;
      if (failInitialEditor && state.editorReads === 1) {
        return json({ error: "uad_request_failed" }, 503);
      }
      return json({
        workfile: { id: WORKFILE_A, current_revision: state.revision },
        values: state.commentary == null ? [] : [{
          entity_id: null,
          context_key: "assignment_commentary",
          uid: "0100.0044",
          value: state.commentary,
        }],
      });
    }
    if (path === `/api/uad/workfiles/${WORKFILE_A}/sections/assignment` && init.method === "PATCH") {
      const rawBody = String(init.body || "");
      if (Buffer.byteLength(rawBody) > 1024 * 1024) {
        return json({ error: "request_body_too_large" }, 413);
      }
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return json({ error: "invalid_json_body" }, 400);
      }
      if (!Array.isArray(body.values)) return json({ error: "invalid_uad_field_values" }, 400);
      state.validSectionWrites += 1;
      if (!allowLostUpdate && body.expected_revision !== state.revision) {
        return json({ error: "uad_section_stale_revision", details: { current_revision: state.revision } }, 409);
      }
      state.revision += 1;
      state.commentary = body.values[0]?.value ?? null;
      return json({ current_revision: state.revision, saved_field_count: 1 });
    }

    const artifactMatch = path.match(/\/api\/uad\/workfiles\/([^/]+)\/artifacts\/(xml|pdf|submission-package)$/);
    if (artifactMatch) {
      const [, workfileId, artifactType] = artifactMatch;
      if (workfileId === WORKFILE_B && persona === "assigned_appraiser_a") {
        return json({ error: "uad_workfile_access_denied" }, 403);
      }
      if (init.method === "POST") {
        const code = artifactType === "xml"
          ? "uad_xml_local_validation_required"
          : artifactType === "pdf"
            ? "uad_pdf_local_validation_required"
            : "uad_package_signature_required";
        return json({ error: code }, 409);
      }
      if (artifactType === "xml") return json({ artifact: null, schema_validation: null });
      if (artifactType === "pdf") return json({ artifact: null });
      return json({ manifest: null, package: null });
    }

    if (path.endsWith("/assets/upload-url") && init.method === "POST") {
      if (path.includes(WORKFILE_B) && persona === "assigned_appraiser_a") {
        return json({ error: "uad_workfile_access_denied" }, 403);
      }
      const body = JSON.parse(String(init.body || "{}"));
      if (body.content_type !== "image/png") return json({ error: "invalid_uad_asset_content_type" }, 400);
      if (!Number.isInteger(body.byte_size) || body.byte_size <= 0 || body.byte_size > 50 * 1024 * 1024) {
        return json({ error: "invalid_uad_asset_byte_size" }, 400);
      }
      const suffix = String(state.nextAsset++).padStart(12, "0");
      const id = `30000000-0000-4000-8000-${suffix}`;
      const objectKey = unsafeObjectKey
        ? `../../outside/${id}`
        : `organizations/${ORGANIZATION_A}/uad/${WORKFILE_A}/assets/${id}/probe.png`;
      const asset = {
        id,
        expectedSize: body.byte_size,
        contentType: body.content_type,
        objectKey,
        originalFileName: body.file_name,
        captureMetadata: body.capture_metadata,
        status: "pending_upload",
        bytes: null,
      };
      state.assets.set(id, asset);
      return json({
        asset_id: id,
        object_key: objectKey,
        upload: {
          method: "PUT",
          url: `https://redteam-account.r2.cloudflarestorage.com/redteam-bucket/probe?asset=${id}`,
          headers: { "content-type": "image/png" },
          expires_in_seconds: 900,
        },
      }, 201);
    }

    if (path === `/api/uad/workfiles/${WORKFILE_A}/assets` && init.method !== "DELETE") {
      if (persona === "appraiser_b") return json({ error: "uad_workfile_access_denied" }, 403);
      return json({ assets: [...state.assets.values()].map((asset) => ({
        id: asset.id,
        original_file_name: asset.originalFileName,
        capture_metadata: asset.captureMetadata,
        status: asset.status,
        byte_size: asset.bytes?.length ?? null,
      })) });
    }

    const verifyMatch = path.match(new RegExp(`/api/uad/workfiles/${WORKFILE_A}/assets/([^/]+)/verify$`));
    if (verifyMatch && init.method === "POST") {
      const asset = state.assets.get(verifyMatch[1]);
      if (!asset) return json({ error: "uad_asset_not_found" }, 404);
      const validPng = asset.bytes?.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (!asset.bytes || asset.bytes.length !== asset.expectedSize || asset.storedType !== asset.contentType || !validPng) {
        asset.status = "rejected";
        return json({ error: "invalid_uad_uploaded_asset" }, 400);
      }
      asset.status = "verified";
      return json({ asset: { id: asset.id, status: asset.status, byte_size: asset.bytes.length } });
    }

    const deleteMatch = path.match(new RegExp(`/api/uad/workfiles/${WORKFILE_A}/assets/([^/]+)$`));
    if (deleteMatch && init.method === "DELETE") {
      if (!state.assets.has(deleteMatch[1])) return json({ error: "uad_asset_not_found" }, 404);
      state.assets.delete(deleteMatch[1]);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected_request:${init.method || "GET"}:${path}`);
  };
  return { fetchImpl, state };
}

const getAccessToken = async (persona) => `redteam-token-${persona}`;

test("integrity runner proves revision, parser, tenant, upload, and cleanup controls", async () => {
  const { fetchImpl, state } = integrityFetch();
  const result = await runUadRedTeamIntegrityChecks({
    fetchImpl,
    getAccessToken,
    checkedAt: "2026-08-21T22:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.optimistic_concurrency.success_count, 1);
  assert.equal(result.checks.optimistic_concurrency.stale_conflict_count, 1);
  assert.equal(result.checks.optimistic_concurrency.restored, true);
  assert.equal(result.checks.json_parser.oversized.http_status, 413);
  assert.equal(result.checks.storage_scope_and_signature.wrong_content_type_http_status, 403);
  assert.equal(result.checks.artifact_access_and_state.ready, true);
  assert.deepEqual(result.checks.artifact_access_and_state.cross_tenant_http_statuses, [403, 403, 403]);
  assert.deepEqual(result.checks.artifact_access_and_state.blocked_generation_http_statuses, [409, 409, 409]);
  assert.equal(result.checks.storage_verification.verification_error_code, "invalid_uad_uploaded_asset");
  assert.equal(result.checks.storage_content_validation.verification_error_code, "invalid_uad_uploaded_asset");
  assert.equal(result.checks.cleanup.remaining_asset_count, 0);
  assert.equal(state.assets.size, 0);
  assert.equal(state.commentary, null);
  assert.doesNotMatch(
    JSON.stringify(result),
    /redteam-token-|X-Amz-|\"object_key\"\s*:|\"asset_id\"\s*:|BEGIN .*PRIVATE KEY|Bearer\s/i,
  );
});

test("integrity runner detects a lost-update race and still restores the fixture", async () => {
  const { fetchImpl, state } = integrityFetch({ allowLostUpdate: true });
  const result = await runUadRedTeamIntegrityChecks({ fetchImpl, getAccessToken });
  assert.equal(result.ok, false);
  assert.equal(result.checks.optimistic_concurrency.ready, false);
  assert.equal(result.checks.optimistic_concurrency.success_count, 2);
  assert.equal(result.checks.optimistic_concurrency.restored, true);
  assert.equal(state.commentary, null);
  assert.equal(state.assets.size, 0);
});

test("integrity runner detects an object key escaping its organization prefix", async () => {
  const { fetchImpl, state } = integrityFetch({ unsafeObjectKey: true });
  const result = await runUadRedTeamIntegrityChecks({ fetchImpl, getAccessToken });
  assert.equal(result.ok, false);
  assert.equal(result.checks.storage_scope_and_signature.object_key_scoped, false);
  assert.equal(result.checks.cleanup.ready, true);
  assert.equal(state.assets.size, 0);
});

test("integrity runner does not mutate a fixture it could not snapshot", async () => {
  const { fetchImpl, state } = integrityFetch({ failInitialEditor: true });
  const result = await runUadRedTeamIntegrityChecks({ fetchImpl, getAccessToken });
  assert.equal(result.ok, false);
  assert.equal(result.checks.optimistic_concurrency.ready, false);
  assert.equal(state.validSectionWrites, 0);
  assert.equal(state.revision, 5);
  assert.equal(state.commentary, null);
  assert.equal(state.assets.size, 0);
});

test("integrity runner removes a stale synthetic probe before creating new objects", async () => {
  const { fetchImpl, state } = integrityFetch({ staleProbe: true });
  const result = await runUadRedTeamIntegrityChecks({ fetchImpl, getAccessToken });
  assert.equal(result.ok, true);
  assert.equal(result.checks.preflight_cleanup.stale_probe_count, 1);
  assert.equal(result.checks.preflight_cleanup.delete_success_count, 1);
  assert.equal(result.checks.cleanup.remaining_asset_count, 0);
  assert.equal(state.assets.size, 0);
});
