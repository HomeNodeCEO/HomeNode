import { readBoundedJsonResponse } from "../util/boundedResponse.js";

const AZURE_API_VERSION = "2024-11-30";
const AZURE_MODEL_ID = "prebuilt-read";
const MAX_OCR_ERROR_RESPONSE_BYTES = 256 * 1024;
const MAX_OCR_RESULT_RESPONSE_BYTES = 32 * 1024 * 1024;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function cleanEndpoint(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("document_ocr_endpoint_invalid");
  }
  if (url.protocol !== "https:") throw new Error("document_ocr_endpoint_must_use_https");
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("document_ocr_endpoint_invalid");
  }
  return url;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response headers have already been consumed; cancellation is best-effort cleanup.
  }
}

async function fetchWithTimeout(url, init, timeoutMs, unavailableCode) {
  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), timeoutMs);
  const finish = () => {
    if (timeout == null) return;
    clearTimeout(timeout);
    timeout = null;
  };
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    return { response, finish };
  } catch {
    finish();
    throw new Error(unavailableCode);
  }
}

function responseError(status, payload, fallback) {
  const safeStatus = Number.isInteger(status) ? status : "unknown";
  const rawProviderCode = String(payload?.error?.code || "");
  const providerCode = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawProviderCode)
    ? `_${rawProviderCode}`
    : "";
  return new Error(`${fallback}_http_${safeStatus}${providerCode}`);
}

async function readProviderJson(
  response,
  maximumBytes,
  errorPrefix,
  { optional = false } = {},
) {
  const tooLargeCode = `${errorPrefix}_response_too_large`;
  const unavailableCode = `${errorPrefix}_response_unavailable`;
  try {
    return await readBoundedJsonResponse(response, {
      maximumBytes,
      tooLargeCode,
      unavailableCode,
    });
  } catch (error) {
    const code = String(error?.message || "");
    if (code === tooLargeCode) throw new Error(code);
    if (optional) return {};
    if (code === unavailableCode) throw new Error(code);
    throw new Error(`${errorPrefix}_invalid_response`);
  }
}

function trustedOperationUrl(operationLocation, endpoint) {
  let resultUrl;
  try {
    resultUrl = new URL(String(operationLocation || ""));
  } catch {
    throw new Error("document_ocr_operation_location_untrusted");
  }
  const pathPrefix =
    `/documentintelligence/documentModels/${AZURE_MODEL_ID}/analyzeResults/`;
  const operation = resultUrl.pathname.slice(pathPrefix.length);
  if (
    resultUrl.origin !== endpoint.origin
    || resultUrl.username
    || resultUrl.password
    || resultUrl.hash
    || !resultUrl.pathname.startsWith(pathPrefix)
    || !/^[A-Za-z0-9._~-]{1,256}$/.test(operation)
    || resultUrl.searchParams.get("api-version") !== AZURE_API_VERSION
  ) {
    throw new Error("document_ocr_operation_location_untrusted");
  }
  return resultUrl;
}

function pageTextFromResult(result = {}) {
  const analyzeResult = result.analyzeResult || {};
  const fullText = String(analyzeResult.content || "");
  const paragraphs = Array.isArray(analyzeResult.paragraphs) ? analyzeResult.paragraphs : [];
  const pages = Array.isArray(analyzeResult.pages) ? analyzeResult.pages : [];
  return pages
    .slice()
    .sort((left, right) => Number(left?.pageNumber || 0) - Number(right?.pageNumber || 0))
    .map((page) => {
      if (Array.isArray(page?.lines) && page.lines.length) {
        return page.lines.map((line) => String(line?.content || "").trim()).filter(Boolean).join("\n");
      }
      if (Array.isArray(page?.spans) && page.spans.length && fullText) {
        return page.spans
          .map((span) => fullText.slice(Number(span?.offset || 0), Number(span?.offset || 0) + Number(span?.length || 0)))
          .join("\n")
          .trim();
      }
      const pageNumber = Number(page?.pageNumber || 0);
      return paragraphs
        .filter((paragraph) => Array.isArray(paragraph?.boundingRegions)
          && paragraph.boundingRegions.some((region) => Number(region?.pageNumber || 0) === pageNumber))
        .map((paragraph) => String(paragraph?.content || "").trim())
        .filter(Boolean)
        .join("\n");
    });
}

function operationId(operationLocation) {
  const match = String(operationLocation || "").match(/\/analyzeResults\/([^/?]+)/i);
  return match?.[1] || null;
}

