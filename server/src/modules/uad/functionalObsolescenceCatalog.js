export const UAD_FUNCTIONAL_ISSUE_TYPES = Object.freeze([
  "CeilingHeight",
  "FloorPlan",
  "NonConformity",
  "None",
  "Other",
  "Overimprovement",
  "Underimprovement",
]);

export const UAD_FUNCTIONAL_OBSOLESCENCE_CAPTION_TYPES = Object.freeze([
  "FunctionalObsolescenceExhibit",
]);

export const UAD_FUNCTIONAL_OBSOLESCENCE_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

const functionalIssueExists = Object.freeze({
  all: [
    { key: "functional_obsolescence:3600.0002", present: true },
    { not: { key: "functional_obsolescence:3600.0002", contains: "None" } },
  ],
});

export const UAD_FUNCTIONAL_OBSOLESCENCE_FIELDS = Object.freeze([
  {
    section: "functional_obsolescence",
    group: "Functional issues",
    contextKey: "functional_obsolescence",
    uid: "3600.0002",
    reportFieldId: "11.000",
    label: "Functional issues",
    dataType: "multi_enum",
    required: true,
    options: UAD_FUNCTIONAL_ISSUE_TYPES,
  },
  {
    section: "functional_obsolescence",
    group: "Functional issues",
    contextKey: "functional_obsolescence",
    uid: "3600.0003",
    reportFieldId: "11.000",
    label: "Other functional issue",
    dataType: "string",
    maxLength: 33,
    showWhen: { key: "functional_obsolescence:3600.0002", contains: "Other" },
    requiredWhen: { key: "functional_obsolescence:3600.0002", contains: "Other" },
  },
  {
    section: "functional_obsolescence",
    group: "Functional obsolescence commentary",
    contextKey: "functional_obsolescence_commentary",
    uid: "3600.0006",
    reportFieldId: "11.001",
    label: "Functional obsolescence commentary",
    dataType: "text",
    maxLength: 5000,
    requiredWhen: functionalIssueExists,
  },
]);

export function isVerifiedFunctionalObsolescenceAsset(asset) {
  return asset?.section_number === 11
    && asset?.status === "verified"
    && asset?.caption_type === "FunctionalObsolescenceExhibit"
    && UAD_FUNCTIONAL_OBSOLESCENCE_IMAGE_CONTENT_TYPES.includes(
      String(asset?.content_type || "").toLowerCase(),
    );
}

export { functionalIssueExists };
