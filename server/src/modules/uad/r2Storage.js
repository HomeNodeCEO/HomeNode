import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_BUFFERED_DOWNLOAD_BYTES = 64 * 1024 * 1024;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function retryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function retryDelayMs(response, attempt, baseMs) {
  const retryAfter = String(response?.headers?.get?.("retry-after") || "").trim();
  if (/^\d+$/.test(retryAfter)) {
    return Math.min(5_000, Math.max(baseMs, Number(retryAfter) * 1_000));
  }
  return Math.min(5_000, baseMs * (2 ** Math.max(0, attempt - 1)));
}

function normalizedStorageError(operation, error) {
  const name = String(error?.name || "");
  if (["AbortError", "TimeoutError"].includes(name)) {
    return new Error(`uad_object_${operation}_timeout`);
  }
  const message = String(error?.message || "");
  if (message.startsWith("uad_object_")) return error;
  return new Error(`uad_object_${operation}_network_error`);
}

function transientStorageError(error) {
  const message = String(error?.message || "");
  if (message.endsWith("_timeout") || message.endsWith("_network_error")) return true;
  const status = Number(message.split(":").at(-1));
  return retryableStatus(status);
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value, "utf8").digest(encoding);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function objectPath(objectKey) {
  return `/${String(objectKey).split("/").map(encodeRfc3986).join("/")}`;
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signingKey(secretAccessKey, dateStamp, region = "auto", service = "s3") {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

export function sanitizeUadFileName(value) {
  const source = String(value || "upload.bin").normalize("NFKD");
  const sanitized = source
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return sanitized || "upload.bin";
}

export function buildUadObjectKey({ organizationId, workfileId, assetId, fileName }) {
  const organization = organizationId || "unassigned";
  return `organizations/${organization}/uad/${workfileId}/assets/${assetId}/${sanitizeUadFileName(fileName)}`;
}

export function buildUadGeneratedArtifactObjectKey({
  organizationId,
  workfileId,
  revisionNumber,
  artifactType,
  checksumSha256,
  fileName,
}) {
  const organization = organizationId || "unassigned";
  const revision = Math.max(1, Number(revisionNumber) || 1);
  const checksum = String(checksumSha256 || "unverified").replace(/[^a-f0-9]/gi, "").toLowerCase().slice(0, 64)
    || "unverified";
  return `organizations/${organization}/uad/${workfileId}/generated/revision-${revision}/${artifactType}/${checksum}/${sanitizeUadFileName(fileName)}`;
}

export function createR2PresignedUrl({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  objectKey,
  method = "PUT",
  contentType,
  expiresInSeconds = 900,
  now = new Date(),
}) {
  const expires = Math.max(1, Math.min(Number(expiresInSeconds) || 900, 604800));
  const host = `${bucket}.${accountId}.r2.cloudflarestorage.com`;
  const timestamp = amzTimestamp(now);
  const dateStamp = timestamp.slice(0, 8);
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const headers = contentType
    ? { "content-type": String(contentType).trim().toLowerCase(), host }
    : { host };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": timestamp,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
  const canonicalRequest = [
    method.toUpperCase(),
    objectPath(objectKey),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = hmac(signingKey(secretAccessKey, dateStamp), stringToSign, "hex");
  return `https://${host}${objectPath(objectKey)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function buildUadVerifiedAssetObjectKey({
  organizationId,
  workfileId,
  assetId,
  checksumSha256,
  fileName,
}) {
  const organization = organizationId || "unassigned";
  const checksum = String(checksumSha256 || "").replace(/[^a-f0-9]/gi, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("invalid_uad_asset_checksum");
  return `organizations/${organization}/uad/${workfileId}/verified-assets/${assetId}/${checksum}/${sanitizeUadFileName(fileName)}`;
}

export function createUadObjectStorage(env = process.env, {
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const provider = String(env.UAD_OBJECT_STORAGE_PROVIDER || "r2").trim().toLowerCase();
  const config = {
    accountId: String(env.R2_ACCOUNT_ID || "").trim(),
    accessKeyId: String(env.R2_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY || "").trim(),
    bucket: String(env.R2_BUCKET || "").trim(),
    uploadTtlSeconds: Math.max(60, Math.min(Number(env.R2_UPLOAD_URL_TTL_SECONDS) || 900, 3600)),
    requestTimeoutMs: boundedInteger(
      env.R2_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1_000,
      120_000,
    ),
    streamTimeoutMs: boundedInteger(
      env.R2_STREAM_TIMEOUT_MS,
      DEFAULT_STREAM_TIMEOUT_MS,
      5_000,
      600_000,
    ),
    maxAttempts: boundedInteger(env.R2_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, 5),
    retryBaseMs: boundedInteger(env.R2_RETRY_BASE_MS, DEFAULT_RETRY_BASE_MS, 25, 5_000),
    maxBufferedDownloadBytes: boundedInteger(
      env.R2_MAX_BUFFERED_DOWNLOAD_BYTES,
      DEFAULT_MAX_BUFFERED_DOWNLOAD_BYTES,
      1024,
      512 * 1024 * 1024,
    ),
  };
  const configured = provider === "r2" && Object.values(config).slice(0, 4).every(Boolean);

  async function request(operation, url, init = {}, {
    attempts = config.maxAttempts,
    bodyFactory = null,
    timeoutMs = config.requestTimeoutMs,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new Error(`uad_object_${operation}_network_error`);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        const body = bodyFactory ? bodyFactory() : init.body;
        response = await fetchImpl(url, {
          ...init,
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = normalizedStorageError(operation, error);
        if (attempt >= attempts || !transientStorageError(lastError)) throw lastError;
        await sleep(Math.min(5_000, config.retryBaseMs * (2 ** (attempt - 1))));
        continue;
      }
      if (response.ok) return response;
      lastError = new Error(`uad_object_${operation}_failed:${response.status}`);
      if (attempt >= attempts || !retryableStatus(response.status)) throw lastError;
      await response.body?.cancel?.().catch(() => undefined);
      await sleep(retryDelayMs(response, attempt, config.retryBaseMs));
    }
    throw lastError || new Error(`uad_object_${operation}_network_error`);
  }

  async function readBoundedResponse(response, maximumBytes) {
    const maximum = boundedInteger(
      maximumBytes,
      config.maxBufferedDownloadBytes,
      1,
      512 * 1024 * 1024,
    );
    const contentLength = response.headers.get("content-length");
    const advertisedKnown = /^\d+$/.test(String(contentLength || ""));
    const advertised = advertisedKnown ? Number(contentLength) : 0;
    if (advertisedKnown && advertised > maximum) {
      await response.body?.cancel?.().catch(() => undefined);
      throw new Error("uad_object_download_too_large");
    }
    const reader = response.body?.getReader?.();
    if (!reader) {
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > maximum) throw new Error("uad_object_download_too_large");
      if (advertisedKnown && body.length !== advertised) {
        throw new Error("uad_object_download_size_mismatch");
      }
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
        throw new Error("uad_object_download_too_large");
      }
      chunks.push(Buffer.from(value));
    }
    if (advertisedKnown && bytes !== advertised) {
      throw new Error("uad_object_download_size_mismatch");
    }
    return Buffer.concat(chunks, bytes);
  }

  return {
    provider,
    bucket: config.bucket || null,
    configured,
    resilience: Object.freeze({
      request_timeout_ms: config.requestTimeoutMs,
      stream_timeout_ms: config.streamTimeoutMs,
      max_attempts: config.maxAttempts,
      max_buffered_download_bytes: config.maxBufferedDownloadBytes,
    }),
    createUploadUrl({ objectKey, contentType }) {
      if (!configured) throw new Error("uad_object_storage_not_configured");
      return {
        method: "PUT",
        url: createR2PresignedUrl({
          ...config,
          objectKey,
          contentType,
          expiresInSeconds: config.uploadTtlSeconds,
        }),
        headers: { "content-type": contentType },
        expires_in_seconds: config.uploadTtlSeconds,
      };
    },
    createDownloadUrl({ objectKey, expiresInSeconds = 300 }) {
      if (!configured) throw new Error("uad_object_storage_not_configured");
      return {
        method: "GET",
        url: createR2PresignedUrl({
          ...config,
          objectKey,
          method: "GET",
          expiresInSeconds,
        }),
        expires_in_seconds: Math.max(1, Math.min(Number(expiresInSeconds) || 300, 604800)),
      };
    },
    async putObject({ objectKey, contentType, body }) {
      const upload = this.createUploadUrl({ objectKey, contentType });
      const response = await request("upload", upload.url, {
        method: upload.method,
        headers: upload.headers,
        body,
      });
      return {
        etag: response.headers.get("etag"),
        byte_size: Buffer.byteLength(body),
        content_type: contentType,
      };
    },
    async putFile({ objectKey, contentType, filePath, byteSize }) {
      if (!configured) throw new Error("uad_object_storage_not_configured");
      const file = await stat(filePath);
      const size = Number(byteSize ?? file.size);
      if (!Number.isSafeInteger(size) || size < 0 || file.size !== size) {
        throw new Error("uad_object_upload_size_mismatch");
      }
      const upload = this.createUploadUrl({ objectKey, contentType });
      const response = await request("upload", upload.url, {
        method: upload.method,
        headers: { ...upload.headers, "content-length": String(size) },
        duplex: "half",
      }, {
        bodyFactory: () => createReadStream(filePath),
        timeoutMs: config.streamTimeoutMs,
      });
      return {
        etag: response.headers.get("etag"),
        byte_size: size,
        content_type: contentType,
      };
    },
    async inspectObject({ objectKey }) {
      if (!configured) throw new Error("uad_object_storage_not_configured");
      const url = createR2PresignedUrl({
        ...config,
        objectKey,
        method: "HEAD",
        expiresInSeconds: 60,
      });
      const response = await request("verification", url, { method: "HEAD" });
      return {
        byte_size: Number(response.headers.get("content-length") || 0),
        etag: response.headers.get("etag"),
        content_type: response.headers.get("content-type"),
      };
    },
    async deleteObject({ objectKey }) {
      if (!configured) throw new Error("uad_object_storage_not_configured");
      const url = createR2PresignedUrl({
        ...config,
        objectKey,
        method: "DELETE",
        expiresInSeconds: 60,
      });
      await request("delete", url, { method: "DELETE" });
      return { deleted: true };
    },
    async getObject({ objectKey, maxBytes }) {
      const download = this.createDownloadUrl({ objectKey, expiresInSeconds: 60 });
      const response = await request("download", download.url, { method: download.method });
      const body = await readBoundedResponse(response, maxBytes);
      return {
        body,
        byte_size: body.length,
        etag: response.headers.get("etag"),
        content_type: response.headers.get("content-type"),
      };
    },
    async downloadObjectToFile({ objectKey, filePath, maxBytes }) {
      if (!configured) throw new Error("uad_object_storage_not_configured");
      const maximum = boundedInteger(maxBytes, 512 * 1024 * 1024, 1, 512 * 1024 * 1024);
      const download = this.createDownloadUrl({ objectKey, expiresInSeconds: 60 });
      let lastError = null;
      for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
        try {
          await rm(filePath, { force: true }).catch(() => undefined);
          const response = await request("download", download.url, {
            method: download.method,
          }, { attempts: 1, timeoutMs: config.streamTimeoutMs });
          const contentLength = response.headers.get("content-length");
          const advertisedKnown = /^\d+$/.test(String(contentLength || ""));
          const advertised = advertisedKnown ? Number(contentLength) : 0;
          if (advertisedKnown && advertised > maximum) {
            await response.body?.cancel?.().catch(() => undefined);
            throw new Error("uad_object_download_too_large");
          }
          if (!response.body) throw new Error("uad_object_download_network_error");
          let bytes = 0;
          const digest = createHash("sha256");
          const meter = new Transform({
            transform(chunk, _encoding, callback) {
              bytes += chunk.length;
              if (bytes > maximum) {
                callback(new Error("uad_object_download_too_large"));
                return;
              }
              digest.update(chunk);
              callback(null, chunk);
            },
          });
          await pipeline(
            Readable.fromWeb(response.body),
            meter,
            createWriteStream(filePath, { flags: "w" }),
          );
          if (advertisedKnown && bytes !== advertised) {
            throw new Error("uad_object_download_size_mismatch");
          }
          return {
            file_path: filePath,
            byte_size: bytes,
            checksum_sha256: digest.digest("hex"),
            etag: response.headers.get("etag"),
            content_type: response.headers.get("content-type"),
          };
        } catch (error) {
          await rm(filePath, { force: true }).catch(() => undefined);
          lastError = normalizedStorageError("download", error);
          if (attempt >= config.maxAttempts || !transientStorageError(lastError)) throw lastError;
          await sleep(Math.min(5_000, config.retryBaseMs * (2 ** (attempt - 1))));
        }
      }
      throw lastError || new Error("uad_object_download_network_error");
    },
  };
}
