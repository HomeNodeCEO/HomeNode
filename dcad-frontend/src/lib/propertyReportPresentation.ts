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
