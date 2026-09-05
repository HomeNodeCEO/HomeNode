import assert from "node:assert/strict";
import test from "node:test";
import { assessmentEvidenceDigest, canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import { buildCachedNeighborhoodInputs } from "../src/services/neighborhoodAssessment/cachedRecords.js";
import { CACHED_ROW_MAPPING_VERSION, CACHED_ROW_PROJECTION_FIELDS,
  mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow, mapCachedSaleLinkRow,
} from "../src/services/neighborhoodAssessment/cachedRowMappings.js";

const parcel = () => ({ object_id: "1234", account_id: "R-0001-001", low_parcel_id: "0001001",
  residential_year_built: 2004, residential_area_sqft: "2000", parcel_area_sqft: "8000",
  current_market_value: "300000", land_use_category: "one_unit", classification_confidence: "high",
  classification_review_reason: null, subdivision_name: "Same Name",
  source_record_hash: "a".repeat(64), source_updated_at: "2026-09-01 12:00:00+00",
  synced_at: "2026-09-02 12:00:00+00", sync_run_id: "40000000-0000-4000-8000-000000000001",
  stored_geometry_geojson: { type: "MultiPolygon", coordinates: [[[[-96.8, 32.8], [-96.7, 32.8], [-96.8, 32.9], [-96.8, 32.8]]]] } });
const sale = () => ({ source_record_id: "9007199254740993", sale_id: "9007199254740995", sale_account_id: "P1",
  sale_closing_date: "2024-03-01", sale_price: "300000", sale_loaded_at: "2026-09-01 12:00:00+00",
  source_name: "cached-MLS", source_record_hash: "a".repeat(64), source_sha256: "b".repeat(64), transaction_fingerprint: "listing-key-hash",
  primary_account_id: "P1", source_close_date: "2024-03-01", source_current_price: "300000",
  source_living_area: "2200", source_loaded_at: "2026-09-01 12:00:00+00", source_updated_at: "2026-09-02 12:00:00+00",
  record_type: "closed_sale", parcel_number_raw: "P1", parcel_number2_raw: null,
  has_multiple_parcel_numbers: false, multi_parcel_status: "single", has_unresolved_parcel: false,
  requires_additional_review: false, data_quality_flags: [], match_status: "exact" });
const link = () => ({ parcel_link_id: "991", source_record_id: "9007199254740993", source_position: 1,
  parcel_sequence: 1, parcel_role: "primary", parcel_number_raw: "P1", parcel_number_normalized: "P1",
  account_id: "P1", match_method: "exact", is_resolved: true, link_loaded_at: "2026-09-01 12:00:00+00" });

test("GIS current facts preserve typed values without turning cached land-use labels into verified historical housing", () => {
  const row = parcel();
  const mapped = mapCachedParcelRow(row);
  assert.equal(mapped.record_id, "gis.dcad_parcels:1234");
  assert.equal(mapped.data.account_id, "R-0001-001");
  assert.equal(mapped.data.year_built, 2004);
  assert.equal(mapped.data.gla_sqft, 2000);
  assert.equal(mapped.data.site_area_sqft, 8000);
  assert.equal(mapped.data.assessed_value, 300000);
  assert.equal(mapped.data.assessment_tax_year, null);
  assert.equal(mapped.data.housing_type, null);
  assert.equal(mapped.data.subdivision_key, null);
  assert.equal(mapped.data.historical_support, "unknown");
  assert.equal(mapped.data.valid_from, null);
  assert.equal(Object.hasOwn(mapped.data, "observed_at"), false, "sync time is not a fact observation date");
  assert.equal(Object.hasOwn(mapped.data, "land_use_category"), false, "avoid cachedRecords housing fallback");
  assert.ok(mapped.capability_gaps.includes("housing_classification_unverified"));
  assert.ok(mapped.capability_gaps.includes("original_provider_geometry_unavailable"));
  assert.deepEqual(mapped.raw_projection.stored_geometry_geojson, row.stored_geometry_geojson);
  row.stored_geometry_geojson.coordinates[0][0][0][0] = 0;
  assert.equal(mapped.raw_projection.stored_geometry_geojson.coordinates[0][0][0][0], -96.8);
  assert.ok(Object.isFrozen(mapped.raw_projection.stored_geometry_geojson.coordinates[0][0]));
});

test("sparse, NULL, blank, zero and false remain distinct retained evidence with deterministic digests", () => {
  const inputs = [undefined, null, "", 0, false].map(value => {
    const row = { object_id: "1234", account_id: "P1" };
    if (value !== undefined) row.current_market_value = value;
    return row;
  });
  const mapped = inputs.map(mapCachedParcelRow);
  assert.equal(new Set(mapped.map(row => row.data.cached_projection_sha256)).size, inputs.length);
  assert.equal(Object.hasOwn(mapped[0].raw_projection, "current_market_value"), false);
  assert.equal(mapped[1].raw_projection.current_market_value, null);
  assert.equal(mapped[2].raw_projection.current_market_value, "");
  assert.equal(mapped[3].data.assessed_value, 0);
  assert.equal(mapped[4].raw_projection.current_market_value, false);
  assert.equal(mapped[4].data.assessed_value, null);
  const row = parcel();
  const first = mapCachedParcelRow(row);
  const reversed = mapCachedParcelRow(Object.fromEntries(Object.entries(row).reverse()));
  assert.deepEqual(first, reversed);
  assert.equal(first.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: CACHED_ROW_MAPPING_VERSION,
    projection_kind: "parcel", raw_projection: first.raw_projection }));
  row.residential_area_sqft = "2100";
  assert.notEqual(mapCachedParcelRow(row).data.cached_projection_sha256, first.data.cached_projection_sha256);
  assert.equal(row.source_record_hash, first.raw_projection.source_record_hash, "old ingestion hash is not used as current content evidence");
  const invalidNumber = mapCachedParcelRow({ ...parcel(), residential_area_sqft: "2,000" });
  assert.equal(invalidNumber.data.gla_sqft, null, "raw SQL numeric projection does not assume formatted-number semantics");
  assert.equal(invalidNumber.raw_projection.residential_area_sqft, "2,000");
  assert.ok(invalidNumber.capability_gaps.includes("gla_sqft_invalid"));
});

