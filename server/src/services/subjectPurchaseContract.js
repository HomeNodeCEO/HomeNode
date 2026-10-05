const supplementalName = document => /\b(?:th+ird[ -]?party financing|non[ -]?realty|addend(?:um|a)|amendment|rider)\b/i
  .test(`${document.title || ''} ${document.file_name || ''}`);
const primaryName = document => [document.title, document.file_name].some(name =>
  /^(?:purchase\s+)?contract(?:\.pdf)?$/i.test(String(name || '').trim()));

/** Pick the base contract in one assignment workfile. Financing and other
 * addenda remain evidence, but cannot displace a document labeled Contract.
 * Two equally plausible base contracts are an appraiser decision, not a guess. */
export function selectSubjectPurchaseContract(documents) {
  const contracts = documents.filter(document => document.document_type === 'purchase_contract');
  const base = contracts.filter(document => !supplementalName(document));
  const explicitlyLabeled = base.filter(primaryName);
  if (explicitlyLabeled.length === 1) return { document: explicitlyLabeled[0], supplementalCount: contracts.length - 1 };
  if (base.length === 1) return { document: base[0], supplementalCount: contracts.length - 1 };
  return { document: null, ambiguous: base.length > 1, supplementalCount: contracts.length - base.length };
}
