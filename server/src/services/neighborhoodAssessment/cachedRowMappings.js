import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from "./contract.js";
import { finiteNumberOrNull } from "./statistics.js";
import { assertNeighborhoodJsonbStorage } from "./jsonbStorage.js";

export const CACHED_ROW_MAPPING_VERSION = 1;
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// Explicit local SQL projection vocabulary. No provider raw_payload/private
// remarks are retained. Optional unavailable columns stay absent, not defaulted.
export const CACHED_ROW_PROJECTION_FIELDS = freeze({
  parcel: ["object_id", "account_id", "low_parcel_id", "site_address", "residential_year_built",
    "residential_area_sqft", "parcel_area_sqft", "current_market_value", "land_use_category",
    "classification_confidence", "classification_review_reason", "subdivision_name",
    "source_record_hash", "source_updated_at", "sync_run_id", "synced_at",
    "stored_geometry_ewkb", "stored_geometry_geojson"],
  account: ["account_id", "county", "subdivision", "neighborhood_code", "legal_description"],
  sale: ["source_record_id", "source_name", "source_filename", "source_sha256", "source_record_hash",
    "transaction_fingerprint", "listing_key", "listing_id", "source_system_name", "source_modified_at",
    "source_loaded_at", "source_updated_at", "primary_account_id", "record_type", "source_close_date",
    "listing_contract_date", "source_current_price", "source_living_area", "parcel_number_raw",
    "parcel_number2_raw", "match_status", "has_multiple_parcel_numbers", "multi_parcel_status",
    "has_unresolved_parcel", "requires_additional_review", "data_quality_flags",
    "sale_id", "sale_account_id", "sale_closing_date", "sale_price", "sale_source", "sale_loaded_at"],
  sale_link: ["parcel_link_id", "source_record_id", "source_position", "parcel_sequence", "parcel_role",
    "parcel_number_raw", "parcel_number_normalized", "account_id", "match_method", "is_resolved", "link_loaded_at"],
});

const MATCH_METHODS = ["exact", "punctuation_normalized", "embedded_full_id", "concatenated_full_ids", "unmatched", "manual_verified"];
const UNKNOWN_HISTORY = Object.freeze({ historical_support: "unknown", valid_from: null, valid_to: null });
const MAX_ROW_BYTES = 1_000_000;
const fail = field => { throw new TypeError(`invalid_neighborhood_cached_row:${field}`); };
const present = value => value !== undefined && value !== null && !(typeof value === "string" && !value.trim());

function projection(input, kind) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) fail("projection_object");
  const fields = CACHED_ROW_PROJECTION_FIELDS[kind];
  const raw = {};
  for (const key of fields) {
    if (Object.hasOwn(input, key)) {
      // pg readers must project dates/timestamps as text and bigint IDs as text.
      // Undefined is not SQL NULL; retaining it would erase presence evidence.
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.value === undefined) fail(`projection.${key}`);
      raw[key] = descriptor.value;
    }
  }
  const json = canonicalAssessmentJson(raw);
  if (Buffer.byteLength(json) > MAX_ROW_BYTES) fail("projection_bytes");
  const retained = JSON.parse(json);
  assertNeighborhoodJsonbStorage(retained);
  const gaps = new Set(["historical_validity_unavailable"]);
  if (Object.keys(input).some(key => !fields.includes(key))) gaps.add("projection_fields_not_retained");
  return { raw: retained, gaps, kind };
}

function storageId(value, field, optional = false) {
  if (value == null && optional) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) fail(field);
    value = String(value);
  }
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail(field);
  return value;
}

function accountId(value, gaps) {
  if (!present(value)) { gaps.add("account_identity_unavailable"); return null; }
  if (typeof value !== "string" || value !== value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) fail("account_id");
  return value; // Do not strip Collin's R/dashes, normalize aliases or infer LOWPARCELID matches.
}

function numeric(value, field, gaps, { zero = false, integer = false } = {}) {
  if (!present(value)) return null;
  const result = finiteNumberOrNull(value);
  if (result === null || result < 0 || (!zero && result === 0) || (integer && !Number.isSafeInteger(result))) {
    gaps.add(`${field}_invalid`); return null;
  }
  return result;
}

function date(value, field, gaps) {
  if (!present(value)) return null;
  try { return assessmentDate(value, field); }
  catch { gaps.add(`${field}_invalid`); return null; }
}

function finish(capture, recordId, data) {
  // This is the digest of retained projection evidence INCLUDING ingestion
  // metadata, not a semantic feature revision or the provider's original hash.
  const digest = assessmentEvidenceDigest({ mapping_version: CACHED_ROW_MAPPING_VERSION,
    projection_kind: capture.kind, raw_projection: capture.raw });
  return freeze({ record_id: recordId, data: { ...data, ...UNKNOWN_HISTORY,
    cached_mapping_version: CACHED_ROW_MAPPING_VERSION, cached_projection_kind: capture.kind,
    cached_projection_sha256: digest }, raw_projection: capture.raw,
  capability_gaps: [...capture.gaps].sort() });
}

/** Pure current-mirror projection only. The reader must retain every wrapper,
 * including raw_projection and capability_gaps, in its scoped source capture.
 * No mapper declares source completeness, historical applicability, verified
 * housing, market eligibility, transaction equivalence or full parcel membership.
 * These require a separately reviewed evidence resolver, never a current date,
 * sync timestamp, source hash, row count or successful SQL query.
 */
