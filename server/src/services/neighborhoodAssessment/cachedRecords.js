import { createHash } from "node:crypto";
import { assessmentDate, canonicalAssessmentJson } from "./contract.js";
import { ageAtEffectiveDate, finiteNumberOrNull, NEIGHBORHOOD_STATISTICS_LIMITS } from "./statistics.js";

const SOURCE_KEYS = ["parcels", "accounts", "transactions", "sale_links"];
const SCOPE_KEYS = ["organization_id", "appraisal_case_id", "subject_snapshot_id", "account_id"];
const RESOLVED_METHODS = ["exact", "punctuation_normalized", "embedded_full_id", "concatenated_full_ids", "manual_verified"];
// Normalized adapter vocabulary, not an inferred provider enumeration. New
// source kinds require an explicit mapping; unknown kinds cannot certify exclusion.
const TRANSACTION_KINDS = ["closed_sale", "listing"];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const text = value => typeof value === "string" && value.trim() && value.length <= 1024 ? value.trim() : null;
const id = value => typeof value === "number" && Number.isSafeInteger(value) ? String(value) : text(value);
const number = (value, allowZero = false) => {
  const result = finiteNumberOrNull(value);
  return result !== null && (allowZero ? result >= 0 : result > 0) ? result : null;
};
const fail = field => { throw new TypeError(`invalid_cached_neighborhood_records:${field}`); };

function bounded(rows, field) {
  if (!Array.isArray(rows)) fail(field);
  if (rows.length > NEIGHBORHOOD_STATISTICS_LIMITS.input_records) {
    const error = new RangeError(`cached_neighborhood_work_limit:${field}`);
    Object.assign(error, { code: "NEIGHBORHOOD_CACHED_RECORDS_LIMIT", state: "incomplete" });
    throw error;
  }
  return rows;
}

