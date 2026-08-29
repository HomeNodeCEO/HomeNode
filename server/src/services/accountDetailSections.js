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
        AND op.tax_year = (
          SELECT MAX(latest.tax_year)
          FROM core.owner_parties latest
          WHERE latest.account_id = os.account_id
        )
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
const DCAD_DETAIL_FALLBACK_FIELDS = [
  "PARCELID", "LOWPARCELID", "STRCLASS", "RESYRBLT", "RESFLRAREA", "BLDGAREA",
  "RESSTRTYP", "OWNERNME1", "OWNERNME2", "PSTLADDRESS", "PSTLCITY", "PSTLSTATE",
  "PSTLZIP5", "PSTLZIP4",
].join(",");
const dcadAttributeCache = new Map();
const DCAD_ATTRIBUTE_CACHE_TTL_MS = 30 * 60 * 1000;
const DCAD_ATTRIBUTE_CACHE_MAX = 500;

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
  const detail = row?.detail;
  if (!detail) return {};
  if (typeof detail === "object") return detail;
  try {
    return JSON.parse(detail);
  } catch {
    return {};
  }
}

function objectFrom(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function parcelOwnerFrom(attributes, taxYear) {
  const ownerName = [attributes.OWNERNME1, attributes.OWNERNME2]
    .filter(hasSourceValue)
    .map((value) => String(value).trim())
    .join(" ");
  const postalCode = [attributes.PSTLZIP5, attributes.PSTLZIP4]
    .filter(hasSourceValue)
    .map((value) => String(value).trim())
    .join("-");
  const mailingAddress = [
    attributes.PSTLADDRESS,
    attributes.PSTLCITY,
    [attributes.PSTLSTATE, postalCode].filter(hasSourceValue).join(" "),
  ].filter(hasSourceValue).map((value) => String(value).trim()).join(", ");
  if (!ownerName && !mailingAddress) return null;
  return {
    owner_name: ownerName || null,
    mailing_address: mailingAddress || null,
    tax_year: taxYear ?? null,
    owner_parties: ownerName
      ? [{ owner_name: ownerName, ownership_pct: null }]
      : [],
  };
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

function ownerFromRaw(detail, taxYear) {
  const owner = detail?.owner;
  if (!owner || typeof owner !== "object") return null;
  const ownerParties = Array.isArray(owner.multi_owner)
    ? owner.multi_owner.filter((party) => hasSourceValue(party?.owner_name))
    : [];
  const ownerName = hasSourceValue(owner.owner_name)
    ? owner.owner_name
    : ownerParties.map((party) => String(party.owner_name).trim()).join(" & ");
  return {
    owner_name: ownerName || null,
    mailing_address: hasSourceValue(owner.mailing_address) ? owner.mailing_address : null,
    tax_year: taxYear ?? null,
    owner_parties: ownerParties,
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

async function fetchDcadAttributes(accountId, fetchImpl) {
  if (!/^[0-9A-Za-z]{17}$/.test(accountId)) return {};
  const cached = cachedDcadAttributes(accountId);
  if (cached) return cached;
  const escaped = accountId.replaceAll("'", "''");
  const body = new URLSearchParams({
    where: `PARCELID = '${escaped}' OR LOWPARCELID = '${escaped}'`,
    outFields: DCAD_DETAIL_FALLBACK_FIELDS,
    returnGeometry: "false",
    f: "json",
  });
  const response = await fetchImpl(DCAD_PARCEL_QUERY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`dcad_account_fallback_http_${response.status}`);
  const payload = await response.json();
  if (payload?.error) throw new Error(`dcad_account_fallback_${payload.error.code || "error"}`);
  const attributes = payload?.features?.[0]?.attributes || {};
  rememberDcadAttributes(accountId, attributes);
  return attributes;
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
  const normalizedOwner = rowsFrom(ownerResult)[0] || null;
  const preliminaryRawOwner = ownerFromRaw(rawDetail, rawRow?.tax_year);
  const preliminaryRawImprovement = mergeSourceRows(
    rawDetail.primary_improvements
      || rawDetail.main_improvement
      || rawDetail.main_improvements
      || null,
    parcelImprovementFrom(parcelAttributes),
  );
  const preliminaryOwner = mergeSourceRows(
    preliminaryRawOwner,
    parcelOwnerFrom(parcelAttributes, rawRow?.tax_year),
  );
  if (
    (!hasSourceValue(normalizedImprovement?.building_class)
      && !hasSourceValue(preliminaryRawImprovement?.building_class))
    || (!hasSourceValue(normalizedOwner?.owner_name)
      && !hasSourceValue(preliminaryOwner?.owner_name))
  ) {
    try {
      const liveAttributes = await fetchDcadAttributes(accountId, fetchImpl);
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
  const rawOwner = mergeSourceRows(
    preliminaryRawOwner,
    parcelOwnerFrom(parcelAttributes, rawRow?.tax_year),
  );
  const owner = mergeSourceRows(normalizedOwner, rawOwner);
  if (owner) {
    owner.owner_parties = hasSourceValue(normalizedOwner?.owner_parties)
      ? normalizedOwner.owner_parties
      : rawOwner?.owner_parties || [];
  }
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
