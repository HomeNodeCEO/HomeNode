import {
  ensureAccountAddressAliasSchema,
} from "./accountAddressAliases.js";
import {
  ensureSalesReconciliationSchema,
  salesSourceLocationEvidence,
} from "./salesReconciliation.js";
import {
  cityHintFromSalesSource,
  salesAddressMatchEvidence,
} from "./salesAutoReconciliation.js";
import {
  parseStructuredAddress,
  structuredAddressSimilarity,
} from "../util/structuredAddress.js";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

async function loadFuzzyAuditRows(pool, sampleSize) {
  const { rows } = await pool.query(
    `SELECT
       source.id AS source_record_id,
       source.listing_id,
       source.source_name,
       source.source_files,
       source.source_filename,
       source.source_row_number,
       source.raw_payload,
       source.parcel_number_raw,
       source.close_date,
       source.current_price
     FROM core.sales_source_records source
     WHERE source.record_type = 'closed_sale'
       AND source.match_status = 'unmatched'
       AND source.primary_account_id IS NULL
       AND COALESCE(source.has_multiple_parcel_numbers, false) = false
       AND COALESCE(source.multi_parcel_status, 'single') = 'single'
     ORDER BY source.close_date DESC NULLS LAST,
              source.current_price DESC NULLS LAST,
              source.id DESC
     LIMIT $1`,
    [Math.min(sampleSize * 10, 500)],
  );
  return rows.map((row) => {
    const fallbackCity = cityHintFromSalesSource(row.source_name, row.source_files);
    const evidence = salesAddressMatchEvidence(row.raw_payload, { fallbackCity });
    const location = salesSourceLocationEvidence(row.raw_payload);
    return {
      row,
      evidence,
      source_components: parseStructuredAddress(location.address_hint),
    };
  }).filter((item) => item.source_components.house_number).slice(0, sampleSize);
}

async function loadAccountAliasCandidates(pool, requests, candidatesPerSale) {
  if (!requests.length) return [];
  const { rows } = await pool.query(
    `WITH requested AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
         request_id text,
         house_number text,
         city_key text,
         postal_code5 text
       )
     )
     SELECT
       request.request_id,
       alias.account_id,
       alias.raw_address,
       alias.raw_city,
       alias.city_key,
       alias.county_key,
       alias.postal_code5,
       'account_alias'::text AS candidate_source,
       true AS account_ready,
       NULL::timestamptz AS target_completed_at
     FROM requested request
     JOIN LATERAL (
       SELECT candidate.*
       FROM app.account_address_aliases candidate
       WHERE candidate.is_current = true
         AND split_part(candidate.address_key, ' ', 1) = request.house_number
       ORDER BY
         (candidate.postal_code5 = request.postal_code5) DESC NULLS LAST,
         (candidate.city_key = request.city_key) DESC NULLS LAST,
         candidate.source_priority DESC,
         candidate.account_id
       LIMIT $2
     ) alias ON true`,
    [JSON.stringify(requests), candidatesPerSale],
  );
  return rows;
}

async function loadPendingTargetCandidates(pool, requests, candidatesPerSale) {
  const cityRequests = requests.filter((request) => request.city_key);
  if (!cityRequests.length) return [];
  const { rows } = await pool.query(
    `WITH requested AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
         request_id text,
         house_number text,
         city_key text,
         postal_code5 text
       )
     ), ranked AS (
       SELECT
         request.request_id,
         target.account_id,
         target.source_address AS raw_address,
         target.source_city AS raw_city,
         upper(btrim(target.source_city)) AS city_key,
         'DALLAS'::text AS county_key,
         target.source_postal_code AS postal_code5,
         'dcad_residential_target'::text AS candidate_source,
         (
           account.account_id IS NOT NULL
           AND NULLIF(btrim(account.address), '') IS NOT NULL
           AND target.initial_completed_at IS NOT NULL
         ) AS account_ready,
         target.initial_completed_at AS target_completed_at,
         row_number() OVER (
           PARTITION BY request.request_id
           ORDER BY
             (target.source_postal_code = request.postal_code5) DESC NULLS LAST,
             target.initial_completed_at DESC NULLS LAST,
             target.account_id
         ) AS candidate_rank
       FROM app.dcad_residential_targets target
       JOIN requested request
         ON upper(btrim(target.source_city)) = request.city_key
        AND split_part(upper(btrim(target.source_address)), ' ', 1) = request.house_number
       LEFT JOIN core.accounts account
         ON account.account_id = target.account_id
        AND account.canonical_account_id IS NULL
       WHERE NULLIF(btrim(target.source_address), '') IS NOT NULL
     )
     SELECT request_id, account_id, raw_address, raw_city, city_key,
            county_key, postal_code5, candidate_source, account_ready,
            target_completed_at
     FROM ranked
     WHERE candidate_rank <= $2`,
    [JSON.stringify(cityRequests), candidatesPerSale],
  );
  return rows;
}