test("unretained columns are explicit and cannot smuggle fabricated eligibility, history, housing or private remarks", () => {
  const row = { ...sale(), market_eligible: true, parcel_links_complete: true, parcel_count: 1,
    historical_support: "reconstructed", valid_from: "2020-01-01", raw_payload: { PrivateRemarks: "not retained" } };
  const mapped = mapCachedSaleRow(row);
  assert.ok(mapped.capability_gaps.includes("projection_fields_not_retained"));
  assert.equal(mapped.data.market_eligible, null);
  assert.equal(mapped.data.parcel_links_complete, null);
  assert.equal(mapped.data.parcel_count, null);
  assert.equal(mapped.data.historical_support, "unknown");
  assert.equal(JSON.stringify(mapped).includes("not retained"), false);
  assert.equal(Object.hasOwn(mapped.raw_projection, "raw_payload"), false);
  assert.ok(Object.isFrozen(CACHED_ROW_PROJECTION_FIELDS.sale));
});

test("account metadata keeps raw neighborhood clues without merging names or aliases into a subdivision identity", () => {
  const row = { account_id: "R-0001-001", county: "Collin", subdivision: "COMMON NAME", neighborhood_code: "N1", legal_description: "COMMON NAME BLK A LOT 1" };
  const first = mapCachedAccountRow(row);
  assert.equal(first.record_id, "core.accounts:R-0001-001");
  assert.equal(first.data.subdivision_key, null);
  assert.equal(first.data.gla_sqft, null);
  assert.equal(first.raw_projection.neighborhood_code, "N1");
  const other = mapCachedAccountRow({ ...row, county: "Dallas" });
  assert.notEqual(first.data.cached_projection_sha256, other.data.cached_projection_sha256);
  const alias = mapCachedParcelRow({ ...parcel(), account_id: null });
  assert.equal(alias.data.account_id, null, "LOWPARCELID is not an authorized account fallback");
  assert.ok(alias.capability_gaps.includes("account_identity_unavailable"));
});

