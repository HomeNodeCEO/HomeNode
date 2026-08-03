export const UAD_CONDITION_RATINGS = new Set([
  "C1", "C2-C1", "C2", "C3-C2", "C3", "C4-C3",
  "C4", "C5-C4", "C5", "C6-C5", "C6",
]);

export const UAD_QUALITY_RATINGS = new Set([
  "Q1", "Q2-Q1", "Q2", "Q3-Q2", "Q3", "Q4-Q3",
  "Q4", "Q5-Q4", "Q5", "Q6-Q5", "Q6",
]);

function optionalText(value, maxLength, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > maxLength) throw new Error(`invalid_${fieldName}`);
  return text;
}

function normalizeRating(value, allowed, fieldName) {
  const rating = String(value ?? "").trim().toUpperCase();
  if (!rating) return null;
  if (!allowed.has(rating)) throw new Error(`invalid_${fieldName}`);
  return rating;
}

export function normalizeEffectiveDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error("invalid_effective_date");
  }
  const date = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error("invalid_effective_date");
  }
  return text;
}

export function normalizeAppraisalRatingUpdate(input = {}) {
  const conditionRating = normalizeRating(
    input.condition_rating,
    UAD_CONDITION_RATINGS,
    "condition_rating",
  );
  const qualityRating = normalizeRating(
    input.quality_rating,
    UAD_QUALITY_RATINGS,
    "quality_rating",
  );
  if (!conditionRating && !qualityRating && input.clear !== true) {
    throw new Error("missing_appraisal_rating");
  }

  const expectedRevision = input.expected_revision == null
    ? null
    : Number(input.expected_revision);
  if (
    expectedRevision != null &&
    (!Number.isInteger(expectedRevision) || expectedRevision < 0)
  ) {
    throw new Error("invalid_expected_revision");
  }

  return {
    conditionRating,
    qualityRating,
    notes: optionalText(input.notes, 4000, "notes"),
    reviewer: optionalText(input.reviewer, 200, "reviewer") || "HomeNode editor",
    expectedRevision,
  };
}
