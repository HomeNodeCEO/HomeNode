import { createHash } from "node:crypto";

import { REDTEAM_API_ORIGIN, normalizeUadRedTeamApiUrl } from "./uadRedTeamBaseline.js";

const DELIVERY_FILE_NUMBER = "HN-REDTEAM-DELIVERY-A-0001";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

async function readBounded(response, maximum) {
  const advertised = Number(response.headers.get("content-length") || 0);
  if (advertised > maximum) {
    await response.body?.cancel?.().catch(() => undefined);
    throw new Error("redteam_artifact_response_too_large");
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maximum) throw new Error("redteam_artifact_response_too_large");
    return body;
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) {
      await reader.cancel().catch(() => undefined);
      throw new Error("redteam_artifact_response_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
}

function safePackageDownloadUrl(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "https:"
      || parsed.username || parsed.password
      || !parsed.hostname.endsWith(".r2.cloudflarestorage.com")) {
    throw new Error("redteam_artifact_download_url_invalid");
  }
  return parsed.href;
}

export async function runUadRedTeamArtifactResilience({
  baseUrl = REDTEAM_API_ORIGIN,
  fixtureAccountId = "UAD-REDTEAM-SFR-0001",
  getAccessToken,
  fetchImpl = globalThis.fetch,
  checkedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("uad_redteam_fetch_unavailable");
  if (typeof getAccessToken !== "function") throw new Error("uad_redteam_token_factory_required");
  if (fixtureAccountId !== "UAD-REDTEAM-SFR-0001") {
    throw new Error("invalid_uad_redteam_artifact_fixture");
  }
  const base = normalizeUadRedTeamApiUrl(baseUrl);
  const token = await getAccessToken("assigned_appraiser_a");
  let requestCount = 0;
  const apiJson = async (pathname, init = {}) => {
    requestCount += 1;
    const response = await fetchImpl(`${base}${pathname}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(init.method === "POST" ? 180_000 : 15_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
    const body = await readBounded(response, MAX_JSON_BYTES);
    let json;
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("redteam_artifact_api_response_invalid");
    }
    if (!response.ok) throw new Error(`redteam_artifact_api_${response.status}`);
    return { status: response.status, body: json };
  };

  const account = encodeURIComponent(fixtureAccountId);
  const listed = await apiJson(`/api/uad/accounts/${account}/workfiles`);
  const workfile = listed.body.workfiles?.find((item) => item.file_number === DELIVERY_FILE_NUMBER);
  if (!workfile?.id) throw new Error("redteam_artifact_workfile_not_found");
  const workfilePath = `/api/uad/workfiles/${encodeURIComponent(workfile.id)}`;
  const beforePerformance = await apiJson("/api/system/performance");
  const before = await apiJson(`${workfilePath}/artifacts/submission-package`);
  if (!before.body.package?.ready_for_download) throw new Error("redteam_artifact_package_not_ready");

  const [first, duplicate] = await Promise.all([
    apiJson(`${workfilePath}/artifacts/submission-package`, { method: "POST" }),
    apiJson(`${workfilePath}/artifacts/submission-package`, { method: "POST" }),
  ]);
  const packageArtifact = first.body.package;
  const duplicatePackage = duplicate.body.package;
  const downloadUrl = safePackageDownloadUrl(packageArtifact?.download?.url);
  requestCount += 1;
  const downloadResponse = await fetchImpl(downloadUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!downloadResponse.ok) throw new Error(`redteam_artifact_download_${downloadResponse.status}`);
  const packageBody = await readBounded(downloadResponse, MAX_PACKAGE_BYTES);
  const packageChecksum = createHash("sha256").update(packageBody).digest("hex");
  const afterPerformance = await apiJson("/api/system/performance");
  const readiness = await apiJson("/ready");
  const beforeCompleted = Number(beforePerformance.body.artifact_executor?.completed || 0);
  const afterCompleted = Number(afterPerformance.body.artifact_executor?.completed || 0);
  const checks = Object.freeze({
    package_regenerated: packageArtifact?.generation_status === "ready"
      && packageArtifact?.ready_for_download === true
      && packageArtifact?.metadata?.streamed_generation === true,
    duplicate_single_flight: first.status === 201
      && duplicate.status === 201
      && packageArtifact?.id === duplicatePackage?.id
      && packageArtifact?.checksum_sha256 === duplicatePackage?.checksum_sha256
      && afterCompleted === beforeCompleted + 1,
    deterministic_identity: packageArtifact?.checksum_sha256 === before.body.package?.checksum_sha256
      && Number(packageArtifact?.byte_size) === Number(before.body.package?.byte_size),
    downloaded_package_verified: packageBody.length === Number(packageArtifact?.byte_size)
      && packageChecksum === packageArtifact?.checksum_sha256
      && packageBody.readUInt32LE(0) === 0x04034b50
      && packageBody.readUInt32LE(packageBody.length - 22) === 0x06054b50,
    backend_recovered: readiness.status === 200
      && readiness.body?.ok === true
      && readiness.body?.checks?.artifact_executor?.active === 0
      && readiness.body?.checks?.artifact_executor?.queued === 0,
  });
  return Object.freeze({
    ok: Object.values(checks).every(Boolean),
    profile: "uad_redteam_artifact_resilience_v1",
    checked_at: checkedAt,
    base_url: base,
    fixture_account_id: fixtureAccountId,
    fixture_file_number: DELIVERY_FILE_NUMBER,
    request_count: requestCount,
    artifact: Object.freeze({
      revision_number: Number(packageArtifact?.revision_number),
      byte_size: Number(packageArtifact?.byte_size),
      entry_count: Number(packageArtifact?.metadata?.entry_count || 0),
      image_count: Number(packageArtifact?.metadata?.image_count || 0),
      checksum_sha256: packageArtifact?.checksum_sha256 || null,
    }),
    executor: Object.freeze({
      completed_before: beforeCompleted,
      completed_after: afterCompleted,
      active_after: Number(afterPerformance.body.artifact_executor?.active || 0),
      queued_after: Number(afterPerformance.body.artifact_executor?.queued || 0),
    }),
    checks,
  });
}
