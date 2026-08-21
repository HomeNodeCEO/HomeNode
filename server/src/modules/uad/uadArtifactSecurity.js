import { buildDeterministicZip } from "./uadDeliveryPackage.js";
import { inspectUadAssetPayload } from "./uadFileSecurity.js";
import { validateUadSubschema } from "./uadSubschema.js";

const PNG_PROBE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function rejects(callback, errorCode) {
  try {
    callback();
    return false;
  } catch (error) {
    return String(error?.message || "") === errorCode;
  }
}

async function rejectsAsync(callback, errorCode) {
  try {
    await callback();
    return false;
  } catch (error) {
    return String(error?.message || "") === errorCode;
  }
}

export async function runUadArtifactSecurityChecks({ checkedAt = new Date().toISOString() } = {}) {
  const validPng = inspectUadAssetPayload(PNG_PROBE, "image/png");
  const imageBomb = Buffer.from(PNG_PROBE);
  imageBomb.writeUInt32BE(20_001, 16);
  const mimeSpoofRejected = rejects(
    () => inspectUadAssetPayload(Buffer.alloc(PNG_PROBE.length, 0x41), "image/png"),
    "invalid_uad_asset_content_type_mismatch",
  );
  const imageBombRejected = rejects(
    () => inspectUadAssetPayload(imageBomb, "image/png"),
    "invalid_uad_asset_image_dimensions",
  );
  const activePdfRejected = rejects(
    () => inspectUadAssetPayload(Buffer.from("%PDF-1.7\n1 0 obj <</OpenAction 2 0 R>>", "ascii"), "application/pdf"),
    "invalid_uad_asset_pdf_active_content",
  );
  const safeZip = buildDeterministicZip([
    { path: "report.xml", body: "<MESSAGE/>" },
    { path: "Images/front.png", body: PNG_PROBE },
  ]);
  const unsafePaths = ["../escape", "C:/escape", "Images//empty", "Images/CON.txt", "Images/name:stream"];
  const unsafePathsRejected = unsafePaths.every((path) => rejects(
    () => buildDeterministicZip([{ path, body: "x" }]),
    "uad_package_entry_path_invalid",
  ));
  const portableCollisionRejected = rejects(
    () => buildDeterministicZip([{ path: "Report.xml", body: "a" }, { path: "report.xml", body: "b" }]),
    "uad_package_entry_duplicate",
  );
  const dtdRejected = await rejectsAsync(
    () => validateUadSubschema('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'),
    "uad_xml_dtd_forbidden",
  );
  const processingInstructionRejected = await rejectsAsync(
    () => validateUadSubschema('<?xml version="1.0"?><?xml-stylesheet href="https://invalid.example/x"?><MESSAGE/>'),
    "uad_xml_processing_instruction_forbidden",
  );
  const checks = Object.freeze({
    verified_asset_payload: Object.freeze({
      ready: validPng.byte_size === PNG_PROBE.length
        && validPng.dimensions?.pixels === 1
        && mimeSpoofRejected
        && imageBombRejected
        && activePdfRejected,
      valid_png_identified: validPng.dimensions?.pixels === 1,
      mime_spoof_rejected: mimeSpoofRejected,
      image_bomb_rejected: imageBombRejected,
      active_pdf_rejected: activePdfRejected,
    }),
    deterministic_package: Object.freeze({
      ready: safeZip.entry_count === 2 && unsafePathsRejected && portableCollisionRejected,
      safe_entry_count: safeZip.entry_count,
      unsafe_path_count: unsafePaths.length,
      unsafe_paths_rejected: unsafePathsRejected,
      portable_collision_rejected: portableCollisionRejected,
    }),
    local_xml_parser: Object.freeze({
      ready: dtdRejected && processingInstructionRejected,
      dtd_rejected: dtdRejected,
      processing_instruction_rejected: processingInstructionRejected,
    }),
  });
  return Object.freeze({
    ok: Object.values(checks).every((check) => check.ready === true),
    profile: "uad_redteam_artifact_security_v1",
    checked_at: checkedAt,
    checks,
  });
}
