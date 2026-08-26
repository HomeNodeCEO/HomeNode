import { createHash, randomUUID } from "node:crypto";

function digest(body) {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Exercise the exact private-object path used by UAD without retaining probe
 * payloads or exposing bucket names, credentials, or object keys in output.
 */
export async function verifyUadObjectStorage(storage, {
  requireIsolated = false,
  nonce = randomUUID(),
  checkedAt = new Date().toISOString(),
} = {}) {
  if (!storage?.configured) throw new Error("uad_object_probe_storage_not_configured");
  if (requireIsolated && !storage.isolated) {
    throw new Error("uad_object_probe_storage_not_isolated");
  }

  const body = Buffer.from(JSON.stringify({ probe: "homenode-uad", nonce, checked_at: checkedAt }));
  const checksum = digest(body);
  const objectKey = `_operational-probes/${nonce}.json`;
  let uploaded = false;
  let verified = false;

  try {
    const write = await storage.putObject({
      objectKey,
      contentType: "application/json",
      body,
    });
    uploaded = true;
    if (Number(write.byte_size) !== body.length) throw new Error("uad_object_probe_write_size_mismatch");

    const head = await storage.inspectObject({ objectKey });
    if (Number(head.byte_size) !== body.length) throw new Error("uad_object_probe_head_size_mismatch");
    if (String(head.content_type || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new Error("uad_object_probe_content_type_mismatch");
    }

    const read = await storage.getObject({ objectKey, maxBytes: body.length + 1 });
    if (Number(read.byte_size) !== body.length || digest(read.body) !== checksum) {
      throw new Error("uad_object_probe_checksum_mismatch");
    }
    verified = true;
  } finally {
    if (uploaded) {
      try {
        await storage.deleteObject({ objectKey });
      } catch (error) {
        if (verified) throw new Error("uad_object_probe_cleanup_failed", { cause: error });
      }
    }
  }

  return Object.freeze({
    ok: true,
    checked_at: checkedAt,
    provider: storage.provider || null,
    isolated: Boolean(storage.isolated),
    write_verified: true,
    metadata_verified: true,
    checksum_verified: true,
    cleanup_verified: true,
  });
}
