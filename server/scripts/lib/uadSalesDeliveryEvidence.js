const SALES_SCOPE_KEY = "sales_comparison_scope:1000.0032";
const SALES_INDICATED_VALUE_KEY = "sales_comparison_summary:1300.0006";
const SALES_RECONCILIATION_KEY = "sales_comparison_reconciliation:1800.0278";
const FINAL_OPINION_KEY = "reconciliation:1300.0017";

function present(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function finiteNumber(value) {
  if (!present(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function valueKey(value) {
  return `${value.context_key}:${value.uid}`;
}

function comparableAddress(values) {
  return [
    values.get("sales_comparable_address:1800.0001"),
    values.get("sales_comparable_address:1800.0003"),
    values.get("sales_comparable_address:1800.0005"),
    values.get("sales_comparable_address:1800.0004"),
  ].filter(present).join(", ");
}

export function summarizeUadSalesDelivery(editor) {
  const rootValues = new Map(
    (editor.values || [])
      .filter((value) => !value.entity_id)
      .map((value) => [valueKey(value), value.value]),
  );
  const comparableEntities = (editor.entities || [])
    .filter((entity) => entity.entity_type === "sales_comparable")
    .sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
  const comparables = comparableEntities.map((entity) => {
    const rows = (editor.values || []).filter((value) => value.entity_id === entity.id);
    const values = new Map(rows.map((value) => [valueKey(value), value.value]));
    const nonzeroAdjustments = rows.filter((value) => (
      value.context_key.startsWith("sales_comparable_adjustment_")
      && value.uid === "1800.0317"
      && finiteNumber(value.value) !== null
      && finiteNumber(value.value) !== 0
    ));
    const calculatedNetAdjustment = nonzeroAdjustments.reduce(
      (total, value) => total + Number(value.value),
      0,
    );
    const listingStatus = values.get("sales_comparable_listing:1800.0075");
    const salePrice = finiteNumber(values.get("sales_comparable_sale:1800.0272"));
    const saleDate = values.get("sales_comparable_sale:1800.0342");
    const netAdjustment = finiteNumber(values.get("sales_comparable_summary:1800.0313"));
    const adjustedPrice = finiteNumber(values.get("sales_comparable_summary:1800.0309"));
    const expectedAdjustedPrice = salePrice === null ? null : salePrice + calculatedNetAdjustment;
    return {
      id: entity.id,
      ordinal: Number(entity.ordinal),
      address: comparableAddress(values),
      listing_status: listingStatus || null,
      sale_price: salePrice,
      sale_date: saleDate || null,
      comparable_weight: values.get("sales_comparable_summary:1800.0312") || null,
      nonzero_adjustment_count: nonzeroAdjustments.length,
      calculated_net_adjustment: calculatedNetAdjustment,
      reported_net_adjustment: netAdjustment,
      adjusted_price: adjustedPrice,
      calculation_consistent: (
        netAdjustment !== null
        && adjustedPrice !== null
        && netAdjustment === calculatedNetAdjustment
        && adjustedPrice === expectedAdjustedPrice
      ),
    };
  });

  return {
    developed: rootValues.get(SALES_SCOPE_KEY) === true,
    comparable_count: comparables.length,
    settled_sale_count: comparables.filter((comparable) => (
      comparable.listing_status === "SettledSale"
      && comparable.sale_price !== null
      && present(comparable.sale_date)
    )).length,
    adjusted_comparable_count: comparables.filter((comparable) => comparable.nonzero_adjustment_count > 0).length,
    nonzero_adjustment_count: comparables.reduce(
      (total, comparable) => total + comparable.nonzero_adjustment_count,
      0,
    ),
    calculation_consistent_count: comparables.filter((comparable) => comparable.calculation_consistent).length,
    indicated_value: finiteNumber(rootValues.get(SALES_INDICATED_VALUE_KEY)),
    sales_reconciliation_present: present(rootValues.get(SALES_RECONCILIATION_KEY)),
    final_opinion: finiteNumber(rootValues.get(FINAL_OPINION_KEY)),
    comparables,
  };
}

export function requireSalesRichUadDelivery(editor, { minimumComparables = 3 } = {}) {
  const evidence = summarizeUadSalesDelivery(editor);
  const failures = [];
  if (!evidence.developed) failures.push("sales_comparison_not_developed");
  if (evidence.comparable_count < minimumComparables) failures.push("insufficient_sales_comparables");
  if (evidence.settled_sale_count < minimumComparables) failures.push("insufficient_settled_sales");
  if (evidence.adjusted_comparable_count < minimumComparables) failures.push("comparables_without_nonzero_adjustments");
  if (evidence.nonzero_adjustment_count < minimumComparables) failures.push("insufficient_nonzero_adjustments");
  if (evidence.calculation_consistent_count < minimumComparables) failures.push("sales_calculation_mismatch");
  if (evidence.indicated_value === null || evidence.indicated_value <= 0) failures.push("sales_indicated_value_missing");
  if (!evidence.sales_reconciliation_present) failures.push("sales_reconciliation_missing");
  if (evidence.final_opinion === null || evidence.final_opinion <= 0) failures.push("final_opinion_missing");
  if (failures.length) {
    const error = new Error(`uad_sales_delivery_gate_failed:${failures.join(",")}`);
    error.failures = failures;
    error.evidence = evidence;
    throw error;
  }
  return evidence;
}
