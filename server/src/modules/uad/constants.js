export const CURRENT_UAD_RELEASE_KEY = "uad-3.6-2026-08-13-h1.5";

export const UAD_ROLE_CODES = Object.freeze([
  "appraiser",
  "supervisory_appraiser",
  "reviewer",
  "organization_admin",
  "homenode_admin",
]);

export const UAD_WORKFILE_STATUSES = Object.freeze([
  "draft",
  "validating",
  "ready",
  "signed",
  "exported",
  "submitted",
  "revised",
  "cancelled",
]);

export const UAD_ASSET_KINDS = Object.freeze([
  "photo",
  "image",
  "sketch",
  "floor_plan",
  "measurement_source",
  "supporting_document",
  "signature",
]);

export const INITIAL_UAD_PROPERTY_TYPE = "traditional_single_family";
export const INITIAL_UAD_INSPECTION_METHOD = "traditional";
