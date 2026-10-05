import type { DcadExemptionsMap } from './propertyReportEditableSections';
export { reportTitleCase, reportAddress, reportZip5, reportNeighborhoodName } from './propertyReportText.ts';

export function recordedExemptionRows(exemptions?: DcadExemptionsMap) {
  const order: Array<[keyof DcadExemptionsMap, string]> = [
    ['city', 'City'], ['school', 'School'], ['county', 'County'],
    ['college', 'College'], ['hospital', 'Hospital'], ['special_district', 'Special District'],
  ];
  return order.map(([key, fallbackLabel]) => ({ key, fallbackLabel, row: exemptions?.[key] }))
    .filter(({ row }) => Boolean(row && Object.values(row).some(hasValue)));
}

export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

export function displayValue(value: unknown, fallback = 'Not reported'): string {
  return hasValue(value) ? String(value) : fallback;
}

export function parseNumber(value: unknown): number | null {
  if (!hasValue(value)) return null;
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMoney(value: unknown): string {
  const parsed = parseNumber(value);
  if (parsed === null) return 'Not reported';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(parsed);
}

export function formatNumber(value: unknown, suffix = ''): string {
  const parsed = parseNumber(value);
  if (parsed === null) return 'Not reported';
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(parsed)}${suffix}`;
}

export function formatOwnershipPercent(value: unknown): string {
  const parsed = parseNumber(value);
  if (parsed === null) return 'Share not reported';
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 3,
  }).format(parsed)}%`;
}

export function formatDate(value: unknown): string {
  if (!hasValue(value)) return 'Not reported';
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function formatCensusTract(value: unknown): string {
  const code = String(value || '').trim();
  if (!/^\d{6}$/.test(code)) return displayValue(value, 'Pending coordinate lookup');
  const whole = Number.parseInt(code.slice(0, 4), 10);
  const decimal = code.slice(4);
  return decimal === '00' ? String(whole) : `${whole}.${decimal}`;
}

export function activityTypeLabel(value: unknown): string {
  const labels: Record<string, string> = {
    listing: 'Listing',
    contract: 'Contract',
    closed_sale: 'Closed Sale',
    cad_transfer: 'CAD Transfer',
  };
  return labels[String(value || '')] || displayValue(value, 'Activity');
}

export function activityTypeClass(value: unknown): string {
  switch (String(value || '')) {
    case 'closed_sale': return 'bg-emerald-100 text-emerald-800';
    case 'contract': return 'bg-amber-100 text-amber-900';
    case 'listing': return 'bg-blue-100 text-blue-800';
    default: return 'bg-slate-200 text-slate-700';
  }
}

type TimelineRow = {
  record_type?: unknown;
  listing_id?: unknown;
  listing_key?: unknown;
  source_record_id?: unknown;
  source?: unknown;
  closing_date?: unknown;
  contract_date?: unknown;
  listing_date?: unknown;
};

export function listingTimelineRows<T extends TimelineRow>(events: T[]): T[] {
  const rows = new Map<string, T>();
  events.forEach((event, index) => {
    if (event.record_type === 'cad_transfer') return;
    if (
      !hasValue(event.listing_id) &&
      !hasValue(event.listing_key) &&
      !hasValue(event.source_record_id) &&
      !['listing', 'contract', 'closed_sale'].includes(String(event.record_type || ''))
    ) return;
    const key = String(
      event.listing_id || event.listing_key || event.source_record_id ||
      `${event.source || 'source'}-${event.closing_date || event.listing_date || index}`,
    );
    const current = rows.get(key) || ({} as T);
    const merged = { ...current } as T;
    Object.entries(event).forEach(([field, value]) => {
      if (hasValue(value)) {
        (merged as Record<string, unknown>)[field] = value;
      }
    });
    rows.set(key, merged);
  });
  return [...rows.values()].sort((left, right) => {
    const leftDate = Date.parse(String(left.closing_date || left.contract_date || left.listing_date || ''));
    const rightDate = Date.parse(String(right.closing_date || right.contract_date || right.listing_date || ''));
    return (Number.isFinite(rightDate) ? rightDate : 0) - (Number.isFinite(leftDate) ? leftDate : 0);
  });
}

function normalizedNameTokens(value: unknown): string[] {
  return [...new Set(
    String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token && !['AND', 'THE'].includes(token)),
  )].sort();
}

