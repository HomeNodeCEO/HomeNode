const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z]{17}$/;
const COLLIN_ACCOUNT_ID_PATTERN = /^(?=.{4,100}$)(?=.*\d)R[0-9A-Za-z._/#-]+$/i;
const HOUSE_NUMBER_PATTERN = /^([0-9]+[A-Za-z]?(?:-[0-9]+[A-Za-z]?)?(?:\s+1\/2)?)\s+(.+)$/;
const ADDRESS_PREFIX_PATTERN = /^[0-9]/;

const ADDRESS_TOKEN_ALIASES = Object.freeze({
  ALLEY: "ALY",
  APARTMENT: "UNIT",
  APT: "UNIT",
  AVENUE: "AVE",
  BOULEVARD: "BLVD",
  CIRCLE: "CIR",
  COURT: "CT",
  DRIVE: "DR",
  EXPRESSWAY: "EXPY",
  FREEWAY: "FWY",
  HIGHWAY: "HWY",
  LANE: "LN",
  NORTH: "N",
  NORTHEAST: "NE",
  NORTHWEST: "NW",
  PARKWAY: "PKWY",
  PLACE: "PL",
  ROAD: "RD",
  SOUTH: "S",
  SOUTHEAST: "SE",
  SOUTHWEST: "SW",
  SQUARE: "SQ",
  STREET: "ST",
  SUITE: "UNIT",
  STE: "UNIT",
  TERRACE: "TER",
  TRAIL: "TRL",
  WEST: "W",
});

export function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^0-9A-Za-z#/-]/g, " ")
    .split(" ")
    .filter(Boolean)
    .join(" ")
    .trim()
    .toUpperCase();
}

export function normalizePropertyCity(value) {
  let city = String(value || "").trim();
  if (city.endsWith(")")) {
    const openingParenthesis = city.lastIndexOf("(");
    if (openingParenthesis >= 0) city = city.slice(0, openingParenthesis).trim();
  }
  const tokens = normalizeSearchText(city).split(" ").filter(Boolean);
  const trailingZip = /^[0-9]{5}(?:-[0-9]{4})?$/.test(tokens.at(-1) || "");
  const stateIndex = trailingZip ? -2 : -1;
  if (trailingZip && ["TX", "TEXAS"].includes(tokens.at(stateIndex) || "")) tokens.pop();
  if (["TX", "TEXAS"].includes(tokens.at(-1) || "")) tokens.pop();
  return tokens.join(" ");
}

export function normalizePropertyAddress(value) {
  return normalizeSearchText(value)
    .split(" ")
    .filter(Boolean)
    .map((token) => ADDRESS_TOKEN_ALIASES[token] || token)
    .join(" ");
}

export function parsePropertySearch(value) {
  const raw = String(value || "").trim();
  const commaParts = raw.split(",");
  const addressPart = commaParts.shift()?.trim() || "";
  const cityPart = commaParts.join(" ").trim();
  const normalizedAddress = normalizePropertyAddress(addressPart);
  const houseMatch = normalizedAddress.match(HOUSE_NUMBER_PATTERN);

  return {
    raw,
    // Dallas uses the familiar 17-character key. Collin CAD account IDs are
    // native identifiers beginning with R and may contain punctuation. Keep
    // the original value intact so a correct Collin ID can be resolved through
    // the county-identifier bridge instead of being mistaken for an address.
    isAccountId:
      ACCOUNT_ID_PATTERN.test(raw) || COLLIN_ACCOUNT_ID_PATTERN.test(raw),
    normalizedAddress,
    houseNumber: houseMatch?.[1] || null,
    streetName: houseMatch?.[2] || normalizedAddress,
    city: normalizePropertyCity(cityPart) || null,
    hasHouseNumber: Boolean(houseMatch),
    isAddressPrefix: ADDRESS_PREFIX_PATTERN.test(normalizedAddress),
  };
}

