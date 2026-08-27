// src/lib/dcad.ts
// Shim around the new DB-backed API helpers (src/lib/api.ts).
// - Re-exports: getHealth, getProperty, searchProperties + types
// - Back-compat aliases: search, searchByAddress, fetchDetail
//   (defaults countyId to 1 = Dallas; override if you support more counties)

import {
  getAccount as getAccountDb,
} from './api';

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
  const normalizedAccountId = (accountId || '').trim();
  const data = await getAccountDb(normalizedAccountId);
  const sales = data?.sales_history || [];
  const propertyActivity = data?.property_activity_history || sales;
  const acc = data?.account || ({} as any);
  const imp = (data?.primary_improvements as any) || {};
  const housingProfile = (data as any)?.housing_profile || null;
  const os = (data as any)?.owner_summary || null;
  const ownerParties = Array.isArray((data as any)?.owner_parties)
    ? (data as any).owner_parties
    : [];
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
      city: acc?.city ?? undefined,
      state:
        acc?.state ??
        (/dallas|collin|tarrant|denton|rockwall/i.test(String(acc?.county || ''))
          ? 'TX'
          : undefined),
      postal_code: acc?.postal_code ?? undefined,
      county: acc?.county ?? undefined,
      subdivision: acc?.subdivision ?? undefined,
      census_tract: data?.census_geography?.tract_code ?? undefined,
      census_tract_geoid: data?.census_geography?.tract_geoid ?? undefined,
      census_tract_status: data?.census_geography?.status ?? 'pending',
      census_vintage: data?.census_geography?.vintage ?? undefined,
    },
    owner: os || ownerParties.length
      ? {
          owner_name: os?.owner_name,
          mailing_address: os?.mailing_address,
          parties: ownerParties.map((party: any) => ({
            owner_name: party?.owner_name,
            ownership_pct: party?.ownership_pct,
          })),
        }
      : undefined,
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
    housing_profile: housingProfile,
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
    homestead_yes: Boolean((data as any)?.homestead_yes),
    sales_history: sales
      .filter((sale) => sale?.closing_date || sale?.sale_price)
      .sort((a, b) =>
        String(b?.closing_date || '').localeCompare(String(a?.closing_date || ''))
      )
      .map((sale) => ({
        source_record_id: sale?.source_record_id ?? undefined,
        listing_id: sale?.listing_id ?? undefined,
        closing_date: sale?.closing_date ?? undefined,
        sale_price: sale?.sale_price ?? undefined,
        days_on_market: sale?.days_on_market ?? undefined,
        buyer_financing: sale?.buyer_financing ?? undefined,
        mls_status: sale?.mls_status ?? undefined,
        record_type: sale?.record_type ?? undefined,
      })),
    property_activity_history: propertyActivity.map((event) => ({
      sale_id: (event as any)?.sale_id ?? undefined,
      source_record_id: (event as any)?.source_record_id ?? undefined,
      listing_key: (event as any)?.listing_key ?? undefined,
      listing_id: (event as any)?.listing_id ?? undefined,
      source: (event as any)?.source ?? undefined,
      record_type: (event as any)?.record_type ?? undefined,
      activity_date: (event as any)?.activity_date ?? undefined,
      listing_date: (event as any)?.listing_date ?? undefined,
      contract_date: (event as any)?.contract_date ?? undefined,
      closing_date: (event as any)?.closing_date ?? undefined,
      list_price: (event as any)?.list_price ?? undefined,
      sale_price: (event as any)?.sale_price ?? undefined,
      days_on_market: (event as any)?.days_on_market ?? undefined,
      buyer_financing: (event as any)?.buyer_financing ?? undefined,
      concessions: (event as any)?.concessions ?? undefined,
      mls_status: (event as any)?.mls_status ?? undefined,
      requires_additional_review: Boolean((event as any)?.requires_additional_review),
      data_quality_flags: Array.isArray((event as any)?.data_quality_flags)
        ? (event as any).data_quality_flags
        : [],
    })),
    census_geography: data?.census_geography || null,
    property_context: data?.property_context || null,
    // Photos are loaded independently by the report page and never delay the
    // core property response.
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
    rows.forEach((r: any) => {
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

  // Explicit report edits are audited overlays. They never mutate the CAD or
  // MLS source records, but they become the displayed/reportable values after
  // a user presses Save.
  const manualValues = (data as any)?.report_manual_values || {};
  const manual = (key: string) => manualValues?.[key]?.value;
  const subjectOverride = manual('report.subject_identification');
  if (subjectOverride && typeof subjectOverride === 'object') {
    const value = subjectOverride as any;
    detail.property_location = {
      ...detail.property_location,
      ...(value.property_location || {}),
    };
    detail.owner = { ...(detail.owner || {}), ...(value.owner || {}) };
    detail.legal_description = {
      ...detail.legal_description,
      ...(value.legal_description || {}),
    };
  }
  const exemptionOverride = manual('report.exemptions');
  if (exemptionOverride && typeof exemptionOverride === 'object') {
    const value = exemptionOverride as any;
    if (value.exemptions) detail.exemptions = value.exemptions;
    if (typeof value.homestead_yes === 'boolean') detail.homestead_yes = value.homestead_yes;
  }
  const salesOverride = manual('report.sales_history');
  if (salesOverride && typeof salesOverride === 'object') {
    const activityRows = (salesOverride as any).property_activity_history;
    if (Array.isArray(activityRows)) {
      detail.property_activity_history = activityRows;
      detail.sales_history = activityRows.filter(
        (row: any) => row?.record_type === 'closed_sale',
      );
    }
    const rows = (salesOverride as any).sales_history;
    if (Array.isArray(rows)) detail.sales_history = rows;
  }
  const characteristicsOverride = manual('report.property_characteristics');
  if (characteristicsOverride && typeof characteristicsOverride === 'object') {
    const value = characteristicsOverride as any;
    detail.main_improvement = {
      ...detail.main_improvement,
      ...(value.main_improvement || {}),
    };
    detail.housing_profile = {
      ...(detail.housing_profile || {}),
      ...(value.housing_profile || {}),
    };
    if (Array.isArray(value.additional_improvements)) {
      detail.additional_improvements = value.additional_improvements;
    }
  }
  const landOverride = manual('report.land_details');
  if (landOverride && typeof landOverride === 'object') {
    const rows = (landOverride as any).land_detail;
    if (Array.isArray(rows)) detail.land_detail = rows;
  }
  const valuesOverride = manual('report.appraisal_values');
  if (valuesOverride && typeof valuesOverride === 'object') {
    detail.value_summary = {
      ...detail.value_summary,
      ...((valuesOverride as any).value_summary || {}),
    };
  }
  const assignmentOverride = manual('report.assignment_details');
  detail.assignment_details =
    assignmentOverride && typeof assignmentOverride === 'object'
      ? assignmentOverride
      : {};
  detail.report_manual_values = manualValues;

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





