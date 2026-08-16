import {
  normalizedCountyAccountKey,
  reconcileSalesSourceRecord,
  salesSourceLocationEvidence,
} from "./salesReconciliation.js";

const ADDRESS_SUFFIXES = new Map([
  ["STREET", "ST"],
  ["ROAD", "RD"],
  ["AVENUE", "AVE"],
  ["BOULEVARD", "BLVD"],
  ["DRIVE", "DR"],
  ["LANE", "LN"],
  ["COURT", "CT"],
  ["CIRCLE", "CIR"],
  ["TRAIL", "TRL"],
  ["PARKWAY", "PKWY"],
  ["PLACE", "PL"],
  ["TERRACE", "TER"],
  ["HIGHWAY", "HWY"],
  ["EXPRESSWAY", "EXPY"],
]);
const CANONICAL_SUFFIXES = new Set([
  ...ADDRESS_SUFFIXES.values(),
  "WAY",
  "LOOP",
  "PLAZA",
]);
const UNIT_MARKERS = new Set(["APT", "APARTMENT", "UNIT", "STE", "SUITE", "#"]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function canonicalAddressToken(value) {
  const token = cleanText(value).toUpperCase();
  return ADDRESS_SUFFIXES.get(token) || token;
}

/**
 * Reduce a full MLS or CAD address to the situs line used for a conservative
 * equality check. City/state/postal text after a street suffix is ignored,
 * while unit identifiers are retained so separate condominium units do not
 * become false matches.
 */
export function normalizedSitusAddress(value) {
  const tokens = cleanText(value)
    .toUpperCase()
    .replace(/([A-Z])\.(?=[A-Z]\.)/g, "$1")
    .replace(/[^0-9A-Z#]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(canonicalAddressToken);
  if (!tokens.length) return null;

  const suffixIndex = tokens.findIndex((token, index) => (
    index > 0 && CANONICAL_SUFFIXES.has(token)
  ));
  if (suffixIndex < 0) return tokens.join(" ");

  let end = suffixIndex + 1;
  if (UNIT_MARKERS.has(tokens[end])) {
    end += tokens[end] === "#" ? 2 : 2;
  }
  return tokens.slice(0, Math.min(end, tokens.length)).join(" ");
}

export function addressAgreement(sourceAddress, cadAddress) {
  const source = normalizedSitusAddress(sourceAddress);
  const cad = normalizedSitusAddress(cadAddress);
  if (!source || !cad) return "unavailable";
  return source === cad ? "match" : "conflict";
}

function parcelValues(source) {
  return [source.parcel_number_raw, source.parcel_number2_raw]
    .map(cleanText)
    .filter(Boolean);
}

function aliasCandidates(aliasIndex, value) {
  const normalizedKey = normalizedCountyAccountKey(value, "COLLIN");
  return aliasIndex.get(normalizedKey) || [];
}

/**
 * Select a single existing Collin account for an MLS row. Every provided
 * parcel field must resolve to that same account; multi-parcel or conflicting
 * rows stay in manual review. An identifier is authoritative, but a positive
 * address conflict blocks automatic reconciliation.
 */
export function selectCollinSalesCandidate(source, aliasIndex) {
  const parcels = parcelValues(source);
  if (!parcels.length) return { candidate: null, reason: "missing_parcel_id" };

  const resolvedFields = [];
  for (const parcel of parcels) {
    const matches = aliasCandidates(aliasIndex, parcel);
    const uniqueAccounts = new Map(matches.map((match) => [match.account_id, match]));
    if (!uniqueAccounts.size) {
      return { candidate: null, reason: "identifier_not_found" };
    }
    if (uniqueAccounts.size > 1) {
      return { candidate: null, reason: "ambiguous_identifier" };
    }
    resolvedFields.push([...uniqueAccounts.values()][0]);
  }

  const accountIds = new Set(resolvedFields.map((match) => match.account_id));
  if (accountIds.size !== 1) {
    return { candidate: null, reason: "multiple_parcel_accounts" };
  }

  const candidate = resolvedFields[0];
  const sourceAddress = salesSourceLocationEvidence(source.raw_payload).address_hint;
  const agreement = addressAgreement(sourceAddress, candidate.address);
  if (agreement === "conflict") {
    return { candidate: null, reason: "address_conflict" };
  }
  return {
    candidate: {
      ...candidate,
      address_agreement: agreement,
      source_address: sourceAddress,
    },
    reason: null,
  };
}

function increment(summary, key) {
  summary[key] = (summary[key] || 0) + 1;
}

async function loadAliasIndex(pool, sources) {
  const normalizedKeys = [...new Set(
    sources.flatMap(parcelValues).map((value) => normalizedCountyAccountKey(value, "COLLIN")),
  )].filter(Boolean);
  if (!normalizedKeys.length) return new Map();

  const rawAccountIds = [...new Set(sources.flatMap(parcelValues).map((value) => cleanText(value)))];
  const { rows } = await pool.query(
    `
      WITH matches AS (
        SELECT
          identifier.normalized_account_id AS lookup_key,
          identifier.native_account_id,
          identifier.account_id,
          account.address,
          account.city,
          account.postal_code,
          'official_alias'::text AS match_source
        FROM app.county_account_identifiers identifier
        JOIN core.accounts account
          ON account.account_id = identifier.account_id
        WHERE identifier.county = 'COLLIN'
          AND identifier.normalized_account_id = ANY($1::text[])

        UNION ALL

        SELECT
          REGEXP_REPLACE(UPPER(account.account_id), '[^0-9A-Z]', '', 'g') AS lookup_key,
          identifier.native_account_id,
          account.account_id,
          account.address,
          account.city,
          account.postal_code,
          'existing_internal_id'::text AS match_source
        FROM core.accounts account
        JOIN app.county_account_identifiers identifier
          ON identifier.county = 'COLLIN'
         AND identifier.account_id = account.account_id
        WHERE account.county ILIKE '%collin%'
          AND account.account_id = ANY($2::text[])
      )
      SELECT DISTINCT ON (lookup_key, account_id)
        lookup_key, native_account_id, account_id, address, city, postal_code,
        match_source
      FROM matches
      ORDER BY lookup_key, account_id,
               CASE WHEN match_source = 'official_alias' THEN 0 ELSE 1 END
    `,
    [normalizedKeys, rawAccountIds],
  );
  const index = new Map();
  for (const row of rows) {
    const existing = index.get(row.lookup_key) || [];
    existing.push(row);
    index.set(row.lookup_key, existing);
  }
  return index;
}

async function loadQueueBatch(pool, { afterId, limit }) {
  const { rows } = await pool.query(
    `
      SELECT
        source.id,
        source.listing_id,
        source.parcel_number_raw,
        source.parcel_number2_raw,
        source.raw_payload
      FROM core.sales_source_records source
      WHERE source.id > $1
        AND source.record_type = 'closed_sale'
        AND source.match_status <> 'manual_verified'
        AND (
          source.primary_account_id IS NULL
          OR source.match_status IN ('unmatched', 'multiple')
          OR source.has_unresolved_parcel
        )
        AND (
          NULLIF(BTRIM(source.parcel_number_raw), '') IS NOT NULL
          OR NULLIF(BTRIM(source.parcel_number2_raw), '') IS NOT NULL
        )
      ORDER BY source.id
      LIMIT $2
    `,
    [afterId, limit],
  );
  return rows;
}

export async function backfillCollinSalesQueue(pool, {
  apply = false,
  batchSize = 500,
  maximumRows = null,
  reviewer = "Automated Collin CAD identifier reconciliation",
} = {}) {
  const summary = {
    mode: apply ? "apply" : "dry_run",
    scanned: 0,
    eligible: 0,
    applied: 0,
    address_confirmed: 0,
    identifier_only: 0,
    skipped: {},
    errors: {},
  };
  let afterId = 0;

  while (maximumRows == null || summary.scanned < maximumRows) {
    const remaining = maximumRows == null ? batchSize : maximumRows - summary.scanned;
    const sources = await loadQueueBatch(pool, {
      afterId,
      limit: Math.min(batchSize, remaining),
    });
    if (!sources.length) break;
    afterId = Number(sources.at(-1).id);
    summary.scanned += sources.length;
    const aliases = await loadAliasIndex(pool, sources);

    for (const source of sources) {
      const result = selectCollinSalesCandidate(source, aliases);
      if (!result.candidate) {
        increment(summary.skipped, result.reason);
        continue;
      }
      summary.eligible += 1;
      if (result.candidate.address_agreement === "match") summary.address_confirmed += 1;
      else summary.identifier_only += 1;
      if (!apply) continue;

      try {
        await reconcileSalesSourceRecord(pool, source.id, {
          account_id: result.candidate.native_account_id,
          linked_account_id: result.candidate.account_id,
          notes: result.candidate.address_agreement === "match"
            ? "Matched from official Collin CAD identifier crosswalk; MLS and CAD situs addresses agree."
            : "Matched from official Collin CAD identifier crosswalk; one address source was unavailable.",
          reviewer,
        });
        summary.applied += 1;
      } catch (error) {
        increment(summary.errors, error?.message || "unknown_error");
      }
    }
  }
  return summary;
}
