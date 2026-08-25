import { REDTEAM_ORGANIZATIONS } from "../../security/redTeamFixtures.js";
import { REDTEAM_API_ORIGIN, normalizeUadRedTeamApiUrl } from "./uadRedTeamBaseline.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_UAD_ASSET_BYTES = 50 * 1024 * 1024;
const PNG_PROBE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const MIME_SPOOF_PROBE = Buffer.alloc(PNG_PROBE.length, 0x41);
const COMMENTARY_FIELD = Object.freeze({
  context_key: "assignment_commentary",
  uid: "0100.0044",
});

function timeout(value) {
  return Math.max(1_000, Math.min(Number(value) || 20_000, 30_000));
}

function safeErrorCode(value) {
  if (value == null) return null;
  return /^[a-z][a-z0-9_:.-]{0,159}$/.test(String(value))
    ? String(value)
    : "unsafe_error_response";
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bodyText = await response.text();
    if (Buffer.byteLength(bodyText, "utf8") > MAX_RESPONSE_BYTES) {
      return { body: null, transportError: "response_too_large" };
    }
    try {
      return { body: bodyText ? JSON.parse(bodyText) : null, transportError: null };
    } catch {
      return { body: null, transportError: bodyText ? "response_not_json" : null };
    }
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { body: null, transportError: "response_too_large" };
    }
    chunks.push(Buffer.from(value));
  }
  const bodyText = Buffer.concat(chunks).toString("utf8");
  try {
    return { body: bodyText ? JSON.parse(bodyText) : null, transportError: null };
  } catch {
    return { body: null, transportError: bodyText ? "response_not_json" : null };
  }
}

function accessToken(value) {
  const token = String(value || "").trim();
  if (!token || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw new Error("invalid_uad_redteam_access_token");
  }
  return token;
}

function exactError(result, status, code) {
  return result.status === status
    && !result.transportError
    && result.body
    && Object.keys(result.body).length <= 2
    && result.body.error === code;
}

function compact(result, ready, extra = {}) {
  return Object.freeze({
    ready: Boolean(ready),
    http_status: result?.status ?? null,
    error_code: result?.transportError || safeErrorCode(result?.body?.error),
    ...extra,
  });
}

