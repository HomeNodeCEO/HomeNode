const PURCHASE_CONTRACT_REVIEW_FIELDS = new Set([
  "buyer_name",
  "seller_name",
  "contract_price",
  "contract_date",
  "closing_date",
  "loan_amount",
  "down_payment",
  "earnest_money",
  "seller_concessions",
  "contract_property_condition",
  "contract_repairs",
  "contract_personal_property_included",
  "contract_personal_property_details",
  "contract_exclusions",
]);

function cleanText(value, maximum = 5_000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

export function purchaseContractCurrency(value) {
  const normalized = cleanText(value, 100).replace(/[$,]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 && amount <= 999_999_999.99 ? amount : null;
}

export function purchaseContractBoolean(value) {
  const normalized = cleanText(value, 100).toLowerCase();
  if (["true", "yes", "y", "included"].includes(normalized)) return true;
  if (["false", "no", "n", "none", "not included"].includes(normalized)) return false;
  return null;
}

export function confirmedPurchaseContractCandidates(candidates = []) {
  const byField = new Map();
  for (const candidate of candidates) {
    if (candidate?.review_status !== "confirmed") continue;
    if (!PURCHASE_CONTRACT_REVIEW_FIELDS.has(candidate.field_key)) continue;
    const value = cleanText(
      candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value,
    );
    if (value) byField.set(candidate.field_key, { ...candidate, value });
  }
  return byField;
}

function formatContractCurrency(value) {
  const amount = purchaseContractCurrency(value);
  return amount == null
    ? null
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
}

/** One shared, deterministic narrative for Custom Appraisal and UAD 3.6. */
export function buildPurchaseContractAnalysis(candidates = []) {
  const fields = confirmedPurchaseContractCandidates(candidates);
  const value = (key) => fields.get(key)?.value || null;
  const concessionsAmount = purchaseContractCurrency(value("seller_concessions"));
  const concessions = formatContractCurrency(value("seller_concessions"));
  const condition = value("contract_property_condition");
  const repairs = value("contract_repairs");
  const personalPropertyIncluded = purchaseContractBoolean(value("contract_personal_property_included"));
  const personalPropertyDetails = value("contract_personal_property_details");
  const exclusions = value("contract_exclusions");
  return cleanText([
    value("buyer_name") ? `Contract buyer(s): ${value("buyer_name")}.` : null,
    value("seller_name") ? `Contract seller(s): ${value("seller_name")}.` : null,
    value("contract_date") ? `The contract was fully executed on ${value("contract_date")}.` : null,
    formatContractCurrency(value("contract_price"))
      ? `The agreed sales price is ${formatContractCurrency(value("contract_price"))}.`
      : null,
    formatContractCurrency(value("down_payment"))
      ? `The cash portion/down payment is ${formatContractCurrency(value("down_payment"))}.`
      : null,
    formatContractCurrency(value("loan_amount"))
      ? `The sum of financing is ${formatContractCurrency(value("loan_amount"))}.`
      : null,
    formatContractCurrency(value("earnest_money"))
      ? `Earnest money is ${formatContractCurrency(value("earnest_money"))}.`
      : null,
    value("closing_date") ? `Closing is scheduled on or before ${value("closing_date")}.` : null,
    concessionsAmount === 0
      ? "Section 12A(1)(b) reports no seller concessions."
      : concessions
        ? `Section 12A(1)(b) seller concessions are ${concessions}.`
        : null,
    condition === "as_is"
      ? "The buyer accepts the property as is; no seller-paid repairs or treatments are stated in Section 7D(2)."
      : condition === "seller_repairs"
        ? repairs
          ? `The buyer accepts the property as is provided the seller completes these repairs or treatments at the seller's expense: ${repairs}.`
          : "The contract selects the seller-repair provision; the specific repairs or treatments require manual verification."
        : repairs
          ? `Seller repairs or treatments stated in the contract: ${repairs}.`
          : null,
    personalPropertyIncluded === true
      ? personalPropertyDetails
        ? `The contract identifies personal property conveyed with the sale: ${personalPropertyDetails}. Personal-property value is not included in the appraisal opinion of value.`
        : "The contract indicates that personal property is conveyed with the sale; the specific items require appraiser description. Personal-property value is not included in the appraisal opinion of value."
      : personalPropertyIncluded === false
        ? "The contract does not identify personal property conveyed with the sale."
        : null,
    exclusions ? `Contract Section 2D exclusions language: ${exclusions}.` : null,
  ].filter(Boolean).join(" "));
}
