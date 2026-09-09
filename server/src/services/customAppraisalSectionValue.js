export const CUSTOM_APPRAISAL_SECTION_MAX_BYTES = 850_000;

// Shared pure admission for ordinary section saves and neighborhood preflight.
// Re-exported from customAppraisalWorkfiles to preserve existing callers.
export function normalizeCustomAppraisalSectionValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_custom_appraisal_section_value");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > CUSTOM_APPRAISAL_SECTION_MAX_BYTES) {
    throw new Error("custom_appraisal_section_too_large");
  }
  return value;
}
