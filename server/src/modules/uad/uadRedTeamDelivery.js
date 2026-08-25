import { randomUUID } from "node:crypto";

import { REDTEAM_API_ORIGIN, normalizeUadRedTeamApiUrl } from "./uadRedTeamBaseline.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_LENGTH = 16_384;
const DELIVERY_FILE_NUMBER = "HN-REDTEAM-DELIVERY-A-0001";
const CROSS_TENANT_FILE_NUMBER = "HN-REDTEAM-ORG-B-0001";

function boundedTimeout(value) {
  return Math.max(1_000, Math.min(Number(value) || 20_000, 30_000));
}

function accessToken(value) {
  const token = String(value || "").trim();
  if (!token || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw new Error("invalid_uad_redteam_access_token");
  }
  return token;
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
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      return { body: null, transportError: "response_too_large" };
    }
    try {
      return { body: text ? JSON.parse(text) : null, transportError: null };
    } catch {
      return { body: null, transportError: text ? "response_not_json" : null };
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
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return { body: text ? JSON.parse(text) : null, transportError: null };
  } catch {
    return { body: null, transportError: text ? "response_not_json" : null };
  }
}

function exactError(result, status, code) {
  return result.status === status
    && !result.transportError
    && result.body?.error === code
    && Object.keys(result.body).length <= 2;
}

function compact(result, ready, extra = {}) {
  return Object.freeze({
    ready: Boolean(ready),
    http_status: result?.status ?? null,
    error_code: result?.transportError || safeErrorCode(result?.body?.error),
    ...extra,
  });
}

function findExactWorkfile(result, fileNumber) {
  if (result.status !== 200 || result.transportError || !Array.isArray(result.body?.workfiles)) return null;
  const matches = result.body.workfiles.filter((workfile) => workfile?.file_number === fileNumber);
  return matches.length === 1 && typeof matches[0].id === "string" ? matches[0] : null;
}