function deduplicateCandidates(candidates) {
  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.request_id}\u0000${candidate.account_id}`;
    const existing = unique.get(key);
    if (!existing || (
      existing.candidate_source !== "account_alias" &&
      candidate.candidate_source === "account_alias"
    )) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}

async function loadCandidates(pool, requests, candidatesPerSale) {
  if (!requests.length) return [];
  const [accountAliases, pendingTargets] = await Promise.all([
    loadAccountAliasCandidates(pool, requests, candidatesPerSale),
    loadPendingTargetCandidates(pool, requests, candidatesPerSale),
  ]);
  return deduplicateCandidates([...accountAliases, ...pendingTargets]);
}

function localityScore(evidence, candidate) {
  const city = evidence.city_key
    ? (candidate.city_key === evidence.city_key ? 1 : 0)
    : 0.5;
  const postal = evidence.postal_code5
    ? (candidate.postal_code5 === evidence.postal_code5 ? 1 : 0)
    : 0.5;
  const county = evidence.county_key
    ? (candidate.county_key === evidence.county_key ? 1 : 0)
    : 0.5;
  return Number(((city * 0.45) + (postal * 0.4) + (county * 0.15)).toFixed(6));
}

export function rankFuzzyAddressCandidates(item, candidates) {
  const ranked = candidates.map((candidate) => {
    let candidateComponents = parseStructuredAddress(candidate.raw_address);
    let secondaryEvidenceSource = null;
    const sourceUnit = item.source_components?.unit_key;
    const exactBase = item.source_components?.base_address_key &&
      item.source_components.base_address_key === candidateComponents.base_address_key;
    const canUseTargetSuffixHint = candidate.candidate_source === "dcad_residential_target" &&
      sourceUnit && sourceUnit.length >= 2 && exactBase &&
      !candidateComponents.unit_key &&
      String(candidate.account_id || "").toUpperCase().endsWith(sourceUnit);
    if (canUseTargetSuffixHint) {
      candidateComponents = {
        ...candidateComponents,
        unit_key: sourceUnit,
      };
      secondaryEvidenceSource = "account_id_suffix_review_hint";
    }
    const address = structuredAddressSimilarity(
      item.source_components,
      candidateComponents,
    );
    const locality = localityScore(item.evidence, candidate);
    const total = address.eligible
      ? Number(((address.score * 0.94) + (locality * 0.06)).toFixed(6))
      : 0;
    return {
      account_id: candidate.account_id,
      cad_address: candidate.raw_address,
      cad_city: candidate.raw_city,
      cad_postal_code: candidate.postal_code5,
      score: total,
      address_score: address.score,
      street_score: address.street_score || 0,
      locality_score: locality,
      eligible: address.eligible,
      secondary_incomplete: Boolean(address.secondary_incomplete),
      secondary_evidence_source: secondaryEvidenceSource,
      candidate_source: candidate.candidate_source || "account_alias",
      account_ready: candidate.account_ready !== false,
      target_completed_at: candidate.target_completed_at || null,
      reasons: address.reasons,
      components: candidateComponents,
    };
  }).sort((left, right) => right.score - left.score ||
    String(left.account_id).localeCompare(String(right.account_id)));

  const eligible = ranked.filter((candidate) => candidate.eligible);
  const best = eligible[0] || null;
  const runnerUp = eligible[1] || null;
  const margin = best
    ? Number((best.score - (runnerUp?.score || 0)).toFixed(6))
    : 0;
  const highConfidence = Boolean(
    best &&
    best.score >= 0.9 &&
    best.street_score >= 0.9 &&
    best.account_ready &&
    !best.secondary_evidence_source &&
    !best.secondary_incomplete &&
    (!runnerUp || margin >= 0.06),
  );
  return {
    proposed_account_id: best?.account_id || null,
    confidence: highConfidence
      ? "high"
      : best?.score >= 0.78
        ? "review"
        : "low",
    score: best?.score || 0,
    score_margin: margin,
    resolution_state: best?.account_ready === false
      ? "awaiting_cad_account_scrape"
      : best
        ? "candidate_ready"
        : "no_eligible_candidate",
    candidate_count: candidates.length,
    eligible_candidate_count: eligible.length,
    top_candidates: ranked.slice(0, 5),
  };
}

/**
 * Produce candidate evidence only. This function deliberately contains no
 * write transaction and cannot reconcile a sale.
 */
export async function auditFuzzySalesAddressCandidates(pool, {
  sampleSize = 20,
  candidatesPerSale = 250,
} = {}) {
  const safeSampleSize = boundedInteger(sampleSize, 20, 1, 100);
  const safeCandidatesPerSale = boundedInteger(candidatesPerSale, 250, 10, 1_000);
  await ensureSalesReconciliationSchema(pool);
  await ensureAccountAddressAliasSchema(pool);
  const items = await loadFuzzyAuditRows(pool, safeSampleSize);
  const requests = items.map((item) => ({
    request_id: String(item.row.source_record_id),
    house_number: item.source_components.house_number,
    city_key: item.evidence.city_key,
    postal_code5: item.evidence.postal_code5,
  }));
  const candidateRows = await loadCandidates(pool, requests, safeCandidatesPerSale);
  const candidatesByRequest = new Map();
  for (const candidate of candidateRows) {
    const key = String(candidate.request_id);
    if (!candidatesByRequest.has(key)) candidatesByRequest.set(key, []);
    candidatesByRequest.get(key).push(candidate);
  }

  const sample = items.map((item) => ({
    source_record_id: Number(item.row.source_record_id),
    listing_id: item.row.listing_id || null,
    source_filename: item.row.source_filename || null,
    source_row_number: item.row.source_row_number || null,
    source_address: item.source_components.raw_address,
    raw_parcel_number: item.row.parcel_number_raw || null,
    source_components: item.source_components,
    locality_evidence: {
      city_key: item.evidence.city_key,
      city_source: item.evidence.city_source,
      county_key: item.evidence.county_key,
      postal_code5: item.evidence.postal_code5,
    },
    ...rankFuzzyAddressCandidates(
      item,
      candidatesByRequest.get(String(item.row.source_record_id)) || [],
    ),
  }));
  return {
    dry_run: true,
    writes_performed: 0,
    sample_size: sample.length,
    high_confidence: sample.filter((item) => item.confidence === "high").length,
    review: sample.filter((item) => item.confidence === "review").length,
    low_confidence: sample.filter((item) => item.confidence === "low").length,
    sample,
  };
}