export function mapCachedParcelRow(input) {
  const capture = projection(input, "parcel");
  const { raw, gaps } = capture;
  const objectId = storageId(raw.object_id, "object_id");
  const account = accountId(raw.account_id, gaps);
  gaps.add("housing_classification_unverified");
  gaps.add("subdivision_identity_unresolved");
  gaps.add("assessment_tax_year_unavailable");
  gaps.add("original_provider_geometry_unavailable");
  const year = numeric(raw.residential_year_built, "year_built", gaps, { integer: true });
  return finish(capture, `gis.dcad_parcels:${objectId}`, { account_id: account,
    year_built: year, gla_sqft: numeric(raw.residential_area_sqft, "gla_sqft", gaps),
    site_area_sqft: numeric(raw.parcel_area_sqft, "site_area_sqft", gaps, { zero: true }),
    assessed_value: numeric(raw.current_market_value, "assessed_value", gaps, { zero: true }),
    assessment_tax_year: null, housing_type: null, subdivision_key: null });
}

export function mapCachedAccountRow(input) {
  const capture = projection(input, "account");
  const account = accountId(capture.raw.account_id, capture.gaps);
  if (account === null) fail("account_id");
  capture.gaps.add("account_physical_characteristics_not_projected");
  capture.gaps.add("housing_classification_unverified");
  capture.gaps.add("subdivision_identity_unresolved");
  return finish(capture, `core.accounts:${account}`, { account_id: account,
    year_built: null, gla_sqft: null, site_area_sqft: null, assessed_value: null,
    assessment_tax_year: null, housing_type: null, subdivision_key: null });
}

export function mapCachedSaleRow(input) {
  const capture = projection(input, "sale");
  const { raw, gaps } = capture;
  const sourceId = storageId(raw.source_record_id, "source_record_id", true);
  const saleId = storageId(raw.sale_id, "sale_id", true);
  if (sourceId === null && saleId === null) fail("sale_or_source_identity");
  const primary = accountId(raw.sale_account_id, gaps);
  const sourcePrimary = present(raw.primary_account_id) ? accountId(raw.primary_account_id, gaps) : null;
  const saleDate = date(raw.sale_closing_date, "sale_date", gaps);
  const sourceDate = date(raw.source_close_date, "source_date", gaps);
  const salePrice = numeric(raw.sale_price, "sale_price", gaps, { zero: true });
  const sourcePrice = numeric(raw.source_current_price, "source_price", gaps, { zero: true });
  if (saleId === null) gaps.add("canonical_sale_identity_unavailable");
  if (sourceId === null) gaps.add("source_record_unavailable");
  if (primary !== null && sourcePrimary !== null && primary !== sourcePrimary) gaps.add("canonical_source_account_conflict");
  if (saleDate !== null && sourceDate !== null && saleDate !== sourceDate) gaps.add("canonical_source_date_conflict");
  if (salePrice !== null && sourcePrice !== null && salePrice !== sourcePrice) gaps.add("canonical_source_price_conflict");
  const kind = ["closed_sale", "listing"].includes(raw.record_type) ? raw.record_type : null;
  if (kind === null) gaps.add("transaction_kind_unknown");
  gaps.add("transaction_equivalence_unverified");
  gaps.add("market_eligibility_unavailable");
  gaps.add("transaction_membership_completeness_unavailable");
  gaps.add("gla_at_sale_unavailable");
  gaps.add("sale_price_meaning_unverified");
  if (present(raw.parcel_number2_raw) || raw.has_multiple_parcel_numbers === true || raw.multi_parcel_status === "possible" || raw.multi_parcel_status === "confirmed") {
    gaps.add("additional_parcel_evidence_requires_review");
  }
  if (raw.has_unresolved_parcel === true) gaps.add("source_reports_unresolved_parcel");
  if (raw.requires_additional_review === true) gaps.add("source_requires_review");
  return finish(capture, sourceId === null ? `core.sales:${saleId}` : `core.sales_source_records:${sourceId}`, {
    canonical_transaction_id: saleId, source_record_id: sourceId, primary_account_id: primary,
    sale_date: saleDate, sale_price: salePrice, record_type: kind, market_eligible: null,
    primary_account_verified: null, parcel_links_complete: null, parcel_count: null, gla_sqft_at_sale: null });
}

export function mapCachedSaleLinkRow(input) {
  const capture = projection(input, "sale_link");
  const { raw, gaps } = capture;
  const linkId = storageId(raw.parcel_link_id, "parcel_link_id");
  const sourceId = storageId(raw.source_record_id, "source_record_id");
  const account = accountId(raw.account_id, gaps);
  const resolved = typeof raw.is_resolved === "boolean" ? raw.is_resolved : null;
  const method = MATCH_METHODS.includes(raw.match_method) ? raw.match_method : null;
  if (resolved !== true || method === null || method === "unmatched" || account === null) gaps.add("parcel_link_resolution_unavailable");
  gaps.add("transaction_membership_completeness_unavailable");
  gaps.add("parcel_price_allocation_unavailable");
  gaps.add("gla_at_sale_unavailable");
  return finish(capture, `core.sale_parcels:${linkId}`, { source_record_id: sourceId, account_id: account,
    is_resolved: resolved, match_method: method, allocated_sale_price: null,
    allocation_verified: null, allocation_evidence_ref: null, gla_sqft_at_sale: null });
}
