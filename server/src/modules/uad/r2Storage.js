import { createHash, createHmac } from "node:crypto";

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

export function createUadObjectStorage(env = process.env) {
  const provider = String(env.UAD_OBJECT_STORAGE_PROVIDER || "r2").trim().toLowerCase();
  const config = {
    accountId: String(env.R2_ACCOUNT_ID || "").trim(),
    accessKeyId: String(env.R2_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY || "").trim(),
    bucket: String(env.R2_BUCKET || "").trim(),
    uploadTtlSeconds: Math.max(60, Math.min(Number(env.R2_UPLOAD_URL_TTL_SECONDS) || 900, 3600)),
  };
  const configured = provider === "r2" && Object.values(config).slice(0, 4).every(Boolean);

  return {
    provider,
    bucket: config.bucket || null,
    configured,
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
      const response = await fetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body,
      });
      if (!response.ok) throw new Error(`uad_object_upload_failed:${response.status}`);
      return {
        etag: response.headers.get("etag"),
        byte_size: Buffer.byteLength(body),
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
      const response = await fetch(url, { method: "HEAD" });
      if (!response.ok) throw new Error(`uad_object_verification_failed:${response.status}`);
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
      const response = await fetch(url, { method: "DELETE" });
      if (!response.ok) throw new Error(`uad_object_delete_failed:${response.status}`);
      return { deleted: true };
    },
    async getObject({ objectKey }) {
      const download = this.createDownloadUrl({ objectKey, expiresInSeconds: 60 });
      const response = await fetch(download.url, { method: download.method });
      if (!response.ok) throw new Error(`uad_object_download_failed:${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      return {
        body,
        byte_size: body.length,
        etag: response.headers.get("etag"),
        content_type: response.headers.get("content-type"),
      };
    },
  };
}
