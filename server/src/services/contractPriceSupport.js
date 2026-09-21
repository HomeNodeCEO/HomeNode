const DEFAULT_LOCAL_RADIUS_MILES = 3;
const MINIMUM_PHYSICAL_SCORE = 35;

function finitePositiveNumber(value) {
  const parsed = typeof value === "string"
    ? Number(value.replace(/[^0-9.-]/g, ""))
    : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function saleIdentity(sale) {
  return String(
    sale?.source_record_id ??
    sale?.sale_id ??
    sale?.primary_account_id ??
    `${sale?.address || ""}|${sale?.closing_date || ""}|${sale?.sale_price || ""}`,
  );
}

function conditionIndicatesUpperTierReview(condition, notes) {
  const normalizedCondition = String(condition || "").trim().toUpperCase();
  const normalizedNotes = String(notes || "").trim().toLowerCase();
  return ["C1", "C2", "C2-C1"].includes(normalizedCondition) ||
    /\b(remodel(?:ed|ing)?|renovat(?:ed|ion)|updated|complete(?:ly)? rehab)\b/.test(normalizedNotes);
}

export async function loadComparableContractContext(pool, {
  accountId,
  assignmentFileId,
} = {}) {
  const parsedAssignmentFileId = Number(assignmentFileId);
  if (!Number.isSafeInteger(parsedAssignmentFileId) || parsedAssignmentFileId <= 0) {
    return null;
  }
  const { rows } = await pool.query(
    `SELECT assignment_details
       FROM app.assignment_files
      WHERE id = $1 AND account_id = $2`,
    [parsedAssignmentFileId, accountId],
  );
  const details = rows[0]?.assignment_details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  return {
    contractPrice: finitePositiveNumber(details.contract_price),
    subjectCondition: String(details.subject_condition_rating || "").trim() || null,
    subjectConditionNotes: String(details.subject_condition_notes || "").trim() || null,
  };
}

/**
 * Test whether a contract price has independent local market support without
 * changing the ordinary physical-similarity recommendation order. This is a
 * screening result, not a value conclusion: condition and quality still need
 * appraiser verification before any candidate enters the primary grid.
 */
export function analyzeContractPriceSupport({
  sales = [],
  contractPrice,
  subjectCondition,
  subjectConditionNotes,
  radiusMiles = DEFAULT_LOCAL_RADIUS_MILES,
} = {}) {
  const price = finitePositiveNumber(contractPrice);
  const localRadiusMiles = Math.min(
    Math.max(finitePositiveNumber(radiusMiles) || DEFAULT_LOCAL_RADIUS_MILES, 0.1),
    DEFAULT_LOCAL_RADIUS_MILES,
  );
  if (price === null) {
    return {
      available: false,
      reason: "contract_price_unavailable",
      contract_price: null,
      support_status: "not_analyzed",
      local_radius_miles: localRadiusMiles,
      support_sales: [],
      upper_tier_sales: [],
      review_set_sales: [],
    };
  }

  const deduplicated = new Map();
  for (const sale of Array.isArray(sales) ? sales : []) {
    const salePrice = finitePositiveNumber(sale?.sale_price);
    const distance = finiteNumber(sale?.distanceMiles);
    const physicalScore = finiteNumber(sale?.comparableScore);
    if (
      salePrice === null ||
      distance === null ||
      distance < 0 ||
      distance > localRadiusMiles ||
      sale?.insideAnalysisPeriod === false ||
      sale?.housingTypeCompatible === false ||
      sale?.influence_support_candidate === true ||
      (physicalScore !== null && physicalScore < MINIMUM_PHYSICAL_SCORE)
    ) continue;
    const priceDifference = salePrice - price;
    const priceDifferencePercent = Math.abs(priceDifference) / price;
    deduplicated.set(saleIdentity(sale), {
      ...sale,
      contract_price_difference: Math.round(priceDifference),
      contract_price_difference_percent: Math.round(priceDifferencePercent * 10_000) / 100,
      contract_support_band: priceDifferencePercent <= 0.05
        ? "within_5_percent"
        : priceDifferencePercent <= 0.1
          ? "within_10_percent"
          : "outside_10_percent",
    });
  }

  const localSales = [...deduplicated.values()];
  const localPrices = localSales
    .map((sale) => finitePositiveNumber(sale.sale_price))
    .filter((value) => value !== null);
  const withinFive = localSales.filter((sale) => sale.contract_support_band === "within_5_percent");
  const withinTen = localSales.filter((sale) => sale.contract_support_band !== "outside_10_percent");
  const topQuartilePrice = quantile(localPrices, 0.75);
  const contractPercentile = localPrices.length
    ? Math.round(
      localPrices.filter((salePrice) => salePrice <= price).length /
      localPrices.length * 1_000,
    ) / 10
    : null;
  const upperTierReview = conditionIndicatesUpperTierReview(
    subjectCondition,
    subjectConditionNotes,
  );

  const byContractSupport = (left, right) =>
    left.contract_price_difference_percent - right.contract_price_difference_percent ||
    (finiteNumber(right.comparableScore) || 0) - (finiteNumber(left.comparableScore) || 0) ||
    (finiteNumber(left.distanceMiles) || 0) - (finiteNumber(right.distanceMiles) || 0);
  const supportSales = [...withinTen].sort(byContractSupport).slice(0, 6);
  const upperTierSales = localSales
    .filter((sale) => topQuartilePrice !== null && finitePositiveNumber(sale.sale_price) >= topQuartilePrice)
    .sort((left, right) =>
      (finiteNumber(right.comparableScore) || 0) - (finiteNumber(left.comparableScore) || 0) ||
      finitePositiveNumber(right.sale_price) - finitePositiveNumber(left.sale_price) ||
      (finiteNumber(left.distanceMiles) || 0) - (finiteNumber(right.distanceMiles) || 0))
    .slice(0, 12);
  const reviewSet = [];
  const reviewIds = new Set();
  for (const sale of [...supportSales, ...(upperTierReview ? upperTierSales : [])]) {
    const id = saleIdentity(sale);
    if (reviewIds.has(id)) continue;
    reviewIds.add(id);
    reviewSet.push(sale);
    if (reviewSet.length === 6) break;
  }

  const supportStatus = withinTen.length >= 3
    ? "supported"
    : withinTen.length > 0
      ? "limited"
      : "unsupported";
  const reconciliation = supportStatus === "supported"
    ? `${withinTen.length} physically screened sales within ${localRadiusMiles} miles closed within 10% of the contract price, including ${withinFive.length} within 5%. The contract has local sale-price support, subject to condition and quality verification.`
    : supportStatus === "limited"
      ? `${withinTen.length} physically screened sale${withinTen.length === 1 ? "" : "s"} within ${localRadiusMiles} miles closed within 10% of the contract price. Support is limited; verify remodeling, condition, quality, and concessions before reconciling toward the contract.`
      : `No physically screened sale within ${localRadiusMiles} miles closed within 10% of the contract price. The contract is not supported by the available local sale-price screen and should not anchor the value conclusion.`;

  return {
    available: true,
    reason: null,
    contract_price: price,
    local_radius_miles: localRadiusMiles,
    local_sale_count: localSales.length,
    support_status: supportStatus,
    within_5_percent_count: withinFive.length,
    within_10_percent_count: withinTen.length,
    contract_percentile: contractPercentile,
    upper_quartile_price: topQuartilePrice === null ? null : Math.round(topQuartilePrice),
    subject_condition: String(subjectCondition || "").trim() || null,
    upper_tier_review: upperTierReview,
    reconciliation,
    methodology: {
      purpose: "independent_contract_price_plausibility_test",
      primary_recommendations_unchanged: true,
      price_band_percent: 10,
      close_support_band_percent: 5,
      minimum_physical_score: MINIMUM_PHYSICAL_SCORE,
      condition_quality_verification_required: true,
    },
    support_sales: supportSales,
    upper_tier_sales: upperTierSales.slice(0, 6),
    review_set_sales: reviewSet,
  };
}