test("joined sale projections retain both claims, exact bigint identity and explicit unresolved capability gates", () => {
  const row = sale();
  const mapped = mapCachedSaleRow(row);
  assert.equal(mapped.record_id, "core.sales_source_records:9007199254740993");
  assert.equal(mapped.data.canonical_transaction_id, "9007199254740995");
  assert.equal(mapped.data.sale_date, "2024-03-01");
  assert.equal(mapped.data.sale_price, 300000);
  for (const key of ["market_eligible", "primary_account_verified", "parcel_links_complete", "parcel_count", "gla_sqft_at_sale"]) assert.equal(mapped.data[key], null);
  assert.ok(mapped.capability_gaps.includes("transaction_equivalence_unverified"));
  assert.ok(mapped.capability_gaps.includes("sale_price_meaning_unverified"));
  assert.equal(mapped.raw_projection.source_living_area, "2200", "listing GLA retained separately, never GLA at sale");
  row.source_current_price = "400000"; row.source_close_date = "2024-04-01"; row.primary_account_id = "P2";
  const conflicting = mapCachedSaleRow(row);
  for (const dimension of ["account", "price", "date"]) assert.ok(conflicting.capability_gaps.includes(`canonical_source_${dimension}_conflict`));
  assert.equal(conflicting.data.sale_price, 300000);
  assert.equal(conflicting.raw_projection.source_current_price, "400000");
  assert.notEqual(conflicting.data.cached_projection_sha256, mapped.data.cached_projection_sha256);
});

test("source-only and legacy sales retain their own identity without fabricated canonical IDs or source fallback", () => {
  const sourceOnly = mapCachedSaleRow({ ...sale(), sale_id: null, sale_price: null, sale_closing_date: null, sale_account_id: null });
  assert.equal(sourceOnly.data.canonical_transaction_id, null);
  assert.equal(sourceOnly.data.sale_price, null);
  assert.equal(sourceOnly.data.sale_date, null);
  assert.equal(sourceOnly.data.primary_account_id, null);
  assert.ok(sourceOnly.capability_gaps.includes("canonical_sale_identity_unavailable"));
  const legacy = mapCachedSaleRow({ sale_id: "12", source_record_id: null, sale_account_id: "P1", sale_price: "300000", sale_closing_date: "2024-03-01" });
  assert.equal(legacy.record_id, "core.sales:12");
  assert.equal(legacy.data.source_record_id, null);
  assert.equal(legacy.data.record_type, null, "legacy storage presence cannot invent closed_sale type");
  assert.equal(legacy.data.parcel_count, null);
  assert.ok(legacy.capability_gaps.includes("transaction_kind_unknown"));
  assert.notEqual(legacy.data.canonical_transaction_id, sourceOnly.data.canonical_transaction_id);
});

test("secondary descriptions and review flags never become a complete single-parcel attestation", () => {
  const mapped = mapCachedSaleRow({ ...sale(), parcel_number2_raw: "Includes unnumbered additional tract", multi_parcel_status: "possible",
    has_unresolved_parcel: true, requires_additional_review: true });
  assert.equal(mapped.raw_projection.parcel_number2_raw, "Includes unnumbered additional tract");
  assert.ok(mapped.capability_gaps.includes("additional_parcel_evidence_requires_review"));
  assert.ok(mapped.capability_gaps.includes("source_reports_unresolved_parcel"));
  assert.ok(mapped.capability_gaps.includes("source_requires_review"));
  assert.equal(mapped.data.parcel_links_complete, null);
  assert.equal(mapCachedSaleRow(sale()).data.parcel_links_complete, null, "even a single/fully resolved database row is not full real-world enumeration");
});

