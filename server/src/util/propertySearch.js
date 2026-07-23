const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z]{17}$/;
const HOUSE_NUMBER_PATTERN = /^([0-9]+[A-Za-z]?(?:-[0-9]+[A-Za-z]?)?(?:\s+1\/2)?)\s+(.+)$/;

export function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^0-9A-Za-z#/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function normalizePropertyCity(value) {
  return normalizeSearchText(String(value || "").replace(/\s*\([^)]*\)\s*$/, ""))
    .replace(/\s+(?:TX|TEXAS)(?:\s+[0-9]{5}(?:-[0-9]{4})?)?$/, "")
    .trim();
}

export function parsePropertySearch(value) {
  const raw = String(value || "").trim();
  const commaParts = raw.split(",");
  const addressPart = commaParts.shift()?.trim() || "";
  const cityPart = commaParts.join(" ").trim();
  const normalizedAddress = normalizeSearchText(addressPart);
  const houseMatch = normalizedAddress.match(HOUSE_NUMBER_PATTERN);

  return {
    raw,
    isAccountId: ACCOUNT_ID_PATTERN.test(raw),
    normalizedAddress,
    houseNumber: houseMatch?.[1] || null,
    streetName: houseMatch?.[2] || normalizedAddress,
    city: normalizePropertyCity(cityPart) || null,
    hasHouseNumber: Boolean(houseMatch),
  };
}

