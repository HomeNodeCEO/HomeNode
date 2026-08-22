import { normalizeSearchText } from "./propertySearch.js";

const UNIT_LABELS = new Set([
  "APARTMENT",
  "APT",
  "NO",
  "NUMBER",
  "NUM",
  "STE",
  "SUITE",
  "UNIT",
]);

const BUILDING_LABELS = new Set([
  "BLD",
  "BLDG",
  "BUILDING",
  "TOWER",
]);

const FLOOR_LABELS = new Set([
  "FL",
  "FLOOR",
  "LEVEL",
  "LVL",
]);

const ADDRESS_TOKEN_ALIASES = Object.freeze({
  ALLEY: "ALY",
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
  TERRACE: "TER",
  TRAIL: "TRL",
  WEST: "W",
});

const HOUSE_NUMBER_PATTERN = /^([0-9]+[A-Z]?(?:-[0-9]+[A-Z]?)?(?:\s+1\/2)?)\b/;

function secondaryLabel(token) {
  if (UNIT_LABELS.has(token)) return "unit";
  if (BUILDING_LABELS.has(token)) return "building";
  if (FLOOR_LABELS.has(token)) return "floor";
  return null;
}

function normalizeSecondaryIdentifier(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "") || null;
}

function addressBearingParts(value) {
  const parts = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  const kept = [parts[0]];
  for (const part of parts.slice(1)) {
    const normalized = normalizeSearchText(part.replace(/#/g, " UNIT "));
    const first = normalized.split(" ")[0];
    if (secondaryLabel(first) || /^\d+[A-Z]?$/.test(first)) {
      kept.push(part);
      continue;
    }
    break;
  }
  return kept.join(" ");
}

function normalizedAddressTokens(value) {
  const prepared = addressBearingParts(value)
    .replace(/\b(BUILDING|BLDG|BLD|TOWER)\s*#\s*/gi, "$1 ")
    .replace(/\b(APARTMENT|APT|UNIT|SUITE|STE|NUMBER|NUM|NO)\s*#\s*/gi, "$1 ")
    .replace(/#\s*/g, " UNIT ")
    .replace(/\b(APARTMENT|APT|UNIT|SUITE|STE|NUMBER|NUM|NO)[\s:#.-]*([0-9A-Z][0-9A-Z/-]*)\b/gi, "$1 $2")
    .replace(/\b(BUILDING|BLDG|BLD|TOWER)[\s:#.-]*([0-9A-Z][0-9A-Z/-]*)\b/gi, "$1 $2")
    .replace(/\b(FLOOR|FL|LEVEL|LVL)[\s:#.-]*([0-9A-Z][0-9A-Z/-]*)\b/gi, "$1 $2");
  return normalizeSearchText(prepared)
    .split(" ")
    .filter(Boolean)
    .map((token) => ADDRESS_TOKEN_ALIASES[token] || token);
}

/**
 * Parse a situs address without treating presentation words such as Apt,
 * Suite, Unit, Number, or # as identity. Building and floor identifiers stay
 * separate so two units with the same number in different buildings cannot
 * be silently conflated.
 */
export function parseStructuredAddress(value) {
  const tokens = normalizedAddressTokens(value);
  const components = {
    raw_address: String(value || "").trim() || null,
    normalized_address: tokens.join(" ") || null,
    house_number: null,
    base_address_key: null,
    street_key: null,
    unit_key: null,
    building_key: null,
    floor_key: null,
    secondary_labels: [],
  };
  if (!tokens.length) return components;

  const baseTokens = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const kind = baseTokens.length >= 2 ? secondaryLabel(token) : null;
    if (!kind) {
      baseTokens.push(token);
      continue;
    }
    let identifierIndex = index + 1;
    while (secondaryLabel(tokens[identifierIndex]) === kind) {
      components.secondary_labels.push(tokens[identifierIndex]);
      identifierIndex += 1;
    }
    const identifier = normalizeSecondaryIdentifier(tokens[identifierIndex]);
    components.secondary_labels.push(token);
    if (identifier && !components[`${kind}_key`]) {
      components[`${kind}_key`] = identifier;
      index = identifierIndex;
    }
  }

  const baseAddressKey = baseTokens.join(" ").trim();
  const houseNumber = baseAddressKey.match(HOUSE_NUMBER_PATTERN)?.[1] || null;
  components.house_number = houseNumber;
  components.base_address_key = baseAddressKey || null;
  components.street_key = houseNumber
    ? baseAddressKey.slice(houseNumber.length).trim() || null
    : baseAddressKey || null;
  return components;
}

export function normalizedEditSimilarity(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const above = previous[column];
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }
  return Math.max(0, 1 - (previous[b.length] / Math.max(a.length, b.length)));
}

function tokenDiceSimilarity(left, right) {
  const leftTokens = new Set(String(left || "").split(" ").filter(Boolean));
  const rightTokens = new Set(String(right || "").split(" ").filter(Boolean));
  if (!leftTokens.size && !rightTokens.size) return 1;
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

export function structuredAddressSimilarity(source, candidate) {
  if (!source?.house_number || source.house_number !== candidate?.house_number) {
    return { eligible: false, score: 0, reasons: ["house_number_mismatch"] };
  }

  const edit = normalizedEditSimilarity(source.street_key, candidate.street_key);
  const dice = tokenDiceSimilarity(source.street_key, candidate.street_key);
  const streetScore = Math.max(edit, dice);
  const reasons = [source.street_key === candidate.street_key
    ? "street_exact"
    : `street_similarity_${streetScore.toFixed(3)}`];

  const compareSecondary = (kind, missingScore) => {
    const left = source[`${kind}_key`];
    const right = candidate[`${kind}_key`];
    if (left && right) {
      const exact = left === right;
      reasons.push(`${kind}_${exact ? "exact" : "mismatch"}`);
      return { score: exact ? 1 : 0, mismatch: !exact, incomplete: false };
    }
    if (!left && !right) return { score: 1, mismatch: false, incomplete: false };
    reasons.push(`${kind}_missing_on_${left ? "candidate" : "source"}`);
    return { score: missingScore, mismatch: false, incomplete: true };
  };

  const unit = compareSecondary("unit", 0.35);
  const building = compareSecondary("building", 0.55);
  const floor = compareSecondary("floor", 0.7);
  const secondaryMismatch = unit.mismatch || building.mismatch || floor.mismatch;
  const score = (streetScore * 0.75) + (unit.score * 0.16) +
    (building.score * 0.06) + (floor.score * 0.03);
  return {
    eligible: !secondaryMismatch && streetScore >= 0.72,
    score: Number(score.toFixed(6)),
    street_score: Number(streetScore.toFixed(6)),
    secondary_incomplete: unit.incomplete || building.incomplete || floor.incomplete,
    reasons,
  };
}

