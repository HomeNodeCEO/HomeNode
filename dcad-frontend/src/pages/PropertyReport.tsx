import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { fetchDetail } from "@/lib/dcad";
import {
  createAssignmentFile,
  getCensusZipProfile,
  getNeighborhoodProfile,
  getAssignmentFiles,
  getAccountPhotos,
  getRelatedParcels,
  lookupAccountCensusGeography,
  updateAssignmentFile,
  updatePropertyReportSections,
  type AppraisalAssignmentFile,
  type AssignmentDetailsPayload,
  type NeighborhoodProfileResponse,
  type ReportManualSectionKey,
  type RelatedParcelsResponse,
} from "@/lib/api";
import {
  readMarketConditionsDraft,
  type MarketConditionsDraft,
} from "@/lib/marketConditionsDraft";
import {
  marketTrendFromChange,
  neighborhoodBoundaryReadinessErrors,
  neighborhoodLandUseTotal,
  NEIGHBORHOOD_CITY_AVERAGE_ROWS,
  NEIGHBORHOOD_LAND_USE_FIELDS,
  NEIGHBORHOOD_RANGE_ROWS,
} from "@/lib/neighborhoodCharacteristics";

type DcadOwner = {
  owner_name?: string;
  mailing_address?: string;
  parties?: DcadOwnerParty[];
};

type DcadOwnerParty = {
  owner_name?: string;
  ownership_pct?: string | number;
};

type DcadValueSummary = {
  certified_year?: number | string;
  improvement_value?: string | number;
  land_value?: string | number;
  market_value?: string | number;
  capped_value?: string | number;
};

type DcadMainImprovement = {
  building_class?: string;
  year_built?: string | number;
  effective_year_built?: string | number;
  actual_age?: string | number;
  desirability?: string;
  living_area_sqft?: string | number;
  total_living_area?: string | number;
  total_area_sqft?: string | number;
  percent_complete?: string | number;
  stories?: number | string;
  construction_type?: string;
  foundation?: string;
  roof_type?: string;
  roof_material?: string;
  exterior_material?: string;
  basement?: boolean | string;
  heating?: string;
  air_conditioning?: string;
  bedroom_count?: string | number;
  bath_count?: string | number;
  baths_full?: string | number;
  baths_half?: string | number;
  kitchens?: string | number;
  wetbars?: string | number;
  fireplaces?: string | number;
  sprinkler?: boolean | string;
  spa?: boolean | string;
  pool?: boolean | string;
  sauna?: boolean | string;
  fence_type?: string;
  number_units?: string | number;
};

type DcadLandRow = {
  number?: string | number;
  state_code?: string;
  zoning?: string;
  frontage_ft?: string | number;
  depth_ft?: string | number;
  area_sqft?: string | number;
  pricing_method?: string;
  unit_price?: string | number;
  market_adjustment_pct?: string | number;
  adjusted_price?: string | number;
  ag_land?: string;
};

type DcadImprovementRow = {
  number?: string | number;
  improvement_type?: string;
  construction?: string;
  floor?: string;
  exterior_wall?: string;
  area_sqft?: string | number;
  value?: string | number;
  year_built?: string | number;
};

type DcadExemptionRow = {
  taxing_jurisdiction?: string;
  homestead_exemption?: string | number;
  disabled_vet?: string | number;
  taxable_value?: string | number;
};

type DcadExemptionsMap = {
  city?: DcadExemptionRow;
  school?: DcadExemptionRow;
  county?: DcadExemptionRow;
  college?: DcadExemptionRow;
  hospital?: DcadExemptionRow;
  special_district?: DcadExemptionRow;
};

type DcadSaleHistoryRow = {
  sale_id?: string | number;
  source_record_id?: string | number;
  listing_key?: string;
  listing_id?: string;
  source?: string;
  activity_date?: string;
  listing_date?: string;
  contract_date?: string;
  closing_date?: string;
  list_price?: string | number;
  sale_price?: string | number;
  days_on_market?: string | number;
  buyer_financing?: string;
  concessions?: string | number;
  mls_status?: string;
  record_type?: string;
  requires_additional_review?: boolean;
  data_quality_flags?: string[];
};

type DcadHousingProfile = {
  structural_style?: string;
  housing_type?: string;
  attachment_type?: string;
  architectural_style?: string;
  profile_source?: string;
};

type AssignmentDetails = AssignmentDetailsPayload;

type DcadDetail = {
  tax_year?: number;
  property_location?: {
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
  };
  owner?: DcadOwner;
  value_summary?: DcadValueSummary;
  main_improvement?: DcadMainImprovement;
  housing_profile?: DcadHousingProfile;
  additional_improvements?: DcadImprovementRow[];
  land_detail?: DcadLandRow[];
  exemptions?: DcadExemptionsMap;
  legal_description?: {
    lines?: string[];
    deed_transfer_date?: string;
  };
  sales_history?: DcadSaleHistoryRow[];
  property_activity_history?: DcadSaleHistoryRow[];
  census_geography?: {
    tract_geoid?: string;
    tract_code?: string;
    status?: string;
    vintage?: string;
    review_reason?: string;
  } | null;
  homestead_yes?: boolean;
  assignment_details?: AssignmentDetails;
  photos?: string[];
  report_manual_values?: Partial<Record<ReportManualSectionKey, unknown>>;
};

type EditableReportSection = {
  key: ReportManualSectionKey;
  title: string;
};

const EDITABLE_REPORT_SECTIONS: EditableReportSection[] = [
  { key: "report.subject_identification", title: "Subject Identification" },
  { key: "report.exemptions", title: "Current Exemptions" },
  { key: "report.sales_history", title: "Listings, Contracts, and Sales History" },
  { key: "report.property_characteristics", title: "Property Characteristics" },
  { key: "report.land_details", title: "Land Details" },
  { key: "report.appraisal_values", title: "Appraisal District Values" },
];

const HOA_FREQUENCY_OPTIONS = [
  ["per_year", "Per Year"],
  ["per_quarter", "Per Quarter"],
  ["per_month", "Per Month"],
  ["other", "Other"],
] as const;

const OCCUPANCY_OPTIONS = [
  ["owner", "Owner"],
  ["tenant", "Tenant"],
  ["vacant", "Vacant"],
  ["unknown", "Unknown"],
] as const;

const ASSIGNMENT_TYPE_OPTIONS = [
  ["purchase_transaction", "Purchase Transaction"],
  ["refinance", "Refinance"],
  ["heloc", "HELOC"],
  ["rtl", "RTL"],
  ["bridge_loan", "Bridge Loan"],
  ["new_construction", "New Construction"],
  ["rehab", "Rehab"],
  ["dscr", "DSCR"],
  ["other", "Other"],
] as const;

const CONTRACT_AMOUNT_FIELDS = [
  ["contract_price", "Contract Price"],
  ["loan_amount", "Loan Amount"],
  ["down_payment", "Down Payment"],
  ["earnest_money", "Earnest Money"],
  ["seller_concessions", "Seller Concessions"],
] as const;

const NEIGHBORHOOD_CHOICE_GROUPS = [
  {
    label: "Location Type",
    field: "neighborhood_location_type",
    options: [["urban", "Urban"], ["suburban", "Suburban"], ["rural", "Rural"]],
  },
  {
    label: "% Built-Up",
    field: "neighborhood_built_up",
    options: [["over_75", "Over 75%"], ["25_to_75", "25-75%"], ["under_25", "Under 25%"]],
  },
  {
    label: "Overall Growth",
    field: "neighborhood_growth",
    options: [["rapid", "Rapid"], ["stable", "Stable"], ["slow", "Slow"]],
  },
  {
    label: "Market Trends",
    field: "neighborhood_market_trend",
    options: [["increasing", "Increasing"], ["stable", "Stable"], ["declining", "Declining"]],
  },
  {
    label: "Demand / Supply",
    field: "neighborhood_demand_supply",
    options: [["shortage", "Shortage"], ["in_balance", "In Balance"], ["over_supply", "Over Supply"]],
  },
  {
    label: "Marketing Time",
    field: "neighborhood_marketing_time",
    options: [["under_3_months", "Under 3 Months"], ["3_to_6_months", "3-6 Months"], ["over_6_months", "Over 6 Months"]],
  },
] as const;

function assignmentDraftFromDetail(value?: AssignmentDetails): AssignmentDetails {
  return {
    pud: Boolean(value?.pud),
    hoa_dues_amount: value?.hoa_dues_amount || "",
    hoa_frequency: value?.hoa_frequency || "",
    hoa_explanation: value?.hoa_explanation || "",
    occupancy: value?.occupancy || "",
    occupancy_explanation: value?.occupancy_explanation || "",
    assignment_types: cloneEditorValue(value?.assignment_types || []),
    assignment_explanation: value?.assignment_explanation || "",
    lender_client_name: value?.lender_client_name || "",
    lender_client_address: value?.lender_client_address || "",
    subject_under_contract: Boolean(value?.subject_under_contract),
    contract_arms_length: typeof value?.contract_arms_length === "boolean"
      ? value.contract_arms_length
      : true,
    contract_seller_names: value?.contract_seller_names || "",
    contract_price: value?.contract_price || "",
    contract_date: value?.contract_date || "",
    loan_amount: value?.loan_amount || "",
    down_payment: value?.down_payment || "",
    earnest_money: value?.earnest_money || "",
    seller_concessions: value?.seller_concessions || "",
    seller_matches_public_records:
      typeof value?.seller_matches_public_records === "boolean"
        ? value.seller_matches_public_records
        : null,
    seller_mismatch_explanation: value?.seller_mismatch_explanation || "",
    neighborhood_land_use_one_unit_pct: value?.neighborhood_land_use_one_unit_pct ?? "",
    neighborhood_land_use_two_to_four_unit_pct:
      value?.neighborhood_land_use_two_to_four_unit_pct ?? "",
    neighborhood_land_use_multifamily_pct: value?.neighborhood_land_use_multifamily_pct ?? "",
    neighborhood_land_use_commercial_pct: value?.neighborhood_land_use_commercial_pct ?? "",
    neighborhood_land_use_other_vacant_pct:
      value?.neighborhood_land_use_other_vacant_pct ?? "",
    neighborhood_location_type: value?.neighborhood_location_type || "",
    neighborhood_built_up: value?.neighborhood_built_up || "",
    neighborhood_growth: value?.neighborhood_growth || "",
    neighborhood_unemployment_pct: value?.neighborhood_unemployment_pct ?? "",
    neighborhood_unemployment_zip: value?.neighborhood_unemployment_zip || "",
    neighborhood_unemployment_source: value?.neighborhood_unemployment_source || "",
    neighborhood_unemployment_dataset_year:
      value?.neighborhood_unemployment_dataset_year ?? "",
    neighborhood_unemployment_variable: value?.neighborhood_unemployment_variable || "",
    neighborhood_market_trend: value?.neighborhood_market_trend || "",
    neighborhood_demand_supply: value?.neighborhood_demand_supply || "",
    neighborhood_marketing_time: value?.neighborhood_marketing_time || "",
    neighborhood_house_price_low: value?.neighborhood_house_price_low ?? "",
    neighborhood_house_price_high: value?.neighborhood_house_price_high ?? "",
    neighborhood_house_price_predominant: value?.neighborhood_house_price_predominant ?? "",
    neighborhood_ppsf_low: value?.neighborhood_ppsf_low ?? "",
    neighborhood_ppsf_high: value?.neighborhood_ppsf_high ?? "",
    neighborhood_ppsf_predominant: value?.neighborhood_ppsf_predominant ?? "",
    neighborhood_age_low: value?.neighborhood_age_low ?? "",
    neighborhood_age_high: value?.neighborhood_age_high ?? "",
    neighborhood_age_predominant: value?.neighborhood_age_predominant ?? "",
    neighborhood_gla_low: value?.neighborhood_gla_low ?? "",
    neighborhood_gla_high: value?.neighborhood_gla_high ?? "",
    neighborhood_gla_predominant: value?.neighborhood_gla_predominant ?? "",
    neighborhood_city_name: value?.neighborhood_city_name || "",
    neighborhood_city_sale_count: value?.neighborhood_city_sale_count ?? "",
    neighborhood_city_average_sale_price: value?.neighborhood_city_average_sale_price ?? "",
    neighborhood_city_average_ppsf: value?.neighborhood_city_average_ppsf ?? "",
    neighborhood_city_average_age: value?.neighborhood_city_average_age ?? "",
    neighborhood_city_average_gla: value?.neighborhood_city_average_gla ?? "",
    neighborhood_city_comparison_as_of: value?.neighborhood_city_comparison_as_of || "",
    neighborhood_boundary_geometry: value?.neighborhood_boundary_geometry || null,
    neighborhood_boundary_label: value?.neighborhood_boundary_label || "",
    neighborhood_boundary_source: value?.neighborhood_boundary_source || "",
    neighborhood_boundary_saved_at: value?.neighborhood_boundary_saved_at || "",
    neighborhood_boundary_streets: value?.neighborhood_boundary_streets || "",
    neighborhood_boundary_north: value?.neighborhood_boundary_north || "",
    neighborhood_boundary_east: value?.neighborhood_boundary_east || "",
    neighborhood_boundary_south: value?.neighborhood_boundary_south || "",
    neighborhood_boundary_west: value?.neighborhood_boundary_west || "",
    neighborhood_boundary_exclusions: value?.neighborhood_boundary_exclusions || "",
    neighborhood_boundary_streets_source: value?.neighborhood_boundary_streets_source || "",
    neighborhood_boundary_streets_retrieved_at:
      value?.neighborhood_boundary_streets_retrieved_at || "",
    neighborhood_boundary_confirmed: Boolean(value?.neighborhood_boundary_confirmed),
    neighborhood_boundary_confirmed_at: value?.neighborhood_boundary_confirmed_at || "",
  };
}

function assignmentValidationErrors(assignment: AssignmentDetails): string[] {
  const errors: string[] = [];
  const hoaAmount = parseNumber(assignment.hoa_dues_amount);
  const hoaExplanation = String(assignment.hoa_explanation || "").trim();
  const assignmentTypes = Array.isArray(assignment.assignment_types)
    ? assignment.assignment_types
    : [];
  if (
    assignment.pud &&
    !((hoaAmount !== null && hoaAmount > 0 && assignment.hoa_frequency) || hoaExplanation)
  ) {
    errors.push("Enter HOA dues and a frequency, or explain why they are unavailable.");
  }
  if (assignment.pud && assignment.hoa_frequency === "other" && !hoaExplanation) {
    errors.push("Explain the Other HOA dues frequency.");
  }
  if (
    assignment.occupancy === "unknown" &&
    !String(assignment.occupancy_explanation || "").trim()
  ) {
    errors.push("Explain why occupancy is unknown.");
  }
  if (
    assignmentTypes.includes("other") &&
    !String(assignment.assignment_explanation || "").trim()
  ) {
    errors.push("Explain the Other assignment type.");
  }
  if (assignment.subject_under_contract && !assignmentTypes.includes("purchase_transaction")) {
    errors.push("Subject Under Contract requires Purchase Transaction in Assignment Details.");
  }
  if (assignment.subject_under_contract && typeof assignment.contract_arms_length !== "boolean") {
    errors.push("Select Yes or No for Arms Length.");
  }
  if (
    assignment.subject_under_contract &&
    typeof assignment.seller_matches_public_records !== "boolean"
  ) {
    errors.push("Select Yes or No for whether the seller matches public records.");
  }
  if (
    assignment.subject_under_contract &&
    assignment.seller_matches_public_records === false &&
    !String(assignment.seller_mismatch_explanation || "").trim()
  ) {
    errors.push("Explain the difference between the contract seller and public records.");
  }
  const landUseTotal = neighborhoodLandUseTotal(assignment);
  if (landUseTotal !== null && Math.abs(landUseTotal - 100) > 0.1) {
    errors.push("Present land use percentages must total 100%.");
  }
  return errors;
}

