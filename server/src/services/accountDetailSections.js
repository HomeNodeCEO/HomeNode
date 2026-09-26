import { readBoundedJsonResponse } from "../util/boundedResponse.js";

const PRIMARY_IMPROVEMENT_SQL = `
  SELECT
    construction_type, percent_complete, year_built, effective_year_built,
    actual_age, depreciation, desirability, stories, living_area_sqft,
    total_living_area, bedroom_count, bath_count, basement, kitchens,
    wetbars, fireplaces, sprinkler, spa, pool, sauna, air_conditioning,
    heating, foundation, roof_material, roof_type, exterior_material,
    fence_type, number_units, building_class, total_area_sqft, baths_full,
    baths_half
  FROM core.primary_improvements
  WHERE account_id = $1
`;

const HOUSING_PROFILE_SQL = `
  SELECT
    structural_style, housing_type, attachment_type, architectural_style,
    source_name, source_url, source_record_reference, observed_at, confidence,
    profile_source
  FROM core.v_account_housing_profiles
  WHERE account_id = $1
`;

const OWNER_SQL = `
  SELECT
    os.owner_name,
    os.mailing_address,
    os.tax_year,
    COALESCE((
      SELECT json_agg(
        json_build_object(
          'owner_name', op.owner_name,
          'ownership_pct', op.ownership_pct,
          'tax_year', op.tax_year
        )
        ORDER BY op.id
      )
      FROM core.owner_parties op
      WHERE op.account_id = os.account_id
        AND op.tax_year = os.tax_year
    ), '[]'::json) AS owner_parties
  FROM core.owner_summary os
  WHERE os.account_id = $1
  ORDER BY os.tax_year DESC
  LIMIT 1
`;

const LEGAL_CURRENT_SQL = `
  SELECT tax_year, legal_lines, legal_text, deed_transfer_date
  FROM core.legal_description_current
  WHERE account_id = $1
  LIMIT 1
`;

const LEGAL_HISTORY_SQL = `
  SELECT tax_year, legal_lines, legal_text, deed_transfer_date
  FROM core.legal_description_history
  WHERE account_id = $1 AND deed_transfer_date IS NOT NULL
  ORDER BY tax_year DESC
  LIMIT 1
`;

const EXEMPTIONS_SQL = `
  SELECT tax_year, jurisdiction_key, taxing_jurisdiction,
         homestead_exemption, disabled_vet, taxable_value
  FROM core.exemptions_summary
  WHERE account_id = $1
  ORDER BY tax_year DESC
`;

const LAND_DETAIL_SQL = `
  SELECT line_number AS number,
         state_code,
         zoning,
         frontage_ft,
         depth_ft,
         area_sqft,
         pricing_method,
         unit_price,
         market_adjustment_pct,
         adjusted_price,
         ag_land
  FROM core.land_detail
  WHERE account_id = $1
    AND tax_year = (
      SELECT MAX(latest.tax_year)
      FROM core.land_detail latest
      WHERE latest.account_id = $1
    )
  ORDER BY line_number
`;

const SECONDARY_IMPROVEMENTS_SQL = `
  SELECT
    sec_imp_number AS number,
    sec_imp_type AS improvement_type,
    sec_imp_cons_type AS construction,
    sec_imp_floor AS floor,
    sec_imp_ext_wall AS exterior_wall,
    sec_imp_sqft AS area_sqft,
    sec_imp_value AS value,
    sec_imp_year_built AS year_built
  FROM core.secondary_improvements
  WHERE account_id = $1
  ORDER BY sec_imp_number NULLS LAST, id
`;

const RAW_DETAIL_SQL = `
  SELECT raw.tax_year, raw.detail, parcel.source_attributes
  FROM (SELECT $1::text AS account_id) requested
  LEFT JOIN LATERAL (
    SELECT snapshot.tax_year, snapshot.raw -> 'detail' AS detail
    FROM core.dcad_json_raw snapshot
    WHERE snapshot.account_id = requested.account_id
    ORDER BY snapshot.tax_year DESC, snapshot.fetched_at DESC
    LIMIT 1
  ) raw ON true
  LEFT JOIN LATERAL (
    SELECT dcad.source_attributes
    FROM gis.dcad_parcels dcad
    WHERE dcad.account_id = requested.account_id
       OR dcad.low_parcel_id = requested.account_id
    ORDER BY dcad.source_updated_at DESC NULLS LAST, dcad.object_id
    LIMIT 1
  ) parcel ON true
`;

