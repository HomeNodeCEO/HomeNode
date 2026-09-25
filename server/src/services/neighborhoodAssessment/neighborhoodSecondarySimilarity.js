// Optional current-CAD support for an existing, independently established
// physical similarity score. Missing source values never mean zero/absent.
// This diagnostic must not establish historical condition or report evidence.
export const NEIGHBORHOOD_SECONDARY_SIMILARITY_VERSION = 1;
export const NEIGHBORHOOD_SECONDARY_WEIGHTS = Object.freeze({
  bedrooms: 0.025,
  baths: 0.025,
  garage: 0.020,
  pool: 0.010,
  outbuilding: 0.020,
});

function number(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:\d+)(?:\.\d+)?$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

const round = value => Math.round(value * 10) / 10;
const bounded = value => Math.max(0, Math.min(100, value));
function countSimilarity(subject, candidate, tolerance) {
  return subject === null || candidate === null ? null
    : round(bounded(100 - Math.abs(subject - candidate) * tolerance));
}
function areaSimilarity(subject, candidate, floor) {
  if (subject === null || candidate === null) return null;
  const scale = Math.max(floor, subject * 0.5);
  return round(100 * Math.exp(-0.5 * ((subject - candidate) / scale) ** 2));
}
function area(value, maximum) {
  // A recorded zero is not evidence of no improvement; only measured areas
  // participate. Large but implausible source literals remain unavailable.
  const parsed = number(value, maximum);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** At most ten percentage points of support. The established core score
 * remains exactly unchanged when no pair has a usable observation. A large
 * outbuilding can move the result by at most two points; garage area is never
 * silently converted to an invented garage-space count.
 */
export function scoreNeighborhoodSecondarySimilarity({ baseScore, subject = {}, candidate = {} } = {}) {
  const base = number(baseScore, 100);
  if (base === null) throw new TypeError('neighborhood_secondary_base_score_required');
  const bedrooms = countSimilarity(number(subject.bedroom_count, 30), number(candidate.bedroom_count, 30), 30);
  const baths = countSimilarity(number(subject.bath_count, 30), number(candidate.bath_count, 30), 35);
  const garage = areaSimilarity(area(subject.garage_area_sqft, 100000), area(candidate.garage_area_sqft, 100000), 200);
  const outbuilding = areaSimilarity(area(subject.outbuilding_area_sqft, 100000), area(candidate.outbuilding_area_sqft, 100000), 150);
  const pool = typeof subject.pool === 'boolean' && typeof candidate.pool === 'boolean'
    ? (subject.pool === candidate.pool ? 100 : 0) : null;
  const factors = { bedrooms, baths, garage, pool, outbuilding };
  const observed = Object.entries(factors).filter(([, score]) => score !== null);
  const availableWeight = observed.reduce((sum, [key]) => sum + NEIGHBORHOOD_SECONDARY_WEIGHTS[key], 0);
  const score = base * (1 - availableWeight)
    + observed.reduce((sum, [key, value]) => sum + NEIGHBORHOOD_SECONDARY_WEIGHTS[key] * value, 0);
  return Object.freeze({ methodology_version: NEIGHBORHOOD_SECONDARY_SIMILARITY_VERSION,
    basis: 'current_recorded_characteristics_diagnostic_only',
    score: observed.length ? round(score) : base, base_score: base,
    available_weight_percent: round(availableWeight * 100),
    factors: Object.freeze(Object.fromEntries(Object.entries(factors).map(([key, value]) => [key,
      Object.freeze({ score: value, weight_percent: NEIGHBORHOOD_SECONDARY_WEIGHTS[key] * 100,
        observed: value !== null })]))),
  });
}