function CheckboxChoice({
  checked,
  label,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
      disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer"
    } ${
      checked
        ? "border-blue-400 bg-blue-50 text-blue-900"
        : "border-slate-200 bg-white text-slate-700"
    }`}>
      <input
        type="checkbox"
        className="checkbox checkbox-sm checkbox-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

const ARRAY_ROW_TEMPLATES: Record<string, Record<string, unknown>> = {
  property_activity_history: {
    record_type: "listing",
    activity_date: "",
    listing_id: "",
    mls_status: "",
    list_price: "",
    sale_price: "",
    days_on_market: "",
    buyer_financing: "",
    concessions: "",
    source: "Manual appraisal-file entry",
  },
  sales_history: {
    closing_date: "",
    listing_id: "",
    sale_price: "",
    days_on_market: "",
    buyer_financing: "",
  },
  land_detail: {
    number: "",
    state_code: "",
    zoning: "",
    frontage_ft: "",
    depth_ft: "",
    area_sqft: "",
    pricing_method: "",
    adjusted_price: "",
  },
  additional_improvements: {
    improvement_type: "",
    construction: "",
    floor: "",
    exterior_wall: "",
    area_sqft: "",
    value: "",
    year_built: "",
  },
  parties: {
    owner_name: "",
    ownership_pct: "",
  },
};

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function displayValue(value: unknown, fallback = "Not reported"): string {
  return hasValue(value) ? String(value) : fallback;
}

function parseNumber(value: unknown): number | null {
  if (!hasValue(value)) return null;
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value: unknown): string {
  const parsed = parseNumber(value);
  if (parsed === null) return "Not reported";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(parsed);
}

function formatNumber(value: unknown, suffix = ""): string {
  const parsed = parseNumber(value);
  if (parsed === null) return "Not reported";
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(parsed)}${suffix}`;
}

