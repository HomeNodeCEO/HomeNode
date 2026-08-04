const PROFILE_ROWS = [
  ["urban_simple", "Urban - Simple", "urban", "simple", 1],
  ["urban_moderate", "Urban - Moderate", "urban", "moderate", 2],
  ["urban_complex", "Urban - Complex", "urban", "complex", 3],
  ["suburban_simple", "Suburban - Simple", "suburban", "simple", 2],
  ["suburban_moderate", "Suburban - Moderate", "suburban", "moderate", 5],
  ["suburban_complex", "Suburban - Complex", "suburban", "complex", 10],
  ["semi_rural_simple", "Semi-Rural - Simple", "semi_rural", "simple", 5],
  ["semi_rural_moderate", "Semi-Rural - Moderate", "semi_rural", "moderate", 10],
  ["semi_rural_complex", "Semi-Rural - Complex", "semi_rural", "complex", 20],
  ["rural_simple", "Rural - Simple", "rural", "simple", 10],
  ["rural_moderate", "Rural - Moderate", "rural", "moderate", 25],
  ["rural_complex", "Rural - Complex", "rural", "complex", 50],
];

export const COMPARABLE_SEARCH_PROFILES = Object.freeze(
  PROFILE_ROWS.map(([key, label, geography, complexity, radiusMiles]) =>
    Object.freeze({
      key,
      label,
      geography,
      complexity,
      radiusMiles,
    }),
  ),
);

export const DEFAULT_COMPARABLE_SEARCH_PROFILE_KEY = "suburban_simple";

const PROFILE_BY_KEY = new Map(
  COMPARABLE_SEARCH_PROFILES.map((profile) => [profile.key, profile]),
);

export function normalizeComparableSearchProfileKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function resolveComparableSearchProfile(value, { useDefault = true } = {}) {
  const normalized = normalizeComparableSearchProfileKey(value);
  const key = normalized || (useDefault ? DEFAULT_COMPARABLE_SEARCH_PROFILE_KEY : "");
  return PROFILE_BY_KEY.get(key) || null;
}