const DCAD_PARCEL_QUERY_URL =
  "https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query";
// Live CAD is optional enrichment, not a reason to hold the entire report page
// for a provider outage. The indexed database remains the primary source.
const DCAD_DETAIL_FALLBACK_TIMEOUT_MS = 2_000;
const MAX_DCAD_DETAIL_RESPONSE_BYTES = 1024 * 1024;
const DCAD_DETAIL_FALLBACK_FIELDS = [
  "PARCELID", "LOWPARCELID", "STRCLASS", "RESYRBLT", "RESFLRAREA", "BLDGAREA",
  "RESSTRTYP", "OWNERNME1", "OWNERNME2", "PSTLADDRESS", "PSTLCITY", "PSTLSTATE",
  "PSTLZIP5", "PSTLZIP4",
].join(",");
const dcadAttributeCache = new Map();
const DCAD_ATTRIBUTE_CACHE_TTL_MS = 30 * 60 * 1000;
const DCAD_ATTRIBUTE_CACHE_MAX = 500;
const dcadAttributeFailures = new Map();
const DCAD_FAILURE_TTL_MS = 60 * 1000;
const dcadAttributeInflight = new Map();

function rowsFrom(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}
async function optionalRows(promise, label, logger) {
  try {
    return rowsFrom(await promise);
  } catch (error) {
    logger?.error?.(`${label} query failed`, error);
    return [];
  }
}

function hasSourceValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return Boolean(normalized) && !["n/a", "na", "not reported", "unknown"].includes(normalized);
  }
  return true;
}

function mergeSourceRows(preferred, fallback) {
  if (!preferred && !fallback) return null;
  const merged = { ...(fallback || {}) };
  for (const [key, value] of Object.entries(preferred || {})) {
    if (hasSourceValue(value)) merged[key] = value;
  }
  return merged;
}

function rawDetailFrom(row) {
  return objectFrom(row?.detail);
}

function objectFrom(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ownerName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim(), key = name.replace(/\s+/g, " ").toUpperCase();
  if (!key || key.endsWith("&") || ["N/A", "NA", "N\\A", "NONE", "NULL", "UNKNOWN", "NOT REPORTED", "UNASSIGNED", "-", "--",
    "WITHHELD", "CONFIDENTIAL", "REDACTED", "NOT AVAILABLE", "OWNER WITHHELD",
    "OWNER INFORMATION WITHHELD", "OWNER INFORMATION CONFIDENTIAL"].includes(key)) return null;
  if (key.length <= 500
    && /^OWNER WITHHELD PER SEC\.?#?\s*25\.025 OR 25\.026 OF TEXAS PROPERTY TAX CODE\.?$/.test(key)) return null;
  return name;
}

function ownerYear(value) {
  if (!["string", "number"].includes(typeof value) || !/^[1-9][0-9]{3}$/.test(String(value))) return null;
  return Number(value);
}

function rawOwnerYear(owner) {
  const year = ownerYear(owner.source_year);
  const headingYear = (value, expression) => typeof value === "string" && value.length <= 200
    ? ownerYear(expression.exec(value.trim())?.[1]) : null;
  if (year === null || headingYear(owner.source_heading, /^Owner\s*\(\s*Current\s+([1-9][0-9]{3})\s*\)$/i) !== year) return null;
  if (owner.parties_source_heading != null
    && headingYear(owner.parties_source_heading, /^Multi[- ]Owner\s*\(\s*Current\s+([1-9][0-9]{3})\s*\)$/i) !== year) return null;
  return year;
}

function ownerParties(value, year) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(party => !party || typeof party !== "object"
    || Array.isArray(party) || !ownerName(party.owner_name)
    || (party.tax_year != null && ownerYear(party.tax_year) !== year))) return null;
  return value;
}

