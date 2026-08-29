const sketchProvided = Object.freeze({ key: "sketch:3300.0002", equals: true });
const sketchNotProvided = Object.freeze({ key: "sketch:3300.0002", equals: false });
const otherMeasurementStandard = Object.freeze({ key: "sketch:3300.0007", equals: "Other" });

export const UAD_SKETCH_REPORT_CAPTION_TYPES = Object.freeze([
  "SubjectPropertyImprovementSketch",
  "FloorPlan",
]);

export const UAD_SKETCH_REPORT_CONTENT_TYPES = Object.freeze([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

export function isVerifiedSketchReportAsset(asset) {
  return asset?.section_number === 7
    && asset?.status === "verified"
    && UAD_SKETCH_REPORT_CAPTION_TYPES.includes(asset?.caption_type)
    && UAD_SKETCH_REPORT_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export const UAD_SKETCH_FIELDS = [
  {
    section: "sketch",
    group: "Sketch availability",
    contextKey: "sketch",
    uid: "3300.0002",
    reportFieldId: "7.000",
    label: "Sketch or floor plan provided",
    dataType: "boolean",
    required: true,
  },
  {
    section: "sketch",
    group: "Measurement standard",
    contextKey: "sketch",
    uid: "3300.0007",
    reportFieldId: "7.001",
    label: "Measurement standard",
    dataType: "enum",
    options: ["AmericanNationalStandardsInstitute", "AmericanMeasurementStandard", "Other"],
    showWhen: sketchProvided,
    requiredWhen: sketchProvided,
  },
  {
    section: "sketch",
    group: "Measurement standard",
    contextKey: "sketch",
    uid: "3300.0008",
    reportFieldId: "7.001",
    label: "Other measurement standard",
    dataType: "string",
    maxLength: 50,
    showWhen: otherMeasurementStandard,
    requiredWhen: otherMeasurementStandard,
  },
  {
    section: "sketch",
    group: "Sketch commentary",
    contextKey: "sketch_commentary",
    uid: "3300.0010",
    reportFieldId: "7.003",
    label: "Sketch commentary",
    dataType: "text",
    maxLength: 5000,
    requiredWhen: { any: [sketchNotProvided, otherMeasurementStandard] },
    guidance: "When another measurement standard is required by law or regulation, identify it and explain how it was applied.",
  },
];

export { otherMeasurementStandard, sketchNotProvided, sketchProvided };
