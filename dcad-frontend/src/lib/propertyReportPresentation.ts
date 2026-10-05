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

const nameSuffixes = new Set(['MR', 'MRS', 'MS', 'DR', 'JR', 'SR', 'II', 'III', 'IV', 'ET', 'AL']);
const businessWords = new Set([
  'LLC', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'COMPANY', 'LLP', 'LP',
  'LTD', 'LIMITED', 'PLC', 'PLLC', 'PC', 'HOLDINGS', 'ENTERPRISES', 'INVESTMENTS',
  'PROPERTIES', 'TRUST', 'BANK', 'ASSOCIATION', 'REALTY', 'BUILDERS', 'DEVELOPMENT',
  'VENTURES', 'CAPITAL',
]);

function nameTokens(value: string): string[] {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/['’`]/g, '').replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\bL\s+L\s+C\b/g, 'LLC').replace(/\bL\s+L\s+P\b/g, 'LLP')
    .replace(/\b([OD])\s+([A-Z]{3,})\b/g, '$1$2').trim().split(/\s+/)
    .filter((token) => token && !nameSuffixes.has(token));
}

function nameParties(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => {
    const label = String(entry || '').trim();
    if (!label) return [];
    return label.split(/\s+(?:AND|&)\s+|\s*[/;\n]\s*/i).flatMap((group) => {
      const commaParts = group.split(',').map((part) => part.trim()).filter(Boolean);
      // A comma separates two full names, but not "SMITH, JOHN".
      return commaParts.length > 1 && commaParts.every((part) => nameTokens(part).length >= 2)
        ? commaParts : [group.trim()];
    }).filter(Boolean);
  });
}

function closeNameToken(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 4 || right.length < 4 || Math.abs(left.length - right.length) > 1) return false;
  // One spelling/typing difference is allowed, but a shared first or last
  // name by itself is never enough to identify the same person.
  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i += 1; j += 1; continue; }
    if (++edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + Number(i < left.length || j < right.length) <= 1;
}

function matchingPerson(left: string, right: string): boolean {
  const seller = [...new Set(nameTokens(left))];
  const owner = [...new Set(nameTokens(right))];
  if (seller.length < 2 || owner.length < 2) return false;
  // A shared given and middle name cannot override a different family name.
  // CAD frequently places that family name first, so its position is flexible.
  if (!owner.some((token) => closeNameToken(seller[seller.length - 1], token))) return false;
  const unmatched = [...owner];
  let matched = 0;
  for (const token of seller) {
    const index = unmatched.findIndex((candidate) => closeNameToken(token, candidate));
    if (index >= 0) { unmatched.splice(index, 1); matched += 1; }
  }
  return matched >= 2;
}

export function sellerComparisonSummary(contractSeller: unknown, publicOwner: unknown): {
  matches: boolean | null;
  summary: string;
} {
  const contractParties = nameParties(contractSeller);
  const publicParties = nameParties(publicOwner);
  const contractLabel = contractParties.join(', ');
  const publicLabel = publicParties.join(', ');
  if (!contractLabel) return { matches: null, summary: 'Enter the contract seller name to compare it with CAD ownership.' };
  if (!publicLabel || publicLabel.toLowerCase() === 'not reported') {
    return { matches: null, summary: 'CAD ownership is unavailable, so the contract seller requires manual review.' };
  }
  const business = [...contractParties, ...publicParties]
    .some((party) => nameTokens(party).some((token) => businessWords.has(token)));
  const matches = !business && contractParties.some((seller) =>
    publicParties.some((owner) => matchingPerson(seller, owner)));
  return matches
    ? {
        matches: true,
        summary: `The contract seller appears consistent with CAD public records (${publicLabel}).`,
      }
    : {
        matches: false,
        summary: business
          ? `A contract seller or CAD owner is a business or trust. Marked No; review and explain the ownership difference before completing the assignment.`
          : `The contract lists ${contractLabel}, while CAD public records list ${publicLabel}. Review and explain the difference before completing the assignment.`,
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
