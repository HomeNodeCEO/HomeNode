import { polygonCentroid } from "../util/comparableScoring.js";

export const DCAD_PARCEL_QUERY_URL =
  "https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z]{17}$/;

export async function ensureAccountLocationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS core.account_locations (
      account_id                  varchar(32) PRIMARY KEY
                                  REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      latitude                    double precision,
      longitude                   double precision,
      status                      text NOT NULL DEFAULT 'matched'
                                  CHECK (status IN ('matched', 'not_found', 'invalid')),
      source                      text NOT NULL,
      precision                   text,
      confidence                  text
                                  CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
      match_method                text,
      source_parcel_id            text,
      source_site_address         text,
      source_neighborhood_code    text,
      source_living_area_sqft     numeric,
      source_updated_at           timestamptz,
      geocoded_at                 timestamptz NOT NULL DEFAULT now(),
      feature_count               integer NOT NULL DEFAULT 0,
      review_required             boolean NOT NULL DEFAULT false,
      review_reason               text,
      metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at                  timestamptz NOT NULL DEFAULT now(),
      CHECK (
        (latitude IS NULL AND longitude IS NULL)
        OR (
          latitude BETWEEN -90 AND 90
          AND longitude BETWEEN -180 AND 180
        )
      )
    );
    CREATE INDEX IF NOT EXISTS account_locations_coordinate_idx
      ON core.account_locations(latitude, longitude)
      WHERE status = 'matched';
    CREATE INDEX IF NOT EXISTS account_locations_geocoded_at_idx
      ON core.account_locations(geocoded_at);
  `);
}

function normalizeAccountId(value) {
  const normalized = String(value || "").trim();
  return ACCOUNT_ID_PATTERN.test(normalized) ? normalized : null;
}

function isDcadCandidate(county) {
  const normalized = String(county || "").trim().toLowerCase();
  return !normalized || normalized.includes("dallas");
}

function normalizeAddress(value) {
  return String(value || "")
    .split(",")[0]
    .toUpperCase()
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bLANE\b/g, "LN")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bCOURT\b/g, "CT")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/[^A-Z0-9]/g, "");
}

function addressesAgree(databaseAddress, gisAddress) {
  const databaseNormalized = normalizeAddress(databaseAddress);
  const gisNormalized = normalizeAddress(gisAddress);
  if (!databaseNormalized || !gisNormalized) return null;
  return (
    databaseNormalized === gisNormalized ||
    databaseNormalized.startsWith(gisNormalized) ||
    gisNormalized.startsWith(databaseNormalized)
  );
}

function featureAccountIds(feature) {
  return [
    normalizeAccountId(feature?.attributes?.PARCELID),
    normalizeAccountId(feature?.attributes?.LOWPARCELID),
  ].filter(Boolean);
}

function aggregateFeatures(account, features) {
  const exactParcelFeatures = features.filter(
    (feature) =>
      normalizeAccountId(feature?.attributes?.PARCELID) === account.account_id,
  );
  const selectedFeatures = exactParcelFeatures.length ? exactParcelFeatures : features;
  const centroids = selectedFeatures
    .map((feature) => ({
      feature,
      centroid: polygonCentroid(feature?.geometry?.rings),
    }))
    .filter((item) => item.centroid);

  if (!centroids.length) {
    return {
      account_id: account.account_id,
      status: "invalid",
      source: "dcad_parcel_query",
      precision: null,
      confidence: "low",
      match_method: exactParcelFeatures.length ? "parcel_id" : "low_parcel_id",
      feature_count: selectedFeatures.length,
      review_required: true,
      review_reason: "parcel_geometry_invalid",
    };
  }

  const totalArea = centroids.reduce(
    (sum, item) => sum + Math.max(item.centroid.area || 0, 1e-15),
    0,
  );
  const longitude =
    centroids.reduce(
      (sum, item) =>
        sum +
        item.centroid.longitude * Math.max(item.centroid.area || 0, 1e-15),
      0,
    ) / totalArea;
  const latitude =
    centroids.reduce(
      (sum, item) =>
        sum +
        item.centroid.latitude * Math.max(item.centroid.area || 0, 1e-15),
      0,
    ) / totalArea;
  const representative = centroids[0].feature.attributes || {};
  const addressAgreement = addressesAgree(
    account.address,
    representative.SITEADDRESS,
  );
  const reviewReasons = [];
  if (selectedFeatures.length > 1) reviewReasons.push("multiple_parcel_features");
  if (addressAgreement === false) reviewReasons.push("site_address_mismatch");

  const sourceUpdatedMilliseconds = Math.max(
    ...selectedFeatures
      .map((feature) => Number(feature?.attributes?.LASTUPDATE))
      .filter(Number.isFinite),
    0,
  );

  return {
    account_id: account.account_id,
    latitude,
    longitude,
    status: "matched",
    source: "dcad_parcel_query",
    precision: "parcel_centroid",
    confidence: reviewReasons.length ? "medium" : "high",
    match_method: exactParcelFeatures.length ? "parcel_id" : "low_parcel_id",
    source_parcel_id:
      normalizeAccountId(representative.PARCELID) ||
      normalizeAccountId(representative.LOWPARCELID),
    source_site_address: representative.SITEADDRESS || null,
    source_neighborhood_code: representative.NGHBRHDCD || null,
    source_living_area_sqft:
      Number.isFinite(Number(representative.RESFLRAREA))
        ? Number(representative.RESFLRAREA)
        : null,
    source_updated_at:
      sourceUpdatedMilliseconds > 0
        ? new Date(sourceUpdatedMilliseconds).toISOString()
        : null,
    feature_count: selectedFeatures.length,
    review_required: reviewReasons.length > 0,
    review_reason: reviewReasons.join(",") || null,
    metadata: {
      address_agreement: addressAgreement,
      queried_feature_count: features.length,
    },
  };
}

async function queryDcadFeatures(accountIds, fetchImpl) {
  const ids = accountIds.map(normalizeAccountId).filter(Boolean);
  if (!ids.length) return [];
  const quoted = ids.map((id) => `'${id}'`).join(",");
  const body = new URLSearchParams({
    where: `PARCELID IN (${quoted}) OR LOWPARCELID IN (${quoted})`,
    outFields:
      "LOWPARCELID,PARCELID,SITEADDRESS,NGHBRHDCD,RESFLRAREA,LASTUPDATE",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
  });
  const response = await fetchImpl(DCAD_PARCEL_QUERY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    throw new Error(`dcad_parcel_query_http_${response.status}`);
  }
  const payload = await response.json();
  if (payload?.error) {
    throw new Error(
      `dcad_parcel_query_${payload.error.code || "error"}: ${
        payload.error.message || "unknown error"
      }`,
    );
  }
  return Array.isArray(payload?.features) ? payload.features : [];
}

async function upsertLocation(pool, location) {
  await pool.query(
    `
      INSERT INTO core.account_locations (
        account_id, latitude, longitude, status, source, precision, confidence,
        match_method, source_parcel_id, source_site_address,
        source_neighborhood_code, source_living_area_sqft, source_updated_at,
        geocoded_at, feature_count, review_required, review_reason, metadata,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14,$15,$16,$17,now()
      )
      ON CONFLICT (account_id) DO UPDATE SET
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        precision = EXCLUDED.precision,
        confidence = EXCLUDED.confidence,
        match_method = EXCLUDED.match_method,
        source_parcel_id = EXCLUDED.source_parcel_id,
        source_site_address = EXCLUDED.source_site_address,
        source_neighborhood_code = EXCLUDED.source_neighborhood_code,
        source_living_area_sqft = EXCLUDED.source_living_area_sqft,
        source_updated_at = EXCLUDED.source_updated_at,
        geocoded_at = now(),
        feature_count = EXCLUDED.feature_count,
        review_required = EXCLUDED.review_required,
        review_reason = EXCLUDED.review_reason,
        metadata = EXCLUDED.metadata,
        updated_at = now()
    `,
    [
      location.account_id,
      location.latitude ?? null,
      location.longitude ?? null,
      location.status,
      location.source,
      location.precision ?? null,
      location.confidence ?? null,
      location.match_method ?? null,
      location.source_parcel_id ?? null,
      location.source_site_address ?? null,
      location.source_neighborhood_code ?? null,
      location.source_living_area_sqft ?? null,
      location.source_updated_at ?? null,
      location.feature_count ?? 0,
      location.review_required ?? false,
      location.review_reason ?? null,
      JSON.stringify(location.metadata || {}),
    ],
  );
}

export async function refreshAccountLocations(
  pool,
  accounts,
  {
    fetchImpl = fetch,
    batchSize = 50,
    onBatch = null,
  } = {},
) {
  await ensureAccountLocationsTable(pool);
  const uniqueAccounts = [
    ...new Map(
      accounts
        .map((account) => ({
          account_id: normalizeAccountId(account?.account_id),
          address: account?.address || null,
          county: account?.county || null,
        }))
        .filter(
          (account) =>
            account.account_id && isDcadCandidate(account.county),
        )
        .map((account) => [account.account_id, account]),
    ).values(),
  ];
  const summary = {
    requested: accounts.length,
    eligible: uniqueAccounts.length,
    skippedUnsupportedCounty: accounts.length - uniqueAccounts.length,
    matched: 0,
    notFound: 0,
    invalid: 0,
  };

  for (let start = 0; start < uniqueAccounts.length; start += batchSize) {
    const batch = uniqueAccounts.slice(start, start + batchSize);
    const features = await queryDcadFeatures(
      batch.map((account) => account.account_id),
      fetchImpl,
    );

    const locations = batch.map((account) => {
      const matchingFeatures = features.filter((feature) =>
        featureAccountIds(feature).includes(account.account_id),
      );
      return matchingFeatures.length
        ? aggregateFeatures(account, matchingFeatures)
        : {
            account_id: account.account_id,
            status: "not_found",
            source: "dcad_parcel_query",
            precision: null,
            confidence: "low",
            match_method: "account_id",
            feature_count: 0,
            review_required: true,
            review_reason: "parcel_not_found",
          };
    });
    await Promise.all(
      locations.map((location) => upsertLocation(pool, location)),
    );
    for (const location of locations) {
      if (location.status === "matched") summary.matched += 1;
      else if (location.status === "not_found") summary.notFound += 1;
      else summary.invalid += 1;
    }
    if (typeof onBatch === "function") {
      onBatch({
        completed: Math.min(start + batch.length, uniqueAccounts.length),
        total: uniqueAccounts.length,
        summary: { ...summary },
      });
    }
  }
  return summary;
}
