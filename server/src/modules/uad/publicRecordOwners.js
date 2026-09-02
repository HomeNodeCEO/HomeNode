const BUSINESS_OWNER_PATTERN = /\b(?:bank|company|co\.?|corp(?:oration)?\.?|inc(?:orporated)?\.?|llc|l\.l\.c\.?|llp|lp|ltd\.?|trust|trustee|estate|association|holdings?|partners?|partnership|properties|foundation|church)\b/i;
const SUFFIX_PATTERN = /^(?:jr\.?|sr\.?|ii|iii|iv|v)$/i;

function cleanOwnerName(value, maximumLength = 300) {
  const cleaned = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || /^n\/?a$/i.test(cleaned)) return null;
  return cleaned.slice(0, maximumLength);
}

function ownerNameParts(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9'\-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function individualOwnerValues(name, { primarySurname = null } = {}) {
  let first;
  let middle = [];
  let last;
  let suffix = null;
  const commaIndex = name.indexOf(",");

  if (commaIndex > 0) {
    last = cleanOwnerName(name.slice(0, commaIndex), 50);
    const givenParts = ownerNameParts(name.slice(commaIndex + 1));
    if (SUFFIX_PATTERN.test(givenParts.at(-1) || "")) suffix = givenParts.pop();
    first = givenParts.shift();
    middle = givenParts;
  } else {
    const parts = ownerNameParts(name);
    if (SUFFIX_PATTERN.test(parts.at(-1) || "")) suffix = parts.pop();
    if (parts.length < 2) return null;

    const sharedSurnameAtEnd = primarySurname
      && parts.length > 1
      && parts.at(-1).localeCompare(primarySurname, undefined, { sensitivity: "accent" }) === 0;
    const appearsGivenNameFirst = name !== name.toUpperCase() || sharedSurnameAtEnd;
    if (appearsGivenNameFirst) {
      first = parts.shift();
      last = parts.pop();
      middle = parts;
    } else {
      last = parts.shift();
      first = parts.shift();
      middle = parts;
    }
  }

  first = cleanOwnerName(first, 50);
  last = cleanOwnerName(last, 50);
  const middleName = cleanOwnerName(middle.join(" "), 50);
  if (!first || !last) return null;
  return [
    { uid: "1000.0022", context_key: "owner", value: first },
    ...(middleName ? [{ uid: "1000.0174", context_key: "owner", value: middleName }] : []),
    { uid: "1000.0023", context_key: "owner", value: last },
    ...(suffix ? [{ uid: "1000.0175", context_key: "owner", value: suffix.replace(/\.$/, "") }] : []),
  ];
}

export function uadPublicRecordOwnerNameValues(value, options = {}) {
  const name = cleanOwnerName(value);
  if (!name) return null;
  if (BUSINESS_OWNER_PATTERN.test(name)) {
    return [{ uid: "1000.0024", context_key: "owner", value: name }];
  }
  return individualOwnerValues(name, options);
}

function sourceOwnerRows(subjectSnapshot) {
  const parties = Array.isArray(subjectSnapshot?.owner_parties)
    ? subjectSnapshot.owner_parties
      .map((party, index) => ({
        name: cleanOwnerName(party?.owner_name),
        taxYear: Number(party?.tax_year) || Number(subjectSnapshot?.owner_summary?.tax_year) || null,
        ownershipPercent: party?.ownership_pct ?? null,
        sourceReference: `subject_snapshot.owner_parties.${index}.owner_name`,
      }))
      .filter((party) => party.name)
    : [];
  if (parties.length) return parties;

  const summaryName = cleanOwnerName(subjectSnapshot?.owner_summary?.owner_name);
  if (!summaryName) return [];
  const names = BUSINESS_OWNER_PATTERN.test(summaryName)
    ? [summaryName]
    : summaryName.split(/\s+(?:&|and)\s+|\s*\/\s*|\s*;\s*/i).map((name) => cleanOwnerName(name)).filter(Boolean);
  return names.map((name, index) => ({
    name,
    taxYear: Number(subjectSnapshot?.owner_summary?.tax_year) || null,
    ownershipPercent: null,
    sourceReference: names.length === 1
      ? "subject_snapshot.owner_summary.owner_name"
      : `subject_snapshot.owner_summary.owner_name:party-${index + 1}`,
  }));
}

export function buildUadPublicRecordOwners(subjectSnapshot) {
  const sourceRows = sourceOwnerRows(subjectSnapshot).slice(0, 20);
  const primarySurname = ownerNameParts(sourceRows[0]?.name)[0] || null;
  const seen = new Set();
  return sourceRows.flatMap((source, index) => {
    const dedupeKey = source.name.toLocaleUpperCase();
    if (seen.has(dedupeKey)) return [];
    seen.add(dedupeKey);
    const values = uadPublicRecordOwnerNameValues(source.name, {
      primarySurname: index > 0 ? primarySurname : null,
    });
    if (!values?.length) return [];
    return [{
      ...source,
      ordinal: index + 1,
      values,
    }];
  });
}

