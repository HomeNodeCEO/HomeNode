import { hasSnapshotValue, mergeNonBlankSnapshot } from './reportSnapshotMerge.ts';

type NumericValue = string | number;
type FieldValue = string | number | boolean;
type JsonRecord = Record<string, unknown>;

export interface LegacyDcadLocation {
  address?: string;
  neighborhood?: string;
  mapsco?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  county?: string;
  subdivision?: string;
  census_tract?: string;
  census_tract_geoid?: string;
  census_tract_status?: string;
  census_vintage?: string;
}

export interface LegacyDcadOwner {
  owner_name?: string;
  mailing_address?: string;
  parties: Array<{
    owner_name?: string;
    ownership_pct?: NumericValue;
  }>;
}

export interface LegacyDcadValueSummary {
  certified_year?: number;
  improvement_value?: NumericValue;
  land_value?: NumericValue;
  market_value?: NumericValue;
  capped_value?: NumericValue;
  tax_agent?: string;
  revaluation_year?: number;
  previous_revaluation_year?: number;
}

export interface LegacyDcadMainImprovement {
  [key: string]: unknown;
  construction_type?: string;
  percent_complete?: NumericValue;
  year_built?: NumericValue;
  effective_year_built?: NumericValue;
  actual_age?: NumericValue;
  depreciation?: NumericValue;
  desirability?: string;
  stories?: NumericValue;
  stories_text?: string;
  living_area_sqft?: NumericValue;
  total_living_area?: NumericValue;
  bedroom_count?: NumericValue;
  bath_count?: NumericValue;
  baths_full?: NumericValue;
  baths_half?: NumericValue;
  basement?: FieldValue;
  basement_raw?: FieldValue;
  kitchens?: NumericValue;
  wetbars?: NumericValue;
  fireplaces?: NumericValue;
  sprinkler?: FieldValue;
  spa?: FieldValue;
  pool?: FieldValue;
  sauna?: FieldValue;
  air_conditioning?: string;
  heating?: string;
  foundation?: string;
  roof_material?: string;
  roof_type?: string;
  exterior_material?: string;
  fence_type?: string;
  number_units?: NumericValue;
  building_class?: string;
  total_area_sqft?: NumericValue;
}

export interface LegacyDcadHousingProfile {
  [key: string]: unknown;
  structural_style?: string;
  housing_type?: string;
  attachment_type?: 'mixed' | 'detached' | 'attached' | 'unknown';
  architectural_style?: string;
  profile_source?: string;
}

export interface LegacyDcadActivityRow {
  [key: string]: unknown;
  sale_id?: NumericValue;
  source_record_id?: NumericValue;
  listing_key?: string;
  listing_id?: string;
  source?: string;
  record_type?: string;
  activity_date?: string;
  listing_date?: string;
  contract_date?: string;
  closing_date?: string;
  list_price?: NumericValue;
  sale_price?: NumericValue;
  days_on_market?: NumericValue;
  buyer_financing?: string;
  concessions?: NumericValue;
  mls_status?: string;
  requires_additional_review: boolean;
  data_quality_flags: string[];
}

export interface LegacyDcadExemption {
  [key: string]: unknown;
  taxing_jurisdiction?: string;
  homestead_exemption?: NumericValue;
  disabled_vet?: NumericValue;
  taxable_value?: NumericValue;
}

export interface LegacyDcadDetail {
  tax_year?: number;
  total_living_area?: NumericValue;
  property_location: LegacyDcadLocation;
  owner?: LegacyDcadOwner;
  value_summary: LegacyDcadValueSummary;
  main_improvement: LegacyDcadMainImprovement;
  housing_profile: LegacyDcadHousingProfile | null;
  additional_improvements: JsonRecord[];
  secondary_improvements: JsonRecord[];
  land_detail: JsonRecord[];
  exemptions?: Record<string, LegacyDcadExemption>;
  history?: JsonRecord;
  legal_description: {
    lines: string[];
    deed_transfer_date?: string;
  };
  exemption_details?: JsonRecord;
  arb_hearing?: JsonRecord;
  estimated_taxes_total?: NumericValue;
  homestead_yes: boolean;
  sales_history: LegacyDcadActivityRow[];
  property_activity_history: LegacyDcadActivityRow[];
  census_geography: JsonRecord | null;
  property_context: JsonRecord | null;
  photos: string[];
  assignment_details: JsonRecord;
  report_manual_values: JsonRecord;
}

export interface LegacyDcadResponse {
  detail: LegacyDcadDetail;
}

