import { randomUUID } from "node:crypto";

export const CENSUS_BENCHMARK = "Public_AR_Current";
export const CENSUS_VINTAGE = "Current_Current";
export const CENSUS_COORDINATES_BATCH_URL =
  "https://geocoding.geo.census.gov/geocoder/geographies/coordinatesbatch";
export const CENSUS_ADDRESS_BATCH_URL =
  "https://geocoding.geo.census.gov/geocoder/geographies/addressbatch";

const COUNTY_FIPS = new Map([
  ["collin", "085"],
  ["dallas", "113"],
  ["denton", "121"],
  ["rockwall", "397"],
  ["tarrant", "439"],
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function parseCsvRow(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

export function parseCensusCoordinatesBatchResponse(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [accountId, longitude, latitude, match, stateFips, countyFips, tractCode, blockCode] =
        parseCsvRow(line);
      const matched = String(match || "").trim().toLowerCase() === "match";
      const validCodes =
        /^\d{2}$/.test(stateFips || "") &&
        /^\d{3}$/.test(countyFips || "") &&
        /^\d{6}$/.test(tractCode || "");
      return {
        account_id: String(accountId || "").trim(),
        longitude: Number(longitude),
        latitude: Number(latitude),
        matched: matched && validCodes,
        state_fips: validCodes ? stateFips : null,
        county_fips: validCodes ? countyFips : null,
        tract_code: validCodes ? tractCode : null,
        tract_geoid: validCodes ? `${stateFips}${countyFips}${tractCode}` : null,
        block_code: /^\d{4}$/.test(blockCode || "") ? blockCode : null,
        response_status: String(match || "").trim() || "No_Match",
      };
    })
    .filter((row) => row.account_id);
}

export function parseCensusAddressBatchResponse(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [
        accountId,
        inputAddress,
        match,
        matchType,
        matchedAddress,
        coordinates,
        tigerLineId,
        tigerLineSide,
        stateFips,
        countyFips,
        tractCode,
        blockCode,
      ] = parseCsvRow(line);
      const [longitudeText, latitudeText] = String(coordinates || "").split(",");
      const longitude = Number(longitudeText);
      const latitude = Number(latitudeText);
      const matched = String(match || "").trim().toLowerCase() === "match";
      const validCodes =
        /^\d{2}$/.test(stateFips || "") &&
        /^\d{3}$/.test(countyFips || "") &&
        /^\d{6}$/.test(tractCode || "");
      return {
        account_id: String(accountId || "").trim(),
        longitude: Number.isFinite(longitude) ? longitude : null,
        latitude: Number.isFinite(latitude) ? latitude : null,
        matched: matched && validCodes,
        state_fips: validCodes ? stateFips : null,
        county_fips: validCodes ? countyFips : null,
        tract_code: validCodes ? tractCode : null,
        tract_geoid: validCodes ? `${stateFips}${countyFips}${tractCode}` : null,
        block_code: /^\d{4}$/.test(blockCode || "") ? blockCode : null,
        response_status: String(match || "").trim() || "No_Match",
        input_address: String(inputAddress || "").trim() || null,
        matched_address: String(matchedAddress || "").trim() || null,
        match_type: String(matchType || "").trim() || null,
        tiger_line_id: String(tigerLineId || "").trim() || null,
        tiger_line_side: String(tigerLineSide || "").trim() || null,
      };
    })
    .filter((row) => row.account_id);
}

export function expectedCountyFips(county) {
  const normalized = String(county || "")
    .toLowerCase()
    .replace(/\bcounty\b/g, "")
    .replace(/[^a-z]/g, "")
    .trim();
  return COUNTY_FIPS.get(normalized) || null;
}

