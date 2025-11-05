// src/lib/dcad.ts
// Shim around the new DB-backed API helpers (src/lib/api.ts).
// - Re-exports: getHealth, getProperty, searchProperties + types
// - Back-compat aliases: search, searchByAddress, fetchDetail
//   (defaults countyId to 1 = Dallas; override if you support more counties)

import { getAccount as getAccountDb } from './api';

// Health endpoint (proxied to the app server)
export async function getHealth(): Promise<any> {
  const res = await fetch('/health');
  if (!res.ok) throw new Error(`Health HTTP ${res.status}`);
  return res.json();
}

// Legacy shape for older UI code that expected { query, results }
export type LegacySearchResponse = {
  query: string;
  results: SearchResult[];
};

/**
 * Legacy: searchByAddress(q, limit?, countyId?)
 * - Calls the new searchProperties under the hood.
 * - Defaults countyId to 1 (Dallas) to match your current dataset.
 */
export async function searchByAddress(
  q: string,
  limit = 5,
  countyId = 1
): Promise<LegacySearchResponse> {
  if (!q?.trim()) return { query: q ?? '', results: [] };
  const { results } = await searchProperties({ q, limit, countyId });
  return { query: q, results };
}

// Legacy alias some code might still import as { search }
export const search = searchByAddress;

/**
 * Legacy: fetchDetail(accountId, countyId?)
 * - Calls the new getProperty(countyId, accountId).
 * - Defaults countyId to 1 (Dallas).
 */
export async function fetchDetail(accountId: string, countyId = 1) {
  // Database-backed detail only (no scraper). Map DB result to the legacy detail shape
  const data = await getAccountDb((accountId || '').trim());
  const acc = data?.account || ({} as any);
  const imp = (data?.primary_improvements as any) || {};
  const os = (data as any)?.owner_summary || null;
  const lc = (data as any)?.legal_current || null;
  const lh = (data as any)?.legal_history || null;
  const exRows: Array<any> = (data as any)?.exemptions_summary || [];
  const exYear: number | undefined = (data as any)?.exemptions_summary_year || undefined;

  const detail = {
    tax_year: acc?.latest_tax_year ?? undefined,
    property_location: {
      address: acc?.address ?? undefined,
      neighborhood: acc?.neighborhood_code ?? undefined,
      mapsco: undefined,
      city: undefined,
    },
    owner: os ? { owner_name: os.owner_name, mailing_address: os.mailing_address } : undefined,
    value_summary: {
      certified_year: acc?.latest_tax_year ?? undefined,
      improvement_value: acc?.latest_improvement_value ?? undefined,
      land_value: acc?.latest_land_value ?? undefined,
      market_value: acc?.latest_market_value ?? undefined,
      capped_value: acc?.latest_capped_value ?? undefined,
      tax_agent: undefined,
      revaluation_year: undefined,
      previous_revaluation_year: undefined,
    },
    main_improvement: {
      construction_type: imp?.construction_type ?? undefined,
      percent_complete: imp?.percent_complete ?? undefined,
      year_built: imp?.year_built ?? undefined,
      effective_year_built: imp?.effective_year_built ?? undefined,
      actual_age: imp?.actual_age ?? undefined,
      depreciation: imp?.depreciation ?? undefined,
      desirability: imp?.desirability ?? undefined,
      stories: imp?.stories ?? undefined,
      living_area_sqft: imp?.living_area_sqft ?? imp?.total_living_area ?? undefined,
      total_living_area: imp?.total_living_area ?? imp?.living_area_sqft ?? undefined,
      bedroom_count: imp?.bedroom_count ?? undefined,
      bath_count: imp?.bath_count ?? undefined,
      baths_full: imp?.baths_full ?? undefined,
      baths_half: imp?.baths_half ?? undefined,
      basement: imp?.basement ?? undefined,
      basement_raw: (imp as any)?.basement_raw ?? undefined,
      kitchens: imp?.kitchens ?? undefined,
      wetbars: imp?.wetbars ?? imp?.wet_bars ?? undefined,
      fireplaces: imp?.fireplaces ?? undefined,
      sprinkler: imp?.sprinkler ?? undefined,
      spa: imp?.spa ?? undefined,
      pool: imp?.pool ?? undefined,
      sauna: imp?.sauna ?? undefined,
      air_conditioning: imp?.air_conditioning ?? undefined,
      heating: imp?.heating ?? undefined,
      foundation: imp?.foundation ?? undefined,
      roof_material: imp?.roof_material ?? undefined,
      roof_type: imp?.roof_type ?? undefined,
      exterior_material: imp?.exterior_material ?? undefined,
      fence_type: imp?.fence_type ?? undefined,
      number_units: imp?.number_units ?? undefined,
      building_class: imp?.building_class ?? undefined,
      total_area_sqft: (imp as any)?.total_area_sqft ?? undefined,
    },
    additional_improvements: (data as any)?.additional_improvements || [],
    secondary_improvements: (data as any)?.secondary_improvements || [],
    land_detail: (data as any)?.land_detail || [],
    exemptions: undefined,
    history: undefined,
    legal_description: {
      lines:
        (Array.isArray(lc?.legal_lines) && lc.legal_lines.length ? lc.legal_lines : undefined) ||
        (acc?.legal_description ? [String(acc.legal_description)] : []),
      deed_transfer_date: lc?.deed_transfer_date ?? lh?.deed_transfer_date ?? undefined,
    },
    exemption_details: undefined,
    arb_hearing: undefined,
    estimated_taxes_total: undefined,
    photos: [],
  } as any;

  // Populate exemptions map (latest year) so UI can detect Homestead
  if (Array.isArray(exRows) && exRows.length) {
    const latest = exYear ?? Math.max(...exRows.map((r: any) => Number(r.tax_year) || 0));
    const rows = exRows.filter((r: any) => Number(r.tax_year) === latest);
    const obj: Record<string, any> = {};
    const bucket = (name?: string) => {
      const s = (name || '').toString().toLowerCase();
      if (s.includes('school') || s.includes('isd')) return 'school';
      if (s.includes('county')) return 'county';
      if (s.includes('city')) return 'city';
      if (s.includes('college')) return 'college';
      if (s.includes('hospital')) return 'hospital';
      return 'special_district';
    };
    rows.forEach((r: any, i: number) => {
      const k = bucket(r.jurisdiction_key || r.taxing_jurisdiction);
      obj[k] = {
        taxing_jurisdiction: r.taxing_jurisdiction || r.jurisdiction_key,
        homestead_exemption: r.homestead_exemption,
        disabled_vet: (r as any).disabled_vet,
        taxable_value: (r as any).taxable_value,
      };
    });
    (detail as any).exemptions = obj;
  }

  return { detail };
}

/** Utility kept from your previous file */
export function fmtMoney(x: string | number | null | undefined): string {
  if (x == null) return '—';
  if (typeof x === 'number') {
    return x.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    });
  }
  if (x.includes('$') || x.includes(',')) return x;
  const n = Number(x.replace(/[^\d.-]/g, ''));
  if (Number.isFinite(n)) {
    return n.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    });
  }
  return String(x);
}