function record(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== '__proto__' && key !== 'prototype' && key !== 'constructor',
    ),
  );
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numeric(value: unknown): NumericValue | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return typeof value === 'string' ? value : undefined;
}

function field(value: unknown): FieldValue | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return typeof value === 'string' || typeof value === 'boolean' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function records(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const normalized = record(item);
    return normalized ? [normalized] : [];
  });
}

function location(value: unknown): LegacyDcadLocation {
  const source = record(value) || {};
  return {
    address: text(source.address),
    neighborhood: text(source.neighborhood),
    mapsco: text(source.mapsco),
    city: text(source.city),
    state: text(source.state),
    postal_code: text(source.postal_code),
    county: text(source.county),
    subdivision: text(source.subdivision),
    census_tract: text(source.census_tract),
    census_tract_geoid: text(source.census_tract_geoid),
    census_tract_status: text(source.census_tract_status),
    census_vintage: text(source.census_vintage),
  };
}

function owner(value: unknown): LegacyDcadOwner | undefined {
  const source = record(value);
  if (!source) return undefined;
  const parties = records(source.parties).map((party) => ({
    owner_name: text(party.owner_name),
    ownership_pct: numeric(party.ownership_pct),
  }));
  const ownerName = text(source.owner_name);
  const mailingAddress = text(source.mailing_address);
  return ownerName || mailingAddress || parties.length
    ? { owner_name: ownerName, mailing_address: mailingAddress, parties }
    : undefined;
}

function valueSummary(value: unknown): LegacyDcadValueSummary {
  const source = record(value) || {};
  return {
    certified_year: numberValue(source.certified_year),
    improvement_value: numeric(source.improvement_value),
    land_value: numeric(source.land_value),
    market_value: numeric(source.market_value),
    capped_value: numeric(source.capped_value),
    tax_agent: text(source.tax_agent),
    revaluation_year: numberValue(source.revaluation_year),
    previous_revaluation_year: numberValue(source.previous_revaluation_year),
  };
}

function mainImprovement(value: unknown): LegacyDcadMainImprovement {
  const source = record(value) || {};
  return {
    construction_type: text(source.construction_type),
    percent_complete: numeric(source.percent_complete),
    year_built: numeric(source.year_built),
    effective_year_built: numeric(source.effective_year_built),
    actual_age: numeric(source.actual_age),
    depreciation: numeric(source.depreciation),
    desirability: text(source.desirability),
    stories: numeric(source.stories),
    stories_text: text(source.stories_text),
    living_area_sqft: numeric(source.living_area_sqft),
    total_living_area: numeric(source.total_living_area),
    bedroom_count: numeric(source.bedroom_count),
    bath_count: numeric(source.bath_count),
    baths_full: numeric(source.baths_full),
    baths_half: numeric(source.baths_half),
    basement: field(source.basement),
    basement_raw: field(source.basement_raw),
    kitchens: numeric(source.kitchens),
    wetbars: numeric(source.wetbars ?? source.wet_bars),
    fireplaces: numeric(source.fireplaces),
    sprinkler: field(source.sprinkler),
    spa: field(source.spa),
    pool: field(source.pool),
    sauna: field(source.sauna),
    air_conditioning: text(source.air_conditioning),
    heating: text(source.heating),
    foundation: text(source.foundation),
    roof_material: text(source.roof_material),
    roof_type: text(source.roof_type),
    exterior_material: text(source.exterior_material),
    fence_type: text(source.fence_type),
    number_units: numeric(source.number_units),
    building_class: text(source.building_class),
    total_area_sqft: numeric(source.total_area_sqft),
  };
}

function housingProfile(value: unknown): LegacyDcadHousingProfile | null {
  const source = record(value);
  if (!source) return null;
  return {
    structural_style: text(source.structural_style),
    housing_type: text(source.housing_type),
    attachment_type: attachmentType(source.attachment_type),
    architectural_style: text(source.architectural_style),
    profile_source: text(source.profile_source),
  };
}

function attachmentType(value: unknown): LegacyDcadHousingProfile['attachment_type'] {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'mixed' || normalized === 'detached' || normalized === 'attached') {
    return normalized;
  }
  return normalized ? 'unknown' : undefined;
}