export async function runUadRedTeamDeliveryChecks({
  baseUrl = REDTEAM_API_ORIGIN,
  fixtureAccountId = "UAD-REDTEAM-SFR-0001",
  getAccessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  checkedAt = new Date().toISOString(),
  idempotencyKey = `redteam-delivery-${randomUUID()}`,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("uad_redteam_fetch_unavailable");
  if (typeof getAccessToken !== "function") throw new Error("uad_redteam_token_factory_required");
  if (!/^UAD-REDTEAM-[0-9A-Z-]+$/.test(String(fixtureAccountId || ""))) {
    throw new Error("invalid_uad_redteam_fixture_account");
  }
  const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
  if (!/^redteam-delivery-[a-z0-9-]{8,140}$/.test(normalizedIdempotencyKey)) {
    throw new Error("invalid_uad_redteam_delivery_idempotency_key");
  }
  const base = normalizeUadRedTeamApiUrl(baseUrl);
  const requestTimeout = boundedTimeout(timeoutMs);
  const tokens = new Map();
  for (const persona of ["assigned_appraiser_a", "appraiser_b", "reviewer_a", "homenode_admin"]) {
    tokens.set(persona, accessToken(await getAccessToken(persona)));
  }
  let requestCount = 0;
  const api = async (persona, path, { method = "GET", body } = {}) => {
    requestCount += 1;
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeout),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${tokens.get(persona)}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return { status: null, body: null, transportError: "request_failed" };
    }
    const parsed = await readBoundedJson(response);
    return { status: response.status, ...parsed };
  };

  const account = encodeURIComponent(String(fixtureAccountId));
  const discovery = await api("homenode_admin", `/api/uad/accounts/${account}/workfiles`);
  const deliveryWorkfile = findExactWorkfile(discovery, DELIVERY_FILE_NUMBER);
  const crossTenantWorkfile = findExactWorkfile(discovery, CROSS_TENANT_FILE_NUMBER);
  const checks = {
    discovery: compact(discovery, Boolean(deliveryWorkfile && crossTenantWorkfile), {
      delivery_status: deliveryWorkfile?.status || null,
    }),
  };
  if (!deliveryWorkfile || !crossTenantWorkfile) {
    return Object.freeze({
      ok: false,
      profile: "uad_redteam_delivery_boundaries_v1",
      checked_at: checkedAt,
      synthetic_only: true,
      external_submission_attempted: false,
      fixture_account_id: String(fixtureAccountId),
      request_count: requestCount,
      checks: Object.freeze(checks),
    });
  }

  const workfilePath = `/api/uad/workfiles/${deliveryWorkfile.id}`;
  const otherPath = `/api/uad/workfiles/${crossTenantWorkfile.id}`;
  const packageResult = await api("assigned_appraiser_a", `${workfilePath}/artifacts/submission-package`);
  const artifact = packageResult.body?.package || packageResult.body?.artifact;
  const packageReady = packageResult.status === 200
    && !packageResult.transportError
    && artifact?.ready_for_download === true
    && artifact?.generation_status === "ready"
    && artifact?.content_type === "application/zip"
    && artifact?.is_current_revision === true
    && /^[0-9a-f]{64}$/.test(String(artifact?.checksum_sha256 || ""));
  checks.package_identity = compact(packageResult, packageReady, {
    revision_number: Number.isInteger(Number(artifact?.revision_number)) ? Number(artifact.revision_number) : null,
    byte_size: Number.isSafeInteger(Number(artifact?.byte_size)) ? Number(artifact.byte_size) : null,
    checksum_present: /^[0-9a-f]{64}$/.test(String(artifact?.checksum_sha256 || "")),
  });

  const reviewerRead = await api("reviewer_a", `${workfilePath}/delivery-attempts`);
  const reviewerWrite = await api("reviewer_a", `${workfilePath}/delivery-attempts`, {
    method: "POST",
    body: { portal_url: "https://amerimacamc.spurams.com/login.aspx" },
  });
  const crossTenantRead = await api("appraiser_b", `${workfilePath}/delivery-attempts`);
  const crossTenantWrite = await api("appraiser_b", `${workfilePath}/delivery-attempts`, {
    method: "POST",
    body: { portal_url: "https://amerimacamc.spurams.com/login.aspx" },
  });
  const reverseTenantRead = await api("assigned_appraiser_a", `${otherPath}/delivery-attempts`);
  checks.authorization = Object.freeze({
    ready: reviewerRead.status === 200
      && exactError(reviewerWrite, 403, "uad_workfile_access_denied")
      && exactError(crossTenantRead, 403, "uad_workfile_access_denied")
      && exactError(crossTenantWrite, 403, "uad_workfile_access_denied")
      && exactError(reverseTenantRead, 403, "uad_workfile_access_denied"),
    reviewer_read_http_status: reviewerRead.status,
    reviewer_write_http_status: reviewerWrite.status,
    cross_tenant_http_statuses: [crossTenantRead.status, crossTenantWrite.status, reverseTenantRead.status],
  });

  const hostilePortalUrls = [
    "http://amerimacamc.spurams.com/login.aspx",
    "https://user:secret@amerimacamc.spurams.com/login.aspx",
    "https://amerimacamc.spurams.com/login.aspx?token=synthetic-secret",
    "https://127.0.0.1/login",
    "https://[::1]/login",
    "https://169.254.169.254/latest/meta-data",
    "https://portal.internal/login",
    "https://orders.example.com:8443/login",
  ];
  const portalResponses = [];
  for (const portalUrl of hostilePortalUrls) {
    portalResponses.push(await api("assigned_appraiser_a", "/api/uad/delivery/resolve", {
      method: "POST",
      body: { portal_url: portalUrl },
    }));
  }
  checks.portal_target_validation = Object.freeze({
    ready: portalResponses.every((result) => exactError(result, 400, "delivery_portal_url_invalid")),
    attempted_count: portalResponses.length,
    http_statuses: portalResponses.map((result) => result.status),
    error_codes: portalResponses.map((result) => safeErrorCode(result.body?.error)),
  });

  let attemptId = null;
  if (packageReady) {
    const createBody = {
      portal_url: "https://amerimacamc.spurams.com/login.aspx",
      external_order_id: "SYNTHETIC-REDTEAM-ORDER",
      idempotency_key: normalizedIdempotencyKey,
    };
    const created = await api("assigned_appraiser_a", `${workfilePath}/delivery-attempts`, {
      method: "POST",
      body: createBody,
    });
    attemptId = created.body?.attempt?.id || null;
    const retry = await api("assigned_appraiser_a", `${workfilePath}/delivery-attempts`, {
      method: "POST",
      body: createBody,
    });
    const listed = await api("assigned_appraiser_a", `${workfilePath}/delivery-attempts`);
    const attempts = Array.isArray(listed.body?.attempts) ? listed.body.attempts : [];
    const matchingAttempts = attempts.filter((attempt) => attempt?.id === attemptId);
    const bound = created.status === 201
      && retry.status === 201
      && typeof attemptId === "string"
      && retry.body?.attempt?.id === attemptId
      && created.body?.attempt?.workfile_id === deliveryWorkfile.id
      && Number(created.body?.attempt?.revision_number) === Number(artifact.revision_number)
      && created.body?.attempt?.artifact_id === artifact.id
      && created.body?.attempt?.package_checksum_sha256 === artifact.checksum_sha256
      && Number(created.body?.attempt?.package_byte_size) === Number(artifact.byte_size)
      && created.body?.plan?.mode === "guided_manual"
      && created.body?.plan?.automated_submission === false
      && created.body?.plan?.package?.checksum_sha256 === artifact.checksum_sha256
      && matchingAttempts.length === 1;
    checks.idempotent_package_binding = Object.freeze({
      ready: bound,
      create_http_status: created.status,
      retry_http_status: retry.status,
      same_attempt_id: Boolean(attemptId && retry.body?.attempt?.id === attemptId),
      single_list_entry: matchingAttempts.length === 1,
      checksum_bound: created.body?.attempt?.package_checksum_sha256 === artifact.checksum_sha256,
      automated_submission: created.body?.plan?.automated_submission ?? null,
    });

    const patch = (persona, body, id = attemptId) => api(
      persona,
      `${workfilePath}/delivery-attempts/${encodeURIComponent(String(id))}`,
      { method: "PATCH", body },
    );
    const deliveredWithoutReceipt = await patch("assigned_appraiser_a", { status: "delivered" });
    const failedWithoutCode = await patch("assigned_appraiser_a", { status: "failed" });
    const invalidFailureCode = await patch("assigned_appraiser_a", {
      status: "failed",
      failure_code: "unsafe failure code",
    });
    const invalidAttemptId = await patch("assigned_appraiser_a", { status: "cancelled" }, "not-a-uuid");
    const reviewerPatch = await patch("reviewer_a", { status: "cancelled" });
    const crossTenantPatch = await patch("appraiser_b", { status: "cancelled" });
    checks.result_validation = Object.freeze({
      ready: exactError(deliveredWithoutReceipt, 400, "delivery_receipt_required")
        && exactError(failedWithoutCode, 400, "delivery_failure_code_required")
        && exactError(invalidFailureCode, 400, "delivery_failure_code_invalid")
        && exactError(invalidAttemptId, 400, "delivery_attempt_id_invalid")
        && exactError(reviewerPatch, 403, "uad_workfile_access_denied")
        && exactError(crossTenantPatch, 403, "uad_workfile_access_denied"),
      invalid_result_http_statuses: [
        deliveredWithoutReceipt.status,
        failedWithoutCode.status,
        invalidFailureCode.status,
        invalidAttemptId.status,
      ],
      unauthorized_http_statuses: [reviewerPatch.status, crossTenantPatch.status],
    });

    const cancelled = await patch("assigned_appraiser_a", { status: "cancelled" });
    const repeated = await patch("assigned_appraiser_a", { status: "cancelled" });
    const finalList = await api("assigned_appraiser_a", `${workfilePath}/delivery-attempts`);
    const finalAttempt = Array.isArray(finalList.body?.attempts)
      ? finalList.body.attempts.find((attempt) => attempt?.id === attemptId)
      : null;
    checks.cancellation_finality = Object.freeze({
      ready: cancelled.status === 200
        && cancelled.body?.attempt?.status === "cancelled"
        && exactError(repeated, 409, "delivery_attempt_not_found_or_completed")
        && finalAttempt?.status === "cancelled"
        && finalAttempt?.package_checksum_sha256 === artifact.checksum_sha256
        && Number(finalAttempt?.revision_number) === Number(artifact.revision_number),
      cancel_http_status: cancelled.status,
      repeated_cancel_http_status: repeated.status,
      final_status: finalAttempt?.status || null,
      package_identity_preserved: finalAttempt?.package_checksum_sha256 === artifact.checksum_sha256,
    });
  } else {
    checks.idempotent_package_binding = Object.freeze({ ready: false, skipped: true });
    checks.result_validation = Object.freeze({ ready: false, skipped: true });
    checks.cancellation_finality = Object.freeze({ ready: false, skipped: true });
  }

  return Object.freeze({
    ok: Object.values(checks).every((check) => check.ready === true),
    profile: "uad_redteam_delivery_boundaries_v1",
    checked_at: checkedAt,
    synthetic_only: true,
    external_submission_attempted: false,
    fixture_account_id: String(fixtureAccountId),
    request_count: requestCount,
    checks: Object.freeze(checks),
  });
}
