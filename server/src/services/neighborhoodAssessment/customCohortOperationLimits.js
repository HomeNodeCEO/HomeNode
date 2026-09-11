// A new capture performs spatial discovery, complete source acquisition and
// immutable retention. Give that aggregate operation its own bounded budget;
// ordinary previews/reads still use one minute. Per-source/SQL limits, the
// single-heavy-operation gate and earlier caller deadlines remain independent.
export const CUSTOM_COHORT_OPERATION_LIMITS = Object.freeze({ duration_ms: 60_000, capture_duration_ms: 120_000 });