export function validateCensusGeography(row, county) {
  if (!row?.matched) return { valid: false, reason: "census_coordinate_no_match" };
  if (row.state_fips !== "48") {
    return { valid: false, reason: `unexpected_state_fips:${row.state_fips || "missing"}` };
  }
  const expectedCounty = expectedCountyFips(county);
  if (expectedCounty && row.county_fips !== expectedCounty) {
    return {
      valid: false,
      reason: `county_fips_mismatch:expected_${expectedCounty}:received_${row.county_fips || "missing"}`,
    };
  }
  if (!/^\d{11}$/.test(row.tract_geoid || "")) {
    return { valid: false, reason: "invalid_tract_geoid" };
  }
  return { valid: true, reason: null };
}

export async function ensureCensusGeographySchema(pool) {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS core;

    CREATE TABLE IF NOT EXISTS core.account_census_geographies (
      account_id          varchar(32) PRIMARY KEY
                          REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      tract_geoid         varchar(11),
      tract_code          varchar(6),
      state_fips          varchar(2),
      county_fips         varchar(3),
      block_code          varchar(4),
      benchmark           text NOT NULL DEFAULT '${CENSUS_BENCHMARK}',
      vintage             text NOT NULL DEFAULT '${CENSUS_VINTAGE}',
      source_latitude     double precision,
      source_longitude    double precision,
      source_address      text,
      source_city         text,
      source_state        text,
      source_postal_code  text,
      source_method       text NOT NULL DEFAULT 'coordinate'
                          CHECK (source_method IN ('coordinate', 'address')),
      status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN (
                            'pending', 'processing', 'retry', 'matched',
                            'review_required', 'failed'
                          )),
      attempts            integer NOT NULL DEFAULT 0,
      next_attempt_at     timestamptz NOT NULL DEFAULT now(),
      leased_at           timestamptz,
      worker_id           text,
      response_status     text,
      review_reason       text,
      looked_up_at        timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CHECK (source_latitude IS NULL OR source_latitude BETWEEN -90 AND 90),
      CHECK (source_longitude IS NULL OR source_longitude BETWEEN -180 AND 180),
      CHECK (tract_geoid IS NULL OR tract_geoid ~ '^[0-9]{11}$'),
      CHECK (tract_code IS NULL OR tract_code ~ '^[0-9]{6}$')
    );

    ALTER TABLE core.account_census_geographies
      ALTER COLUMN source_latitude DROP NOT NULL,
      ALTER COLUMN source_longitude DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS source_address text,
      ADD COLUMN IF NOT EXISTS source_city text,
      ADD COLUMN IF NOT EXISTS source_state text,
      ADD COLUMN IF NOT EXISTS source_postal_code text,
      ADD COLUMN IF NOT EXISTS source_method text NOT NULL DEFAULT 'coordinate';

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'account_census_geographies_source_method_check'
          AND conrelid = 'core.account_census_geographies'::regclass
      ) THEN
        ALTER TABLE core.account_census_geographies
          ADD CONSTRAINT account_census_geographies_source_method_check
          CHECK (source_method IN ('coordinate', 'address'));
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS account_census_geographies_work_idx
      ON core.account_census_geographies (status, next_attempt_at, updated_at)
      WHERE status IN ('pending', 'retry');

    CREATE INDEX IF NOT EXISTS account_census_geographies_tract_idx
      ON core.account_census_geographies (tract_geoid)
      WHERE status IN ('matched', 'review_required');
  `);
}

/**
 * Prefer cached parcel coordinates. If they are unavailable, queue the situs
 * address for the Census address-batch service so tract coverage is not held
 * hostage by a county-specific mapping backlog.
 */
export async function seedCensusGeographyQueue(
  pool,
  { limit = 25_000, benchmark = CENSUS_BENCHMARK, vintage = CENSUS_VINTAGE } = {},
) {
  const safeLimit = boundedInteger(limit, 25_000, 1, 100_000);
  const { rows } = await pool.query(
    `
      WITH candidates AS (
        SELECT
          account.account_id,
          account.county,
          CASE WHEN location.status = 'matched' THEN location.latitude END AS latitude,
          CASE WHEN location.status = 'matched' THEN location.longitude END AS longitude,
          NULLIF(BTRIM(account.address), '') AS address,
          NULLIF(BTRIM(account.city), '') AS city,
          'TX'::text AS state,
          NULLIF(BTRIM(account.postal_code), '') AS postal_code,
          CASE
            WHEN location.status = 'matched'
              AND location.latitude IS NOT NULL
              AND location.longitude IS NOT NULL
              THEN 'coordinate'
            ELSE 'address'
          END AS source_method
        FROM core.accounts account
        LEFT JOIN core.account_locations location
          ON location.account_id = account.account_id
        LEFT JOIN core.account_census_geographies geography
          ON geography.account_id = account.account_id
        WHERE (
          (
            location.status = 'matched'
            AND location.latitude IS NOT NULL
            AND location.longitude IS NOT NULL
          )
          OR (
            NULLIF(BTRIM(account.address), '') IS NOT NULL
            AND (
              NULLIF(BTRIM(account.city), '') IS NOT NULL
              OR NULLIF(BTRIM(account.postal_code), '') IS NOT NULL
            )
          )
        )
          AND (
            geography.account_id IS NULL
            OR geography.benchmark IS DISTINCT FROM $2
            OR geography.vintage IS DISTINCT FROM $3
            OR (
              location.status = 'matched'
              AND location.latitude IS NOT NULL
              AND location.longitude IS NOT NULL
              AND (
                geography.source_method IS DISTINCT FROM 'coordinate'
                OR geography.source_latitude IS DISTINCT FROM location.latitude
                OR geography.source_longitude IS DISTINCT FROM location.longitude
              )
            )
            OR (
              NOT COALESCE((
                location.status = 'matched'
                AND location.latitude IS NOT NULL
                AND location.longitude IS NOT NULL
              ), false)
              AND (
                geography.source_method IS DISTINCT FROM 'address'
                OR geography.source_address IS DISTINCT FROM NULLIF(BTRIM(account.address), '')
                OR geography.source_city IS DISTINCT FROM NULLIF(BTRIM(account.city), '')
                OR geography.source_postal_code IS DISTINCT FROM NULLIF(BTRIM(account.postal_code), '')
              )
            )
          )
        ORDER BY account.account_id
        LIMIT $1
      )
      INSERT INTO core.account_census_geographies (
        account_id, source_latitude, source_longitude,
        source_address, source_city, source_state, source_postal_code,
        source_method, benchmark, vintage,
        status, attempts, next_attempt_at, leased_at, worker_id,
        response_status, review_reason, looked_up_at, updated_at
      )
      SELECT
        account_id, latitude, longitude,
        address, city, state, postal_code, source_method, $2, $3,
        'pending', 0, now(), NULL, NULL, NULL, NULL, NULL, now()
      FROM candidates
      ON CONFLICT (account_id) DO UPDATE SET
        source_latitude = EXCLUDED.source_latitude,
        source_longitude = EXCLUDED.source_longitude,
        source_address = EXCLUDED.source_address,
        source_city = EXCLUDED.source_city,
        source_state = EXCLUDED.source_state,
        source_postal_code = EXCLUDED.source_postal_code,
        source_method = EXCLUDED.source_method,
        benchmark = EXCLUDED.benchmark,
        vintage = EXCLUDED.vintage,
        tract_geoid = NULL,
        tract_code = NULL,
        state_fips = NULL,
        county_fips = NULL,
        block_code = NULL,
        status = 'pending',
        attempts = 0,
        next_attempt_at = now(),
        leased_at = NULL,
        worker_id = NULL,
        response_status = NULL,
        review_reason = NULL,
        looked_up_at = NULL,
        updated_at = now()
      RETURNING account_id
    `,
    [safeLimit, benchmark, vintage],
  );
  return { queued: rows.length, limit: safeLimit };
}

async function claimCensusGeographyBatch(
  pool,
  { batchSize = 1000, workerId = randomUUID() } = {},
) {
  const safeBatchSize = boundedInteger(batchSize, 1000, 1, 10_000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      UPDATE core.account_census_geographies
      SET status = 'retry', worker_id = NULL, leased_at = NULL,
          next_attempt_at = now(),
          review_reason = COALESCE(review_reason, 'stale_worker_lease'),
          updated_at = now()
      WHERE status = 'processing'
        AND leased_at < now() - interval '15 minutes'
    `);
    const { rows } = await client.query(
      `
        WITH next_items AS (
          SELECT account_id
          FROM core.account_census_geographies
          WHERE status IN ('pending', 'retry')
            AND next_attempt_at <= now()
          ORDER BY next_attempt_at, updated_at, account_id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE core.account_census_geographies geography
        SET status = 'processing', leased_at = now(), worker_id = $2,
            attempts = attempts + 1, updated_at = now()
        FROM next_items
        JOIN core.accounts account ON account.account_id = next_items.account_id
        WHERE geography.account_id = next_items.account_id
        RETURNING geography.account_id, geography.source_latitude,
                  geography.source_longitude, geography.source_address,
                  geography.source_city, geography.source_state,
                  geography.source_postal_code, geography.source_method,
                  geography.attempts,
                  geography.benchmark, geography.vintage,
                  geography.worker_id, account.county
      `,
      [safeBatchSize, workerId],
    );
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function fetchCensusCoordinatesBatch(
  rows,
  { fetchImpl = fetch, benchmark = CENSUS_BENCHMARK, vintage = CENSUS_VINTAGE } = {},
) {
  const csv = rows
    .map((row) => [row.account_id, row.source_longitude, row.source_latitude].map(csvCell).join(","))
    .join("\n");
  const form = new FormData();
  form.append("coordinatesFile", new Blob([`${csv}\n`], { type: "text/csv" }), "coordinates.csv");
  form.append("benchmark", benchmark);
  form.append("vintage", vintage);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  timeout.unref?.();
  try {
    const response = await fetchImpl(CENSUS_COORDINATES_BATCH_URL, {
      method: "POST",
      body: form,
      signal: controller.signal,
      headers: { "user-agent": "HomeNode census-tract backfill/1.0" },
    });
    if (!response.ok) throw new Error(`census_coordinates_batch_http_${response.status}`);
    return parseCensusCoordinatesBatchResponse(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchCensusAddressBatch(
  rows,
  { fetchImpl = fetch, benchmark = CENSUS_BENCHMARK, vintage = CENSUS_VINTAGE } = {},
) {
  const csv = rows
    .map((row) => [
      row.account_id,
      row.source_address,
      row.source_city,
      row.source_state || "TX",
      row.source_postal_code,
    ].map(csvCell).join(","))
    .join("\n");
  const form = new FormData();
  form.append("addressFile", new Blob([`${csv}\n`], { type: "text/csv" }), "addresses.csv");
  form.append("benchmark", benchmark);
  form.append("vintage", vintage);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  timeout.unref?.();
  try {
    const response = await fetchImpl(CENSUS_ADDRESS_BATCH_URL, {
      method: "POST",
      body: form,
      signal: controller.signal,
      headers: { "user-agent": "HomeNode census-tract backfill/1.0" },
    });
    if (!response.ok) throw new Error(`census_address_batch_http_${response.status}`);
    return parseCensusAddressBatchResponse(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve and persist one account immediately without waiting for the background queue.
 * A direct lookup also clears any worker lease so an older batch cannot overwrite it.
 */
export async function lookupAccountCensusGeographyNow(
  pool,
  accountId,
  {
    fetchImpl = fetch,
    benchmark = CENSUS_BENCHMARK,
    vintage = CENSUS_VINTAGE,
  } = {},
) {
  await ensureCensusGeographySchema(pool);
  const { rows } = await pool.query(
    `
      SELECT
        account.account_id,
        account.county,
        CASE WHEN location.status = 'matched' THEN location.latitude END AS source_latitude,
        CASE WHEN location.status = 'matched' THEN location.longitude END AS source_longitude,
        COALESCE(NULLIF(BTRIM(account.address), ''), raw_location.address) AS source_address,
        COALESCE(NULLIF(BTRIM(account.city), ''), raw_location.city) AS source_city,
        'TX'::text AS source_state,
        COALESCE(NULLIF(BTRIM(account.postal_code), ''), raw_location.postal_code)
          AS source_postal_code
      FROM core.accounts account
      LEFT JOIN core.account_locations location
        ON location.account_id = account.account_id
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            NULLIF(BTRIM(raw.raw #>> '{detail,property_location,address}'), ''),
            NULLIF(BTRIM(raw.raw #>> '{detail,property_location,subject_address}'), '')
          ) AS address,
          COALESCE(
            NULLIF(BTRIM(raw.raw #>> '{detail,property_location,city}'), ''),
            NULLIF(BTRIM(raw.raw #>> '{detail,property_location,situs_city}'), '')
          ) AS city,
          COALESCE(
            NULLIF(BTRIM(raw.raw #>> '{detail,property_location,postal_code}'), ''),
            NULLIF(BTRIM(raw.raw #>> '{detail,property_location,zip_code}'), '')
          ) AS postal_code
        FROM core.dcad_json_raw raw
        WHERE raw.account_id = account.account_id
        ORDER BY raw.tax_year DESC, raw.fetched_at DESC
        LIMIT 1
      ) raw_location ON TRUE
      WHERE account.account_id = $1
    `,
    [accountId],
  );
  const account = rows[0];
  if (!account) {
    const error = new Error("account_not_found");
    error.code = "account_not_found";
    throw error;
  }

  const hasCoordinates =
    account.source_latitude !== null && account.source_latitude !== undefined &&
    account.source_longitude !== null && account.source_longitude !== undefined &&
    Number.isFinite(Number(account.source_latitude)) &&
    Number.isFinite(Number(account.source_longitude));
  const hasAddress = Boolean(
    String(account.source_address || "").trim() &&
    (String(account.source_city || "").trim() || String(account.source_postal_code || "").trim()),
  );
  if (!hasCoordinates && !hasAddress) {
    const error = new Error("census_lookup_input_missing");
    error.code = "census_lookup_input_missing";
    throw error;
  }

  const sourceMethod = hasCoordinates ? "coordinate" : "address";
  const lookupRow = {
    account_id: account.account_id,
    source_latitude: hasCoordinates ? Number(account.source_latitude) : null,
    source_longitude: hasCoordinates ? Number(account.source_longitude) : null,
    source_address: account.source_address || null,
    source_city: account.source_city || null,
    source_state: account.source_state || "TX",
    source_postal_code: account.source_postal_code || null,
  };
  const lookupOptions = { fetchImpl, benchmark, vintage };
  const results = sourceMethod === "coordinate"
    ? await fetchCensusCoordinatesBatch([lookupRow], lookupOptions)
    : await fetchCensusAddressBatch([lookupRow], lookupOptions);
  const result = results.find((item) => item.account_id === account.account_id) || null;
  const validation = validateCensusGeography(result, account.county);
  const status = validation.valid ? "matched" : "review_required";

  const { rows: savedRows } = await pool.query(
    `
      INSERT INTO core.account_census_geographies (
        account_id, tract_geoid, tract_code, state_fips, county_fips, block_code,
        benchmark, vintage, source_latitude, source_longitude,
        source_address, source_city, source_state, source_postal_code,
        source_method, status, attempts, next_attempt_at, leased_at, worker_id,
        response_status, review_reason, looked_up_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, 1, now(), NULL, NULL,
        $17, $18, now(), now()
      )
      ON CONFLICT (account_id) DO UPDATE SET
        tract_geoid = EXCLUDED.tract_geoid,
        tract_code = EXCLUDED.tract_code,
        state_fips = EXCLUDED.state_fips,
        county_fips = EXCLUDED.county_fips,
        block_code = EXCLUDED.block_code,
        benchmark = EXCLUDED.benchmark,
        vintage = EXCLUDED.vintage,
        source_latitude = EXCLUDED.source_latitude,
        source_longitude = EXCLUDED.source_longitude,
        source_address = EXCLUDED.source_address,
        source_city = EXCLUDED.source_city,
        source_state = EXCLUDED.source_state,
        source_postal_code = EXCLUDED.source_postal_code,
        source_method = EXCLUDED.source_method,
        status = EXCLUDED.status,
        attempts = core.account_census_geographies.attempts + 1,
        next_attempt_at = now(),
        leased_at = NULL,
        worker_id = NULL,
        response_status = EXCLUDED.response_status,
        review_reason = EXCLUDED.review_reason,
        looked_up_at = now(),
        updated_at = now()
      RETURNING tract_geoid, tract_code, state_fips, county_fips, block_code,
                benchmark, vintage, status, response_status, review_reason,
                source_method, source_latitude, source_longitude,
                looked_up_at, updated_at
    `,
    [
      account.account_id,
      result?.tract_geoid || null,
      result?.tract_code || null,
      result?.state_fips || null,
      result?.county_fips || null,
      result?.block_code || null,
      benchmark,
      vintage,
      result?.latitude ?? lookupRow.source_latitude,
      result?.longitude ?? lookupRow.source_longitude,
      lookupRow.source_address,
      lookupRow.source_city,
      lookupRow.source_state,
      lookupRow.source_postal_code,
      sourceMethod,
      status,
      result?.response_status || "Missing_Response",
      validation.reason,
    ],
  );
  return savedRows[0];
}

function retryDelaySeconds(attempt) {
  return Math.min(3600, 30 * 2 ** Math.max(0, Number(attempt || 1) - 1));
}

async function finishCensusBatch(pool, claimed, results, { maximumAttempts = 5 } = {}) {
  const resultsById = new Map(results.map((row) => [row.account_id, row]));
  const outcomes = claimed.map((item) => {
    const result = resultsById.get(item.account_id) || null;
    const validation = validateCensusGeography(result, item.county);
    const terminal = Number(item.attempts || 0) >= maximumAttempts;
    const matchedButReview = Boolean(result?.matched && !validation.valid);
    const status = validation.valid
      ? "matched"
      : matchedButReview || terminal
        ? "review_required"
        : "retry";
    return {
      account_id: item.account_id,
      worker_id: item.worker_id,
      status,
      tract_geoid: result?.tract_geoid || null,
      tract_code: result?.tract_code || null,
      state_fips: result?.state_fips || null,
      county_fips: result?.county_fips || null,
      block_code: result?.block_code || null,
      source_latitude: result?.latitude ?? item.source_latitude ?? null,
      source_longitude: result?.longitude ?? item.source_longitude ?? null,
      response_status: result?.response_status || "Missing_Response",
      review_reason: validation.reason,
      retry_delay_seconds: retryDelaySeconds(item.attempts),
    };
  });
  await pool.query(
    `
      WITH outcome AS (
        SELECT *
        FROM JSONB_TO_RECORDSET($1::jsonb) AS item(
          account_id text, worker_id text, status text,
          tract_geoid text, tract_code text, state_fips text,
          county_fips text, block_code text,
          source_latitude double precision, source_longitude double precision,
          response_status text,
          review_reason text, retry_delay_seconds integer
        )
      )
      UPDATE core.account_census_geographies geography
      SET tract_geoid = outcome.tract_geoid,
          tract_code = outcome.tract_code,
          state_fips = outcome.state_fips,
          county_fips = outcome.county_fips,
          block_code = outcome.block_code,
          source_latitude = outcome.source_latitude,
          source_longitude = outcome.source_longitude,
          status = outcome.status,
          response_status = outcome.response_status,
          review_reason = outcome.review_reason,
          next_attempt_at = CASE WHEN outcome.status = 'retry'
            THEN now() + (outcome.retry_delay_seconds * interval '1 second')
            ELSE geography.next_attempt_at END,
          leased_at = NULL,
          worker_id = NULL,
          looked_up_at = now(),
          updated_at = now()
      FROM outcome
      WHERE geography.account_id = outcome.account_id
        AND geography.worker_id = outcome.worker_id
    `,
    [JSON.stringify(outcomes)],
  );
  return {
    claimed: claimed.length,
    matched: outcomes.filter((row) => row.status === "matched").length,
    retry: outcomes.filter((row) => row.status === "retry").length,
    reviewRequired: outcomes.filter((row) => row.status === "review_required").length,
  };
}

async function releaseFailedCensusBatch(pool, claimed, error, maximumAttempts) {
  const outcomes = claimed.map((item) => {
    const terminal = Number(item.attempts || 0) >= maximumAttempts;
    return {
      account_id: item.account_id,
      worker_id: item.worker_id,
      status: terminal ? "failed" : "retry",
      review_reason: String(error?.message || error || "census_batch_failed").slice(0, 1000),
      retry_delay_seconds: retryDelaySeconds(item.attempts),
    };
  });
  await pool.query(
    `
      WITH outcome AS (
        SELECT * FROM JSONB_TO_RECORDSET($1::jsonb) AS item(
          account_id text, worker_id text, status text,
          review_reason text, retry_delay_seconds integer
        )
      )
      UPDATE core.account_census_geographies geography
      SET status = outcome.status, review_reason = outcome.review_reason,
          next_attempt_at = CASE WHEN outcome.status = 'retry'
            THEN now() + (outcome.retry_delay_seconds * interval '1 second')
            ELSE geography.next_attempt_at END,
          leased_at = NULL, worker_id = NULL, looked_up_at = now(), updated_at = now()
      FROM outcome
      WHERE geography.account_id = outcome.account_id
        AND geography.worker_id = outcome.worker_id
    `,
    [JSON.stringify(outcomes)],
  );
  return {
    claimed: claimed.length,
    matched: 0,
    retry: outcomes.filter((row) => row.status === "retry").length,
    reviewRequired: 0,
    failed: outcomes.filter((row) => row.status === "failed").length,
    error: String(error?.message || error),
  };
}

export async function runCensusGeographyBatch(
  pool,
  {
    batchSize = 1000,
    workerId = randomUUID(),
    maximumAttempts = 5,
    fetchImpl = fetch,
  } = {},
) {
  const claimed = await claimCensusGeographyBatch(pool, { batchSize, workerId });
  if (!claimed.length) {
    return { claimed: 0, matched: 0, retry: 0, reviewRequired: 0 };
  }
  try {
    const coordinateRows = claimed.filter((row) => row.source_method === "coordinate");
    const addressRows = claimed.filter((row) => row.source_method === "address");
    const lookupOptions = {
      fetchImpl,
      benchmark: claimed[0].benchmark,
      vintage: claimed[0].vintage,
    };
    const [coordinateResults, addressResults] = await Promise.all([
      coordinateRows.length
        ? fetchCensusCoordinatesBatch(coordinateRows, lookupOptions)
        : [],
      addressRows.length
        ? fetchCensusAddressBatch(addressRows, lookupOptions)
        : [],
    ]);
    const results = [...coordinateResults, ...addressResults];
    return await finishCensusBatch(pool, claimed, results, { maximumAttempts });
  } catch (error) {
    return releaseFailedCensusBatch(pool, claimed, error, maximumAttempts);
  }
}

export async function getCensusGeographyStatus(pool) {
  const [{ rows: statusRows }, { rows: coverageRows }] = await Promise.all([
    pool.query(`
      SELECT status, COUNT(*)::integer AS count
      FROM core.account_census_geographies
      GROUP BY status
    `),
    pool.query(`
      SELECT
        COUNT(*)::integer AS account_count,
        COUNT(*) FILTER (
          WHERE location.status = 'matched'
            AND location.latitude IS NOT NULL
            AND location.longitude IS NOT NULL
        )::integer AS coordinate_ready_count,
        COUNT(*) FILTER (
          WHERE NULLIF(BTRIM(account.address), '') IS NOT NULL
            AND (
              NULLIF(BTRIM(account.city), '') IS NOT NULL
              OR NULLIF(BTRIM(account.postal_code), '') IS NOT NULL
            )
        )::integer AS address_ready_count,
        COUNT(*) FILTER (
          WHERE (
            location.status = 'matched'
            AND location.latitude IS NOT NULL
            AND location.longitude IS NOT NULL
          ) OR (
            NULLIF(BTRIM(account.address), '') IS NOT NULL
            AND (
              NULLIF(BTRIM(account.city), '') IS NOT NULL
              OR NULLIF(BTRIM(account.postal_code), '') IS NOT NULL
            )
          )
        )::integer AS lookup_ready_count,
        COUNT(*) FILTER (WHERE geography.status = 'matched')::integer AS matched_tract_count,
        COUNT(*) FILTER (WHERE geography.status = 'review_required')::integer AS review_required_count
      FROM core.accounts account
      LEFT JOIN core.account_locations location ON location.account_id = account.account_id
      LEFT JOIN core.account_census_geographies geography ON geography.account_id = account.account_id
    `),
  ]);
  const queue = Object.fromEntries(
    ["pending", "processing", "retry", "matched", "review_required", "failed"]
      .map((status) => [status, 0]),
  );
  statusRows.forEach((row) => { queue[row.status] = Number(row.count || 0); });
  const coverage = coverageRows[0] || {};
  const total = Number(coverage.account_count || 0);
  const matched = Number(coverage.matched_tract_count || 0);
  return {
    benchmark: CENSUS_BENCHMARK,
    vintage: CENSUS_VINTAGE,
    queue,
    coverage: {
      account_count: total,
      coordinate_ready_count: Number(coverage.coordinate_ready_count || 0),
      address_ready_count: Number(coverage.address_ready_count || 0),
      lookup_ready_count: Number(coverage.lookup_ready_count || 0),
      matched_tract_count: matched,
      review_required_count: Number(coverage.review_required_count || 0),
      missing_lookup_input_count:
        Math.max(0, total - Number(coverage.lookup_ready_count || 0)),
      coverage_percent: total ? Math.round((matched / total) * 10_000) / 100 : 100,
    },
  };
}

export function startCensusGeographyWorker(
  pool,
  {
    intervalMs = 60_000,
    seedIntervalMs = 60_000,
    initialDelayMs = 10_000,
    batchSize = 1000,
    seedLimit = 25_000,
    maximumAttempts = 5,
    logger = console,
  } = {},
) {
  const workerId = `census-geography-${randomUUID()}`;
  const safeInterval = boundedInteger(intervalMs, 60_000, 10_000, 3_600_000);
  const safeSeedInterval = boundedInteger(seedIntervalMs, 60_000, safeInterval, 86_400_000);
  const safeInitialDelay = boundedInteger(initialDelayMs, 10_000, 0, 300_000);
  let stopped = false;
  let running = false;
  let timer = null;
  let lastSeededAt = 0;

  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(() => void cycle(), delay);
    timer.unref?.();
  };
  const cycle = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const seedDue = Date.now() - lastSeededAt >= safeSeedInterval;
      const seed = seedDue
        ? await seedCensusGeographyQueue(pool, { limit: seedLimit })
        : { queued: 0 };
      if (seedDue) lastSeededAt = Date.now();
      const result = await runCensusGeographyBatch(pool, {
        batchSize,
        workerId,
        maximumAttempts,
      });
      if (seed.queued || result.claimed) {
        logger.info?.("[census-geography] cycle", { workerId, seeded: seed.queued, ...result });
      }
    } catch (error) {
      logger.warn?.("[census-geography] cycle failed; will retry", error?.message || error);
    } finally {
      running = false;
      schedule(safeInterval);
    }
  };

  schedule(safeInitialDelay);
  return {
    workerId,
    runNow: cycle,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