function normalizedOwnerFrom(owner) {
  const name = ownerName(owner?.owner_name);
  if (!name) return null;
  const year = ownerYear(owner.tax_year), parties = ownerParties(owner.owner_parties, year);
  if (!parties) return null;
  return { owner_name: name, mailing_address: typeof owner.mailing_address === "string"
    && hasSourceValue(owner.mailing_address) ? owner.mailing_address : null,
    tax_year: year, source_year: year, owner_parties: parties };
}

// Owner name, address and parties are a single source group. Never fill one
// owner's missing fields with another source/year's observations.
function selectOwner(normalized, raw, parcel) {
  if (normalized?.source_year != null && (raw?.source_year == null || normalized.source_year >= raw.source_year)) return normalized;
  if (raw?.source_year != null) return raw;
  return normalized || raw || parcel || null;
}

function parcelOwnerFrom(attributes) {
  const names = [attributes.OWNERNME1, attributes.OWNERNME2].filter(hasSourceValue);
  if (names.some(value => !ownerName(value))) return null;
  const name = names.map(value => value.trim()).join(" ");
  const postalValue = value => (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))
    && hasSourceValue(value);
  const postalCode = [attributes.PSTLZIP5, attributes.PSTLZIP4]
    .filter(postalValue)
    .map((value) => String(value).trim())
    .join("-");
  const mailingAddress = [
    attributes.PSTLADDRESS,
    attributes.PSTLCITY,
    [attributes.PSTLSTATE, postalCode].filter(postalValue).join(" "),
  ].filter(postalValue).map((value) => String(value).trim()).join(", ");
  return normalizedOwnerFrom({
    owner_name: name || null,
    mailing_address: mailingAddress || null,
    tax_year: null,
    owner_parties: name
      ? [{ owner_name: name, ownership_pct: null }]
      : [],
  });
}

function parcelImprovementFrom(attributes) {
  const fallback = {
    building_class: attributes.STRCLASS,
    year_built: attributes.RESYRBLT,
    living_area_sqft: attributes.RESFLRAREA,
    total_living_area: attributes.RESFLRAREA,
    total_area_sqft: attributes.BLDGAREA,
    stories: attributes.RESSTRTYP,
  };
  return Object.values(fallback).some(hasSourceValue) ? fallback : null;
}

function ownerFromRaw(detail) {
  const owner = detail?.owner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
  const name = ownerName(owner.owner_name);
  // Legacy party-only records can still be shown coherently, but cannot prove
  // that the missing owner summary belongs to the dated current-owner heading.
  const year = name ? rawOwnerYear(owner) : null;
  const parties = ownerParties(owner.multi_owner, year);
  if (!parties || (hasSourceValue(owner.owner_name) && !name)) return null;
  const displayName = name || parties.map(party => party.owner_name.trim()).join(" & ");
  if (!displayName) return null;
  return {
    owner_name: displayName,
    mailing_address: typeof owner.mailing_address === "string" && hasSourceValue(owner.mailing_address) ? owner.mailing_address : null,
    tax_year: year,
    source_year: year,
    owner_parties: parties,
  };
}

function cachedDcadAttributes(accountId) {
  const cached = dcadAttributeCache.get(accountId);
  if (!cached || cached.expiresAt <= Date.now()) {
    dcadAttributeCache.delete(accountId);
    return null;
  }
  return cached.attributes;
}

function rememberDcadAttributes(accountId, attributes) {
  if (dcadAttributeCache.size >= DCAD_ATTRIBUTE_CACHE_MAX) {
    dcadAttributeCache.delete(dcadAttributeCache.keys().next().value);
  }
  dcadAttributeCache.set(accountId, {
    attributes,
    expiresAt: Date.now() + DCAD_ATTRIBUTE_CACHE_TTL_MS,
  });
}

