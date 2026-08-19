const CLASSIFICATIONS = new Set(["inferior", "similar", "superior", "excluded"]);

function text(value, maxLength = 2_000) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function positiveNumber(value) {
  const parsed = typeof value === "number"
    ? value
    : Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundTo(value, increment = 1_000) {
  return Math.round(value / increment) * increment;
}

export function qualitativeComparableKey(comparable, index = 0) {
  const sale = comparable?.sale || comparable || {};
  const stable = sale.source_record_id ?? sale.sale_id ?? sale.listing_key ?? sale.listing_id ?? sale.mls_number;
  if (stable !== null && stable !== undefined && String(stable).trim()) return `sale:${String(stable).trim()}`;
  const fallback = [sale.primary_account_id, sale.closing_date, sale.address]
    .map((value) => text(value, 200).toLowerCase())
    .filter(Boolean)
    .join("|");
  return fallback ? `fallback:${fallback}` : `slot:${index}`;
}

/**
 * Reconcile qualitative inferior/similar/superior judgments against the
 * quantitatively adjusted indications already present in the sales grid.
 */
export function calculateQualitativeAnalysis(input = {}, comparables = []) {
  const selectionInput = Array.isArray(input.selections) ? input.selections.slice(0, 12) : [];
  const selectionByKey = new Map(selectionInput.map((selection) => [
    text(selection?.comparable_key, 500),
    selection,
  ]));
  const selections = comparables.slice(0, 12).flatMap((comparable, index) => {
    const comparableKey = qualitativeComparableKey(comparable, index);
    const raw = selectionByKey.get(comparableKey);
    const classification = text(raw?.classification, 20).toLowerCase();
    if (!CLASSIFICATIONS.has(classification)) return [];
    const sale = comparable?.sale || {};
    const indicatedValue = positiveNumber(comparable?.indicatedValue) || positiveNumber(sale.sale_price);
    return [{
      comparable_key: comparableKey,
      comparable_number: index + 1,
      address: text(sale.address, 500) || null,
      classification,
      commentary: text(raw?.commentary, 2_000) || null,
      indicated_value: indicatedValue,
    }];
  });
  const analyzed = selections.filter((selection) => selection.classification !== "excluded" && selection.indicated_value);
  const inferior = analyzed.filter((selection) => selection.classification === "inferior").map((selection) => selection.indicated_value);
  const similar = analyzed.filter((selection) => selection.classification === "similar").map((selection) => selection.indicated_value);
  const superior = analyzed.filter((selection) => selection.classification === "superior").map((selection) => selection.indicated_value);
  const lowerBound = inferior.length ? Math.max(...inferior) : null;
  const upperBound = superior.length ? Math.min(...superior) : null;
  const similarMedian = similar.length ? median(similar) : null;
  const warnings = [];
  let recommendedValue = null;

  if (analyzed.length < 2) {
    warnings.push("Classify at least two selected comparables before applying a qualitative conclusion.");
  } else if (lowerBound !== null && upperBound !== null && lowerBound > upperBound) {
    warnings.push("The qualitative bracket is inconsistent: an inferior comparable indicates above the lowest superior comparable.");
  } else if (similarMedian !== null) {
    recommendedValue = similarMedian;
    if (lowerBound !== null) recommendedValue = Math.max(recommendedValue, lowerBound);
    if (upperBound !== null) recommendedValue = Math.min(recommendedValue, upperBound);
  } else if (lowerBound !== null && upperBound !== null) {
    recommendedValue = (lowerBound + upperBound) / 2;
  } else if (lowerBound !== null) {
    recommendedValue = lowerBound;
    warnings.push("Only a lower bracket is present; add a superior or similar comparable when possible.");
  } else if (upperBound !== null) {
    recommendedValue = upperBound;
    warnings.push("Only an upper bracket is present; add an inferior or similar comparable when possible.");
  } else {
    warnings.push("No inferior, similar, or superior comparable with a valid indicated value is classified.");
  }

  const roundedRecommendation = recommendedValue === null ? null : roundTo(recommendedValue);
  const requestedApplied = input.applied === true;
  const applied = requestedApplied && roundedRecommendation !== null && analyzed.length >= 2 && !(lowerBound !== null && upperBound !== null && lowerBound > upperBound);
  if (requestedApplied && !applied) warnings.push("The qualitative conclusion was not applied because the current bracket is incomplete or inconsistent.");
  const narrative = roundedRecommendation === null
    ? "A qualitative value conclusion has not been developed."
    : `The subject is bracketed${lowerBound === null ? " without a lower indication" : ` above ${roundTo(lowerBound).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}`}${upperBound === null ? " and without an upper indication" : ` and below ${roundTo(upperBound).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}`}. Similar and bracketing indications support a reconciled value of ${roundedRecommendation.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}.`;

  return {
    schema_version: 1,
    methodology: "qualitative_bracketing",
    selections,
    conclusion: {
      analyzed_count: analyzed.length,
      inferior_count: inferior.length,
      similar_count: similar.length,
      superior_count: superior.length,
      excluded_count: selections.filter((selection) => selection.classification === "excluded").length,
      lower_bound: lowerBound === null ? null : roundTo(lowerBound),
      upper_bound: upperBound === null ? null : roundTo(upperBound),
      similar_median: similarMedian === null ? null : roundTo(similarMedian),
      recommended_value: roundedRecommendation,
      bracket_consistent: !(lowerBound !== null && upperBound !== null && lowerBound > upperBound),
      narrative,
      warnings: [...new Set(warnings)],
    },
    applied,
    calculated_at: new Date().toISOString(),
  };
}

export function normalizeSalesComparisonQualitativeAnalysis(section = {}) {
  if (!section || typeof section !== "object" || Array.isArray(section)) return section;
  const qualitative = section.workspace?.qualitativeAnalysis;
  if (!qualitative) return section;
  const qualitativeAnalysis = calculateQualitativeAnalysis(
    qualitative,
    Array.isArray(section.comparables) ? section.comparables : [],
  );
  const recommendedValue = qualitativeAnalysis.applied
    ? qualitativeAnalysis.conclusion.recommended_value
    : null;
  const costToCureTotal = Number(section.costToCure?.total);
  const opinionAfterCostToCure = recommendedValue === null
    ? section.opinionAfterCostToCure
    : Math.max(0, recommendedValue - (Number.isFinite(costToCureTotal) && costToCureTotal > 0 ? costToCureTotal : 0));
  return {
    ...section,
    opinionOfValue: recommendedValue ?? section.opinionOfValue,
    opinionAfterCostToCure,
    workspace: {
      ...section.workspace,
      qualitativeAnalysis,
    },
  };
}

export function qualitativeAnalysisErrorStatus(message) {
  if (String(message || "").startsWith("invalid_")) return 400;
  return 500;
}
