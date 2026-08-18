export const UAD_HIGHEST_BEST_USE_CAPTION_TYPES = Object.freeze([
  "HighestAndBestUseExhibit",
]);

export const UAD_HIGHEST_BEST_USE_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

const anyHighestBestUseAnswerIsNo = Object.freeze({
  any: [
    { key: "highest_best_use:3100.0004", equals: false },
    { key: "highest_best_use:3100.0006", equals: false },
    { key: "highest_best_use:3100.0003", equals: false },
    { key: "highest_best_use:3100.0005", equals: false },
    { key: "highest_best_use:3100.0007", equals: false },
  ],
});

const field = (group, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "highest_best_use",
  group,
  contextKey: "highest_best_use",
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

export const UAD_HIGHEST_BEST_USE_FIELDS = Object.freeze([
  field(
    "Four tests of present or proposed use",
    "3100.0004",
    "16.000",
    "Legally permissible",
    "boolean",
    {
      required: true,
      guidance: "Indicate whether the current or proposed improvements are legally allowed, with particular attention to zoning.",
    },
  ),
  field(
    "Four tests of present or proposed use",
    "3100.0006",
    "16.001",
    "Physically possible",
    "boolean",
    {
      required: true,
      guidance: "Indicate whether the current or proposed improvements are physically possible on the site.",
    },
  ),
  field(
    "Four tests of present or proposed use",
    "3100.0003",
    "16.002",
    "Financially feasible",
    "boolean",
    {
      required: true,
      guidance: "Indicate whether the current or proposed improvements are financially feasible.",
    },
  ),
  field(
    "Four tests of present or proposed use",
    "3100.0005",
    "16.003",
    "Maximally productive",
    "boolean",
    {
      required: true,
      guidance: "Indicate whether the current or proposed improvements are maximally productive.",
    },
  ),
  field(
    "Highest and best use conclusion",
    "3100.0007",
    "16.004",
    "Is the present or proposed use the highest and best use?",
    "boolean",
    {
      required: true,
      guidance: "Answer after considering all four tests. This conclusion also redisplays in URAR Summary field 1.024.",
    },
  ),
  {
    section: "highest_best_use",
    group: "Highest and best use commentary",
    contextKey: "highest_best_use_commentary",
    uid: "3100.0010",
    reportFieldId: "16.005",
    label: "Highest and best use commentary",
    dataType: "text",
    maxLength: 5000,
    requiredWhen: anyHighestBestUseAnswerIsNo,
    guidance: "When any answer is No, describe the evidence and support for the conclusion. Additional analysis, including highest and best use as vacant, may also be documented here.",
  },
]);

export const UAD_HIGHEST_BEST_USE_FIELD_KEYS = Object.freeze({
  legallyPermissible: "highest_best_use:3100.0004",
  physicallyPossible: "highest_best_use:3100.0006",
  financiallyFeasible: "highest_best_use:3100.0003",
  maximallyProductive: "highest_best_use:3100.0005",
  presentUseIsHighestBest: "highest_best_use:3100.0007",
  commentary: "highest_best_use_commentary:3100.0010",
});

export function isVerifiedHighestBestUseAsset(asset) {
  return asset?.section_number === 16
    && asset?.status === "verified"
    && UAD_HIGHEST_BEST_USE_CAPTION_TYPES.includes(asset?.caption_type)
    && UAD_HIGHEST_BEST_USE_IMAGE_CONTENT_TYPES.includes(
      String(asset?.content_type || "").toLowerCase(),
    );
}

export { anyHighestBestUseAnswerIsNo };