function formatOwnershipPercent(value: unknown): string {
  const parsed = parseNumber(value);
  if (parsed === null) return "Share not reported";
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 3,
  }).format(parsed)}%`;
}

function formatDate(value: unknown): string {
  if (!hasValue(value)) return "Not reported";
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatCensusTract(value: unknown): string {
  const code = String(value || "").trim();
  if (!/^\d{6}$/.test(code)) return displayValue(value, "Pending coordinate lookup");
  const whole = Number.parseInt(code.slice(0, 4), 10);
  const decimal = code.slice(4);
  return decimal === "00" ? String(whole) : `${whole}.${decimal}`;
}

function activityTypeLabel(value: unknown): string {
  const labels: Record<string, string> = {
    listing: "Listing",
    contract: "Contract",
    closed_sale: "Closed Sale",
    cad_transfer: "CAD Transfer",
  };
  return labels[String(value || "")] || displayValue(value, "Activity");
}

function activityTypeClass(value: unknown): string {
  switch (String(value || "")) {
    case "closed_sale": return "bg-emerald-100 text-emerald-800";
    case "contract": return "bg-amber-100 text-amber-900";
    case "listing": return "bg-blue-100 text-blue-800";
    default: return "bg-slate-200 text-slate-700";
  }
}

function listingTimelineRows(events: DcadSaleHistoryRow[]): DcadSaleHistoryRow[] {
  const rows = new Map<string, DcadSaleHistoryRow>();
  events.forEach((event, index) => {
    if (event.record_type === "cad_transfer") return;
    if (
      !hasValue(event.listing_id) &&
      !hasValue(event.listing_key) &&
      !hasValue(event.source_record_id) &&
      !["listing", "contract", "closed_sale"].includes(String(event.record_type || ""))
    ) return;
    const key = String(
      event.listing_id || event.listing_key || event.source_record_id ||
      `${event.source || "source"}-${event.closing_date || event.listing_date || index}`,
    );
    const current = rows.get(key) || {};
    const merged = { ...current } as DcadSaleHistoryRow;
    Object.entries(event).forEach(([field, value]) => {
      if (hasValue(value)) {
        (merged as Record<string, unknown>)[field] = value;
      }
    });
    rows.set(key, merged);
  });
  return [...rows.values()].sort((left, right) => {
    const leftDate = Date.parse(String(left.closing_date || left.contract_date || left.listing_date || ""));
    const rightDate = Date.parse(String(right.closing_date || right.contract_date || right.listing_date || ""));
    return (Number.isFinite(rightDate) ? rightDate : 0) - (Number.isFinite(leftDate) ? leftDate : 0);
  });
}

function normalizedNameTokens(value: unknown): string[] {
  return [...new Set(
    String(value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token && !["AND", "THE"].includes(token)),
  )].sort();
}

function sellerComparisonSummary(contractSeller: unknown, publicOwner: unknown): {
  matches: boolean | null;
  summary: string;
} {
  const contractLabel = String(contractSeller || "").trim();
  const publicLabel = String(publicOwner || "").trim();
  if (!contractLabel) return { matches: null, summary: "Enter the contract seller name to compare it with CAD ownership." };
  if (!publicLabel || publicLabel === "Not reported") {
    return { matches: null, summary: "CAD ownership is unavailable, so the contract seller requires manual review." };
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

function NeighborhoodCharacteristicsContent({
  accountId,
  assignmentDraft,
  postalCode,
  unemploymentLoading,
  unemploymentMessage,
  profileLoading,
  profileMessage,
  boundarySuggestions,
  customAreaAvailable,
  assignmentDirty,
  assignmentSaveMessage,
  assignmentSaveDisabled,
  savingAssignmentFile,
  onAssignmentChange,
  onRefreshUnemployment,
  onRefreshBoundary,
  onConfirmBoundary,
  onSave,
}: {
  accountId?: string;
  assignmentDraft: AssignmentDetails;
  postalCode: string;
  unemploymentLoading: boolean;
  unemploymentMessage: string;
  profileLoading: boolean;
  profileMessage: string;
  boundarySuggestions: NonNullable<NeighborhoodProfileResponse["boundary_streets"]>["cardinal_boundaries"] | null;
  customAreaAvailable: boolean;
  assignmentDirty: boolean;
  assignmentSaveMessage: string;
  assignmentSaveDisabled: boolean;
  savingAssignmentFile: boolean;
  onAssignmentChange: <K extends keyof AssignmentDetails>(
    key: K,
    value: AssignmentDetails[K],
  ) => void;
  onRefreshUnemployment: () => void;
  onRefreshBoundary: () => void;
  onConfirmBoundary: (checked: boolean) => void;
  onSave: () => void;
}) {
  const landUseTotal = neighborhoodLandUseTotal(assignmentDraft);
  const boundaryErrors = neighborhoodBoundaryReadinessErrors(assignmentDraft);
  const boundaryRing = assignmentDraft.neighborhood_boundary_geometry?.coordinates?.[0] || [];
  const updateBoundarySide = (
    field: "neighborhood_boundary_north" | "neighborhood_boundary_east" |
      "neighborhood_boundary_south" | "neighborhood_boundary_west",
    value: string,
  ) => {
    const next = { ...assignmentDraft, [field]: value };
    onAssignmentChange(field, value);
    onAssignmentChange("neighborhood_boundary_streets", [
      ["North", next.neighborhood_boundary_north],
      ["East", next.neighborhood_boundary_east],
      ["South", next.neighborhood_boundary_south],
      ["West", next.neighborhood_boundary_west],
    ].filter(([, street]) => String(street || "").trim())
      .map(([side, street]) => `${side}: ${String(street).trim()}`)
      .join("; "));
  };

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Present Land Use</h3>
            <p className="mt-0.5 text-xs text-slate-500">Enter the current neighborhood allocation; all categories must total 100%.</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
            landUseTotal !== null && Math.abs(landUseTotal - 100) <= 0.1
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-900"
          }`}>
            Total {landUseTotal === null ? "0" : landUseTotal.toFixed(1)}%
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {NEIGHBORHOOD_LAND_USE_FIELDS.map(([field, label]) => (
            <label key={field} className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</span>
              <div className="relative mt-1">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  className="input input-bordered input-sm w-full bg-white pr-8"
                  value={assignmentDraft[field] ?? ""}
                  onChange={(event) => onAssignmentChange(field, event.target.value)}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section className="border-t border-slate-200 pt-5">
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {NEIGHBORHOOD_CHOICE_GROUPS.map((group) => (
            <fieldset key={group.field} className="rounded-xl border border-slate-200 bg-white p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">{group.label}</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {group.options.map(([value, label]) => (
                  <CheckboxChoice
                    key={value}
                    checked={assignmentDraft[group.field] === value}
                    label={label}
                    onChange={(checked) => onAssignmentChange(group.field, checked ? value : "")}
                  />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </section>

      <section className="grid gap-4 border-t border-slate-200 pt-5 lg:grid-cols-[1fr_2fr]">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Unemployment</h3>
              <p className="mt-0.5 text-xs text-slate-500">ZIP-level ACS 5-year unemployment rate.</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-xs normal-case text-blue-700"
              onClick={onRefreshUnemployment}
              disabled={unemploymentLoading || !postalCode}
            >
              {unemploymentLoading ? "Loading..." : "Refresh Census"}
            </button>
          </div>
          <label className="mt-3 block max-w-[180px]">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Unemployment %</span>
            <div className="relative mt-1">
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                className="input input-bordered input-sm w-full bg-white pr-8"
                value={assignmentDraft.neighborhood_unemployment_pct ?? ""}
                onChange={(event) => onAssignmentChange("neighborhood_unemployment_pct", event.target.value)}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
            </div>
          </label>
          <div className="mt-2 text-[11px] leading-5 text-slate-500">
            {assignmentDraft.neighborhood_unemployment_source ? (
              <>
                {assignmentDraft.neighborhood_unemployment_source}, {assignmentDraft.neighborhood_unemployment_dataset_year} ACS 5-Year<br />
                ZIP {assignmentDraft.neighborhood_unemployment_zip || postalCode} ? {assignmentDraft.neighborhood_unemployment_variable}
              </>
            ) : `Awaiting Census lookup for ZIP ${postalCode || "not reported"}.`}
          </div>
          {unemploymentMessage ? (
            <div className={`mt-2 text-xs font-medium ${
              /loaded|updated/i.test(unemploymentMessage) ? "text-emerald-700" : "text-amber-800"
            }`}>{unemploymentMessage}</div>
          ) : null}
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">Neighborhood Property Ranges</h3>
          <p className="mt-0.5 text-xs text-slate-500">Low, high, and predominant (median) values from the defined market area.</p>
          <div className="mt-3 min-w-[620px]">
            <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-3 border-b border-slate-300 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
              <div>Measure</div><div>Low</div><div>High</div><div>Predominant</div>
            </div>
            {NEIGHBORHOOD_RANGE_ROWS.map((row) => (
              <div key={row.label} className="grid grid-cols-[1.2fr_1fr_1fr_1fr] items-center gap-3 border-b border-slate-100 py-2.5 last:border-0">
                <div className="text-sm font-medium text-slate-800">{row.label}</div>
                {[row.low, row.high, row.predominant].map((field) => (
                  <input
                    key={field}
                    type="number"
                    min="0"
                    step={row.label === "Age" ? "1" : "0.01"}
                    className="input input-bordered input-sm w-full bg-white"
                    value={assignmentDraft[field] ?? ""}
                    onChange={(event) => onAssignmentChange(field, event.target.value)}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="mt-5 border-t border-slate-200 pt-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-slate-900">Full-City Average Comparison</h4>
                <p className="mt-0.5 text-xs text-slate-500">
                  {assignmentDraft.neighborhood_city_name || "Subject city"} closed-sale averages; this does not replace the appraiser-defined neighborhood ranges.
                </p>
              </div>
              <span className="text-xs font-medium text-slate-600">
                {assignmentDraft.neighborhood_city_sale_count === "" || assignmentDraft.neighborhood_city_sale_count == null
                  ? "Sample pending"
                  : `${formatNumber(assignmentDraft.neighborhood_city_sale_count)} sales`}
              </span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {NEIGHBORHOOD_CITY_AVERAGE_ROWS.map((row) => (
                <div key={row.field} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Average {row.label}</div>
                  <div className="mt-1 text-base font-semibold text-slate-900">
                    {row.format === "money"
                      ? formatMoney(assignmentDraft[row.field])
                      : formatNumber(assignmentDraft[row.field], row.label === "GLA" ? " sq. ft." : " years")}
                  </div>
                </div>
              ))}
            </div>
            {assignmentDraft.neighborhood_city_comparison_as_of ? (
              <p className="mt-2 text-[11px] text-slate-500">Analysis through {formatDate(assignmentDraft.neighborhood_city_comparison_as_of)}</p>
            ) : null}
          </div>
        </div>
      </section>

      <section className={`rounded-xl border p-4 ${
        boundaryErrors.length ? "border-amber-300 bg-amber-50" : "border-emerald-300 bg-emerald-50"
      }`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Neighborhood Boundaries</h3>
            <p className="mt-1 text-xs text-slate-600">
              {assignmentDraft.neighborhood_boundary_geometry
                ? `${assignmentDraft.neighborhood_boundary_label || "Appraiser-defined market area"} ? ${Math.max(boundaryRing.length - 1, 0)} boundary vertices`
                : "No appraiser-defined boundary has been imported."}
            </p>
            {assignmentDraft.neighborhood_boundary_saved_at ? (
              <p className="mt-1 text-[11px] text-slate-500">Market study saved {formatDate(assignmentDraft.neighborhood_boundary_saved_at)}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to={accountId
                ? `/ComparableSalesAnalysis?propertyId=${encodeURIComponent(accountId)}`
                : "/ComparableSalesAnalysis"}
              className="btn btn-ghost btn-sm normal-case text-blue-700"
            >
              Open Market Conditions
            </Link>
            <button
              type="button"
              className="btn btn-outline btn-sm normal-case"
              onClick={onRefreshBoundary}
              disabled={!customAreaAvailable || profileLoading}
            >
              {profileLoading ? "Refreshing..." : "Refresh Area Data"}
            </button>
          </div>
        </div>
        <div className="mt-4">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Appraisal Boundary Summary</span>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {([
              ["neighborhood_boundary_north", "North"],
              ["neighborhood_boundary_east", "East"],
              ["neighborhood_boundary_south", "South"],
              ["neighborhood_boundary_west", "West"],
            ] as const).map(([field, label]) => (
              <label key={field} className="block">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
                <input
                  type="text"
                  list={`boundary-${label.toLowerCase()}-candidates`}
                  className="input input-bordered input-sm mt-1 w-full bg-white"
                  value={assignmentDraft[field] || ""}
                  onChange={(event) => updateBoundarySide(field, event.target.value)}
                  placeholder={`${label} boundary road`}
                />
                <datalist id={`boundary-${label.toLowerCase()}-candidates`}>
                  {boundarySuggestions?.[label.toLowerCase() as "north" | "east" | "south" | "west"]?.candidates.map((candidate) => (
                    <option key={candidate.name} value={candidate.name} />
                  ))}
                </datalist>
                {boundarySuggestions?.[label.toLowerCase() as "north" | "east" | "south" | "west"]?.confidence ? (
                  <span className="mt-1 block text-[10px] text-slate-500">
                    Automated confidence: {boundarySuggestions[label.toLowerCase() as "north" | "east" | "south" | "west"].confidence}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
          <label className="mt-3 block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Exclusions / Irregular Areas</span>
            <textarea
              rows={2}
              className="textarea textarea-bordered mt-1 w-full bg-white text-sm"
              value={assignmentDraft.neighborhood_boundary_exclusions || ""}
              onChange={(event) => onAssignmentChange("neighborhood_boundary_exclusions", event.target.value)}
              placeholder="Describe excluded subdivisions, pockets, or irregular boundary sections"
            />
          </label>
          <span className="mt-1 block text-[11px] text-slate-500">
            The system suggests the dominant road on each side. Review and edit these fields for appraisal use; record irregular exclusions separately.
            {assignmentDraft.neighborhood_boundary_streets_source
              ? ` Source: ${assignmentDraft.neighborhood_boundary_streets_source}.`
              : ""}
          </span>
        </div>
        {profileMessage ? (
          <div className={`mt-3 text-xs font-medium ${/updated|loaded|refreshed/i.test(profileMessage) ? "text-emerald-800" : "text-amber-900"}`}>
            {profileMessage}
          </div>
        ) : null}
        <div className="mt-3 max-w-xl">
          <CheckboxChoice
            checked={Boolean(assignmentDraft.neighborhood_boundary_confirmed)}
            disabled={!assignmentDraft.neighborhood_boundary_geometry}
            label="I reviewed this boundary for the current appraisal file"
            onChange={onConfirmBoundary}
          />
        </div>
        {boundaryErrors.length ? (
          <div className="mt-3 text-sm font-medium text-amber-950">
            PDF E&amp;O blocker: {boundaryErrors.join(" ")}
          </div>
        ) : (
          <div className="mt-3 text-sm font-medium text-emerald-900">Boundary is confirmed and ready for the appraisal PDF.</div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-slate-500">
          {assignmentSaveMessage || (assignmentDirty ? "Unsaved neighborhood changes" : "No unsaved changes")}
        </span>
        <button
          type="button"
          onClick={onSave}
          className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
          disabled={assignmentSaveDisabled}
        >
          {savingAssignmentFile ? "Saving..." : "Save Neighborhood Characteristics"}
        </button>
      </div>
    </div>
  );
}

function ListingsContractsSalesContent({
  listingRows,
  salesHistoryRows,
  assignmentDraft,
  purchaseTransactionSelected,
  assignmentErrors,
  assignmentDirty,
  assignmentSaveMessage,
  assignmentSaveDisabled,
  savingAssignmentFile,
  contractSellerComparison,
  onAssignmentChange,
  onSave,
}: {
  listingRows: DcadSaleHistoryRow[];
  salesHistoryRows: DcadSaleHistoryRow[];
  assignmentDraft: AssignmentDetails;
  purchaseTransactionSelected: boolean;
  assignmentErrors: string[];
  assignmentDirty: boolean;
  assignmentSaveMessage: string;
  assignmentSaveDisabled: boolean;
  savingAssignmentFile: boolean;
  contractSellerComparison: ReturnType<typeof sellerComparisonSummary>;
  onAssignmentChange: <K extends keyof AssignmentDetails>(
    key: K,
    value: AssignmentDetails[K],
  ) => void;
  onSave: () => void;
}) {
  const listingColumns =
    "minmax(150px,1.2fr) minmax(115px,.85fr) minmax(115px,.85fr) minmax(115px,.85fr) minmax(150px,1.1fr) minmax(130px,1fr)";
  const salesColumns =
    "minmax(100px,.9fr) minmax(100px,.8fr) minmax(70px,.6fr) minmax(160px,1.3fr) minmax(110px,.9fr) minmax(110px,.9fr) minmax(70px,.5fr) minmax(190px,1.5fr)";

  return (
    <>
      <section>
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-900">Listings</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Consolidated MLS listing dates, contract activity, and closing terms.
          </p>
        </div>
        {listingRows.length ? (
          <div className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div
                className="grid items-end gap-x-4 border-b border-slate-300 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                style={{ gridTemplateColumns: listingColumns }}
              >
                <div>MLS / Source #</div>
                <div>List Date</div>
                <div>Contract Date</div>
                <div>Closing Date</div>
                <div>Financing Type</div>
                <div>Concessions</div>
              </div>
              {listingRows.slice(0, 20).map((event, index) => (
                <div
                  key={event.listing_id || event.listing_key || event.source_record_id || index}
                  className="grid items-start gap-x-4 border-b border-slate-200 px-1 py-2.5 text-sm last:border-b-0"
                  style={{ gridTemplateColumns: listingColumns }}
                >
                  <div>
                    <div className="font-medium text-slate-800">
                      {displayValue(
                        event.listing_id || event.listing_key || event.source_record_id,
                        "?",
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {displayValue(event.source, "Source not reported")}
                    </div>
                  </div>
                  <div className="whitespace-nowrap">{formatDate(event.listing_date)}</div>
                  <div className="whitespace-nowrap">{formatDate(event.contract_date)}</div>
                  <div className="whitespace-nowrap">{formatDate(event.closing_date)}</div>
                  <div>{displayValue(event.buyer_financing)}</div>
                  <div>{displayValue(event.concessions)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
            No linked MLS listing records are currently available for this parcel.
          </div>
        )}
      </section>

      <section className="mt-6 border-t border-slate-200 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Contract Analysis</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Assignment-specific contract terms and seller-to-public-record verification.
            </p>
          </div>
          <div className="min-w-[230px]">
            <CheckboxChoice
              checked={Boolean(assignmentDraft.subject_under_contract)}
              label="Subject Under Contract"
              disabled={!purchaseTransactionSelected}
              onChange={(checked) => onAssignmentChange("subject_under_contract", checked)}
            />
          </div>
        </div>

        {!purchaseTransactionSelected ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
            Select Purchase Transaction in Assignment Details before marking the subject under contract.
          </div>
        ) : null}

        {assignmentDraft.subject_under_contract ? (
          <div className="mt-4 space-y-4">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <label className="block lg:col-span-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Contract Seller Name(s)
                </span>
                <input
                  type="text"
                  maxLength={1000}
                  className="input input-bordered input-sm mt-1 w-full bg-white"
                  value={assignmentDraft.contract_seller_names || ""}
                  onChange={(event) => onAssignmentChange("contract_seller_names", event.target.value)}
                  placeholder="Seller name exactly as shown in the contract"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Contract Date
                </span>
                <input
                  type="date"
                  className="input input-bordered input-sm mt-1 w-full bg-white"
                  value={String(assignmentDraft.contract_date || "").slice(0, 10)}
                  onChange={(event) => onAssignmentChange("contract_date", event.target.value)}
                />
              </label>
              {CONTRACT_AMOUNT_FIELDS.map(([field, label]) => (
                <label key={field} className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    {label}
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="input input-bordered input-sm mt-1 w-full bg-white"
                    value={assignmentDraft[field] ?? ""}
                    onChange={(event) => onAssignmentChange(field, event.target.value)}
                    placeholder="Dollar amount"
                  />
                </label>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Arms Length
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  <CheckboxChoice
                    checked={assignmentDraft.contract_arms_length === true}
                    label="Yes"
                    onChange={(checked) => onAssignmentChange(
                      "contract_arms_length",
                      checked ? true : null,
                    )}
                  />
                  <CheckboxChoice
                    checked={assignmentDraft.contract_arms_length === false}
                    label="No"
                    onChange={(checked) => onAssignmentChange(
                      "contract_arms_length",
                      checked ? false : null,
                    )}
                  />
                </div>
              </fieldset>

              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Does Seller Match Public Records?
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  <CheckboxChoice
                    checked={assignmentDraft.seller_matches_public_records === true}
                    label="Yes"
                    onChange={(checked) => onAssignmentChange(
                      "seller_matches_public_records",
                      checked ? true : null,
                    )}
                  />
                  <CheckboxChoice
                    checked={assignmentDraft.seller_matches_public_records === false}
                    label="No"
                    onChange={(checked) => onAssignmentChange(
                      "seller_matches_public_records",
                      checked ? false : null,
                    )}
                  />
                </div>
              </fieldset>
            </div>

            <div className={`rounded-xl border p-3 text-sm ${
              contractSellerComparison.matches === true
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : contractSellerComparison.matches === false
                  ? "border-amber-300 bg-amber-50 text-amber-950"
                  : "border-slate-200 bg-slate-50 text-slate-700"
            }`}>
              <div className="text-xs font-semibold uppercase tracking-wide">Seller Comparison</div>
              <p className="mt-1">{contractSellerComparison.summary}</p>
            </div>

            {assignmentDraft.seller_matches_public_records === false ? (
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Seller Difference Explanation
                </span>
                <textarea
                  maxLength={3000}
                  className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                  value={assignmentDraft.seller_mismatch_explanation || ""}
                  onChange={(event) => onAssignmentChange(
                    "seller_mismatch_explanation",
                    event.target.value,
                  )}
                  placeholder="Required when the contract seller does not match CAD ownership"
                />
              </label>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            Contract terms remain hidden until Subject Under Contract is selected.
          </p>
        )}

        {assignmentErrors.length ? (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <ul className="list-disc space-y-1 pl-5">
              {assignmentErrors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            {assignmentSaveMessage || (assignmentDirty ? "Unsaved assignment changes" : "No unsaved changes")}
          </span>
          <button
            type="button"
            onClick={onSave}
            className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
            disabled={assignmentSaveDisabled}
          >
            {savingAssignmentFile ? "Saving..." : "Save Contract Analysis"}
          </button>
        </div>
      </section>

      <section className="mt-6 border-t border-slate-200 pt-5">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-900">Sales History</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Closed MLS sales and CAD deed-transfer records.
          </p>
        </div>
        {salesHistoryRows.length ? (
          <div className="overflow-x-auto">
            <div className="min-w-[1120px]">
              <div
                className="grid items-end gap-x-4 border-b border-slate-300 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                style={{ gridTemplateColumns: salesColumns }}
              >
                <div>Activity</div>
                <div>Date</div>
                <div>MLS</div>
                <div>Status / Source</div>
                <div className="text-right">List Price</div>
                <div className="text-right">Sale Price</div>
                <div className="text-right">DOM</div>
                <div>Financing / Concessions</div>
              </div>
              {salesHistoryRows.slice(0, 20).map((event, index) => (
                <div
                  key={event.source_record_id || event.sale_id || `${event.record_type}-${event.activity_date}-${index}`}
                  className="grid items-start gap-x-4 border-b border-slate-200 px-1 py-2.5 text-sm last:border-b-0"
                  style={{ gridTemplateColumns: salesColumns }}
                >
                  <div>
                    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${activityTypeClass(event.record_type)}`}>
                      {activityTypeLabel(event.record_type)}
                    </span>
                    {event.requires_additional_review ? (
                      <span className="ml-1 text-xs font-semibold text-amber-700" title="Source record needs review">!</span>
                    ) : null}
                  </div>
                  <div className="whitespace-nowrap">
                    {formatDate(event.activity_date || event.closing_date || event.listing_date)}
                  </div>
                  <div>{displayValue(event.listing_id, "?")}</div>
                  <div>
                    <div className="font-medium text-slate-800">
                      {displayValue(event.mls_status, activityTypeLabel(event.record_type))}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {displayValue(event.source, "Source not reported")}
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-right">{formatMoney(event.list_price)}</div>
                  <div className="whitespace-nowrap text-right">{formatMoney(event.sale_price)}</div>
                  <div className="text-right">{displayValue(event.days_on_market, "?")}</div>
                  <div className="text-xs leading-5">
                    <div>{displayValue(event.buyer_financing, "Financing not reported")}</div>
                    {hasValue(event.concessions) ? (
                      <div className="mt-0.5 text-slate-500">Concessions: {displayValue(event.concessions)}</div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
            No linked closed-sale or CAD deed-transfer records are currently available.
          </div>
        )}
      </section>
    </>
  );
}

function formatReportedBoolean(value: unknown): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (!hasValue(value)) return "Not reported";
  const normalized = String(value).trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(normalized)) return "Yes";
  if (["no", "n", "false", "0"].includes(normalized)) return "No";
  return String(value);
}

function formatBaths(improvement?: DcadMainImprovement): string {
  const full = parseNumber(improvement?.baths_full);
  const half = parseNumber(improvement?.baths_half);
  if (full !== null || half !== null) {
    return `${full ?? 0} full / ${half ?? 0} half`;
  }
  return displayValue(improvement?.bath_count);
}

function SummarySection({
  title,
  subtitle,
  children,
  onEdit,
  actions,
  manuallyVerified = false,
  inherited = false,
  compact = false,
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onEdit?: () => void;
  actions?: ReactNode;
  manuallyVerified?: boolean;
  inherited?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border ${
      inherited ? "border-amber-300 bg-amber-50/80" : "border-slate-200 bg-slate-50/70"
    } ${compact ? "p-3 sm:p-4" : "p-4 sm:p-5"} ${className}`}>
      <div className={`${compact ? "mb-3" : "mb-4"} flex items-start justify-between gap-3`}>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-800">
              {title}
            </h2>
            {manuallyVerified ? (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-blue-800">
                Manually verified
              </span>
            ) : null}
            {inherited ? (
              <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-amber-950">
                From Previous Assignment
              </span>
            ) : null}
          </div>
          {subtitle ? <p className="mt-1 text-xs text-slate-500">{subtitle}</p> : null}
        </div>
        {actions || (onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            className="btn btn-sm normal-case border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
          >
            Edit
          </button>
        ) : null)}
      </div>
      {children}
    </section>
  );
}

function SummaryField({
  label,
  value,
  className = "",
}: {
  label: string;
  value?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold text-slate-900">
        {value ?? "Not reported"}
      </div>
    </div>
  );
}

function editorLabel(key: string): string {
  const overrides: Record<string, string> = {
    mls_status: "MLS Status",
    listing_id: "MLS Number",
    area_sqft: "Area (Sq. Ft.)",
    living_area_sqft: "Living Area (Sq. Ft.)",
    total_area_sqft: "Total Area (Sq. Ft.)",
    postal_code: "ZIP Code",
    baths_full: "Full Baths",
    baths_half: "Half Baths",
    homestead_yes: "Homestead",
  };
  return overrides[key] || key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cloneEditorValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {})) as T;
}

function editorValueAtPath(
  root: Record<string, unknown>,
  path: Array<string | number>,
): unknown {
  let cursor: unknown = root;
  path.forEach((segment) => {
    if (Array.isArray(cursor) && typeof segment === "number") {
      cursor = cursor[segment];
    } else if (cursor && typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[String(segment)];
    } else {
      throw new Error("Invalid report editor field path");
    }
  });
  return cursor;
}

function ReportSectionEditor({
  section,
  initialValue,
  saving,
  onCancel,
  onSave,
}: {
  section: EditableReportSection;
  initialValue: Record<string, unknown>;
  saving: boolean;
  onCancel: () => void;
  onSave: (value: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    cloneEditorValue(initialValue),
  );

  useEffect(() => {
    setDraft(cloneEditorValue(initialValue));
  }, [initialValue, section.key]);

  const updateAtPath = (path: Array<string | number>, nextValue: unknown) => {
    setDraft((current) => {
      const next = cloneEditorValue(current);
      const parent = editorValueAtPath(next, path.slice(0, -1));
      const finalSegment = path[path.length - 1];
      if (Array.isArray(parent) && typeof finalSegment === "number") {
        parent[finalSegment] = nextValue;
      } else if (parent && typeof parent === "object") {
        (parent as Record<string, unknown>)[String(finalSegment)] = nextValue;
      }
      return next;
    });
  };

  const removeArrayItem = (path: Array<string | number>, index: number) => {
    setDraft((current) => {
      const next = cloneEditorValue(current);
      const cursor = editorValueAtPath(next, path);
      if (Array.isArray(cursor)) cursor.splice(index, 1);
      return next;
    });
  };

  const addArrayItem = (path: Array<string | number>, key: string) => {
    setDraft((current) => {
      const next = cloneEditorValue(current);
      const cursor = editorValueAtPath(next, path);
      if (Array.isArray(cursor)) {
        cursor.push(cloneEditorValue(ARRAY_ROW_TEMPLATES[key] || {}));
      }
      return next;
    });
  };

  const assignment = draft as AssignmentDetails;
  const assignmentTypes = Array.isArray(assignment.assignment_types)
    ? assignment.assignment_types
    : [];
  const assignmentErrors = section.key === "report.assignment_details"
    ? assignmentValidationErrors(assignment)
    : [];

  const checkboxOption = (
    checked: boolean,
    label: string,
    onChange: (checked: boolean) => void,
  ) => (
    <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
      checked
        ? "border-blue-400 bg-blue-50 text-blue-900"
        : "border-slate-200 bg-white text-slate-700"
    }`}>
      <input
        type="checkbox"
        className="checkbox checkbox-sm checkbox-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );

  const assignmentEditor = section.key === "report.assignment_details" ? (
    <div className="space-y-5">
      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Lender / Client</legend>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Lender / Client
            </span>
            <input
              type="text"
              maxLength={500}
              className="input input-bordered mt-1 w-full bg-white"
              value={assignment.lender_client_name || ""}
              onChange={(event) => updateAtPath(["lender_client_name"], event.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Lender / Client Address
            </span>
            <textarea
              maxLength={2000}
              className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
              value={assignment.lender_client_address || ""}
              onChange={(event) => updateAtPath(["lender_client_address"], event.target.value)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Planned Unit Development</legend>
        <div className="mt-1 max-w-xs">
          {checkboxOption(Boolean(assignment.pud), "PUD", (checked) =>
            updateAtPath(["pud"], checked),
          )}
        </div>
        {assignment.pud ? (
          <div className="mt-4 space-y-4">
            <label className="block max-w-sm">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                HOA Dues Amount
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                className="input input-bordered mt-1 w-full bg-white"
                value={assignment.hoa_dues_amount ?? ""}
                onChange={(event) => updateAtPath(["hoa_dues_amount"], event.target.value)}
                placeholder="Dollar amount"
              />
            </label>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                HOA Dues Frequency
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {HOA_FREQUENCY_OPTIONS.map(([value, label]) =>
                  <div key={value}>
                    {checkboxOption(assignment.hoa_frequency === value, label, (checked) =>
                      updateAtPath(["hoa_frequency"], checked ? value : ""),
                    )}
                  </div>
                )}
              </div>
            </div>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                HOA Explanation
              </span>
              <textarea
                className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                value={assignment.hoa_explanation || ""}
                onChange={(event) => updateAtPath(["hoa_explanation"], event.target.value)}
                placeholder="Required when dues are unavailable or the frequency is Other"
              />
            </label>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Occupancy</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {OCCUPANCY_OPTIONS.map(([value, label]) =>
            <div key={value}>
              {checkboxOption(assignment.occupancy === value, label, (checked) =>
                updateAtPath(["occupancy"], checked ? value : ""),
              )}
            </div>
          )}
        </div>
        {assignment.occupancy === "unknown" ? (
          <label className="mt-4 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Unknown Occupancy Explanation
            </span>
            <textarea
              className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
              value={assignment.occupancy_explanation || ""}
              onChange={(event) => updateAtPath(["occupancy_explanation"], event.target.value)}
            />
          </label>
        ) : null}
      </fieldset>

      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Assignment Type</legend>
        <p className="mb-3 text-xs text-slate-600">Select every type that applies to the assignment.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {ASSIGNMENT_TYPE_OPTIONS.map(([value, label]) =>
            <div key={value}>
              {checkboxOption(assignmentTypes.includes(value), label, (checked) => {
                const next = checked
                  ? [...new Set([...assignmentTypes, value])]
                  : assignmentTypes.filter((item) => item !== value);
                updateAtPath(["assignment_types"], next);
              })}
            </div>
          )}
        </div>
        {assignmentTypes.includes("other") ? (
          <label className="mt-4 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Other Assignment Explanation
            </span>
            <textarea
              className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
              value={assignment.assignment_explanation || ""}
              onChange={(event) => updateAtPath(["assignment_explanation"], event.target.value)}
            />
          </label>
        ) : null}
      </fieldset>

      {assignmentErrors.length ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <ul className="list-disc space-y-1 pl-5">
            {assignmentErrors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  ) : null;

  const renderValue = (
    value: unknown,
    path: Array<string | number>,
    key: string,
  ): ReactNode => {
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === "string")) {
        return (
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              {editorLabel(key)}
            </span>
            <textarea
              className="textarea textarea-bordered mt-1 min-h-24 w-full bg-white"
              value={value.join("\n")}
              onChange={(event) =>
                updateAtPath(path, event.target.value.split("\n").filter(Boolean))
              }
            />
          </label>
        );
      }
      return (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-800">{editorLabel(key)}</div>
            <button
              type="button"
              onClick={() => addArrayItem(path, key)}
              className="btn btn-xs normal-case border-blue-300 bg-white text-blue-800"
            >
              Add record
            </button>
          </div>
          {value.length ? value.map((item, index) => (
            <div key={index} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">Record {index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeArrayItem(path, index)}
                  className="btn btn-ghost btn-xs normal-case text-rose-700"
                >
                  Remove
                </button>
              </div>
              {renderValue(item, [...path, index], `${key}_${index + 1}`)}
            </div>
          )) : (
            <div className="text-xs text-slate-500">No records. Select Add record to create one.</div>
          )}
        </div>
      );
    }
    if (value && typeof value === "object") {
      return (
        <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
          <legend className="px-1 text-sm font-semibold text-slate-800">
            {editorLabel(key)}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => (
              <div
                key={childKey}
                className={Array.isArray(childValue) || (childValue && typeof childValue === "object")
                  ? "sm:col-span-2"
                  : ""}
              >
                {renderValue(childValue, [...path, childKey], childKey)}
              </div>
            ))}
          </div>
        </fieldset>
      );
    }
    if (typeof value === "boolean") {
      return (
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            {editorLabel(key)}
          </span>
          <select
            className="select select-bordered mt-1 w-full bg-white"
            value={value ? "true" : "false"}
            onChange={(event) => updateAtPath(path, event.target.value === "true")}
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      );
    }
    if (key === "attachment_type") {
      return (
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Attachment Type
          </span>
          <select
            className="select select-bordered mt-1 w-full bg-white"
            value={value == null ? "unknown" : String(value)}
            onChange={(event) => updateAtPath(path, event.target.value)}
          >
            <option value="detached">Detached</option>
            <option value="attached">Attached</option>
            <option value="mixed">Mixed</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
      );
    }
    const isLongText = ["legal_text", "mailing_address", "notes"].includes(key);
    return (
      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          {editorLabel(key)}
        </span>
        {isLongText ? (
          <textarea
            className="textarea textarea-bordered mt-1 w-full bg-white"
            value={value == null ? "" : String(value)}
            onChange={(event) => updateAtPath(path, event.target.value)}
          />
        ) : (
          <input
            type={key.includes("date") ? "date" : typeof value === "number" ? "number" : "text"}
            className="input input-bordered mt-1 w-full bg-white"
            value={value == null ? "" : String(value)}
            onChange={(event) =>
              updateAtPath(
                path,
                typeof value === "number" && event.target.value !== ""
                  ? Number(event.target.value)
                  : event.target.value,
              )
            }
          />
        )}
      </label>
    );
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/60 p-3 sm:p-6">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-950">Edit {section.title}</h2>
            <p className="mt-1 text-xs text-slate-600">
              Saved values override the report display and are retained with revision history.
            </p>
          </div>
          <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm" disabled={saving}>
            Close
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto p-5">
          {assignmentEditor || Object.entries(draft).map(([key, value]) => (
            <div key={key}>{renderValue(value, [key], key)}</div>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
          <button type="button" onClick={onCancel} className="btn btn-ghost normal-case" disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="btn normal-case border-blue-600 bg-blue-600 text-white hover:bg-blue-700"
            disabled={saving || assignmentErrors.length > 0}
          >
            {saving ? "Saving?" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddressHero({
  detail,
  accountId,
  onReload,
}: {
  detail: DcadDetail | null;
  accountId?: string;
  onReload: () => Promise<void>;
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [relatedParcelSearchVersion, setRelatedParcelSearchVersion] = useState(0);
  const [relatedParcels, setRelatedParcels] = useState<RelatedParcelsResponse | null>(null);
  const [relatedParcelsLoading, setRelatedParcelsLoading] = useState(false);
  const [relatedParcelsError, setRelatedParcelsError] = useState("");
  const [editingSection, setEditingSection] = useState<EditableReportSection | null>(null);
  const [savingSection, setSavingSection] = useState(false);
  const [assignmentDraft, setAssignmentDraft] = useState<AssignmentDetails>(() =>
    assignmentDraftFromDetail(detail?.assignment_details),
  );
  const [assignmentDirty, setAssignmentDirty] = useState(false);
  const [assignmentSaveMessage, setAssignmentSaveMessage] = useState("");
  const [assignmentFiles, setAssignmentFiles] = useState<AppraisalAssignmentFile[]>([]);
  const [assignmentFilesLoading, setAssignmentFilesLoading] = useState(false);
  const [assignmentFilesLoaded, setAssignmentFilesLoaded] = useState(false);
  const [assignmentFilesError, setAssignmentFilesError] = useState("");
  const [activeAssignmentFile, setActiveAssignmentFile] = useState<AppraisalAssignmentFile | null>(null);
  const [inheritedAssignmentFile, setInheritedAssignmentFile] = useState<AppraisalAssignmentFile | null>(null);
  const [inheritedLegacyAssignment, setInheritedLegacyAssignment] = useState(false);
  const [assignmentFileNumber, setAssignmentFileNumber] = useState("");
  const [savingAssignmentFile, setSavingAssignmentFile] = useState(false);
  const [censusLookupLoading, setCensusLookupLoading] = useState(false);
  const [censusLookupMessage, setCensusLookupMessage] = useState("");
  const [unemploymentLookupLoading, setUnemploymentLookupLoading] = useState(false);
  const [unemploymentLookupMessage, setUnemploymentLookupMessage] = useState("");
  const [unemploymentAutoAttemptedZip, setUnemploymentAutoAttemptedZip] = useState("");
  const [neighborhoodProfileLoading, setNeighborhoodProfileLoading] = useState(false);
  const [neighborhoodProfileMessage, setNeighborhoodProfileMessage] = useState("");
  const [neighborhoodBoundarySuggestions, setNeighborhoodBoundarySuggestions] = useState<
    NonNullable<NeighborhoodProfileResponse["boundary_streets"]>["cardinal_boundaries"] | null
  >(null);
  const neighborhoodProfileAttemptedSignature = useRef("");
  const [marketConditionsDraft, setMarketConditionsDraft] = useState<MarketConditionsDraft | null>(
    () => readMarketConditionsDraft(accountId || ""),
  );
  const photos = useMemo(
    () => (detail?.photos || []).filter((photo) => Boolean(photo?.trim())),
    [detail?.photos],
  );
  const customMarketStudy = useMemo(
    () => marketConditionsDraft?.response.analyses.find(
      (analysis) => analysis.market.key === "custom" && Boolean(analysis.market.custom_geometry),
    ) || null,
    [marketConditionsDraft],
  );
  const detailLoaded = Boolean(detail);
  const exactAddress = detail?.property_location?.address?.trim() || "";

  useEffect(() => {
    if (photoIndex >= photos.length) setPhotoIndex(0);
  }, [photoIndex, photos.length]);

  useEffect(() => {
    let cancelled = false;
    const fallback = assignmentDraftFromDetail(detail?.assignment_details);
    setAssignmentDraft(fallback);
    setAssignmentDirty(false);
    setAssignmentSaveMessage("");
    setNeighborhoodProfileMessage("");
    neighborhoodProfileAttemptedSignature.current = "";
    setAssignmentFiles([]);
    setAssignmentFilesLoaded(false);
    setActiveAssignmentFile(null);
    setInheritedAssignmentFile(null);
    setInheritedLegacyAssignment(false);
    setAssignmentFileNumber("");
    setAssignmentFilesError("");
    setCensusLookupMessage("");
    setUnemploymentLookupMessage("");
    setUnemploymentAutoAttemptedZip("");
    setMarketConditionsDraft(readMarketConditionsDraft(accountId || ""));
    if (!accountId?.trim() || !detailLoaded) {
      setAssignmentFilesLoading(false);
      setAssignmentFilesLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    setAssignmentFilesLoading(true);
    void getAssignmentFiles(accountId)
      .then((response) => {
        if (cancelled) return;
        setAssignmentFiles(response.files || []);
        if (response.latest_file) {
          setAssignmentDraft(assignmentDraftFromDetail(response.latest_file.assignment_details));
          setInheritedAssignmentFile(response.latest_file);
        } else if (response.legacy_assignment_details) {
          setAssignmentDraft(assignmentDraftFromDetail(response.legacy_assignment_details));
          setInheritedLegacyAssignment(true);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAssignmentFilesError(
            error instanceof Error ? error.message : "The assignment log could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAssignmentFilesLoading(false);
          setAssignmentFilesLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, detail?.assignment_details, detailLoaded]);

  useEffect(() => {
    let cancelled = false;
    setRelatedParcels(null);
    setRelatedParcelsError("");
    if (!accountId?.trim() || !detailLoaded) {
      setRelatedParcelsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setRelatedParcelsLoading(true);
    void getRelatedParcels(accountId, exactAddress || undefined)
      .then((response) => {
        if (!cancelled) setRelatedParcels(response);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRelatedParcelsError(
            error instanceof Error ? error.message : "The related-parcel check was unavailable.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setRelatedParcelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, detailLoaded, exactAddress, relatedParcelSearchVersion]);

  const address = displayValue(detail?.property_location?.address, "Property address unavailable");
  const streetAddress = address.split(",")[0].trim() || address;
  const city = displayValue(detail?.property_location?.city);
  const state = displayValue(detail?.property_location?.state, "TX");
  const postalCode = displayValue(detail?.property_location?.postal_code);
  const censusZip = String(detail?.property_location?.postal_code || "")
    .replace(/\D/g, "")
    .slice(0, 5);
  const neighborhood = displayValue(detail?.property_location?.neighborhood);
  const subdivision = displayValue(detail?.property_location?.subdivision);
  const county = displayValue(detail?.property_location?.county);
  const ownerParties = (detail?.owner?.parties || []).filter((party) =>
    hasValue(party.owner_name),
  );
  const ownerName = displayValue(
    ownerParties.length
      ? ownerParties.map((party) => party.owner_name).join(" / ")
      : detail?.owner?.owner_name,
  );
  const ownerMailing = displayValue(detail?.owner?.mailing_address);
  const legalLines = detail?.legal_description?.lines?.filter((line) => Boolean(line?.trim())) || [];
  const legalDescription = legalLines.length
    ? legalLines.join("\n")
    : "No legal description is available for this parcel.";
  const deedTransferDate = detail?.legal_description?.deed_transfer_date;
  const improvement = detail?.main_improvement;
  const housing = detail?.housing_profile;
  const landRows = detail?.land_detail || [];
  const additionalImprovements = detail?.additional_improvements || [];
  const salesHistory = detail?.sales_history || [];
  const propertyActivityHistory = detail?.property_activity_history || salesHistory;
  const values = detail?.value_summary;

  const editableSectionValue = (sectionKey: ReportManualSectionKey): Record<string, unknown> => {
    switch (sectionKey) {
      case "report.subject_identification":
        return {
          property_location: {
            address: detail?.property_location?.address || "",
            neighborhood: detail?.property_location?.neighborhood || "",
            city: detail?.property_location?.city || "",
            state: detail?.property_location?.state || "TX",
            postal_code: detail?.property_location?.postal_code || "",
            county: detail?.property_location?.county || "",
            subdivision: detail?.property_location?.subdivision || "",
            census_tract: detail?.property_location?.census_tract || "",
          },
          owner: {
            owner_name: detail?.owner?.owner_name || "",
            mailing_address: detail?.owner?.mailing_address || "",
            parties: cloneEditorValue(detail?.owner?.parties || []),
          },
          legal_description: {
            lines: detail?.legal_description?.lines || [],
            deed_transfer_date: detail?.legal_description?.deed_transfer_date || "",
          },
        };
      case "report.exemptions":
        {
          const emptyExemption = () => ({
            taxing_jurisdiction: "",
            homestead_exemption: "",
            disabled_vet: "",
            taxable_value: "",
          });
        return {
          homestead_yes: Boolean(detail?.homestead_yes),
          exemptions: {
            city: cloneEditorValue(detail?.exemptions?.city || emptyExemption()),
            school: cloneEditorValue(detail?.exemptions?.school || emptyExemption()),
            county: cloneEditorValue(detail?.exemptions?.county || emptyExemption()),
            college: cloneEditorValue(detail?.exemptions?.college || emptyExemption()),
            hospital: cloneEditorValue(detail?.exemptions?.hospital || emptyExemption()),
            special_district: cloneEditorValue(
              detail?.exemptions?.special_district || emptyExemption(),
            ),
          },
        };
        }
      case "report.sales_history":
        return {
          property_activity_history: cloneEditorValue(
            detail?.property_activity_history || detail?.sales_history || [],
          ),
        };
      case "report.property_characteristics":
        return {
          main_improvement: {
            living_area_sqft: detail?.main_improvement?.living_area_sqft || "",
            total_area_sqft: detail?.main_improvement?.total_area_sqft || "",
            bedroom_count: detail?.main_improvement?.bedroom_count || "",
            bath_count: detail?.main_improvement?.bath_count || "",
            baths_full: detail?.main_improvement?.baths_full || "",
            baths_half: detail?.main_improvement?.baths_half || "",
            stories: detail?.main_improvement?.stories || "",
            year_built: detail?.main_improvement?.year_built || "",
            effective_year_built: detail?.main_improvement?.effective_year_built || "",
            actual_age: detail?.main_improvement?.actual_age || "",
            building_class: detail?.main_improvement?.building_class || "",
            desirability: detail?.main_improvement?.desirability || "",
            construction_type: detail?.main_improvement?.construction_type || "",
            foundation: detail?.main_improvement?.foundation || "",
            exterior_material: detail?.main_improvement?.exterior_material || "",
            roof_type: detail?.main_improvement?.roof_type || "",
            roof_material: detail?.main_improvement?.roof_material || "",
            heating: detail?.main_improvement?.heating || "",
            air_conditioning: detail?.main_improvement?.air_conditioning || "",
            fireplaces: detail?.main_improvement?.fireplaces || "",
            kitchens: detail?.main_improvement?.kitchens || "",
            wetbars: detail?.main_improvement?.wetbars || "",
            pool: detail?.main_improvement?.pool ?? "",
            sprinkler: detail?.main_improvement?.sprinkler ?? "",
            fence_type: detail?.main_improvement?.fence_type || "",
          },
          housing_profile: {
            structural_style: detail?.housing_profile?.structural_style || "",
            housing_type: detail?.housing_profile?.housing_type || "",
            attachment_type: detail?.housing_profile?.attachment_type || "unknown",
            architectural_style: detail?.housing_profile?.architectural_style || "",
          },
          additional_improvements: cloneEditorValue(detail?.additional_improvements || []),
        };
      case "report.land_details":
        return { land_detail: cloneEditorValue(detail?.land_detail || []) };
      case "report.appraisal_values":
        return {
          value_summary: {
            certified_year: detail?.value_summary?.certified_year || "",
            market_value: detail?.value_summary?.market_value || "",
            capped_value: detail?.value_summary?.capped_value || "",
            improvement_value: detail?.value_summary?.improvement_value || "",
            land_value: detail?.value_summary?.land_value || "",
          },
        };
      case "report.assignment_details":
        return {
          pud: Boolean(detail?.assignment_details?.pud),
          hoa_dues_amount: detail?.assignment_details?.hoa_dues_amount || "",
          hoa_frequency: detail?.assignment_details?.hoa_frequency || "",
          hoa_explanation: detail?.assignment_details?.hoa_explanation || "",
          occupancy: detail?.assignment_details?.occupancy || "",
          occupancy_explanation: detail?.assignment_details?.occupancy_explanation || "",
          assignment_types: cloneEditorValue(detail?.assignment_details?.assignment_types || []),
          assignment_explanation: detail?.assignment_details?.assignment_explanation || "",
          lender_client_name: detail?.assignment_details?.lender_client_name || "",
          lender_client_address: detail?.assignment_details?.lender_client_address || "",
          subject_under_contract: Boolean(detail?.assignment_details?.subject_under_contract),
          contract_arms_length: typeof detail?.assignment_details?.contract_arms_length === "boolean"
            ? detail.assignment_details.contract_arms_length
            : true,
          contract_seller_names: detail?.assignment_details?.contract_seller_names || "",
          contract_price: detail?.assignment_details?.contract_price || "",
          contract_date: detail?.assignment_details?.contract_date || "",
          loan_amount: detail?.assignment_details?.loan_amount || "",
          down_payment: detail?.assignment_details?.down_payment || "",
          earnest_money: detail?.assignment_details?.earnest_money || "",
          seller_concessions: detail?.assignment_details?.seller_concessions || "",
          seller_matches_public_records:
            typeof detail?.assignment_details?.seller_matches_public_records === "boolean"
              ? detail.assignment_details.seller_matches_public_records
              : null,
          seller_mismatch_explanation:
            detail?.assignment_details?.seller_mismatch_explanation || "",
        };
    }
  };

  const editorKeyForSave = (): string => {
    let editorKey = sessionStorage.getItem("homenode-editor-key") || "";
    if (!editorKey) {
      editorKey = window.prompt("Enter the HomeNode editor key to save verified changes:") || "";
      if (!editorKey) return "";
      sessionStorage.setItem("homenode-editor-key", editorKey);
    }
    return editorKey;
  };

  const saveManualSection = async (
    sectionKey: ReportManualSectionKey,
    value: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!accountId) return false;
    const editorKey = editorKeyForSave();
    if (!editorKey) return false;
    setSavingSection(true);
    try {
      await updatePropertyReportSections(
        accountId,
        { [sectionKey]: value },
        editorKey,
      );
      await onReload();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The report changes could not be saved.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      window.alert(message);
      return false;
    } finally {
      setSavingSection(false);
    }
  };

  const lookUpCensusTractNow = async () => {
    if (!accountId || censusLookupLoading) return;
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setCensusLookupLoading(true);
    setCensusLookupMessage("");
    try {
      const response = await lookupAccountCensusGeography(accountId, editorKey);
      const tract = response.census_geography?.tract_code;
      setCensusLookupMessage(
        response.census_geography?.status === "matched"
          ? `Census tract ${formatCensusTract(tract)} added.`
          : "The Census response needs review before it can be treated as a verified tract.",
      );
      await onReload();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The Census tract could not be looked up.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      setCensusLookupMessage(
        message === "census_lookup_input_missing"
          ? "This property needs a usable address or coordinate before Census lookup."
          : message,
      );
    } finally {
      setCensusLookupLoading(false);
    }
  };

  const saveEditedSection = async (value: Record<string, unknown>) => {
    if (!editingSection) return;
    if (await saveManualSection(editingSection.key, value)) {
      setEditingSection(null);
    }
  };

  const updateAssignment = <K extends keyof AssignmentDetails,>(
    key: K,
    value: AssignmentDetails[K],
  ) => {
    setAssignmentDraft((current) => ({ ...current, [key]: value }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const updateAssignmentTypes = (nextTypes: string[]) => {
    setAssignmentDraft((current) => ({
      ...current,
      assignment_types: nextTypes,
      subject_under_contract: nextTypes.includes("purchase_transaction")
        ? current.subject_under_contract
        : false,
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const importCustomMarketArea = useCallback(() => {
    const geometry = customMarketStudy?.market.custom_geometry;
    if (!geometry) {
      setAssignmentSaveMessage("Run and save an Appraiser-Defined Area in Market Conditions Analysis first.");
      return;
    }
    const summary = customMarketStudy.summary;
    setNeighborhoodBoundarySuggestions(null);
    setAssignmentDraft((current) => ({
      ...current,
      neighborhood_boundary_geometry: cloneEditorValue(geometry),
      neighborhood_boundary_label:
        customMarketStudy.market.label || "Appraiser-defined market area",
      neighborhood_boundary_source: "sales_comparison_market_conditions",
      neighborhood_boundary_saved_at: marketConditionsDraft?.savedAt || new Date().toISOString(),
      neighborhood_boundary_streets: "",
      neighborhood_boundary_north: "",
      neighborhood_boundary_east: "",
      neighborhood_boundary_south: "",
      neighborhood_boundary_west: "",
      neighborhood_boundary_exclusions: "",
      neighborhood_boundary_streets_source: "",
      neighborhood_boundary_streets_retrieved_at: "",
      neighborhood_boundary_confirmed: false,
      neighborhood_boundary_confirmed_at: "",
      neighborhood_house_price_low: summary.minimum_sale_price ?? "",
      neighborhood_house_price_high: summary.maximum_sale_price ?? "",
      neighborhood_house_price_predominant: summary.median_sale_price ?? "",
      neighborhood_ppsf_low: summary.minimum_price_per_square_foot ?? "",
      neighborhood_ppsf_high: summary.maximum_price_per_square_foot ?? "",
      neighborhood_ppsf_predominant: summary.median_price_per_square_foot ?? "",
      neighborhood_age_low: summary.minimum_age ?? "",
      neighborhood_age_high: summary.maximum_age ?? "",
      neighborhood_age_predominant: summary.median_age ?? "",
      neighborhood_gla_low: summary.minimum_living_area ?? "",
      neighborhood_gla_high: summary.maximum_living_area ?? "",
      neighborhood_gla_predominant: summary.median_living_area ?? "",
      neighborhood_market_trend:
        marketTrendFromChange(customMarketStudy.statistics.annualized_change_percent) ||
        current.neighborhood_market_trend || "",
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("Appraiser-defined area imported. Review and confirm it for this file.");
  }, [customMarketStudy, marketConditionsDraft?.savedAt]);

  const refreshNeighborhoodProfile = useCallback(async () => {
    const geometry = customMarketStudy?.market.custom_geometry;
    if (!accountId || !geometry || !marketConditionsDraft || neighborhoodProfileLoading) {
      if (!geometry) {
        setNeighborhoodProfileMessage("Run and save an Appraiser-Defined Area in Market Conditions Analysis first.");
      }
      return;
    }
    setNeighborhoodProfileLoading(true);
    setNeighborhoodProfileMessage("Refreshing market-area ranges, city averages, and boundary streets...");
    try {
      const profile = await getNeighborhoodProfile({
        subjectAccountId: accountId,
        asOf: marketConditionsDraft.asOfDate,
        periodMonths: marketConditionsDraft.periodMonths,
        customGeometry: geometry,
        contextOverride: marketConditionsDraft.contextOverride || null,
      });
      const customStudy = profile.analyses.find((analysis) => analysis.market.key === "custom");
      const cityStudy = profile.analyses.find((analysis) => analysis.market.key === "city");
      if (!customStudy) throw new Error("The appraiser-defined area did not return a usable market study.");
      const summary = customStudy.summary;
      const boundaryStreets = profile.boundary_streets;
      setNeighborhoodBoundarySuggestions(boundaryStreets?.cardinal_boundaries || null);
      setAssignmentDraft((current) => {
        const geometryChanged = JSON.stringify(current.neighborhood_boundary_geometry) !== JSON.stringify(geometry);
        const suggested = boundaryStreets?.cardinal_boundaries;
        const north = geometryChanged
          ? suggested?.north?.primary_street || ""
          : current.neighborhood_boundary_north || suggested?.north?.primary_street || "";
        const east = geometryChanged
          ? suggested?.east?.primary_street || ""
          : current.neighborhood_boundary_east || suggested?.east?.primary_street || "";
        const south = geometryChanged
          ? suggested?.south?.primary_street || ""
          : current.neighborhood_boundary_south || suggested?.south?.primary_street || "";
        const west = geometryChanged
          ? suggested?.west?.primary_street || ""
          : current.neighborhood_boundary_west || suggested?.west?.primary_street || "";
        const boundarySummary = [
          ["North", north],
          ["East", east],
          ["South", south],
          ["West", west],
        ].filter(([, street]) => street)
          .map(([side, street]) => `${side}: ${street}`)
          .join("; ");
        return {
          ...current,
          neighborhood_boundary_geometry: cloneEditorValue(geometry),
          neighborhood_boundary_label:
            customStudy.market.label || "Appraiser-defined market area",
          neighborhood_boundary_source: "sales_comparison_market_conditions",
          neighborhood_boundary_saved_at: marketConditionsDraft.savedAt || new Date().toISOString(),
          neighborhood_boundary_confirmed: geometryChanged
            ? false
            : current.neighborhood_boundary_confirmed,
          neighborhood_boundary_confirmed_at: geometryChanged
            ? ""
            : current.neighborhood_boundary_confirmed_at,
          neighborhood_house_price_low: summary.minimum_sale_price ?? "",
          neighborhood_house_price_high: summary.maximum_sale_price ?? "",
          neighborhood_house_price_predominant: summary.median_sale_price ?? "",
          neighborhood_ppsf_low: summary.minimum_price_per_square_foot ?? "",
          neighborhood_ppsf_high: summary.maximum_price_per_square_foot ?? "",
          neighborhood_ppsf_predominant: summary.median_price_per_square_foot ?? "",
          neighborhood_age_low: summary.minimum_age ?? "",
          neighborhood_age_high: summary.maximum_age ?? "",
          neighborhood_age_predominant: summary.median_age ?? "",
          neighborhood_gla_low: summary.minimum_living_area ?? "",
          neighborhood_gla_high: summary.maximum_living_area ?? "",
          neighborhood_gla_predominant: summary.median_living_area ?? "",
          neighborhood_market_trend:
            marketTrendFromChange(customStudy.statistics.annualized_change_percent) ||
            current.neighborhood_market_trend || "",
          neighborhood_city_name:
            cityStudy?.market.city || profile.subject.city ||
            detail?.property_location?.city || current.neighborhood_city_name || "",
          neighborhood_city_sale_count: cityStudy?.population.eligible_sale_count ?? "",
          neighborhood_city_average_sale_price: cityStudy?.summary.average_sale_price ?? "",
          neighborhood_city_average_ppsf:
            cityStudy?.summary.average_price_per_square_foot ?? "",
          neighborhood_city_average_age: cityStudy?.summary.average_age ?? "",
          neighborhood_city_average_gla: cityStudy?.summary.average_living_area ?? "",
          neighborhood_city_comparison_as_of:
            cityStudy?.period.end || marketConditionsDraft.asOfDate || "",
          neighborhood_boundary_streets:
            boundarySummary || current.neighborhood_boundary_streets || "",
          neighborhood_boundary_north: north,
          neighborhood_boundary_east: east,
          neighborhood_boundary_south: south,
          neighborhood_boundary_west: west,
          neighborhood_boundary_exclusions: geometryChanged
            ? ""
            : current.neighborhood_boundary_exclusions || "",
          neighborhood_boundary_streets_source:
            boundaryStreets?.source || current.neighborhood_boundary_streets_source || "",
          neighborhood_boundary_streets_retrieved_at:
            boundaryStreets?.retrieved_at ||
            current.neighborhood_boundary_streets_retrieved_at || "",
        };
      });
      setAssignmentDirty(true);
      setNeighborhoodProfileMessage(
        profile.boundary_street_warning
          ? "Market ranges and city averages refreshed. Boundary streets could not be refreshed and still require review."
          : "Appraiser-defined ranges, city averages, and four-side boundary suggestions refreshed.",
      );
    } catch (error) {
      setNeighborhoodProfileMessage(
        error instanceof Error ? error.message : "The neighborhood profile could not be refreshed.",
      );
    } finally {
      setNeighborhoodProfileLoading(false);
    }
  }, [
    accountId,
    customMarketStudy,
    detail?.property_location?.city,
    marketConditionsDraft,
    neighborhoodProfileLoading,
  ]);

  const confirmNeighborhoodBoundary = (checked: boolean) => {
    setAssignmentDraft((current) => ({
      ...current,
      neighborhood_boundary_confirmed: checked,
      neighborhood_boundary_confirmed_at: checked ? new Date().toISOString() : "",
    }));
    setAssignmentDirty(true);
    setAssignmentSaveMessage("");
  };

  const lookupZipUnemployment = useCallback(async () => {
    if (!censusZip || unemploymentLookupLoading) return;
    setUnemploymentAutoAttemptedZip(censusZip);
    setUnemploymentLookupLoading(true);
    setUnemploymentLookupMessage("");
    try {
      const profile = await getCensusZipProfile(censusZip);
      setAssignmentDraft((current) => ({
        ...current,
        neighborhood_unemployment_pct: profile.unemployment_percent,
        neighborhood_unemployment_zip: profile.postal_code,
        neighborhood_unemployment_source: profile.source,
        neighborhood_unemployment_dataset_year: profile.dataset_year,
        neighborhood_unemployment_variable: profile.variable,
      }));
      setAssignmentDirty(true);
      setUnemploymentLookupMessage(`Census unemployment updated for ZIP ${profile.postal_code}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Census unemployment lookup failed.";
      setUnemploymentLookupMessage(
        /census_api_key_not_configured/i.test(message)
          ? "A free Census API key must be added to Render before automatic lookup can run; manual entry remains available."
          : message,
      );
    } finally {
      setUnemploymentLookupLoading(false);
    }
  }, [censusZip, unemploymentLookupLoading]);

  useEffect(() => {
    const geometry = customMarketStudy?.market.custom_geometry;
    if (!geometry || assignmentFilesLoading || !assignmentFilesLoaded) return;
    if (JSON.stringify(assignmentDraft.neighborhood_boundary_geometry) === JSON.stringify(geometry)) return;
    importCustomMarketArea();
  }, [
    assignmentDraft.neighborhood_boundary_geometry,
    assignmentFilesLoading,
    assignmentFilesLoaded,
    customMarketStudy,
    importCustomMarketArea,
  ]);

  useEffect(() => {
    const geometry = customMarketStudy?.market.custom_geometry;
    if (!geometry || !accountId || !marketConditionsDraft || assignmentFilesLoading || !assignmentFilesLoaded) return;
    const structuredBoundariesPresent = [
      assignmentDraft.neighborhood_boundary_north,
      assignmentDraft.neighborhood_boundary_east,
      assignmentDraft.neighborhood_boundary_south,
      assignmentDraft.neighborhood_boundary_west,
    ].every((value) => String(value || "").trim());
    const profileValuesPresent = structuredBoundariesPresent && [
      assignmentDraft.neighborhood_ppsf_predominant,
      assignmentDraft.neighborhood_age_predominant,
      assignmentDraft.neighborhood_gla_predominant,
      assignmentDraft.neighborhood_city_average_sale_price,
    ].every(hasValue);
    if (profileValuesPresent) return;
    const signature = `${accountId}:${marketConditionsDraft.savedAt}:${JSON.stringify(geometry)}`;
    if (neighborhoodProfileAttemptedSignature.current === signature) return;
    neighborhoodProfileAttemptedSignature.current = signature;
    void refreshNeighborhoodProfile();
  }, [
    accountId,
    assignmentDraft.neighborhood_age_predominant,
    assignmentDraft.neighborhood_boundary_east,
    assignmentDraft.neighborhood_boundary_north,
    assignmentDraft.neighborhood_boundary_south,
    assignmentDraft.neighborhood_boundary_west,
    assignmentDraft.neighborhood_city_average_sale_price,
    assignmentDraft.neighborhood_gla_predominant,
    assignmentDraft.neighborhood_ppsf_predominant,
    assignmentFilesLoading,
    assignmentFilesLoaded,
    customMarketStudy,
    marketConditionsDraft,
    refreshNeighborhoodProfile,
  ]);

  useEffect(() => {
    if (
      assignmentFilesLoading ||
      !/^\d{5}$/.test(censusZip) ||
      unemploymentAutoAttemptedZip === censusZip ||
      hasValue(assignmentDraft.neighborhood_unemployment_pct)
    ) return;
    void lookupZipUnemployment();
  }, [
    assignmentDraft.neighborhood_unemployment_pct,
    assignmentFilesLoading,
    censusZip,
    lookupZipUnemployment,
    unemploymentAutoAttemptedZip,
  ]);

  const saveAssignmentDetails = async () => {
    if (assignmentValidationErrors(assignmentDraft).length) return;
    if (!accountId || !activeAssignmentFile) {
      setAssignmentSaveMessage("Enter a file number and choose Save New File first.");
      return;
    }
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setSavingAssignmentFile(true);
    try {
      const response = await updateAssignmentFile(
        accountId,
        activeAssignmentFile.id,
        {
          assignment_details: cloneEditorValue(assignmentDraft),
          expected_revision: activeAssignmentFile.revision,
        },
        editorKey,
      );
      setActiveAssignmentFile(response.assignment_file);
      setAssignmentFiles((current) => current.map((file) =>
        file.id === response.assignment_file.id ? response.assignment_file : file
      ));
      setAssignmentDirty(false);
      setAssignmentSaveMessage(`Saved to file ${response.assignment_file.file_number}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The assignment file could not be saved.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      setAssignmentSaveMessage(
        message === "assignment_file_revision_conflict"
          ? "This file changed elsewhere. Reload the report before saving again."
          : message,
      );
    } finally {
      setSavingAssignmentFile(false);
    }
  };

  const saveNewAssignmentFile = async () => {
    if (!accountId || assignmentValidationErrors(assignmentDraft).length) return;
    const fileNumber = assignmentFileNumber.trim();
    if (!fileNumber) {
      setAssignmentSaveMessage("Enter a file number before saving a new appraisal file.");
      return;
    }
    const editorKey = editorKeyForSave();
    if (!editorKey) return;
    setSavingAssignmentFile(true);
    setAssignmentSaveMessage("");
    try {
      const response = await createAssignmentFile(
        accountId,
        {
          file_number: fileNumber,
          assignment_details: cloneEditorValue(assignmentDraft),
          inherited_from_file_id: inheritedAssignmentFile?.id || null,
        },
        editorKey,
      );
      const created = response.assignment_file;
      setAssignmentFiles((current) => [created, ...current.filter((file) => file.id !== created.id)]);
      setActiveAssignmentFile(created);
      setInheritedAssignmentFile(null);
      setInheritedLegacyAssignment(false);
      setAssignmentFileNumber(created.file_number);
      setAssignmentDirty(false);
      setAssignmentSaveMessage(`New appraisal file ${created.file_number} saved.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The appraisal file could not be created.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      setAssignmentSaveMessage(
        message === "assignment_file_number_exists"
          ? "That file number already exists for this property. Enter a different file number."
          : message,
      );
    } finally {
      setSavingAssignmentFile(false);
    }
  };

  const inheritAssignmentFile = (source: AppraisalAssignmentFile) => {
    setAssignmentDraft({
      ...assignmentDraftFromDetail(source.assignment_details),
      neighborhood_boundary_confirmed: false,
      neighborhood_boundary_confirmed_at: "",
    });
    setInheritedAssignmentFile(source);
    setInheritedLegacyAssignment(false);
    setActiveAssignmentFile(null);
    setAssignmentFileNumber("");
    setAssignmentDirty(false);
    setAssignmentSaveMessage(`Values copied from file ${source.file_number}. Enter a new file number to save.`);
  };

  const editSection = (key: ReportManualSectionKey) => {
    const section = EDITABLE_REPORT_SECTIONS.find((item) => item.key === key);
    if (section) setEditingSection(section);
  };
  const sectionEditProps = (key: ReportManualSectionKey) => ({
    onEdit: () => editSection(key),
    manuallyVerified: Boolean(detail?.report_manual_values?.[key]),
  });

  const exemptionOrder: Array<[keyof DcadExemptionsMap, string]> = [
    ["city", "City"],
    ["school", "School"],
    ["county", "County"],
    ["college", "College"],
    ["hospital", "Hospital"],
    ["special_district", "Special District"],
  ];
  const exemptionRows = exemptionOrder
    .map(([key, fallbackLabel]) => ({
      key,
      fallbackLabel,
      row: detail?.exemptions?.[key],
    }))
    .filter(({ row }) =>
      Boolean(row && Object.values(row).some((value) => hasValue(value))),
    );
  const exemptJurisdictionCount = exemptionRows.filter(
    ({ row }) => (parseNumber(row?.homestead_exemption) || 0) > 0,
  ).length;
  const homestead = detail?.homestead_yes || exemptJurisdictionCount > 0;
  const assignmentTypes = assignmentDraft.assignment_types || [];
  const purchaseTransactionSelected = assignmentTypes.includes("purchase_transaction");
  const assignmentErrors = assignmentValidationErrors(assignmentDraft);
  const listingRows = listingTimelineRows(propertyActivityHistory);
  const salesHistoryRows = propertyActivityHistory.filter((event) => {
    const recordType = String(event.record_type || "");
    return ["closed_sale", "cad_transfer"].includes(recordType) ||
      (!recordType && (hasValue(event.sale_price) || hasValue(event.closing_date) || hasValue(event.activity_date)));
  });
  const contractSellerComparison = sellerComparisonSummary(
    assignmentDraft.contract_seller_names,
    ownerName,
  );
  const assignmentFromPrevious = Boolean(
    !activeAssignmentFile && (inheritedAssignmentFile || inheritedLegacyAssignment),
  );
  const assignmentSaveDisabled = Boolean(
    assignmentFilesLoading || savingAssignmentFile || !assignmentDirty ||
      assignmentErrors.length > 0 || !activeAssignmentFile,
  );
  const neighborhoodBoundaryErrors = neighborhoodBoundaryReadinessErrors(assignmentDraft);
  const appraisalReportAssignmentFile = activeAssignmentFile || inheritedAssignmentFile;
  const relatedParcelsToShow = (relatedParcels?.parcels || []).filter(
    (parcel) => parcel.is_subject || parcel.materially_different,
  );
  const showRelatedParcelCheck = Boolean(
    relatedParcels?.material_difference_found,
  );

  const primaryZoning =
    landRows.map((row) => row.zoning).find((value) => hasValue(value)) || "Not reported";

  const protestUrl = accountId
    ? `/PropertyTaxProtest?propertyId=${encodeURIComponent(accountId)}${
        hasValue(detail?.owner?.owner_name)
          ? `&ownerName=${encodeURIComponent(String(detail?.owner?.owner_name))}`
          : ""
        }`
    : "/PropertyTaxProtest";

  const canSlide = photos.length > 1;
  const showPreviousPhoto = () =>
    setPhotoIndex((current) => (current - 1 + photos.length) % photos.length);
  const showNextPhoto = () =>
    setPhotoIndex((current) => (current + 1) % photos.length);

  return (
    <div
      className="card overflow-hidden rounded-2xl bg-white shadow-lg"
      style={{ backgroundColor: "#ffffff" }}
    >
      <section className="border-b border-slate-200 bg-slate-50/80 px-4 py-3 sm:px-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-end">
          {activeAssignmentFile ? (
            <span className="mb-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
              Active file {activeAssignmentFile.file_number}
            </span>
          ) : assignmentFromPrevious ? (
            <span className="mb-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-950">
              From Previous Assignment
            </span>
          ) : null}
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
            <label className="block min-w-0 flex-1 xl:w-64 xl:flex-none">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                File Number
              </span>
              <input
                type="text"
                maxLength={100}
                className="input input-bordered input-sm mt-1 w-full bg-white font-medium"
                placeholder="Enter assignment number"
                value={assignmentFileNumber}
                readOnly={Boolean(activeAssignmentFile)}
                onChange={(event) => {
                  setAssignmentFileNumber(event.target.value);
                  if (event.target.value.trim() && !assignmentFileNumber.trim()) {
                    setAssignmentDraft((current) => ({
                      ...current,
                      neighborhood_boundary_confirmed: false,
                      neighborhood_boundary_confirmed_at: "",
                    }));
                    setAssignmentDirty(true);
                  }
                  setAssignmentSaveMessage("");
                }}
              />
            </label>
            {activeAssignmentFile ? (
              <button
                type="button"
                className="btn btn-outline btn-sm normal-case rounded-lg border-slate-300 bg-white shadow-sm"
                onClick={() => inheritAssignmentFile(activeAssignmentFile)}
                disabled={savingAssignmentFile}
              >
                Start Another File
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                onClick={() => void saveNewAssignmentFile()}
                disabled={
                  assignmentFilesLoading || savingAssignmentFile ||
                  !assignmentFileNumber.trim() || assignmentErrors.length > 0
                }
              >
                {savingAssignmentFile ? "Saving..." : "Save New File"}
              </button>
            )}
          </div>
        </div>

        <details className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">
            Assignment Log ({assignmentFiles.length})
          </summary>
          <div className="mt-2 max-h-52 space-y-2 overflow-y-auto border-t border-slate-100 pt-2">
            {assignmentFilesLoading ? (
              <p className="text-xs text-slate-500">Loading prior assignment files...</p>
            ) : assignmentFilesError ? (
              <p className="text-xs text-rose-700">{assignmentFilesError}</p>
            ) : assignmentFiles.length ? (
              assignmentFiles.map((file) => (
                <div
                  key={file.id}
                  className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 text-xs text-slate-600">
                    <span className="font-semibold text-slate-900">{file.file_number}</span>
                    <span className="mx-2 text-slate-300">|</span>
                    Saved {formatDate(file.created_at)}
                    <span className="mx-2 text-slate-300">|</span>
                    Revision {file.revision}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs normal-case text-blue-700"
                    onClick={() => inheritAssignmentFile(file)}
                    disabled={savingAssignmentFile}
                  >
                    Use for New File
                  </button>
                </div>
              ))
            ) : (
              <p className="text-xs text-slate-500">
                No appraisal files have been saved for this property yet.
              </p>
            )}
          </div>
        </details>
      </section>

      <figure className="relative h-64 bg-slate-100 sm:h-72">
        {photos.length ? (
          <img
            src={photos[photoIndex]}
            alt={`${address} property`}
            className="h-full w-full select-none object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 text-slate-500">
            <svg
              className="mb-3 h-14 w-14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M3 11.5 12 4l9 7.5" />
              <path d="M5 10.5V20h14v-9.5" />
              <path d="M9 20v-6h6v6" />
            </svg>
            <span className="text-sm font-medium">Property photo unavailable</span>
          </div>
        )}

        {canSlide ? (
          <>
            <button
              type="button"
              onClick={showPreviousPhoto}
              aria-label="Previous image"
              className="absolute left-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-white/90 text-slate-800 shadow-lg hover:bg-white"
            >
              <span aria-hidden="true">?</span>
            </button>
            <button
              type="button"
              onClick={showNextPhoto}
              aria-label="Next image"
              className="absolute right-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-white/90 text-slate-800 shadow-lg hover:bg-white"
            >
              <span aria-hidden="true">?</span>
            </button>
            <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-1.5 rounded-full bg-black/40 px-3 py-2">
              {photos.map((_, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => setPhotoIndex(index)}
                  aria-label={`Go to image ${index + 1}`}
                  className={`h-2.5 w-2.5 rounded-full border border-white ${
                    index === photoIndex ? "bg-white" : "bg-white/40"
                  }`}
                />
              ))}
            </div>
          </>
        ) : null}
      </figure>

      <div className="card-body bg-white p-4 sm:p-6" style={{ backgroundColor: "#ffffff" }}>
        <header className="border-b border-slate-200 pb-5">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">{streetAddress}</h1>
          <p className="mt-1 text-sm font-medium text-slate-700">
            {city}, {state} {postalCode} <span className="text-slate-400">&middot;</span> {county}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600">
            <span>
              Neighborhood Code: <strong className="text-slate-800">{neighborhood}</strong>
            </span>
          </div>
        </header>

        {showRelatedParcelCheck ? (
        <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-800">
                  Same-Address CAD Parcel Check
                </h2>
                {relatedParcels?.review_required ? (
                  <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                    Review related parcels
                  </span>
                ) : null}
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-600">
                HomeNode checks the official DCAD parcel map in the background for other accounts at
                this exact situs address. Results remain separate and are never merged automatically.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm normal-case border-amber-300 bg-white text-slate-800 hover:border-amber-400 hover:bg-amber-100"
              disabled={relatedParcelsLoading || !accountId}
              onClick={() => setRelatedParcelSearchVersion((current) => current + 1)}
            >
              {relatedParcelsLoading ? "Checking DCAD..." : "Check Again"}
            </button>
          </div>

          {relatedParcelsError ? (
            <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              The live DCAD parcel check could not be completed: {relatedParcelsError}
            </div>
          ) : null}

          {relatedParcels && relatedParcels.live_query_status !== "complete" ? (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-100 p-3 text-sm text-amber-950">
              The official DCAD live check is {relatedParcels.live_query_status.replace(/_/g, " ")}.
              Local exact-address matches are shown below, but this item remains flagged for manual
              parcel review.
            </div>
          ) : null}

          {relatedParcels && !relatedParcelsLoading ? (
            relatedParcels.parcels.length ? (
              <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                {relatedParcelsToShow.map((parcel) => (
                  <div
                    key={parcel.account_id}
                    className={`rounded-xl border bg-white p-3 ${
                      parcel.is_subject ? "border-slate-200" : "border-amber-300"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-950">
                          {parcel.site_address || parcel.address || relatedParcels.query_address}
                        </div>
                        <div className="mt-0.5 font-mono text-xs text-slate-600">
                          {parcel.account_id}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {parcel.is_subject ? (
                          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                            Current subject
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                            Additional parcel
                          </span>
                        )}
                        {!parcel.in_database ? (
                          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800">
                            Not in database
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {!parcel.is_subject && (parcel.difference_fields || []).length ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {(parcel.difference_fields || []).map((field) => (
                          <span
                            key={field}
                            className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900"
                          >
                            Differs: {field}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-600 sm:grid-cols-4">
                      <div>
                        <span className="block text-slate-500">Living Area</span>
                        <strong className="text-slate-800">
                          {parcel.living_area_sqft
                            ? `${new Intl.NumberFormat("en-US").format(parcel.living_area_sqft)} sq. ft.`
                            : "Land / not reported"}
                        </strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Land Value</span>
                        <strong className="text-slate-800">{formatMoney(parcel.land_value)}</strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Improvement Value</span>
                        <strong className="text-slate-800">
                          {formatMoney(parcel.improvement_value)}
                        </strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Total Value</span>
                        <strong className="text-slate-800">{formatMoney(parcel.total_value)}</strong>
                      </div>
                    </div>
                    {parcel.legal_description ? (
                      <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-600">
                        {parcel.legal_description}
                      </p>
                    ) : null}
                    {!parcel.is_subject && parcel.in_database ? (
                      <Link
                        to={`/report/${encodeURIComponent(parcel.account_id)}`}
                        className="mt-3 inline-flex text-xs font-semibold text-blue-700 hover:text-blue-900 hover:underline"
                      >
                        Open this parcel?s report ?
                      </Link>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-600">
                No same-address parcel was returned by the official DCAD parcel map. Keep this item
                under manual review if the situs address is missing or incomplete.
              </p>
            )
          ) : null}
        </section>
        ) : null}

        <div className="mt-5 flex flex-col gap-5">
          <SummarySection
            title="Subject Identification"
            subtitle="Parcel, ownership, and recorded legal information"
            {...sectionEditProps("report.subject_identification")}
            className="order-1"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryField label="Parcel / Account Number" value={displayValue(accountId)} />
              <SummaryField label="County" value={county} />
              <SummaryField label="Subdivision" value={subdivision} />
              <div className="hidden lg:block" aria-hidden="true" />
              <SummaryField label="Zoning" value={primaryZoning} />
              <SummaryField label="Latest Deed Transfer" value={formatDate(deedTransferDate)} />
              <SummaryField
                label={ownerParties.length > 1 ? "Owner Names" : "Owner Name"}
                value={
                  ownerParties.length ? (
                    <div className="space-y-1.5">
                      {ownerParties.map((party, index) => (
                        <div key={`${party.owner_name}-${index}`}>
                          {displayValue(party.owner_name)}
                        </div>
                      ))}
                    </div>
                  ) : ownerName
                }
              />
              <SummaryField
                label="Ownership Percentage"
                value={
                  ownerParties.length ? (
                    <div className="space-y-1.5">
                      {ownerParties.map((party, index) => (
                        <div key={`${party.owner_name}-share-${index}`}>
                          {formatOwnershipPercent(party.ownership_pct)}
                        </div>
                      ))}
                    </div>
                  ) : "Share not reported"
                }
              />
              <SummaryField
                label="Owner Mailing Address"
                value={ownerMailing}
                className="sm:col-span-2 lg:col-span-4"
              />
              <SummaryField
                label="Legal Description"
                value={<span className="whitespace-pre-line">{legalDescription}</span>}
                className="sm:col-span-2 lg:col-span-3"
              />
              <SummaryField
                label="Census Tract"
                value={
                  <div>
                    <span>{formatCensusTract(detail?.property_location?.census_tract)}</span>
                    {detail?.property_location?.census_tract_geoid ? (
                      <span className="mt-0.5 block font-mono text-[11px] font-normal text-slate-500">
                        GEOID {detail.property_location.census_tract_geoid}
                      </span>
                    ) : null}
                    {detail?.property_location?.census_tract_status === "review_required" ? (
                      <span className="mt-1 block text-[11px] font-medium text-amber-700">
                        Coordinate/county match needs review
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs -ml-2 mt-1 normal-case text-blue-700"
                      onClick={() => void lookUpCensusTractNow()}
                      disabled={censusLookupLoading || !accountId}
                    >
                      {censusLookupLoading
                        ? "Looking up..."
                        : detail?.property_location?.census_tract
                          ? "Refresh tract"
                          : "Look Up Now"}
                    </button>
                    {censusLookupMessage ? (
                      <span className={`mt-1 block text-[11px] font-medium ${
                        /added/i.test(censusLookupMessage) ? "text-emerald-700" : "text-amber-700"
                      }`}>
                        {censusLookupMessage}
                      </span>
                    ) : null}
                  </div>
                }
              />
            </div>

            <div className={`mt-5 rounded-xl border p-4 ${
              assignmentFromPrevious
                ? "border-amber-300 bg-amber-50"
                : "border-slate-200 bg-white/70"
            }`}>
              <div className="mb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">PUD and HOA</h3>
                  {assignmentFromPrevious ? (
                    <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-semibold text-amber-950">
                      From Previous Assignment
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {activeAssignmentFile
                    ? `Saving to appraisal file ${activeAssignmentFile.file_number}.`
                    : "Enter a new file number above before saving changes."}
                </p>
              </div>
              <div className="max-w-xs">
                <CheckboxChoice
                  checked={Boolean(assignmentDraft.pud)}
                  label="PUD"
                  onChange={(checked) => updateAssignment("pud", checked)}
                />
              </div>
              {assignmentDraft.pud ? (
                <div className="mt-4 space-y-4">
                  <label className="block max-w-sm">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      HOA Dues Amount
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="input input-bordered mt-1 w-full bg-white"
                      value={assignmentDraft.hoa_dues_amount ?? ""}
                      onChange={(event) =>
                        updateAssignment("hoa_dues_amount", event.target.value)
                      }
                      placeholder="Dollar amount"
                    />
                  </label>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      HOA Dues Frequency
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {HOA_FREQUENCY_OPTIONS.map(([value, label]) => (
                        <CheckboxChoice
                          key={value}
                          checked={assignmentDraft.hoa_frequency === value}
                          label={label}
                          onChange={(checked) =>
                            updateAssignment("hoa_frequency", checked ? value : "")
                          }
                        />
                      ))}
                    </div>
                  </div>
                  <label className="block">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      HOA Explanation
                    </span>
                    <textarea
                      className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                      value={assignmentDraft.hoa_explanation || ""}
                      onChange={(event) =>
                        updateAssignment("hoa_explanation", event.target.value)
                      }
                      placeholder="Required when dues are unavailable or the frequency is Other"
                    />
                  </label>
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-slate-500">
                  {assignmentSaveMessage || (assignmentDirty ? "Unsaved assignment changes" : "No unsaved changes")}
                </span>
                <button
                  type="button"
                  onClick={() => void saveAssignmentDetails()}
                  className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                  disabled={assignmentSaveDisabled}
                >
                  {savingAssignmentFile ? "Saving..." : "Save PUD / HOA"}
                </button>
              </div>
            </div>
          </SummarySection>

          <SummarySection
            title="Assignment Details"
            subtitle={activeAssignmentFile
              ? `Saving to appraisal file ${activeAssignmentFile.file_number}`
              : "Choose a file number above to preserve these values as a new assignment"}
            manuallyVerified={Boolean(activeAssignmentFile || detail?.report_manual_values?.["report.assignment_details"])}
            inherited={assignmentFromPrevious}
            compact
            className="order-5"
          >
            <div className="mb-3 grid gap-3 rounded-xl border border-slate-200 bg-white p-3 md:grid-cols-2">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Lender / Client
                </span>
                <input
                  type="text"
                  maxLength={500}
                  className="input input-bordered input-sm mt-1 w-full bg-white"
                  value={assignmentDraft.lender_client_name || ""}
                  onChange={(event) =>
                    updateAssignment("lender_client_name", event.target.value)
                  }
                  placeholder="Name of lender or client"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Lender / Client Address
                </span>
                <textarea
                  maxLength={2000}
                  className="textarea textarea-bordered textarea-sm mt-1 min-h-16 w-full bg-white"
                  value={assignmentDraft.lender_client_address || ""}
                  onChange={(event) =>
                    updateAssignment("lender_client_address", event.target.value)
                  }
                  placeholder="Mailing address"
                />
              </label>
            </div>

            <div className="grid gap-3 lg:grid-cols-[0.8fr_2.2fr]">
              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-sm font-semibold text-slate-900">Occupancy</legend>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {OCCUPANCY_OPTIONS.map(([value, label]) => (
                    <CheckboxChoice
                      key={value}
                      checked={assignmentDraft.occupancy === value}
                      label={label}
                      onChange={(checked) =>
                        updateAssignment("occupancy", checked ? value : "")
                      }
                    />
                  ))}
                </div>
                {assignmentDraft.occupancy === "unknown" ? (
                  <label className="mt-4 block">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Unknown Occupancy Explanation
                    </span>
                    <textarea
                      className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                      value={assignmentDraft.occupancy_explanation || ""}
                      onChange={(event) =>
                        updateAssignment("occupancy_explanation", event.target.value)
                      }
                    />
                  </label>
                ) : null}
              </fieldset>

              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-sm font-semibold text-slate-900">Assignment Type</legend>
                <p className="mb-2 text-xs text-slate-600">Select every type that applies.</p>
                <div className="grid gap-1.5 sm:grid-cols-3 xl:grid-cols-5">
                  {ASSIGNMENT_TYPE_OPTIONS.map(([value, label]) => (
                    <CheckboxChoice
                      key={value}
                      checked={assignmentTypes.includes(value)}
                      label={label}
                      onChange={(checked) => updateAssignmentTypes(
                        checked
                          ? [...new Set([...assignmentTypes, value])]
                          : assignmentTypes.filter((item) => item !== value),
                      )}
                    />
                  ))}
                </div>
                {assignmentTypes.includes("other") ? (
                  <label className="mt-4 block">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Other Assignment Explanation
                    </span>
                    <textarea
                      className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                      value={assignmentDraft.assignment_explanation || ""}
                      onChange={(event) =>
                        updateAssignment("assignment_explanation", event.target.value)
                      }
                    />
                  </label>
                ) : null}
              </fieldset>
            </div>

            {assignmentErrors.length ? (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                <ul className="list-disc space-y-1 pl-5">
                  {assignmentErrors.map((error) => <li key={error}>{error}</li>)}
                </ul>
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-500">
                {assignmentSaveMessage || (assignmentDirty ? "Unsaved assignment changes" : "No unsaved changes")}
              </span>
              <button
                type="button"
                onClick={() => void saveAssignmentDetails()}
                className="btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
                disabled={assignmentSaveDisabled}
              >
                {savingAssignmentFile ? "Saving..." : "Save Assignment Details"}
              </button>
            </div>
          </SummarySection>

          <div className="order-4 grid grid-cols-1 gap-5">
            <SummarySection
              title="Listings, Contracts, and Sales History"
              subtitle="MLS listing activity, contracts, closed sales, and CAD deed-transfer records"
              {...sectionEditProps("report.sales_history")}
            >
              <ListingsContractsSalesContent
                listingRows={listingRows}
                salesHistoryRows={salesHistoryRows}
                assignmentDraft={assignmentDraft}
                purchaseTransactionSelected={purchaseTransactionSelected}
                assignmentErrors={assignmentErrors}
                assignmentDirty={assignmentDirty}
                assignmentSaveMessage={assignmentSaveMessage}
                assignmentSaveDisabled={assignmentSaveDisabled}
                savingAssignmentFile={savingAssignmentFile}
                contractSellerComparison={contractSellerComparison}
                onAssignmentChange={updateAssignment}
                onSave={() => void saveAssignmentDetails()}
              />
            </SummarySection>
          </div>

          <SummarySection
            title="Property Characteristics"
            subtitle="Auto-populated appraisal-district and verified MLS characteristics"
            {...sectionEditProps("report.property_characteristics")}
            className="order-2"
          >
            <div className="grid grid-cols-2 gap-x-5 gap-y-4 md:grid-cols-3 lg:grid-cols-5">
              <SummaryField
                label="Living Area"
                value={formatNumber(
                  improvement?.living_area_sqft || improvement?.total_living_area,
                  " sq. ft.",
                )}
              />
              <SummaryField
                label="Total Area"
                value={formatNumber(improvement?.total_area_sqft, " sq. ft.")}
              />
              <SummaryField label="Bedrooms" value={displayValue(improvement?.bedroom_count)} />
              <SummaryField label="Bathrooms" value={formatBaths(improvement)} />
              <SummaryField label="Stories" value={displayValue(improvement?.stories)} />
              <SummaryField label="Year Built" value={displayValue(improvement?.year_built)} />
              <SummaryField
                label="Effective Year"
                value={displayValue(improvement?.effective_year_built)}
              />
              <SummaryField label="Actual Age" value={displayValue(improvement?.actual_age)} />
              <SummaryField
                label="Building Class"
                value={displayValue(improvement?.building_class)}
              />
              <SummaryField
                label="Desirability"
                value={displayValue(improvement?.desirability)}
              />
              <SummaryField
                label="Housing Type"
                value={displayValue(housing?.housing_type)}
              />
              <SummaryField
                label="Attachment"
                value={displayValue(housing?.attachment_type)}
              />
              <SummaryField
                label="Architectural Style"
                value={displayValue(housing?.architectural_style)}
              />
              <SummaryField
                label="Construction"
                value={displayValue(improvement?.construction_type)}
              />
              <SummaryField label="Foundation" value={displayValue(improvement?.foundation)} />
              <SummaryField
                label="Exterior"
                value={displayValue(improvement?.exterior_material)}
              />
              <SummaryField
                label="Roof"
                value={[
                  improvement?.roof_type,
                  improvement?.roof_material,
                ]
                  .filter(hasValue)
                  .join(" ? ") || "Not reported"}
              />
              <SummaryField label="Heating" value={displayValue(improvement?.heating)} />
              <SummaryField label="Air Conditioning" value={displayValue(improvement?.air_conditioning)} />
              <SummaryField
                label="Fireplaces"
                value={displayValue(improvement?.fireplaces)}
              />
              <SummaryField label="Kitchens" value={displayValue(improvement?.kitchens)} />
              <SummaryField label="Wet Bars" value={displayValue(improvement?.wetbars)} />
              <SummaryField label="Pool" value={formatReportedBoolean(improvement?.pool)} />
              <SummaryField
                label="Sprinkler"
                value={formatReportedBoolean(improvement?.sprinkler)}
              />
              <SummaryField label="Fence" value={displayValue(improvement?.fence_type)} />
              {additionalImprovements.map((row, index) => (
                <SummaryField
                  key={`${row.number || index}-${row.improvement_type || "improvement"}`}
                  label={displayValue(row.improvement_type, `Improvement ${index + 1}`)}
                  value={(
                    <div>
                      <span>{formatNumber(row.area_sqft, " sq. ft.")}</span>
                      <span className="mt-0.5 block text-xs font-normal leading-5 text-slate-600">
                        {[row.construction, row.floor, row.exterior_wall]
                          .filter(hasValue)
                          .join(" ? ") || "Construction details not reported"}
                        {hasValue(row.year_built)
                          ? ` ? Built ${displayValue(row.year_built)}`
                          : ""}
                      </span>
                    </div>
                  )}
                />
              ))}
            </div>

            <div className="mt-5 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-800">Land Details</h3>
                    {detail?.report_manual_values?.["report.land_details"] ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">
                        Manually verified
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {landRows.length} land record{landRows.length === 1 ? "" : "s"} returned
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => editSection("report.land_details")}
                  className="btn btn-sm normal-case border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
                >
                  Edit Land Details
                </button>
              </div>

              {landRows.length ? (
                <div className="mt-4 space-y-4">
                  {landRows.map((row, index) => {
                    const prefix = landRows.length > 1 ? `Land ${index + 1} ` : "";
                    return (
                      <div
                        key={row.number || index}
                        className="grid grid-cols-2 gap-x-5 gap-y-4 md:grid-cols-3 lg:grid-cols-5"
                      >
                        <SummaryField
                          label={`${prefix}Use / State Code`}
                          value={displayValue(row.state_code)}
                        />
                        <SummaryField
                          label={`${prefix}Area`}
                          value={formatNumber(row.area_sqft, " sq. ft.")}
                        />
                        <SummaryField
                          label={`${prefix}Frontage ? Depth`}
                          value={
                            parseNumber(row.frontage_ft) !== null ||
                            parseNumber(row.depth_ft) !== null
                              ? `${formatNumber(row.frontage_ft, " ft.")} ? ${formatNumber(
                                  row.depth_ft,
                                  " ft.",
                                )}`
                              : "Not reported"
                          }
                        />
                        <SummaryField
                          label={`${prefix}CAD Pricing`}
                          value={displayValue(row.pricing_method)}
                        />
                        <SummaryField
                          label={`${prefix}CAD Adjusted Price`}
                          value={formatMoney(row.adjusted_price)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-600">
                  No land detail records were returned for this parcel.
                </p>
              )}
            </div>
          </SummarySection>

          <SummarySection
            title="Neighborhood Characteristics"
            subtitle="Present land use, neighborhood factors, market ranges, and assignment boundary review"
            manuallyVerified={Boolean(activeAssignmentFile)}
            inherited={assignmentFromPrevious}
            className="order-3"
          >
            <NeighborhoodCharacteristicsContent
              accountId={accountId}
              assignmentDraft={assignmentDraft}
              postalCode={censusZip}
              unemploymentLoading={unemploymentLookupLoading}
              unemploymentMessage={unemploymentLookupMessage}
              profileLoading={neighborhoodProfileLoading}
              profileMessage={neighborhoodProfileMessage}
              boundarySuggestions={neighborhoodBoundarySuggestions}
              customAreaAvailable={Boolean(customMarketStudy?.market.custom_geometry)}
              assignmentDirty={assignmentDirty}
              assignmentSaveMessage={assignmentSaveMessage}
              assignmentSaveDisabled={assignmentSaveDisabled}
              savingAssignmentFile={savingAssignmentFile}
              onAssignmentChange={updateAssignment}
              onRefreshUnemployment={() => void lookupZipUnemployment()}
              onRefreshBoundary={() => void refreshNeighborhoodProfile()}
              onConfirmBoundary={confirmNeighborhoodBoundary}
              onSave={() => void saveAssignmentDetails()}
            />
          </SummarySection>

          <SummarySection
            title="CAD Values, Taxes, and Exemptions"
            subtitle={`Certified tax year ${displayValue(
              values?.certified_year || detail?.tax_year,
            )}`}
            actions={(
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => editSection("report.appraisal_values")}
                  className="btn btn-sm normal-case border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
                >
                  Edit Values
                </button>
                <button
                  type="button"
                  onClick={() => editSection("report.exemptions")}
                  className="btn btn-sm normal-case border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
                >
                  Edit Taxes &amp; Exemptions
                </button>
              </div>
            )}
            manuallyVerified={Boolean(
              detail?.report_manual_values?.["report.appraisal_values"] ||
              detail?.report_manual_values?.["report.exemptions"],
            )}
            className="order-6"
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <SummaryField label="Market Value" value={formatMoney(values?.market_value)} />
              <SummaryField
                label="Assessed / Capped Value"
                value={formatMoney(values?.capped_value || values?.market_value)}
              />
              <SummaryField label="Improvement Value" value={formatMoney(values?.improvement_value)} />
              <SummaryField label="CAD Land Value" value={formatMoney(values?.land_value)} />
            </div>

            <div className="mt-5 border-t border-slate-200 pt-4">
              <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <SummaryField label="Homestead" value={homestead ? "Yes" : "No"} />
                <SummaryField
                  label="Taxing Units with Exemption"
                  value={new Intl.NumberFormat("en-US").format(exemptJurisdictionCount)}
                />
              </div>

              {exemptionRows.length ? (
                <div>
                  <div
                    className="grid gap-x-6 border-b border-slate-300 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                    style={{ gridTemplateColumns: "minmax(180px,1.4fr) minmax(160px,1fr) minmax(160px,1fr)" }}
                  >
                    <div>Taxing Unit</div>
                    <div className="text-right">Homestead Exemption</div>
                    <div className="text-right">Taxable Value</div>
                  </div>
                  {exemptionRows.map(({ key, fallbackLabel, row }) => (
                    <div
                      key={key}
                      className="grid gap-x-6 border-b border-slate-200 py-2.5 text-sm last:border-b-0"
                      style={{ gridTemplateColumns: "minmax(180px,1.4fr) minmax(160px,1fr) minmax(160px,1fr)" }}
                    >
                      <div>{displayValue(row?.taxing_jurisdiction, fallbackLabel)}</div>
                      <div className="text-right">{formatMoney(row?.homestead_exemption)}</div>
                      <div className="text-right">{formatMoney(row?.taxable_value)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-600">
                  No current exemption or taxable-value records were returned for this parcel.
                </p>
              )}
            </div>
          </SummarySection>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-2 border-t border-slate-200 pt-5 sm:grid-cols-2 xl:grid-cols-5">
          <Link
            to={
              accountId
                ? `/ComparableSalesAnalysis?propertyId=${encodeURIComponent(accountId)}`
                : "#"
            }
            aria-label="Sales Comparison Approach"
            aria-disabled={!accountId}
            className={`btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-emerald-600 bg-emerald-600 text-white hover:border-emerald-700 hover:bg-emerald-700"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Sales Comparison Approach
          </Link>
          <button
            type="button"
            disabled
            title="Cost Approach is coming soon"
            aria-label="Cost Approach coming soon"
            className="btn normal-case rounded-md border-slate-200 bg-slate-200 px-4 py-2 text-slate-500"
          >
            Cost Approach
          </button>
          <button
            type="button"
            disabled
            title="Income Approach is coming soon"
            aria-label="Income Approach coming soon"
            className="btn normal-case rounded-md border-slate-200 bg-slate-200 px-4 py-2 text-slate-500"
          >
            Income Approach
          </button>
          <Link
            to={protestUrl}
            aria-label="Property Tax Protest"
            className="btn normal-case rounded-md border-blue-600 bg-blue-600 px-4 py-2 text-white hover:border-blue-700 hover:bg-blue-700"
          >
            Property Tax Protest
          </Link>
          <Link
            to={
              accountId
                ? `/AppraisalReport?propertyId=${encodeURIComponent(accountId)}${
                    appraisalReportAssignmentFile
                      ? `&assignmentFileId=${encodeURIComponent(String(appraisalReportAssignmentFile.id))}`
                      : ""
                  }`
                : "#"
            }
            aria-label="Full Appraisal PDF"
            aria-disabled={!accountId}
            title={neighborhoodBoundaryErrors.length
              ? `PDF printing will be blocked until: ${neighborhoodBoundaryErrors.join(" ")}`
              : "Open the full appraisal report"}
            className={`btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? neighborhoodBoundaryErrors.length
                  ? "border-amber-500 bg-amber-100 text-amber-950 hover:bg-amber-200"
                  : "border-slate-900 bg-slate-900 text-white hover:border-slate-950 hover:bg-slate-950"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            {neighborhoodBoundaryErrors.length ? "PDF Setup Required" : "Full Appraisal PDF"}
          </Link>
        </div>
      </div>
      {editingSection ? (
        <ReportSectionEditor
          section={editingSection}
          initialValue={editableSectionValue(editingSection.key)}
          saving={savingSection}
          onCancel={() => setEditingSection(null)}
          onSave={saveEditedSection}
        />
      ) : null}
    </div>
  );
}

export default function PropertyReport() {
  const location = useLocation();
  const { accountId: routeAccountId } = useParams<{ accountId?: string }>();

  const presetAccount = useMemo(() => {
    if (routeAccountId) return routeAccountId;
    const params = new URLSearchParams(location.search);
    return params.get("account_id") || params.get("account") || "";
  }, [location.search, routeAccountId]);

  const account = presetAccount;
  const [detail, setDetail] = useState<DcadDetail | null>(null);
  const hasAutoImported = useRef(false);
  const loadRequestId = useRef(0);

  async function importFromDatabase() {
    if (!account) {
      window.alert("Enter an Account ID first.");
      return;
    }
    const requestedAccount = account.trim();
    const requestId = ++loadRequestId.current;
    try {
      const response = await fetchDetail(requestedAccount);
      if (requestId !== loadRequestId.current) return;
      setDetail(response?.detail ?? null);

      // The account payload is complete without MLS media. Load any future
      // photo gallery in the background and never hold back the report.
      void getAccountPhotos(requestedAccount)
        .then((photoResponse) => {
          if (requestId !== loadRequestId.current) return;
          const photos = photoResponse?.photos
            ?.map((photo) => photo?.media_url)
            .filter((url): url is string => Boolean(url?.trim())) || [];
          if (!photos.length) return;
          setDetail((current) => (current ? { ...current, photos } : current));
        })
        .catch((error) => {
          console.warn("Property photos were unavailable", error);
        });
    } catch (error: unknown) {
      if (requestId !== loadRequestId.current) return;
      console.error(error);
      window.alert(error instanceof Error ? error.message : "Import failed");
    }
  }

  useEffect(() => {
    if (!hasAutoImported.current && account) {
      hasAutoImported.current = true;
      void importFromDatabase();
    }
    // The account is intentionally imported only once when the routed report opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  return (
    <div className="min-h-screen bg-base-200">
      <div className="navbar bg-base-100 shadow-sm">
        <div className="container mx-auto px-4">
          <div className="flex w-full items-center justify-between">
            <span className="text-xl font-semibold">Property Report</span>
            <Link to="/" className="btn btn-ghost btn-sm normal-case">
              ? Close Report
            </Link>
          </div>
        </div>
      </div>

      <main className="container mx-auto space-y-4 px-4 py-4">
        <AddressHero detail={detail} accountId={account} onReload={importFromDatabase} />
      </main>
    </div>
  );
}