function activityRows(value: unknown): LegacyDcadActivityRow[] {
  return records(value).map((source) => ({
    sale_id: numeric(source.sale_id),
    source_record_id: numeric(source.source_record_id),
    listing_key: text(source.listing_key),
    listing_id: text(source.listing_id),
    source: text(source.source),
    record_type: text(source.record_type),
    activity_date: text(source.activity_date),
    listing_date: text(source.listing_date),
    contract_date: text(source.contract_date),
    closing_date: text(source.closing_date),
    list_price: numeric(source.list_price),
    sale_price: numeric(source.sale_price),
    days_on_market: numeric(source.days_on_market),
    buyer_financing: text(source.buyer_financing),
    concessions: numeric(source.concessions),
    mls_status: text(source.mls_status),
    requires_additional_review: source.requires_additional_review === true,
    data_quality_flags: strings(source.data_quality_flags),
  }));
}

function exemption(value: unknown): LegacyDcadExemption | undefined {
  const source = record(value);
  if (!source) return undefined;
  return {
    taxing_jurisdiction: text(source.taxing_jurisdiction),
    homestead_exemption: numeric(source.homestead_exemption),
    disabled_vet: numeric(source.disabled_vet),
    taxable_value: numeric(source.taxable_value),
  };
}

function exemptionsMap(value: unknown): Record<string, LegacyDcadExemption> {
  const source = record(value) || {};
  const supported = new Set(['city', 'school', 'county', 'college', 'hospital', 'special_district']);
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, raw]) => {
      if (!supported.has(key)) return [];
      const normalized = exemption(raw);
      return normalized ? [[key, normalized]] : [];
    }),
  );
}

function legalDescription(value: unknown): LegacyDcadDetail['legal_description'] {
  const source = record(value) || {};
  return {
    lines: strings(source.lines),
    deed_transfer_date: text(source.deed_transfer_date),
  };
}

function exemptionBucket(name: unknown): string {
  const normalized = String(name || '').toLowerCase();
  if (normalized.includes('school') || normalized.includes('isd')) return 'school';
  if (normalized.includes('county')) return 'county';
  if (normalized.includes('city')) return 'city';
  if (normalized.includes('college')) return 'college';
  if (normalized.includes('hospital')) return 'hospital';
  return 'special_district';
}

function sourceExemptions(data: JsonRecord): Record<string, LegacyDcadExemption> | undefined {
  const rows = records(data.exemptions_summary);
  if (!rows.length) return undefined;
  const configuredYear = numberValue(data.exemptions_summary_year);
  const latestYear = configuredYear ?? Math.max(...rows.map((row) => Number(row.tax_year) || 0));
  const latestRows = rows.filter((row) => Number(row.tax_year) === latestYear);
  const result: Record<string, LegacyDcadExemption> = {};
  for (const row of latestRows) {
    const jurisdiction = text(row.jurisdiction_key) || text(row.taxing_jurisdiction);
    result[exemptionBucket(jurisdiction)] = {
      taxing_jurisdiction: text(row.taxing_jurisdiction) || text(row.jurisdiction_key),
      homestead_exemption: numeric(row.homestead_exemption),
      disabled_vet: numeric(row.disabled_vet),
      taxable_value: numeric(row.taxable_value),
    };
  }
  return result;
}

function manualValue(manualValues: JsonRecord, key: string): unknown {
  return record(manualValues[key])?.value;
}

