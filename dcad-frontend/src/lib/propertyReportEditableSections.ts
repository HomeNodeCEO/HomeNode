import type { AssignmentDetailsPayload, PropertyComplexityAssessment, ReportManualSectionKey } from "./api";
import type { PropertyActivityRow } from "../components/ListingsContractsSalesContent";
import { cloneEditorValue } from "./propertyReportAssignment.ts";

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

export type DcadMainImprovement = {
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

export type DcadImprovementRow = {
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

export type DcadExemptionsMap = {
  city?: DcadExemptionRow;
  school?: DcadExemptionRow;
  county?: DcadExemptionRow;
  college?: DcadExemptionRow;
  hospital?: DcadExemptionRow;
  special_district?: DcadExemptionRow;
};

type DcadSaleHistoryRow = PropertyActivityRow;

export type DcadHousingProfile = {
  structural_style?: string;
  housing_type?: string;
  attachment_type?: string;
  architectural_style?: string;
  profile_source?: string;
};

type AssignmentDetails = AssignmentDetailsPayload;

export type DcadDetail = {
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
  property_context?: PropertyComplexityAssessment | null;
  homestead_yes?: boolean;
  assignment_details?: AssignmentDetails;
  photos?: string[];
  report_manual_values?: Partial<Record<ReportManualSectionKey, unknown>>;
};

/** Pure initial values for the existing manual section editor. Keep the legacy
 * defaults and cloning behavior; this does not hydrate, authorize or save data. */
export function editablePropertyReportSectionValue(
  sectionKey: ReportManualSectionKey,
  { detail, improvement, housing, inspectionDetails, additionalImprovements }: {
    detail: DcadDetail | null;
    improvement: DcadMainImprovement | undefined;
    housing: DcadHousingProfile | undefined;
    inspectionDetails: Record<string, unknown>;
    additionalImprovements: DcadImprovementRow[];
  },
): Record<string, unknown> {
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
          living_area_sqft: improvement?.living_area_sqft || "",
          total_area_sqft: improvement?.total_area_sqft || "",
          bedroom_count: improvement?.bedroom_count || "",
          bath_count: improvement?.bath_count || "",
          baths_full: improvement?.baths_full || "",
          baths_half: improvement?.baths_half || "",
          stories: improvement?.stories || "",
          year_built: improvement?.year_built || "",
          effective_year_built: improvement?.effective_year_built || "",
          actual_age: improvement?.actual_age || "",
          building_class: improvement?.building_class || "",
          desirability: improvement?.desirability || "",
          construction_type: improvement?.construction_type || "",
          foundation: improvement?.foundation || "",
          exterior_material: improvement?.exterior_material || "",
          roof_type: improvement?.roof_type || "",
          roof_material: improvement?.roof_material || "",
          heating: improvement?.heating || "",
          air_conditioning: improvement?.air_conditioning || "",
          fireplaces: improvement?.fireplaces || "",
          kitchens: improvement?.kitchens || "",
          wetbars: improvement?.wetbars || "",
          pool: improvement?.pool ?? "",
          sprinkler: improvement?.sprinkler ?? "",
          fence_type: improvement?.fence_type || "",
        },
        housing_profile: {
          structural_style: housing?.structural_style || "",
          housing_type: housing?.housing_type || "",
          attachment_type: housing?.attachment_type || "unknown",
          architectural_style: housing?.architectural_style || "",
        },
        inspection_details: cloneEditorValue(inspectionDetails),
        additional_improvements: cloneEditorValue(additionalImprovements),
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
        contract_buyer_names: detail?.assignment_details?.contract_buyer_names || "",
        contract_seller_names: detail?.assignment_details?.contract_seller_names || "",
        contract_price: detail?.assignment_details?.contract_price || "",
        contract_date: detail?.assignment_details?.contract_date || "",
        contract_closing_date: detail?.assignment_details?.contract_closing_date || "",
        loan_amount: detail?.assignment_details?.loan_amount || "",
        down_payment: detail?.assignment_details?.down_payment || "",
        earnest_money: detail?.assignment_details?.earnest_money || "",
        seller_concessions: detail?.assignment_details?.seller_concessions || "",
        contract_property_condition:
          detail?.assignment_details?.contract_property_condition || "",
        contract_repairs: detail?.assignment_details?.contract_repairs || "",
        contract_analysis_summary: detail?.assignment_details?.contract_analysis_summary || "",
        seller_matches_public_records:
          typeof detail?.assignment_details?.seller_matches_public_records === "boolean"
            ? detail.assignment_details.seller_matches_public_records
            : null,
        seller_mismatch_explanation:
          detail?.assignment_details?.seller_mismatch_explanation || "",
      };
  }
}
