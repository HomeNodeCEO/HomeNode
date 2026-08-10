function comparableText(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function streetLine(value) {
  return comparableText(String(value ?? "").split(",")[0]);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function differsWhenKnown(left, right, tolerance = 0) {
  const leftNumber = finiteNumber(left);
  const rightNumber = finiteNumber(right);
  if (leftNumber === null || rightNumber === null) return false;
  return Math.abs(leftNumber - rightNumber) > tolerance;
}

function textDiffersWhenKnown(left, right, transform = comparableText) {
  const leftText = transform(left);
  const rightText = transform(right);
  return Boolean(leftText && rightText && leftText !== rightText);
}

export function materialParcelDifferences(subject, candidate) {
  if (!subject || !candidate || subject.account_id === candidate.account_id) return [];
  const differences = [];
  if (differsWhenKnown(subject.total_value, candidate.total_value, 1)) {
    differences.push("Market / total value");
  }
  if (differsWhenKnown(subject.improvement_value, candidate.improvement_value, 1)) {
    differences.push("Improvement value");
  }
  if (differsWhenKnown(subject.land_value, candidate.land_value, 1)) {
    differences.push("Land value");
  }
  if (differsWhenKnown(subject.living_area_sqft, candidate.living_area_sqft, 1)) {
    differences.push("Living area");
  }
  if (textDiffersWhenKnown(subject.legal_description, candidate.legal_description)) {
    differences.push("Legal description");
  }
  if (
    textDiffersWhenKnown(
      subject.site_address || subject.address,
      candidate.site_address || candidate.address,
      streetLine,
    )
  ) {
    differences.push("Situs address");
  }
  if (textDiffersWhenKnown(subject.property_description, candidate.property_description)) {
    differences.push("Property description");
  }
  if (textDiffersWhenKnown(subject.use_description, candidate.use_description)) {
    differences.push("Property use");
  }
  return differences;
}

export function markMaterialParcelDifferences(parcels, subjectAccountId) {
  const subject = parcels.find((parcel) => parcel.account_id === subjectAccountId) || null;
  return parcels.map((parcel) => {
    const differenceFields = materialParcelDifferences(subject, parcel);
    return {
      ...parcel,
      difference_fields: differenceFields,
      materially_different: !parcel.is_subject && differenceFields.length > 0,
    };
  });
}
