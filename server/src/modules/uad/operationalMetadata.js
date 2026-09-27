const VERIFICATION_CODES = new Set([
  "uploaded_object_does_not_match_request",
  "invalid_uad_asset_body_type",
  "invalid_uad_asset_byte_size",
  "invalid_uad_asset_content_type_mismatch",
  "invalid_uad_asset_content_type",
  "invalid_uad_asset_image_dimensions",
  "invalid_uad_asset_json_bytes",
  "invalid_uad_asset_json_complexity",
  "invalid_uad_asset_json",
  "invalid_uad_asset_pdf_active_content",
  "invalid_uad_asset_pdf_annotation_count",
  "invalid_uad_asset_pdf_page_count",
  "invalid_uad_asset_pdf_structure",
  "invalid_uad_uploaded_asset",
]);

function errorMessage(value) {
  try {
    return typeof value === "string" ? value : value?.message;
  } catch {
    return null;
  }
}

export function boundedUadVerificationError(value) {
  const message = errorMessage(value);
  return VERIFICATION_CODES.has(message) ? message : "invalid_uad_uploaded_asset";
}

export function uadUploadFailureMetadata() {
  return { upload_error: "uad_object_upload_failed" };
}

export function publicUadAssetCaptureMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = { ...value };
  if (metadata.verification_error != null) {
    metadata.verification_error = boundedUadVerificationError(metadata.verification_error);
  }
  return metadata;
}

export function publicUadArtifactMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = { ...value };
  // Older rows can contain provider messages and internal cleanup object keys.
  // Neither is part of the report artifact or needed by the client.
  if (metadata.upload_error != null) metadata.upload_error = "uad_object_upload_failed";
  delete metadata.cleanup_pending_object_keys;
  return metadata;
}