export function mapAccountDetailToLegacy(value: unknown): LegacyDcadResponse {
  const data = record(value) || {};
  const account = record(data.account) || {};
  const improvement = mainImprovement(data.primary_improvements);
  const ownerSummary = record(data.owner_summary);
  const parties = records(data.owner_parties).map((party) => ({
    owner_name: text(party.owner_name),
    ownership_pct: numeric(party.ownership_pct),
  }));
  const summarizedOwner = ownerSummary || parties.length
    ? owner({
        owner_name: ownerSummary?.owner_name,
        mailing_address: ownerSummary?.mailing_address,
        parties,
      })
    : undefined;
  const currentLegal = record(data.legal_current);
  const historicalLegal = record(data.legal_history);
  const currentLines = strings(currentLegal?.legal_lines);
  const accountLegal = text(account.legal_description);
  const sales = activityRows(data.sales_history)
    .filter((sale) => sale.closing_date || sale.sale_price !== undefined)
    .sort((left, right) => String(right.closing_date || '').localeCompare(String(left.closing_date || '')));
  const propertyActivity = Array.isArray(data.property_activity_history)
    ? activityRows(data.property_activity_history)
    : sales;
  const county = text(account.county);
  const detail: LegacyDcadDetail = {
    tax_year: numberValue(account.latest_tax_year),
    property_location: {
      address: text(account.address),
      neighborhood: text(account.neighborhood_code),
      city: text(account.city),
      state: text(account.state) || (/dallas|collin|tarrant|denton|rockwall/i.test(county || '') ? 'TX' : undefined),
      postal_code: text(account.postal_code),
      county,
      subdivision: text(account.subdivision),
      census_tract: text(record(data.census_geography)?.tract_code),
      census_tract_geoid: text(record(data.census_geography)?.tract_geoid),
      census_tract_status: text(record(data.census_geography)?.status) || 'pending',
      census_vintage: text(record(data.census_geography)?.vintage),
    },
    owner: summarizedOwner,
    value_summary: {
      certified_year: numberValue(account.latest_tax_year),
      improvement_value: numeric(account.latest_improvement_value),
      land_value: numeric(account.latest_land_value),
      market_value: numeric(account.latest_market_value),
      capped_value: numeric(account.latest_capped_value),
    },
    main_improvement: {
      ...improvement,
      living_area_sqft: improvement.living_area_sqft ?? improvement.total_living_area,
      total_living_area: improvement.total_living_area ?? improvement.living_area_sqft,
    },
    housing_profile: housingProfile(data.housing_profile),
    additional_improvements: records(data.additional_improvements),
    secondary_improvements: records(data.secondary_improvements),
    land_detail: records(data.land_detail),
    exemptions: sourceExemptions(data),
    legal_description: {
      lines: currentLines.length ? currentLines : accountLegal ? [accountLegal] : [],
      deed_transfer_date: text(currentLegal?.deed_transfer_date) || text(historicalLegal?.deed_transfer_date),
    },
    homestead_yes: data.homestead_yes === true,
    sales_history: sales,
    property_activity_history: propertyActivity,
    census_geography: record(data.census_geography) || null,
    property_context: record(data.property_context) || null,
    photos: [],
    assignment_details: {},
    report_manual_values: {},
  };

  const manualValues = record(data.report_manual_values) || {};
  const subjectOverride = record(manualValue(manualValues, 'report.subject_identification'));
  if (subjectOverride) {
    detail.property_location = mergeNonBlankSnapshot(
      detail.property_location,
      location(subjectOverride.property_location),
    );
    detail.owner = mergeNonBlankSnapshot(detail.owner || { parties: [] }, owner(subjectOverride.owner));
    detail.legal_description = mergeNonBlankSnapshot(
      detail.legal_description,
      legalDescription(subjectOverride.legal_description),
    );
  }

  const exemptionOverride = record(manualValue(manualValues, 'report.exemptions'));
  if (exemptionOverride) {
    const normalized = exemptionsMap(exemptionOverride.exemptions);
    if (Object.keys(normalized).length) detail.exemptions = normalized;
    if (typeof exemptionOverride.homestead_yes === 'boolean') {
      detail.homestead_yes = exemptionOverride.homestead_yes;
    }
  }

  const salesOverride = record(manualValue(manualValues, 'report.sales_history'));
  if (salesOverride) {
    if (Array.isArray(salesOverride.property_activity_history)) {
      detail.property_activity_history = activityRows(salesOverride.property_activity_history);
      detail.sales_history = detail.property_activity_history.filter(
        (row) => row.record_type === 'closed_sale',
      );
    }
    if (Array.isArray(salesOverride.sales_history)) {
      detail.sales_history = activityRows(salesOverride.sales_history);
    }
  }

  const characteristicsOverride = record(manualValue(manualValues, 'report.property_characteristics'));
  if (characteristicsOverride) {
    detail.main_improvement = mergeNonBlankSnapshot(
      detail.main_improvement,
      mainImprovement(characteristicsOverride.main_improvement),
    );
    detail.housing_profile = mergeNonBlankSnapshot(
      detail.housing_profile || {},
      housingProfile(characteristicsOverride.housing_profile),
    );
    if (hasSnapshotValue(characteristicsOverride.additional_improvements)) {
      const normalized = records(characteristicsOverride.additional_improvements);
      if (normalized.length) detail.additional_improvements = normalized;
    }
  }

  const landOverride = record(manualValue(manualValues, 'report.land_details'));
  if (landOverride && hasSnapshotValue(landOverride.land_detail)) {
    const normalized = records(landOverride.land_detail);
    if (normalized.length) detail.land_detail = normalized;
  }

  const valuesOverride = record(manualValue(manualValues, 'report.appraisal_values'));
  if (valuesOverride) {
    detail.value_summary = mergeNonBlankSnapshot(
      detail.value_summary,
      valueSummary(valuesOverride.value_summary),
    );
  }

  detail.assignment_details = record(manualValue(manualValues, 'report.assignment_details')) || {};
  detail.report_manual_values = manualValues;
  return { detail };
}