function frozen(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

function iso(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(field);
  return value;
}

function source(value, key, scope) {
  if (!value || typeof value !== "object") fail(`sources.${key}`);
  const rows = bounded(value.rows, `sources.${key}.rows`);
  if (!["absent", "present_empty", "populated", "truncated"].includes(value.state)) fail(`sources.${key}.state`);
  if (![true, false, null].includes(value.complete)) fail(`sources.${key}.complete`);
  if ((["absent", "present_empty"].includes(value.state) && rows.length)
      || (value.state === "populated" && !rows.length)
      || (["absent", "truncated"].includes(value.state) && value.complete === true)) fail(`sources.${key}.state_rows`);
  const snapshot = { key, id: text(value.id), state: value.state, complete: value.complete,
    revision: text(value.revision), content_sha256: value.content_sha256 ?? null,
    captured_at: iso(value.captured_at, `sources.${key}.captured_at`), visibility: value.visibility,
    scope: null, row_count: rows.length };
  if (!snapshot.id) fail(`sources.${key}.id`);
  if (value.state !== "absent" && (!snapshot.revision || !/^[a-f0-9]{64}$/.test(snapshot.content_sha256))) fail(`sources.${key}.version`);
  if (value.state === "absent" && (snapshot.revision !== null || snapshot.content_sha256 !== null)) fail(`sources.${key}.absent_version`);
  if (!["public", "assignment_private"].includes(value.visibility)) fail(`sources.${key}.visibility`);
  if (value.visibility === "assignment_private") {
    if (!value.scope || SCOPE_KEYS.some(field => value.scope[field] !== scope[field])) fail(`sources.${key}.scope_mismatch`);
    snapshot.scope = { ...scope };
  } else if (value.scope !== null) fail(`sources.${key}.public_scope`);
  return { snapshot, rows };
}

function temporal(row, snapshot, atDate) {
  const support = row.historical_support ?? "unknown";
  if (!["contemporaneous", "reconstructed", "current_only", "unknown"].includes(support)) fail("row.historical_support");
  const observedAt = row.observed_at === undefined ? snapshot.captured_at : iso(row.observed_at, "row.observed_at");
  if (observedAt > snapshot.captured_at) fail("row.observed_after_capture");
  const from = row.valid_from == null ? null : assessmentDate(row.valid_from, "row.valid_from");
  const to = row.valid_to == null ? null : assessmentDate(row.valid_to, "row.valid_to");
  if (from !== null && to !== null && from > to) fail("row.reversed_validity");
  const dateCovered = from !== null && from <= atDate && (to === null || to >= atDate);
  const supported = dateCovered && (support === "reconstructed"
    || (support === "contemporaneous" && observedAt.slice(0, 10) <= atDate)
    || (support === "current_only" && observedAt.slice(0, 10) === atDate));
  return { supported, historical_support: support, valid_from: from, valid_to: to, observed_at: observedAt };
}

function characteristics(row, effectiveDate) {
  const rawYear = row.year_built ?? row.residential_year_built;
  const age = ageAtEffectiveDate(rawYear, effectiveDate);
  const taxYear = number(row.assessment_tax_year ?? row.tax_year);
  return {
    year_built: age === null ? null : finiteNumberOrNull(rawYear),
    gla_sqft: number(row.gla_sqft ?? row.residential_area_sqft ?? row.living_area_sqft),
    site_area_sqft: number(row.site_area_sqft ?? row.parcel_area_sqft, true),
    housing_type: text(row.housing_type ?? row.land_use_category)?.toLowerCase() ?? null,
    subdivision_key: text(row.subdivision_key),
    assessed_value: number(row.assessed_value ?? row.market_value ?? row.current_market_value, true),
    assessment_tax_year: Number.isSafeInteger(taxYear) && taxYear >= 1600 && taxYear <= Number(effectiveDate.slice(0, 4)) ? taxYear : null,
  };
}

function dateOrNull(value) {
  if (value == null || value === "") return null;
  try { return assessmentDate(value); } catch { return null; }
}

function transactionKind(value) {
  return TRANSACTION_KINDS.includes(value) ? value : "unknown";
}

function parcelCount(value) {
  const count = number(value);
  return Number.isSafeInteger(count) ? count : null;
}

/** Pure translation of a captured cache query, not a repository or matching
 * engine. complete describes the supplied query envelope, never inferred from
 * row counts. Accounts are optional enrichment; missing required source roles
 * keep this result incomplete. Callers must authorize scope before capture.
 * parcel_links_complete and parcel_count are per-canonical-transaction claims
 * about the FULL parcel set (including unselected parcels), never query-envelope
 * or selected-account counts. Captured source evidence must support those claims.
 */
export function buildCachedNeighborhoodInputs({ scope, population_id, effective_date, observation_period,
  selection, sources, required_sources = ["parcels", "transactions", "sale_links"] }) {
  if (!scope || SCOPE_KEYS.some(key => !text(scope[key]))) fail("scope");
  const capturedScope = Object.fromEntries(SCOPE_KEYS.map(key => [key, scope[key]]));
  if (!text(population_id)) fail("population_id");
  const effectiveDate = assessmentDate(effective_date);
  const start = assessmentDate(observation_period?.start_date, "observation_period.start_date");
  const end = assessmentDate(observation_period?.end_date, "observation_period.end_date");
  if (start > end || end > effectiveDate) fail("observation_period");
  if (!selection || !sources) fail("selection_and_sources");
  const selectedIds = bounded(selection.account_ids, "selection.account_ids").map(id);
  if (selectedIds.some(value => !value) || new Set(selectedIds).size !== selectedIds.length) fail("selection.account_ids");
  const housingTypes = bounded(selection.eligible_housing_types, "selection.eligible_housing_types").map(value => text(value)?.toLowerCase());
  if (!housingTypes.length || housingTypes.some(value => !value)) fail("selection.eligible_housing_types");
  const required = bounded(required_sources, "required_sources");
  if (required.some(key => !SOURCE_KEYS.includes(key)) || new Set(required).size !== required.length) fail("required_sources");
  const prepared = Object.fromEntries(SOURCE_KEYS.map(key => [key, source(sources[key], key, capturedScope)]));
  if (new Set(SOURCE_KEYS.map(key => prepared[key].snapshot.id)).size !== SOURCE_KEYS.length) fail("duplicate_source_id");
  const reasons = new Set(required.filter(key => prepared[key].snapshot.complete !== true)
    .map(key => `${key}:${prepared[key].snapshot.state === "truncated" ? "truncated" : prepared[key].snapshot.state === "absent" ? "absent" : "coverage_unknown"}`));
  const selected = new Set(selectedIds);
  const factsByAccount = new Map(selectedIds.map(account => [account, []]));
  const diagnostics = { missing_account_identity_rows: 0, outside_selection_rows: 0, unsupported_temporal_fact_rows: 0,
    unknown_housing_accounts: 0, ineligible_housing_accounts: 0, conflicting_housing_accounts: 0,
    missing_canonical_transaction_rows: 0, ambiguous_source_record_links: 0, orphan_link_rows: 0,
    invalid_date_transaction_rows: 0, future_transaction_rows: 0, outside_period_transaction_rows: 0,
    nonclosed_transaction_rows: 0, unknown_transaction_kind_rows: 0,
    unknown_transaction_eligibility_rows: 0, unsupported_temporal_transaction_rows: 0,
    unresolved_membership_transaction_rows: 0, conflicting_canonical_transaction_rows: 0 };
  for (const key of ["parcels", "accounts"]) {
    const { snapshot, rows } = prepared[key];
    for (const row of rows) {
      const account = id(row?.account_id);
      if (!account) { diagnostics.missing_account_identity_rows++; continue; }
      if (!selected.has(account)) { diagnostics.outside_selection_rows++; continue; }
      const support = temporal(row, snapshot, effectiveDate);
      if (!support.supported) diagnostics.unsupported_temporal_fact_rows++;
      factsByAccount.get(account).push({ source_id: snapshot.id, ...support, ...characteristics(row, effectiveDate) });
    }
  }
  const stock = [];
  const geographicMembers = selectedIds.toSorted(compare).map(account_id => {
    const facts = factsByAccount.get(account_id).toSorted((a, b) => compare(canonicalAssessmentJson(a), canonicalAssessmentJson(b)));
    const supported = facts.filter(fact => fact.supported);
    const types = [...new Set(supported.map(fact => fact.housing_type).filter(Boolean))];
    const eligibility = types.length !== 1 ? "unknown" : housingTypes.includes(types[0]) ? "eligible" : "ineligible";
    if (eligibility === "unknown") {
      diagnostics.unknown_housing_accounts++;
      if (types.length > 1) diagnostics.conflicting_housing_accounts++;
      reasons.add("housing_eligibility_unknown");
    } else if (eligibility === "ineligible") diagnostics.ineligible_housing_accounts++;
    if (eligibility === "eligible") {
      for (const fact of supported) {
        stock.push({ account_id, year_built: fact.year_built, gla_sqft: fact.gla_sqft,
          site_area_sqft: fact.site_area_sqft, housing_type: types[0],
          assessed_value: fact.assessment_tax_year === null ? null : fact.assessed_value,
          assessment_tax_year: fact.assessment_tax_year, source_references: [fact.source_id] });
      }
    }
    const subdivisionKeys = [...new Set(supported.map(fact => fact.subdivision_key).filter(Boolean))];
    const subjectKey = text(selection.subject_subdivision_key);
    return { account_id, geographic_visibility: "retained", competitive_eligibility: eligibility,
      same_subject_subdivision: subjectKey && subdivisionKeys.length === 1 ? subdivisionKeys[0] === subjectKey : null,
      captured_facts: facts };
  });
  const canonicalBySource = new Map();
  const canonicalEvidence = new Map();
  const transactionRows = prepared.transactions.rows;
  for (const row of transactionRows) {
    const canonical = id(row?.canonical_transaction_id ?? row?.sale_id);
    const sourceRecord = id(row?.source_record_id);
    if (canonical) {
      const evidence = canonicalEvidence.get(canonical) || { dates: new Set(), prices: new Set(), market_states: new Set(),
        record_kinds: new Set(), membership_states: new Set(), parcel_counts: new Set() };
      const date = dateOrNull(row.sale_date ?? row.closing_date);
      const price = number(row.sale_price, true);
      if (date !== null) evidence.dates.add(date);
      if (price !== null) evidence.prices.add(price);
      evidence.market_states.add(row.market_eligible === true ? "eligible" : row.market_eligible === false ? "ineligible" : "unknown");
      evidence.record_kinds.add(transactionKind(row.record_type));
      evidence.membership_states.add(row.parcel_links_complete === true ? "complete" : row.parcel_links_complete === false ? "incomplete" : "unknown");
      evidence.parcel_counts.add(row.parcel_count == null ? "unknown" : parcelCount(row.parcel_count) ?? "invalid");
      canonicalEvidence.set(canonical, evidence);
    }
    if (canonical && sourceRecord) {
      const identities = canonicalBySource.get(sourceRecord) || new Set();
      identities.add(canonical); canonicalBySource.set(sourceRecord, identities);
    }
  }
  const linksBySale = new Map();
  for (const row of prepared.sale_links.rows) {
    const direct = id(row?.canonical_transaction_id ?? row?.sale_id);
    const viaSource = canonicalBySource.get(id(row?.source_record_id));
    if ((viaSource?.size > 1) || (direct && viaSource && !viaSource.has(direct))) {
      diagnostics.ambiguous_source_record_links++; reasons.add("ambiguous_canonical_link"); continue;
    }
    const canonical = direct ?? (viaSource?.size === 1 ? [...viaSource][0] : null);
    if (!canonical) { diagnostics.orphan_link_rows++; continue; }
    const links = linksBySale.get(canonical) || [];
    links.push(row); linksBySale.set(canonical, links);
  }
  const sales = [];
  const transactionEvidence = [];
  let expandedLinks = 0;
  for (const row of transactionRows) {
    const canonical = id(row?.canonical_transaction_id ?? row?.sale_id);
    if (!canonical) { diagnostics.missing_canonical_transaction_rows++; reasons.add("missing_canonical_transaction_identity"); continue; }
    const saleDate = dateOrNull(row.sale_date ?? row.closing_date);
    const evidence = { canonical_transaction_id: canonical, source_record_id: id(row.source_record_id),
      sale_date: saleDate, source_references: [prepared.transactions.snapshot.id], disposition: "eligible" };
    transactionEvidence.push(evidence);
    const canonicalFacts = canonicalEvidence.get(canonical);
    if (Object.values(canonicalFacts).some(values => values.size > 1)) {
      diagnostics.conflicting_canonical_transaction_rows++; evidence.disposition = "conflicting_canonical_metadata";
      reasons.add("conflicting_canonical_transaction_metadata"); continue;
    }
    if (!saleDate) { diagnostics.invalid_date_transaction_rows++; evidence.disposition = "invalid_date"; reasons.add("invalid_transaction_date"); continue; }
    if (saleDate > effectiveDate) { diagnostics.future_transaction_rows++; evidence.disposition = "future_outcome"; continue; }
    if (saleDate < start || saleDate > end) { diagnostics.outside_period_transaction_rows++; evidence.disposition = "outside_period"; continue; }
    const kind = transactionKind(row.record_type);
    if (kind === "unknown") {
      diagnostics.unknown_transaction_kind_rows++; evidence.disposition = "transaction_kind_unknown";
      reasons.add("transaction_kind_unknown"); continue;
    }
    if (kind !== "closed_sale") { diagnostics.nonclosed_transaction_rows++; evidence.disposition = "not_closed_sale"; continue; }
    if (row.market_eligible !== true) {
      evidence.disposition = row.market_eligible === false ? "nonmarket" : "market_eligibility_unknown";
      if (row.market_eligible !== false) { diagnostics.unknown_transaction_eligibility_rows++; reasons.add("market_eligibility_unknown"); }
      continue;
    }
    const saleSupport = temporal(row, prepared.transactions.snapshot, saleDate);
    if (!saleSupport.supported) { diagnostics.unsupported_temporal_transaction_rows++; evidence.disposition = "unsupported_sale_evidence"; reasons.add("unsupported_sale_evidence"); continue; }
    const rawLinks = linksBySale.get(canonical) || [];
    expandedLinks += rawLinks.length + 1;
    if (expandedLinks > NEIGHBORHOOD_STATISTICS_LIMITS.parcel_links) fail("expanded_link_work_limit");
    const parcels = rawLinks.map(link => {
      const support = temporal(link, prepared.sale_links.snapshot, saleDate);
      const verified = support.supported && (link.verified === true || (link.is_resolved === true && RESOLVED_METHODS.includes(link.match_method)));
      return { account_id: id(link.account_id), verified,
        allocated_sale_price: number(link.allocated_sale_price),
        allocation_verified: verified && link.allocation_verified === true && Boolean(text(link.allocation_evidence_ref)),
        gla_sqft_at_sale: verified ? number(link.gla_sqft_at_sale) : null };
    });
    const primary = id(row.primary_account_id ?? row.account_id);
    if (primary && !parcels.some(parcel => parcel.account_id === primary)) {
      parcels.push({ account_id: primary, verified: row.primary_account_verified === true,
        allocated_sale_price: null, allocation_verified: false, gla_sqft_at_sale: number(row.gla_sqft_at_sale) });
    }
    const declaredCount = parcelCount(row.parcel_count);
    const knownParcelCount = new Set(parcels.map(parcel => parcel.account_id).filter(Boolean)).size;
    // A complete selected-account query may still omit unselected co-parcels.
    // Explicit incomplete membership wins over every positive envelope/count.
    const validMembershipClaim = row.parcel_links_complete == null || row.parcel_links_complete === true;
    const consistentCount = row.parcel_count == null || (declaredCount !== null && declaredCount === knownParcelCount);
    const completeLinks = validMembershipClaim && consistentCount && knownParcelCount > 0
      && parcels.every(parcel => parcel.account_id !== null)
      && ((row.parcel_links_complete === true && rawLinks.length > 0)
        || (declaredCount !== null && declaredCount === knownParcelCount));
    if (!completeLinks) {
      diagnostics.unresolved_membership_transaction_rows++; evidence.disposition = "parcel_membership_incomplete";
      reasons.add("parcel_membership_incomplete"); continue;
    }
    sales.push({ canonical_transaction_id: canonical, sale_date: saleDate, sale_price: number(row.sale_price, true),
      market_eligible: true, parcel_count: declaredCount ?? knownParcelCount,
      parcels: parcels.toSorted((a, b) => compare(canonicalAssessmentJson(a), canonicalAssessmentJson(b))),
      source_references: [...new Set([prepared.transactions.snapshot.id,
        ...(rawLinks.length ? [prepared.sale_links.snapshot.id] : []),
        ...rawLinks.filter(link => link.allocation_verified === true).map(link => text(link.allocation_evidence_ref)).filter(Boolean)])].sort(compare) });
  }
  const sourceSnapshots = SOURCE_KEYS.map(key => prepared[key].snapshot);
  bounded(stock, "normalized_stock_rows");
  const stableRows = rows => rows.toSorted((a, b) => compare(canonicalAssessmentJson(a), canonicalAssessmentJson(b)));
  const statisticsInput = { population_id, effective_date: effectiveDate,
    observation_period: { start_date: start, end_date: end }, stock: stableRows(stock), sales: stableRows(sales) };
  const digest = createHash("sha256");
  digest.update(canonicalAssessmentJson({ scope: capturedScope, population_id, effectiveDate, start, end,
    selection: { account_ids: [...selected].sort(compare), eligible_housing_types: [...new Set(housingTypes)].sort(compare),
      subject_subdivision_key: text(selection.subject_subdivision_key) }, required_sources: [...required].sort(compare), sourceSnapshots }));
  for (const row of [...statisticsInput.stock, ...statisticsInput.sales, ...geographicMembers, ...stableRows(transactionEvidence)]) {
    digest.update(canonicalAssessmentJson(row)).update("\n");
  }
  return frozen({ status: reasons.size ? "incomplete" : "ready", scope: capturedScope,
    captured_input_sha256: digest.digest("hex"), source_snapshots: sourceSnapshots,
    statistics_input: statisticsInput, geographic_members: geographicMembers,
    transaction_evidence: stableRows(transactionEvidence), diagnostics, incomplete_reasons: [...reasons].sort(compare),
    source_policy: "captured_rows_only_no_live_fallback_no_implicit_historical_characteristics" });
}