function editorCommentary(editor) {
  return editor?.values?.find((value) => (
    !value.entity_id
    && value.context_key === COMMENTARY_FIELD.context_key
    && value.uid === COMMENTARY_FIELD.uid
  ))?.value ?? null;
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function discoverTargets(result) {
  if (result.status !== 200 || result.transportError || !Array.isArray(result.body?.workfiles)) return null;
  const targets = {};
  for (const workfile of result.body.workfiles) {
    const label = workfile.file_number === "HN-REDTEAM-ORG-A-0001"
      ? "organization_a"
      : workfile.file_number === "HN-REDTEAM-ORG-B-0001"
        ? "organization_b"
        : null;
    if (!label) continue;
    const expectedOrganization = label === "organization_a"
      ? REDTEAM_ORGANIZATIONS.organizationA.id
      : REDTEAM_ORGANIZATIONS.organizationB.id;
    if (targets[label] || workfile.organization_id !== expectedOrganization || typeof workfile.id !== "string") {
      return null;
    }
    targets[label] = workfile.id;
  }
  return Object.keys(targets).length === 2 ? targets : null;
}

function validUploadDescriptor(upload, expectedType) {
  try {
    const parsed = new URL(upload?.url);
    return upload?.method === "PUT"
      && upload?.headers?.["content-type"] === expectedType
      && Number(upload?.expires_in_seconds) > 0
      && Number(upload?.expires_in_seconds) <= 3_600
      && parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.hash
      && parsed.hostname.endsWith(".r2.cloudflarestorage.com");
  } catch {
    return false;
  }
}

function scopedObjectKey(objectKey, workfileId, assetId) {
  const prefix = `organizations/${REDTEAM_ORGANIZATIONS.organizationA.id}/uad/${workfileId}/assets/${assetId}/`;
  return typeof objectKey === "string"
    && objectKey.startsWith(prefix)
    && !objectKey.includes("..")
    && !objectKey.includes("\\")
    && !/%2e|%2f|%5c/i.test(objectKey);
}

function isRedTeamProbeAsset(asset) {
  const fileName = String(asset?.original_file_name || "").replaceAll("\\", "/");
  return asset?.capture_metadata?.synthetic === true
    && asset.capture_metadata?.purpose === "redteam_storage_boundary"
    && ["redteam-storage-probe.png", "verified-probe.png", "size-mismatch.png", "mime-spoof.png"]
      .some((candidate) => fileName.endsWith(candidate));
}

export async function runUadRedTeamIntegrityChecks({
  baseUrl = REDTEAM_API_ORIGIN,
  fixtureAccountId = "UAD-REDTEAM-SFR-0001",
  getAccessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  checkedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("uad_redteam_fetch_unavailable");
  if (typeof getAccessToken !== "function") throw new Error("uad_redteam_token_factory_required");
  if (!/^UAD-REDTEAM-[0-9A-Z-]+$/.test(String(fixtureAccountId || ""))) {
    throw new Error("invalid_uad_redteam_fixture_account");
  }
  const base = normalizeUadRedTeamApiUrl(baseUrl);
  const requestTimeout = timeout(timeoutMs);
  const tokens = new Map();
  for (const persona of ["assigned_appraiser_a", "appraiser_b", "homenode_admin"]) {
    tokens.set(persona, accessToken(await getAccessToken(persona)));
  }
  let requestCount = 0;
  let storageRequestCount = 0;
  const api = async (persona, path, options = {}) => {
    requestCount += 1;
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${tokens.get(persona)}`,
      ...(options.headers || {}),
    };
    let body;
    if (Object.hasOwn(options, "rawBody")) {
      body = options.rawBody;
      headers["content-type"] ||= "application/json";
    } else if (Object.hasOwn(options, "jsonBody")) {
      body = JSON.stringify(options.jsonBody);
      headers["content-type"] ||= "application/json";
    }
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: options.method || "GET",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeout),
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      return { status: null, body: null, transportError: "request_failed" };
    }
    const parsed = await readBoundedJson(response);
    return { status: response.status, ...parsed };
  };
  const storagePut = async (upload, body, contentType) => {
    storageRequestCount += 1;
    if (!validUploadDescriptor(upload, "image/png")) {
      return { status: null, transportError: "invalid_upload_descriptor" };
    }
    try {
      const response = await fetchImpl(upload.url, {
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeout),
        headers: { "content-type": contentType },
        body,
      });
      await response.body?.cancel?.().catch(() => undefined);
      return { status: response.status, transportError: null };
    } catch {
      return { status: null, transportError: "storage_request_failed" };
    }
  };

  const account = encodeURIComponent(String(fixtureAccountId));
  const discoveryResponse = await api("homenode_admin", `/api/uad/accounts/${account}/workfiles`);
  const targets = discoverTargets(discoveryResponse);
  const checks = {
    discovery: compact(discoveryResponse, Boolean(targets), {
      workfile_count: Array.isArray(discoveryResponse.body?.workfiles)
        ? discoveryResponse.body.workfiles.length
        : null,
    }),
  };
  if (!targets) {
    return Object.freeze({
      ok: false,
      profile: "uad_redteam_integrity_and_storage_v1",
      checked_at: checkedAt,
      base_url: base,
      fixture_account_id: String(fixtureAccountId),
      request_count: requestCount,
      storage_request_count: storageRequestCount,
      checks: Object.freeze(checks),
    });
  }

  const workfileA = targets.organization_a;
  const workfileB = targets.organization_b;
  const editorBefore = await api("assigned_appraiser_a", `/api/uad/workfiles/${workfileA}/editor`);
  const initialRevision = Number(editorBefore.body?.workfile?.current_revision);
  const originalCommentary = editorCommentary(editorBefore.body);
  const editorReady = editorBefore.status === 200
    && !editorBefore.transportError
    && Number.isInteger(initialRevision)
    && initialRevision >= 1;

  const malformed = await api(
    "assigned_appraiser_a",
    `/api/uad/workfiles/${workfileA}/sections/assignment`,
    { method: "PATCH", rawBody: "{" },
  );
  const oversized = await api(
    "assigned_appraiser_a",
    `/api/uad/workfiles/${workfileA}/sections/assignment`,
    { method: "PATCH", rawBody: JSON.stringify({ padding: "x".repeat(1024 * 1024 + 128) }) },
  );
  let nested = null;
  for (let index = 0; index < 512; index += 1) nested = { node: nested };
  const deeplyNested = await api(
    "assigned_appraiser_a",
    `/api/uad/workfiles/${workfileA}/sections/assignment`,
    {
      method: "PATCH",
      jsonBody: { expected_revision: initialRevision, values: "invalid", nested },
    },
  );
  checks.json_parser = Object.freeze({
    ready: exactError(malformed, 400, "invalid_json_body")
      && exactError(oversized, 413, "request_body_too_large")
      && exactError(deeplyNested, 400, "invalid_uad_field_values"),
    malformed: compact(malformed, exactError(malformed, 400, "invalid_json_body")),
    oversized: compact(oversized, exactError(oversized, 413, "request_body_too_large")),
    deeply_nested: compact(deeplyNested, exactError(deeplyNested, 400, "invalid_uad_field_values")),
  });

  const markerA = "Synthetic red-team concurrency probe A";
  const markerB = "Synthetic red-team concurrency probe B";
  const racePath = `/api/uad/workfiles/${workfileA}/sections/assignment`;
  const raceRequest = (value) => api("assigned_appraiser_a", racePath, {
    method: "PATCH",
    jsonBody: {
      expected_revision: initialRevision,
      values: [{ ...COMMENTARY_FIELD, value }],
    },
  });
  const raceResponses = editorReady
    ? await Promise.all([raceRequest(markerA), raceRequest(markerB)])
    : [];
  const raceSuccesses = raceResponses.filter((result) => result.status === 200 && !result.transportError);
  const raceStales = raceResponses.filter((result) => exactError(result, 409, "uad_section_stale_revision"));
  const editorAfterRace = raceResponses.length
    ? await api("assigned_appraiser_a", `/api/uad/workfiles/${workfileA}/editor`)
    : { status: null, body: null, transportError: "race_not_attempted" };
  const postRaceRevision = Number(editorAfterRace.body?.workfile?.current_revision);
  const postRaceCommentary = editorCommentary(editorAfterRace.body);
  const successfulRevisions = raceSuccesses
    .map((result) => Number(result.body?.current_revision))
    .filter((revision) => Number.isInteger(revision) && revision >= 1);
  const restoreExpectedRevision = Number.isInteger(postRaceRevision)
    ? postRaceRevision
    : successfulRevisions.length
      ? Math.max(...successfulRevisions)
      : null;

  let restoreResponse = { status: null, body: null, transportError: "restore_not_attempted" };
  if (raceSuccesses.length && Number.isInteger(restoreExpectedRevision)) {
    restoreResponse = await api("assigned_appraiser_a", racePath, {
      method: "PATCH",
      jsonBody: {
        expected_revision: restoreExpectedRevision,
        values: [{ ...COMMENTARY_FIELD, value: originalCommentary }],
      },
    });
  }
  const editorAfterRestore = restoreResponse.status === 200
    ? await api("assigned_appraiser_a", `/api/uad/workfiles/${workfileA}/editor`)
    : { status: null, body: null, transportError: "restore_not_completed" };
  const restoredRevision = Number(editorAfterRestore.body?.workfile?.current_revision);
  const restoredCommentary = editorCommentary(editorAfterRestore.body);
  const restorationReady = restoreResponse.status === 200
    && restoredRevision === restoreExpectedRevision + 1
    && jsonEqual(restoredCommentary, originalCommentary);
  checks.optimistic_concurrency = Object.freeze({
    ready: editorReady
      && raceSuccesses.length === 1
      && raceStales.length === 1
      && postRaceRevision === initialRevision + 1
      && [markerA, markerB].includes(postRaceCommentary)
      && restorationReady,
    success_count: raceSuccesses.length,
    stale_conflict_count: raceStales.length,
    revision_delta_after_race: Number.isInteger(postRaceRevision) && Number.isInteger(initialRevision)
      ? postRaceRevision - initialRevision
      : null,
    restored: restorationReady,
    race_http_statuses: raceResponses.map((result) => result.status),
    race_error_codes: raceResponses.map((result) => (
      result.transportError || safeErrorCode(result.body?.error)
    )),
  });

  const artifactRoutes = Object.freeze([
    { type: "xml", blockedCode: "uad_xml_local_validation_required" },
    { type: "pdf", blockedCode: "uad_pdf_local_validation_required" },
    { type: "submission-package", blockedCode: "uad_package_signature_required" },
  ]);
  const artifactBefore = [];
  const artifactCrossTenant = [];
  const artifactGeneration = [];
  const artifactAfter = [];
  for (const route of artifactRoutes) {
    const pathA = `/api/uad/workfiles/${workfileA}/artifacts/${route.type}`;
    const pathB = `/api/uad/workfiles/${workfileB}/artifacts/${route.type}`;
    artifactBefore.push(await api("assigned_appraiser_a", pathA));
    artifactCrossTenant.push(await api("assigned_appraiser_a", pathB));
    artifactGeneration.push(await api("assigned_appraiser_a", pathA, { method: "POST", jsonBody: {} }));
    artifactAfter.push(await api("assigned_appraiser_a", pathA));
  }
  const artifactOwnReadsReady = artifactBefore.every((result) => result.status === 200 && !result.transportError);
  const artifactCrossTenantReady = artifactCrossTenant.every((result) => (
    exactError(result, 403, "uad_workfile_access_denied")
  ));
  const artifactStateGateReady = artifactGeneration.every((result, index) => (
    exactError(result, 409, artifactRoutes[index].blockedCode)
  ));
  const artifactUnchanged = artifactAfter.every((result, index) => (
    result.status === 200 && !result.transportError && jsonEqual(result.body, artifactBefore[index].body)
  ));
  checks.artifact_access_and_state = Object.freeze({
    ready: artifactOwnReadsReady && artifactCrossTenantReady && artifactStateGateReady && artifactUnchanged,
    own_read_http_statuses: artifactBefore.map((result) => result.status),
    cross_tenant_http_statuses: artifactCrossTenant.map((result) => result.status),
    blocked_generation_http_statuses: artifactGeneration.map((result) => result.status),
    blocked_generation_error_codes: artifactGeneration.map((result) => safeErrorCode(result.body?.error)),
    unchanged_after_blocked_generation: artifactUnchanged,
  });

  const uploadInput = (overrides = {}) => ({
    asset_kind: "photo",
    content_type: "image/png",
    file_name: "redteam-storage-probe.png",
    byte_size: PNG_PROBE.length,
    capture_metadata: { synthetic: true, purpose: "redteam_storage_boundary" },
    ...overrides,
  });
  const crossTenantUpload = await api(
    "assigned_appraiser_a",
    `/api/uad/workfiles/${workfileB}/assets/upload-url`,
    { method: "POST", jsonBody: uploadInput() },
  );
  const invalidType = await api(
    "assigned_appraiser_a",
    `/api/uad/workfiles/${workfileA}/assets/upload-url`,
    { method: "POST", jsonBody: uploadInput({ content_type: "text/html" }) },
  );
  const invalidSize = await api(
    "assigned_appraiser_a",
    `/api/uad/workfiles/${workfileA}/assets/upload-url`,
    { method: "POST", jsonBody: uploadInput({ byte_size: MAX_UAD_ASSET_BYTES + 1 }) },
  );
  checks.upload_validation = Object.freeze({
    ready: exactError(crossTenantUpload, 403, "uad_workfile_access_denied")
      && exactError(invalidType, 400, "invalid_uad_asset_content_type")
      && exactError(invalidSize, 400, "invalid_uad_asset_byte_size"),
    cross_tenant: compact(crossTenantUpload, exactError(crossTenantUpload, 403, "uad_workfile_access_denied")),
    content_type: compact(invalidType, exactError(invalidType, 400, "invalid_uad_asset_content_type")),
    byte_size: compact(invalidSize, exactError(invalidSize, 400, "invalid_uad_asset_byte_size")),
  });

  const pendingCleanup = new Set();
  const deleteAsset = async (assetId) => {
    if (!assetId) return { status: null, body: null, transportError: "asset_id_missing" };
    const response = await api(
      "assigned_appraiser_a",
      `/api/uad/workfiles/${workfileA}/assets/${assetId}`,
      { method: "DELETE" },
    );
    if (response.status === 204 || response.status === 404) pendingCleanup.delete(assetId);
    return response;
  };

  const assetsBefore = await api("assigned_appraiser_a", `/api/uad/workfiles/${workfileA}/assets`);
  const priorProbeAssets = Array.isArray(assetsBefore.body?.assets)
    ? assetsBefore.body.assets.filter(isRedTeamProbeAsset)
    : [];
  const preflightDeletes = [];
  for (const asset of priorProbeAssets) preflightDeletes.push(await deleteAsset(asset.id));
  const assetsAfterPreflight = await api("assigned_appraiser_a", `/api/uad/workfiles/${workfileA}/assets`);
  const priorProbesRemaining = Array.isArray(assetsAfterPreflight.body?.assets)
    ? assetsAfterPreflight.body.assets.filter(isRedTeamProbeAsset).length
    : null;
  const preflightCleanupReady = assetsBefore.status === 200
    && assetsAfterPreflight.status === 200
    && preflightDeletes.every((result) => [204, 404].includes(result.status))
    && priorProbesRemaining === 0;
  checks.preflight_cleanup = Object.freeze({
    ready: preflightCleanupReady,
    stale_probe_count: priorProbeAssets.length,
    delete_success_count: preflightDeletes.filter((result) => [204, 404].includes(result.status)).length,
    remaining_probe_count: priorProbesRemaining,
  });
  if (!preflightCleanupReady) {
    checks.storage_scope_and_signature = Object.freeze({ ready: false, skipped: true });
    checks.verified_storage_lifecycle = Object.freeze({ ready: false, skipped: true });
    checks.storage_verification = Object.freeze({ ready: false, skipped: true });
    checks.cleanup = Object.freeze({
      ready: false,
      remaining_asset_count: priorProbesRemaining,
    });
    return Object.freeze({
      ok: false,
      profile: "uad_redteam_integrity_and_storage_v1",
      checked_at: checkedAt,
      base_url: base,
      fixture_account_id: String(fixtureAccountId),
      request_count: requestCount,
      storage_request_count: storageRequestCount,
      checks: Object.freeze(checks),
    });
  }

  let cleanupReady = true;
  try {
    const signedHeaderUpload = await api(
      "assigned_appraiser_a",
      `/api/uad/workfiles/${workfileA}/assets/upload-url`,
      {
        method: "POST",
        jsonBody: uploadInput({ file_name: "../../../../../redteam-storage-probe.png" }),
      },
    );
    const signedHeaderAssetId = signedHeaderUpload.body?.asset_id;
    if (signedHeaderAssetId) pendingCleanup.add(signedHeaderAssetId);
    const pathScoped = signedHeaderUpload.status === 201
      && scopedObjectKey(signedHeaderUpload.body?.object_key, workfileA, signedHeaderAssetId)
      && validUploadDescriptor(signedHeaderUpload.body?.upload, "image/png");
    const wrongHeaderPut = pathScoped
      ? await storagePut(signedHeaderUpload.body.upload, PNG_PROBE, "text/plain")
      : { status: null, transportError: "upload_not_created" };
    const signedHeaderDelete = await deleteAsset(signedHeaderAssetId);
    checks.storage_scope_and_signature = Object.freeze({
      ready: pathScoped
        && wrongHeaderPut.status >= 400
        && wrongHeaderPut.status < 500
        && signedHeaderDelete.status === 204,
      object_key_scoped: Boolean(pathScoped),
      wrong_content_type_http_status: wrongHeaderPut.status,
      wrong_content_type_transport_error: wrongHeaderPut.transportError,
      cleanup_http_status: signedHeaderDelete.status,
    });

    const verifiedUpload = await api(
      "assigned_appraiser_a",
      `/api/uad/workfiles/${workfileA}/assets/upload-url`,
      { method: "POST", jsonBody: uploadInput({ file_name: "..\\..\\verified-probe.png" }) },
    );
    const verifiedAssetId = verifiedUpload.body?.asset_id;
    if (verifiedAssetId) pendingCleanup.add(verifiedAssetId);
    const verifiedDescriptor = verifiedUpload.status === 201
      && scopedObjectKey(verifiedUpload.body?.object_key, workfileA, verifiedAssetId)
      && validUploadDescriptor(verifiedUpload.body?.upload, "image/png");
    const validPut = verifiedDescriptor
      ? await storagePut(verifiedUpload.body.upload, PNG_PROBE, "image/png")
      : { status: null, transportError: "upload_not_created" };
    const verification = verifiedAssetId && validPut.status >= 200 && validPut.status < 300
      ? await api(
          "assigned_appraiser_a",
          `/api/uad/workfiles/${workfileA}/assets/${verifiedAssetId}/verify`,
          { method: "POST", jsonBody: {} },
        )
      : { status: null, body: null, transportError: "upload_not_completed" };
    const listed = await api("assigned_appraiser_a", `/api/uad/workfiles/${workfileA}/assets`);
    const crossTenantList = await api("appraiser_b", `/api/uad/workfiles/${workfileA}/assets`);
    const presentVerified = Array.isArray(listed.body?.assets)
      && listed.body.assets.some((asset) => (
        asset.id === verifiedAssetId
        && asset.status === "verified"
        && Number(asset.byte_size) === PNG_PROBE.length
      ));
    const verifiedDelete = await deleteAsset(verifiedAssetId);
    const listedAfterDelete = await api("assigned_appraiser_a", `/api/uad/workfiles/${workfileA}/assets`);
    const absentAfterDelete = Array.isArray(listedAfterDelete.body?.assets)
      && !listedAfterDelete.body.assets.some((asset) => asset.id === verifiedAssetId);
    checks.verified_storage_lifecycle = Object.freeze({
      ready: verifiedDescriptor
        && validPut.status >= 200
        && validPut.status < 300
        && verification.status === 200
        && verification.body?.asset?.status === "verified"
        && Number(verification.body?.asset?.byte_size) === PNG_PROBE.length
        && presentVerified
        && exactError(crossTenantList, 403, "uad_workfile_access_denied")
        && verifiedDelete.status === 204
        && absentAfterDelete,
      upload_http_status: validPut.status,
      upload_transport_error: validPut.transportError,
      verification_http_status: verification.status,
      cross_tenant_http_status: crossTenantList.status,
      cleanup_http_status: verifiedDelete.status,
      absent_after_delete: absentAfterDelete,
    });

    const mismatchUpload = await api(
      "assigned_appraiser_a",
      `/api/uad/workfiles/${workfileA}/assets/upload-url`,
      { method: "POST", jsonBody: uploadInput({ file_name: "size-mismatch.png", byte_size: PNG_PROBE.length + 1 }) },
    );
    const mismatchAssetId = mismatchUpload.body?.asset_id;
    if (mismatchAssetId) pendingCleanup.add(mismatchAssetId);
    const mismatchPut = mismatchUpload.status === 201
      && validUploadDescriptor(mismatchUpload.body?.upload, "image/png")
      ? await storagePut(mismatchUpload.body.upload, PNG_PROBE, "image/png")
      : { status: null, transportError: "upload_not_created" };
    const mismatchVerification = mismatchAssetId && mismatchPut.status >= 200 && mismatchPut.status < 300
      ? await api(
          "assigned_appraiser_a",
          `/api/uad/workfiles/${workfileA}/assets/${mismatchAssetId}/verify`,
          { method: "POST", jsonBody: {} },
        )
      : { status: null, body: null, transportError: "upload_not_completed" };
    const mismatchDelete = await deleteAsset(mismatchAssetId);
    checks.storage_verification = Object.freeze({
      ready: mismatchPut.status >= 200
        && mismatchPut.status < 300
        && exactError(mismatchVerification, 400, "invalid_uad_uploaded_asset")
        && mismatchDelete.status === 204,
      upload_http_status: mismatchPut.status,
      upload_transport_error: mismatchPut.transportError,
      verification_http_status: mismatchVerification.status,
      verification_error_code: safeErrorCode(mismatchVerification.body?.error),
      cleanup_http_status: mismatchDelete.status,
    });

    const spoofUpload = await api(
      "assigned_appraiser_a",
      `/api/uad/workfiles/${workfileA}/assets/upload-url`,
      { method: "POST", jsonBody: uploadInput({ file_name: "mime-spoof.png" }) },
    );
    const spoofAssetId = spoofUpload.body?.asset_id;
    if (spoofAssetId) pendingCleanup.add(spoofAssetId);
    const spoofPut = spoofUpload.status === 201
      && validUploadDescriptor(spoofUpload.body?.upload, "image/png")
      ? await storagePut(spoofUpload.body.upload, MIME_SPOOF_PROBE, "image/png")
      : { status: null, transportError: "upload_not_created" };
    const spoofVerification = spoofAssetId && spoofPut.status >= 200 && spoofPut.status < 300
      ? await api(
          "assigned_appraiser_a",
          `/api/uad/workfiles/${workfileA}/assets/${spoofAssetId}/verify`,
          { method: "POST", jsonBody: {} },
        )
      : { status: null, body: null, transportError: "upload_not_completed" };
    const spoofDelete = await deleteAsset(spoofAssetId);
    checks.storage_content_validation = Object.freeze({
      ready: spoofPut.status >= 200
        && spoofPut.status < 300
        && exactError(spoofVerification, 400, "invalid_uad_uploaded_asset")
        && spoofDelete.status === 204,
      upload_http_status: spoofPut.status,
      upload_transport_error: spoofPut.transportError,
      verification_http_status: spoofVerification.status,
      verification_error_code: safeErrorCode(spoofVerification.body?.error),
      cleanup_http_status: spoofDelete.status,
    });
  } finally {
    for (const assetId of [...pendingCleanup]) {
      const cleanup = await deleteAsset(assetId);
      if (![204, 404].includes(cleanup.status)) cleanupReady = false;
    }
  }
  const assetsAfterCleanup = await api("assigned_appraiser_a", `/api/uad/workfiles/${workfileA}/assets`);
  const remainingProbeCount = Array.isArray(assetsAfterCleanup.body?.assets)
    ? assetsAfterCleanup.body.assets.filter(isRedTeamProbeAsset).length
    : null;
  checks.cleanup = Object.freeze({
    ready: cleanupReady
      && pendingCleanup.size === 0
      && assetsAfterCleanup.status === 200
      && remainingProbeCount === 0,
    remaining_asset_count: remainingProbeCount,
  });

  return Object.freeze({
    ok: Object.values(checks).every((check) => check.ready === true),
    profile: "uad_redteam_integrity_and_storage_v1",
    checked_at: checkedAt,
    base_url: base,
    fixture_account_id: String(fixtureAccountId),
    request_count: requestCount,
    storage_request_count: storageRequestCount,
    checks: Object.freeze(checks),
  });
}