export function createDocumentOcrProvider(env = process.env) {
  const provider = String(env.DOCUMENT_OCR_PROVIDER || "disabled").trim().toLowerCase();
  const endpoint = provider === "azure"
    ? cleanEndpoint(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT)
    : null;
  const key = String(env.AZURE_DOCUMENT_INTELLIGENCE_KEY || "").trim();
  const configured = provider === "azure" && Boolean(endpoint && key);
  const pollIntervalMs = boundedInteger(env.DOCUMENT_OCR_POLL_INTERVAL_MS, 2_000, 500, 10_000);
  const maximumPollMs = boundedInteger(env.DOCUMENT_OCR_MAX_POLL_MS, 120_000, 10_000, 300_000);
  const requestTimeoutMs = boundedInteger(env.DOCUMENT_OCR_REQUEST_TIMEOUT_MS, 30_000, 5_000, 120_000);

  return {
    provider,
    configured,
    model_id: configured ? AZURE_MODEL_ID : null,
    api_version: configured ? AZURE_API_VERSION : null,
    async analyzePdf(content) {
      if (!configured) throw new Error("document_ocr_not_configured");
      if (!Buffer.isBuffer(content) || content.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("document_not_pdf");
      }
      const analyzeUrl = new URL(
        `/documentintelligence/documentModels/${AZURE_MODEL_ID}:analyze`,
        endpoint,
      );
      analyzeUrl.searchParams.set("api-version", AZURE_API_VERSION);
      analyzeUrl.searchParams.set("stringIndexType", "utf16CodeUnit");
      const submittedRequest = await fetchWithTimeout(analyzeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/pdf",
          "ocp-apim-subscription-key": key,
        },
        body: content,
      }, requestTimeoutMs, "document_ocr_submit_unavailable");
      const submitted = submittedRequest.response;
      let operationLocation;
      let resultUrl;
      try {
        if (submitted.status !== 202) {
          const payload = await readProviderJson(
            submitted,
            MAX_OCR_ERROR_RESPONSE_BYTES,
            "document_ocr_submit",
            { optional: true },
          );
          throw responseError(submitted.status, payload, "document_ocr_submit_failed");
        }
        operationLocation = submitted.headers.get("operation-location");
        await cancelResponseBody(submitted);
        if (!operationLocation) throw new Error("document_ocr_operation_location_missing");
        resultUrl = trustedOperationUrl(operationLocation, endpoint);
      } finally {
        submittedRequest.finish();
      }
      const deadline = Date.now() + maximumPollMs;
      let result = null;
      while (Date.now() < deadline) {
        const pollRequest = await fetchWithTimeout(resultUrl, {
          method: "GET",
          headers: { "ocp-apim-subscription-key": key },
        }, requestTimeoutMs, "document_ocr_poll_unavailable");
        const response = pollRequest.response;
        let payload;
        try {
          if (!response.ok) {
            const errorPayload = await readProviderJson(
              response,
              MAX_OCR_ERROR_RESPONSE_BYTES,
              "document_ocr_poll",
              { optional: true },
            );
            throw responseError(response.status, errorPayload, "document_ocr_poll_failed");
          }
          payload = await readProviderJson(
            response,
            MAX_OCR_RESULT_RESPONSE_BYTES,
            "document_ocr_poll",
          );
        } finally {
          pollRequest.finish();
        }
        const status = String(payload.status || "").toLowerCase();
        if (status === "succeeded") {
          result = payload;
          break;
        }
        if (status === "failed" || status === "canceled") {
          throw new Error("document_ocr_analysis_failed");
        }
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? boundedInteger(retryAfterSeconds * 1_000, pollIntervalMs, 500, 10_000)
          : pollIntervalMs;
        await sleep(Math.min(retryAfterMs, Math.max(0, deadline - Date.now())));
      }
      if (!result) throw new Error("document_ocr_poll_timeout");
      const pages = pageTextFromResult(result);
      return {
        provider: "azure_document_intelligence",
        extraction_method: "azure_document_intelligence_read",
        model_id: AZURE_MODEL_ID,
        api_version: AZURE_API_VERSION,
        operation_id: operationId(operationLocation),
        page_count: pages.length,
        pages,
      };
    },
  };
}

export const documentOcrInternals = Object.freeze({
  MAX_OCR_ERROR_RESPONSE_BYTES,
  MAX_OCR_RESULT_RESPONSE_BYTES,
});
