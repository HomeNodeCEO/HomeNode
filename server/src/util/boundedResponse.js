async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is already rejected; cancellation is best-effort cleanup.
  }
}

export async function readBoundedResponseBuffer(response, {
  maximumBytes,
  tooLargeCode = "response_too_large",
  unavailableCode = "response_body_unavailable",
} = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("invalid_response_byte_limit");
  }
  const contentLength = response?.headers?.get?.("content-length")?.trim();
  const advertisedBytes = /^\d+$/.test(contentLength || "")
    ? Number(contentLength)
    : null;
  if (advertisedBytes != null && advertisedBytes > maximumBytes) {
    await cancelResponseBody(response);
    throw new Error(tooLargeCode);
  }

  const body = response?.body;
  if (!body || response?.bodyUsed || body.locked || typeof body.getReader !== "function") {
    throw new Error(unavailableCode);
  }
  let reader;
  try {
    reader = body.getReader();
  } catch {
    throw new Error(unavailableCode);
  }
  let buffer = Buffer.allocUnsafe(Math.max(
    1,
    Math.min(maximumBytes, advertisedBytes || 64 * 1024),
  ));
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        try {
          await reader.cancel();
        } catch {
          // The response is already rejected; cancellation is best-effort cleanup.
        }
        throw new Error(unavailableCode);
      }
      if (!value.byteLength) continue;
      const nextTotal = totalBytes + value.byteLength;
      if (nextTotal > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read has already failed; cancellation is best-effort cleanup.
        }
        throw new Error(tooLargeCode);
      }
      if (nextTotal > buffer.length) {
        const expanded = Buffer.allocUnsafe(Math.min(
          maximumBytes,
          Math.max(nextTotal, buffer.length * 2),
        ));
        buffer.copy(expanded, 0, 0, totalBytes);
        buffer = expanded;
      }
      buffer.set(value, totalBytes);
      totalBytes = nextTotal;
    }
  } finally {
    reader.releaseLock();
  }
  if (!totalBytes) return Buffer.alloc(0);
  return totalBytes === buffer.length
    ? buffer
    : Buffer.from(buffer.subarray(0, totalBytes));
}

export async function readBoundedJsonResponse(response, options) {
  const buffer = await readBoundedResponseBuffer(response, options);
  return JSON.parse(buffer.toString("utf8"));
}
