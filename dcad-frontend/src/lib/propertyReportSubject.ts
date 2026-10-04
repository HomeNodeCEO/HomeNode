/** Saved report values, distinct from CAD observations and evidence receipts. */
export interface UrarSubjectDetails {
  borrower_name?: string;
  assessor_parcel_number?: string;
  tax_year?: string;
  tax_amount?: string;
  property_rights?: '' | 'fee_simple' | 'leasehold';
  offered_for_sale_prior_12_months?: boolean | null;
  listing_history_summary?: string;
}

type OwnerParty = { owner_name?: string; ownership_pct?: string | number };
type Owner = { owner_name?: string; parties?: OwnerParty[] };

/** Match the saved report's owner precedence without inheriting CAD parties
 * over an explicit correction. Nonempty malformed parties deliberately clear
 * the displayed owner instead of reviving the alternate owner_name leaf. */
export function propertyReportOwnerPresentation(source: Owner | undefined, savedOwner: unknown): {
  ownerName: string | undefined; ownerParties: OwnerParty[];
} {
  const saved = savedOwner && typeof savedOwner === 'object' && !Array.isArray(savedOwner)
    ? savedOwner as Record<string, unknown> : null;
  const explicitParties = Boolean(saved && Object.hasOwn(saved, 'parties'));
  const explicitName = Boolean(saved && Object.hasOwn(saved, 'owner_name'));
  const names = (entries: unknown[]): OwnerParty[] => entries.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const party = entry as Record<string, unknown>;
    if (typeof party.owner_name !== 'string' || !party.owner_name.trim()) return [];
    return [{ owner_name: party.owner_name.trim(),
      ownership_pct: typeof party.ownership_pct === 'string' || typeof party.ownership_pct === 'number' ? party.ownership_pct : undefined }];
  });
  if (explicitParties && (!Array.isArray(saved!.parties) || saved!.parties.length > 0)) {
    const ownerParties = names(Array.isArray(saved!.parties) ? saved!.parties : []);
    return { ownerParties, ownerName: ownerParties.map(party => party.owner_name).join(' / ') };
  }
  if (explicitName || explicitParties) {
    return { ownerParties: [], ownerName: typeof saved!.owner_name === 'string' ? saved!.owner_name : undefined };
  }
  const ownerParties = names(source?.parties || []);
  return { ownerParties, ownerName: ownerParties.length ? ownerParties.map(party => party.owner_name).join(' / ') : source?.owner_name };
}