async function requestDcadAttributes(accountId, fetchImpl) {
  const escaped = accountId.replaceAll("'", "''");
  const body = new URLSearchParams({
    where: `PARCELID = '${escaped}' OR LOWPARCELID = '${escaped}'`,
    outFields: DCAD_DETAIL_FALLBACK_FIELDS,
    returnGeometry: "false",
    f: "json",
  });
  let response;
  try {
    response = await fetchImpl(DCAD_PARCEL_QUERY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DCAD_DETAIL_FALLBACK_TIMEOUT_MS),
    });
  } catch {
    throw new Error("dcad_account_fallback_unavailable");
  }
  if (!response?.ok) {
    const status = Number.isInteger(response?.status)
      ? response.status
      : "unknown";
    throw new Error(`dcad_account_fallback_http_${status}`);
  }
  let payload;
  try {
    payload = await readBoundedJsonResponse(response, {
      maximumBytes: MAX_DCAD_DETAIL_RESPONSE_BYTES,
      tooLargeCode: "dcad_account_fallback_response_too_large",
      unavailableCode: "dcad_account_fallback_response_unavailable",
    });
  } catch (error) {
    const code = String(error?.message || "");
    if (
      code === "dcad_account_fallback_response_too_large"
      || code === "dcad_account_fallback_response_unavailable"
    ) {
      throw new Error(code);
    }
    throw new Error("dcad_account_fallback_invalid_response");
  }
  if (payload?.error) {
    const rawProviderCode = String(payload.error.code ?? "");
    const providerCode = /^\d{1,6}$/.test(rawProviderCode)
      ? rawProviderCode
      : "error";
    throw new Error(`dcad_account_fallback_${providerCode}`);
  }
  const attributes = payload?.features?.[0]?.attributes || {};
  return attributes;
}

async function fetchDcadAttributes(accountId, fetchImpl) {
  if (!/^[0-9A-Za-z]{17}$/.test(accountId)) return {};
  const cached = cachedDcadAttributes(accountId);
  if (cached) return cached;
  const failureExpiresAt = dcadAttributeFailures.get(accountId);
  if (failureExpiresAt && failureExpiresAt > Date.now()) return {};
  dcadAttributeFailures.delete(accountId);
  // Concurrent report loads of one parcel share the same bounded official
  // lookup; a failed provider call is briefly skipped on later page reloads.
  let pending = dcadAttributeInflight.get(accountId);
  if (!pending) {
    pending = requestDcadAttributes(accountId, fetchImpl);
    dcadAttributeInflight.set(accountId, pending);
  }
  try {
    const attributes = await pending;
    rememberDcadAttributes(accountId, attributes);
    dcadAttributeFailures.delete(accountId);
    return attributes;
  } catch (error) {
    if (dcadAttributeFailures.size >= DCAD_ATTRIBUTE_CACHE_MAX) {
      dcadAttributeFailures.delete(dcadAttributeFailures.keys().next().value);
    }
    dcadAttributeFailures.set(accountId, Date.now() + DCAD_FAILURE_TTL_MS);
    throw error;
  } finally {
    if (dcadAttributeInflight.get(accountId) === pending) dcadAttributeInflight.delete(accountId);
  }
}

function mergeLandRows(preferredRows, rawRows) {
  if (!Array.isArray(preferredRows) || !preferredRows.length) {
    return Array.isArray(rawRows) ? rawRows : [];
  }
  if (!Array.isArray(rawRows) || !rawRows.length) return preferredRows;
  return preferredRows.map((row, index) => {
    const lineNumber = row?.number ?? row?.line_number;
    const fallback = rawRows.find((candidate) =>
      (candidate?.number ?? candidate?.line_number) === lineNumber,
    ) || rawRows[index];
    return mergeSourceRows(row, fallback);
  });
}