export function sellerComparisonSummary(contractSeller: unknown, publicOwner: unknown): {
  matches: boolean | null;
  summary: string;
} {
  const contractLabel = String(contractSeller || '').trim();
  const publicLabel = String(publicOwner || '').trim();
  if (!contractLabel) return { matches: null, summary: 'Enter the contract seller name to compare it with CAD ownership.' };
  if (!publicLabel || publicLabel === 'Not reported') {
    return { matches: null, summary: 'CAD ownership is unavailable, so the contract seller requires manual review.' };
  }
  const contractTokens = normalizedNameTokens(contractLabel);
  const publicTokens = normalizedNameTokens(publicLabel);
  const matches =
    contractTokens.length > 0 &&
    contractTokens.length === publicTokens.length &&
    contractTokens.every((token, index) => token === publicTokens[index]);
  return matches
    ? {
        matches: true,
        summary: `The contract seller appears consistent with CAD public records (${publicLabel}).`,
      }
    : {
        matches: false,
        summary: `The contract lists ${contractLabel}, while CAD public records list ${publicLabel}. Review and explain the difference before completing the assignment.`,
      };
}

function normalizedStreetAddress(value: unknown): string {
  const street = String(value || '').split(',')[0].toUpperCase();
  const suffixes: Record<string, string> = {
    STREET: 'ST',
    ROAD: 'RD',
    DRIVE: 'DR',
    LANE: 'LN',
    COURT: 'CT',
    BOULEVARD: 'BLVD',
    AVENUE: 'AVE',
    HIGHWAY: 'HWY',
    PLACE: 'PL',
    CIRCLE: 'CIR',
    PARKWAY: 'PKWY',
    TRAIL: 'TRL',
    TERRACE: 'TER',
  };
  return street
    .replace(/[^A-Z0-9#]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((token) => suffixes[token] || token)
    .join(' ');
}

export function documentSubjectAddressComparison(
  documentAddress: unknown,
  reportAddress: unknown,
): {
  matches: boolean | null;
  documentAddress: string;
  reportAddress: string;
} {
  const documentLabel = String(documentAddress || '').trim();
  const reportLabel = String(reportAddress || '').trim();
  const documentStreet = normalizedStreetAddress(documentLabel);
  const reportStreet = normalizedStreetAddress(reportLabel);
  return {
    matches: documentStreet && reportStreet ? documentStreet === reportStreet : null,
    documentAddress: documentLabel,
    reportAddress: reportLabel,
  };
}

/** Review-only findings shared by Custom Appraisal and UAD 3.6. An explicit
 * locality mismatch is not an automatic assertion that the document is wrong. */
export function documentSubjectLocalityFlags(
  candidates: Array<{ field_key?: string; review_status?: string | null; confirmed_value?: unknown;
    normalized_value?: unknown; raw_value?: unknown }> | undefined,
  reportAddress: unknown,
): string[] {
  const parse = (value: unknown) => String(value || '').trim().match(/,\s*([A-Za-z][A-Za-z .'-]*?),?\s+(?:TX|Texas),?\s+(\d{5})(?:-\d{4})?\b/i);
  const canonical = parse(reportAddress);
  if (!canonical) return [];
  const flags = new Set<string>();
  for (const candidate of candidates || []) {
    if (candidate.review_status === 'rejected') continue;
    const source = String(candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value ?? '').trim();
    if (!source) continue;
    if (candidate.field_key === 'contract_printed_subject_addresses') {
      // A contract may state one address on its main form and another on an
      // addendum. Keep every printed locality visible instead of checking only
      // the first match or silently choosing one as the report identity.
      for (const match of source.matchAll(/,\s*([A-Za-z][A-Za-z .'-]*?),?\s+(?:TX|Texas),?\s+(\d{5})(?:-\d{4})?\b/gi)) {
        if (match[1].toLowerCase() !== canonical[1].toLowerCase()) flags.add(`City: document says ${match[1]}; HomeNode subject says ${canonical[1]}.`);
        if (match[2] !== canonical[2]) flags.add(`ZIP: document says ${match[2]}; HomeNode subject says ${canonical[2]}.`);
      }
      continue;
    }
    const location = ['subject_property_address', 'subject_street_address'].includes(candidate.field_key || '') ? parse(source) : null;
    const city = candidate.field_key === 'subject_city' ? source : location?.[1];
    const postal = ['subject_zip', 'subject_zip_code'].includes(candidate.field_key || '') ? source.match(/^\d{5}/)?.[0] : location?.[2];
    if (city && city.toLowerCase() !== canonical[1].toLowerCase()) flags.add(`City: document says ${city}; HomeNode subject says ${canonical[1]}.`);
    if (postal && postal !== canonical[2]) flags.add(`ZIP: document says ${postal}; HomeNode subject says ${canonical[2]}.`);
  }
  return [...flags];
}

/** Only confirmed, reviewed source facts may become suggested report text.
 * Recompute this from the latest document before inserting it into any form. */
export function reviewedDocumentSubjectDiscrepancyStatement(
  document: { document_type: string; processing_status: string; candidates?: Array<{
    field_key?: string; review_status?: string | null; confirmed_value?: unknown;
    normalized_value?: unknown; raw_value?: unknown;
  }> } | null | undefined,
  reportAddress: unknown,
): string | null {
  if (!document || document.processing_status !== 'reviewed') return null;
  const confirmed = document.candidates?.filter(candidate => candidate.review_status === 'confirmed');
  const flags = documentSubjectLocalityFlags(confirmed, reportAddress);
  if (!flags.length) return null;
  return `The reviewed ${document.document_type.replaceAll('_', ' ')} contains a subject-location discrepancy: ${flags.join(' ')} The county-backed subject address controls in this report. The original source remains in the workfile for review.`;
}

/** Re-read source evidence at the point of insertion; a saved draft alone is
 * never authority for report commentary after a document changes or vanishes. */
export async function revalidateEvidenceDiscrepancyDrafts(
  prepared: Record<number, string>,
  loadDocument: (documentId: number) => Promise<Parameters<typeof reviewedDocumentSubjectDiscrepancyStatement>[0]>,
  reportAddress: unknown,
): Promise<{ statements: string[]; staleDocumentIds: number[] }> {
  const current = await Promise.all(Object.entries(prepared).map(async ([id, statement]) => {
    const documentId = Number(id);
    const document = await loadDocument(documentId);
    return { documentId, statement,
      latest: reviewedDocumentSubjectDiscrepancyStatement(document, reportAddress) };
  }));
  return {
    statements: current.filter(entry => entry.latest === entry.statement).map(entry => entry.statement),
    staleDocumentIds: current.filter(entry => entry.latest !== entry.statement).map(entry => entry.documentId),
  };
}

/** Preserve appraiser-written commentary and keep all chosen discrepancy
 * statements in one field instead of creating a separate addendum per source. */
export function combineEvidenceDiscrepancyCommentary(existing: unknown, statements: string[], limit = 5_000): string | null {
  const original = String(existing || '');
  const additions = [...new Set(statements.map(statement => statement.trim()).filter(Boolean))]
    .filter(statement => !original.includes(statement));
  const separator = !original || original.endsWith('\n\n') ? '' : original.endsWith('\n') ? '\n' : '\n\n';
  const combined = original + (additions.length
    ? `${separator}${additions.join('\n\n')}` : '');
  return combined.length <= limit ? combined : null;
}

/**
 * A subject-address mismatch is a hard confirmation gate only for engagement
 * letters. Other evidence keeps its extracted address visible for review, but
 * its individual fields must remain approvable.
 */
export function assignmentDocumentConfirmationBlocked(
  documentType: unknown,
  addressMatches: boolean | null,
  addressOverrideAcknowledged: boolean,
): boolean {
  return documentType === 'engagement_letter'
    && addressMatches === false
    && !addressOverrideAcknowledged;
}

export interface ConfirmedDocumentFieldCandidate {
  field_key: string;
  review_status?: string | null;
  confirmed_value?: string | null;
  normalized_value?: string | null;
  raw_value?: string | null;
}

export function confirmedDocumentFieldApplications(
  candidates: ConfirmedDocumentFieldCandidate[] | null | undefined,
): Array<{ fieldKey: string; value: string }> {
  return (candidates || []).flatMap((candidate) => {
    if (candidate.review_status !== 'confirmed') return [];
    const value = String(
      candidate.confirmed_value
        || candidate.normalized_value
        || candidate.raw_value
        || '',
    ).trim();
    if (!candidate.field_key || !value) return [];
    return [{ fieldKey: candidate.field_key, value }];
  });
}

export function formatReportedBoolean(value: unknown): string {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (!hasValue(value)) return 'Not reported';
  const normalized = String(value).trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(normalized)) return 'Yes';
  if (['no', 'n', 'false', '0'].includes(normalized)) return 'No';
  return String(value);
}

export function formatBaths(improvement?: {
  baths_full?: unknown;
  baths_half?: unknown;
  bath_count?: unknown;
}): string {
  const full = parseNumber(improvement?.baths_full);
  const half = parseNumber(improvement?.baths_half);
  if (full !== null || half !== null) {
    return `${full ?? 0} full / ${half ?? 0} half`;
  }
  return displayValue(improvement?.bath_count);
}