test("parcel links retain unselected and unresolved rows without inventing allocation, GLA or historical verification", () => {
  const extra = mapCachedSaleLinkRow({ ...link(), account_id: "UNSELECTED", parcel_role: "additional", source_position: 2 });
  assert.equal(extra.data.account_id, "UNSELECTED");
  assert.equal(extra.data.is_resolved, true);
  assert.equal(extra.data.match_method, "exact");
  assert.equal(extra.data.historical_support, "unknown");
  assert.equal(extra.data.allocated_sale_price, null);
  assert.equal(extra.data.allocation_verified, null);
  assert.equal(extra.data.gla_sqft_at_sale, null);
  assert.equal(Object.hasOwn(extra.data, "canonical_transaction_id"), false, "sale_parcels has no canonical sale column");
  const unresolved = mapCachedSaleLinkRow({ ...link(), account_id: null, is_resolved: false, match_method: "unmatched" });
  assert.equal(unresolved.data.account_id, null);
  assert.equal(unresolved.data.is_resolved, false);
  assert.ok(unresolved.capability_gaps.includes("parcel_link_resolution_unavailable"));
  assert.notEqual(extra.data.cached_projection_sha256, unresolved.data.cached_projection_sha256);
});

test("invalid types and unsafe identifiers are rejected without lossy row capture", () => {
  for (const mutate of [row => { row.source_record_id = 9007199254740992; }, row => { row.sale_id = "01"; },
    row => { row.sale_id = "9223372036854775808"; }, row => { row.sale_price = undefined; },
    row => { row.sale_loaded_at = new Date("2026-01-01"); }, row => { row.source_filename = "bad\u0000name"; },
    row => { row.sale_account_id = " P1"; }]) {
    const row = sale(); mutate(row);
    assert.throws(() => mapCachedSaleRow(row));
  }
  assert.throws(() => mapCachedSaleRow({ source_record_id: null, sale_id: null }), /sale_or_source_identity/);
  assert.throws(() => mapCachedParcelRow({ object_id: "1", site_address: "x".repeat(1_000_001) }), /projection_bytes/);
  const getter = { ...sale() }; Object.defineProperty(getter, "sale_price", { enumerable: true, get() { throw new Error("must not invoke"); } });
  assert.throws(() => mapCachedSaleRow(getter), /projection.sale_price/);
});

test("passing mapped current rows to cachedRecords stays incomplete, without wall-clock or source-completeness invention", () => {
  const mapped = { parcels: [mapCachedParcelRow({ ...parcel(), account_id: "P1" })],
    accounts: [mapCachedAccountRow({ account_id: "P1" })], transactions: [mapCachedSaleRow(sale())], sale_links: [mapCachedSaleLinkRow(link())] };
  const source = (key, records) => ({ id: key, state: "populated", complete: true, revision: "fixture-1",
    content_sha256: assessmentEvidenceDigest(records), captured_at: "2026-09-05T00:00:00.000Z", visibility: "public", scope: null,
    rows: records.map(record => record.data) });
  const result = buildCachedNeighborhoodInputs({ scope: { organization_id: "org", appraisal_case_id: "case", subject_snapshot_id: "snapshot", account_id: "P1" },
    population_id: "selection", effective_date: "2024-06-30", observation_period: { start_date: "2023-07-01", end_date: "2024-06-30" },
    selection: { account_ids: ["P1"], eligible_housing_types: ["one_unit"] },
    sources: Object.fromEntries(Object.entries(mapped).map(([key, rows]) => [key, source(key, rows)])) });
  assert.equal(result.status, "incomplete");
  assert.ok(result.incomplete_reasons.includes("housing_eligibility_unknown"));
  assert.ok(result.incomplete_reasons.includes("market_eligibility_unknown"));
  assert.equal(result.statistics_input.stock.length, 0);
  assert.equal(result.statistics_input.sales.length, 0);
  assert.equal(result.geographic_members.length, 1, "unknown evidence remains visible, not discarded");
  assert.ok(canonicalAssessmentJson(mapped).includes("historical_validity_unavailable"));
});
