import { readBoundedJsonResponse } from "../util/boundedResponse.js";

const DATASET_ID_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/i;
const WHERE = "propid is not null and geoid like 'R%'";
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_PAGE_BYTES = 64 * 1024 * 1024;
const MAX_STATS_BYTES = 1024 * 1024;

function sourceUrl(datasetId) {
  const id = String(datasetId || "");
  if (!DATASET_ID_PATTERN.test(id)) {
    throw new Error("collin_cad_dataset_invalid");
  }
  return new URL(`https://data.texas.gov/resource/${id}.json`);
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The request has already failed; cancellation is best effort.
  }
}

async function fetchJson(url, {
  appToken,
  fetchImpl,
  timeoutMs,
  maximumBytes,
  codePrefix,
}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = appToken ? { "X-App-Token": appToken } : {};
  let response;
  try {
    response = await fetchImpl(url, { headers, signal, redirect: "error" });
  } catch {
    throw new Error(`${codePrefix}_${signal.aborted ? "timeout" : "unavailable"}`);
  }
  if (!response?.ok) {
    await cancelBody(response);
    const status = Number(response?.status);
    const boundedStatus = Number.isInteger(status) && status >= 100 && status <= 599
      ? status : "unknown";
    throw new Error(`${codePrefix}_${boundedStatus}`);
  }
  const tooLargeCode = `${codePrefix}_response_too_large`;
  const unavailableCode = `${codePrefix}_response_unavailable`;
  try {
    return await readBoundedJsonResponse(response, {
      maximumBytes,
      tooLargeCode,
      unavailableCode,
    });
  } catch (error) {
    if (signal.aborted) throw new Error(`${codePrefix}_timeout`);
    let code;
    try { code = error?.message; } catch { /* Ignore malformed exceptions. */ }
    if (code === tooLargeCode || code === unavailableCode) throw error;
    throw new Error(`${codePrefix}_invalid_response`);
  }
}

export async function fetchCollinCadPage({
  datasetId,
  appToken = null,
  offset,
  limit,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maximumBytes = MAX_PAGE_BYTES,
}) {
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) {
    throw new Error("collin_cad_pagination_invalid");
  }
  const url = sourceUrl(datasetId);
  url.searchParams.set("$select", "propid,geoid,situsconcat,propyear");
  url.searchParams.set("$where", WHERE);
  url.searchParams.set("$order", "propid");
  url.searchParams.set("$limit", String(limit));
  url.searchParams.set("$offset", String(offset));
  const rows = await fetchJson(url, {
    appToken, fetchImpl, timeoutMs, maximumBytes,
    codePrefix: "collin_cad_open_data",
  });
  if (!Array.isArray(rows) || rows.length > limit || rows.some(
    (row) => !row || typeof row !== "object" || Array.isArray(row),
  )) {
    throw new Error("collin_cad_open_data_invalid_response");
  }
  return rows;
}

export async function fetchCollinCadCrosswalkStats({
  datasetId,
  appToken = null,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maximumBytes = MAX_STATS_BYTES,
}) {
  const url = sourceUrl(datasetId);
  url.searchParams.set("$select", "count(*) as total, count(distinct propid) as distinct_propid, count(distinct geoid) as distinct_geoid");
  url.searchParams.set("$where", WHERE);
  const payload = await fetchJson(url, {
    appToken, fetchImpl, timeoutMs, maximumBytes,
    codePrefix: "collin_cad_open_data_stats",
  });
  const stats = Array.isArray(payload) && payload.length === 1 ? payload[0] : null;
  if (!stats || typeof stats !== "object" || Array.isArray(stats) ||
      ["total", "distinct_propid", "distinct_geoid"].some(
        (key) => stats[key] === null || stats[key] === undefined || stats[key] === "",
      )) throw new Error("collin_cad_open_data_stats_invalid_response");
  const total = Number(stats?.total);
  const distinctPropertyIds = Number(stats?.distinct_propid);
  const distinctGeoIds = Number(stats?.distinct_geoid);
  if (![total, distinctPropertyIds, distinctGeoIds].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )) throw new Error("collin_cad_open_data_stats_invalid_response");
  return { total, distinctPropertyIds, distinctGeoIds };
}
