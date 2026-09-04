import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 5_000;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
]) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}

function normalizedHostname(url) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function parsePublicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.href.length > 2_048 || url.protocol !== "https:") return null;
    if (url.username || url.password || (url.port && url.port !== "443")) return null;
    const hostname = normalizedHostname(url);
    if (!hostname || hostname.includes("%")) return null;
    if (
      hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || hostname.endsWith(".internal")
      || hostname.endsWith(".lan")
      || hostname.endsWith(".home")
    ) return null;
    return url;
  } catch {
    return null;
  }
}

export function isPublicNetworkAddress(address) {
  const family = isIP(String(address || ""));
  if (family === 4) return !blockedIpv4.check(address, "ipv4");
  if (family === 6) return !blockedIpv6.check(address, "ipv6");
  return false;
}

async function resolvePublicTarget(url, lookupImpl) {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) throw new Error("remote_image_dns_unavailable");
  const normalized = records.map((record) => ({
    address: String(record?.address || ""),
    family: Number(record?.family || isIP(record?.address)),
  }));
  if (normalized.some((record) => !isPublicNetworkAddress(record.address))) {
    throw new Error("remote_image_private_destination");
  }
  const selected = normalized.find((record) => record.family === 4) || normalized[0];
  if (![4, 6].includes(selected.family)) throw new Error("remote_image_dns_invalid");
  return { hostname, ...selected };
}

function pinnedLookup(target) {
  return (hostname, options, callback) => {
    if (String(hostname).toLowerCase().replace(/\.$/, "") !== target.hostname) {
      callback(new Error("remote_image_hostname_changed"));
      return;
    }
    if (options?.all) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

function openPinnedHttpsResponse({ url, target, signal }) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "GET",
      headers: { accept: "image/jpeg, image/png" },
      agent: false,
      lookup: pinnedLookup(target),
      signal,
    }, resolve);
    request.on("error", reject);
    request.end();
  });
}

function responseHeader(response, name) {
  const value = response?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("remote_image_timeout"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("remote_image_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

async function readBoundedResponse(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy?.();
      throw new Error("remote_image_too_large");
    }
    chunks.push(chunk);
  }
  return total > 0 ? Buffer.concat(chunks, total) : null;
}

function hasExpectedImageSignature(buffer, contentType) {
  if (!buffer) return false;
  if (contentType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (contentType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return false;
}

export async function loadRemoteImage(urlValue, {
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  lookup = dnsLookup,
  openResponse = openPinnedHttpsResponse,
} = {}) {
  let url = parsePublicHttpsUrl(urlValue);
  if (!url || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const target = await withAbort(resolvePublicTarget(url, lookup), controller.signal);
      const response = await withAbort(openResponse({ url, target, signal: controller.signal }), controller.signal);
      const status = Number(response?.statusCode || 0);
      if (REDIRECT_STATUSES.has(status)) {
        response.destroy?.();
        if (redirects >= maxRedirects) return null;
        const location = String(responseHeader(response, "location") || "").trim();
        if (!location) return null;
        url = parsePublicHttpsUrl(new URL(location, url));
        if (!url) return null;
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy?.();
        return null;
      }
      const contentType = String(responseHeader(response, "content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        response.destroy?.();
        return null;
      }
      const declaredValue = responseHeader(response, "content-length");
      if (declaredValue != null && !/^\d+$/.test(String(declaredValue).trim())) {
        response.destroy?.();
        return null;
      }
      const declared = declaredValue == null ? 0 : Number(declaredValue);
      if (!Number.isSafeInteger(declared) || declared > maxBytes) {
        response.destroy?.();
        return null;
      }
      const buffer = await readBoundedResponse(response, maxBytes);
      return hasExpectedImageSignature(buffer, contentType) ? buffer : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