export async function loadAccountDetailSections(
  pool,
  accountId,
  { logger = console, fetchImpl = fetch } = {},
) {
  const params = [accountId];
  const [
    improvementResult,
    housingResult,
    ownerResult,
    legalCurrentResult,
    legalHistoryResult,
    exemptionsResult,
    landRows,
    additionalImprovements,
    rawDetailRows,
  ] = await Promise.all([
    pool.query(PRIMARY_IMPROVEMENT_SQL, params),
    pool.query(HOUSING_PROFILE_SQL, params),
    pool.query(OWNER_SQL, params),
    pool.query(LEGAL_CURRENT_SQL, params),
    pool.query(LEGAL_HISTORY_SQL, params),
    pool.query(EXEMPTIONS_SQL, params),
    optionalRows(pool.query(LAND_DETAIL_SQL, params), "land_detail", logger),
    optionalRows(pool.query(SECONDARY_IMPROVEMENTS_SQL, params), "secondary_improvements", logger),
    optionalRows(pool.query(RAW_DETAIL_SQL, params), "dcad_json_raw", logger),
  ]);

  const rawRow = rawDetailRows[0] || null;
  const rawDetail = rawDetailFrom(rawRow);
  let parcelAttributes = objectFrom(rawRow?.source_attributes);
  const normalizedImprovement = rowsFrom(improvementResult)[0] || null;
  const normalizedOwner = normalizedOwnerFrom(rowsFrom(ownerResult)[0]);
  const preliminaryRawOwner = ownerFromRaw(rawDetail);
  let parcelOwner = parcelOwnerFrom(parcelAttributes);
  const preliminaryRawImprovement = mergeSourceRows(
    rawDetail.primary_improvements
      || rawDetail.main_improvement
      || rawDetail.main_improvements
      || null,
    parcelImprovementFrom(parcelAttributes),
  );
  const preliminaryOwner = selectOwner(normalizedOwner, preliminaryRawOwner, parcelOwner);
  if (
    (!hasSourceValue(normalizedImprovement?.building_class)
      && !hasSourceValue(preliminaryRawImprovement?.building_class))
    || !hasSourceValue(preliminaryOwner?.owner_name)
  ) {
    try {
      const liveAttributes = await fetchDcadAttributes(accountId, fetchImpl);
      // A building-class lookup may also return a different owner. Keep cached
      // and live owner groups separate even while unrelated CAD fields merge.
      parcelOwner ||= parcelOwnerFrom(liveAttributes);
      parcelAttributes = mergeSourceRows(parcelAttributes, liveAttributes) || {};
    } catch (error) {
      logger?.warn?.("DCAD account fallback lookup failed", error?.message || error);
    }
  }
  const rawPrimaryImprovement = mergeSourceRows(
    rawDetail.primary_improvements
    || rawDetail.main_improvement
    || rawDetail.main_improvements
    || null,
    parcelImprovementFrom(parcelAttributes),
  );
  const owner = selectOwner(normalizedOwner, preliminaryRawOwner, parcelOwner);
  const rawLegal = rawDetail.legal_description && typeof rawDetail.legal_description === "object"
    ? {
        tax_year: rawRow?.tax_year ?? null,
        legal_lines: rawDetail.legal_description.lines || null,
        legal_text: Array.isArray(rawDetail.legal_description.lines)
          ? rawDetail.legal_description.lines.filter(hasSourceValue).join("\n")
          : null,
        deed_transfer_date: rawDetail.legal_description.deed_transfer_date || null,
      }
    : null;

  const exemptions = rowsFrom(exemptionsResult);
  const exemptionYear = exemptions[0]?.tax_year ?? null;
  const latestExemptions = exemptionYear == null
    ? []
    : exemptions.filter((row) => row.tax_year === exemptionYear);

  return {
    primaryImprovement: mergeSourceRows(
      normalizedImprovement,
      rawPrimaryImprovement,
    ),
    housingProfile: rowsFrom(housingResult)[0] || null,
    owner,
    legalCurrent: mergeSourceRows(rowsFrom(legalCurrentResult)[0] || null, rawLegal),
    legalHistory: rowsFrom(legalHistoryResult)[0] || null,
    exemptionYear,
    exemptions: latestExemptions,
    homesteadYes: latestExemptions.some(
      (row) => Number(row.homestead_exemption || 0) > 0,
    ),
    landRows: mergeLandRows(landRows, rawDetail.land_detail),
    additionalImprovements,
  };
}

export const accountDetailSectionInternals = Object.freeze({
  DCAD_DETAIL_FALLBACK_TIMEOUT_MS,
  MAX_DCAD_DETAIL_RESPONSE_BYTES,
});
