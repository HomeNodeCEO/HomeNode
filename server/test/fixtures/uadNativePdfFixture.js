import { getUadEditorSections } from "../../src/modules/uad/fieldCatalog.js";

const RELEASE_KEY = "uad-3.6-2026-08-13-h1.5";

export function uadNativePdfEditorFixture() {
  return {
    workfile: {
      id: "00000000-0000-4000-8000-000000000001",
      file_number: "UAD-STAGING-SFR-0001",
      current_revision: 3,
      specification_release_key: RELEASE_KEY,
      status: "signed",
      updated_at: "2026-08-21T12:00:00.000Z",
    },
    sections: getUadEditorSections().map((section) => ({ ...section, applicable: true })),
    entities: [],
    values: [
      { entity_id: null, context_key: "subject_address", uid: "0100.0007", value: "1909 Snowmass Ln, Garland, TX 75044", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "assignment", uid: "1000.0034", value: "Purchase", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "assignment", uid: "1000.0158", value: "TraditionalAppraisal", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "assignment", uid: "1000.0043", value: false, is_appraiser_confirmed: true },
      { entity_id: null, context_key: "subject", uid: "1600.0007", value: "Q4", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "subject", uid: "1600.0006", value: "C4", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "sales_contract", uid: "0600.0008", value: 489000, is_appraiser_confirmed: true },
      { entity_id: null, context_key: "sales_contract", uid: "0600.0002", value: true, is_appraiser_confirmed: true },
      { entity_id: null, context_key: "sales_contract_commentary", uid: "0600.0014", value: "Contract evidence was reviewed and reconciled with market behavior.", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "reconciliation", uid: "1300.0017", value: 491000, is_appraiser_confirmed: true },
      { entity_id: null, context_key: "reconciliation", uid: "1300.0012", value: "2026-08-20", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "reconciliation", uid: "1300.0010", value: ["AsIs"], is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market", uid: "3000.0008", value: "North: Belt Line Rd | South: Arapaho Rd | East: Jupiter Rd | West: Shiloh Rd", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market", uid: "3000.0010", value: "Detached single-family properties with similar age, design, site utility, and gross living area.", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market_total_sales", uid: "3000.0026", value: 35, is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market_total_sales", uid: "3000.0029", value: 499000, is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market", uid: "3000.0033", value: "InBalance", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market", uid: "3000.0031", value: "ThreeToSixMonths", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market_commentary", uid: "0100.0044", value: "Market evidence supports stable demand, balanced supply, and typical exposure consistent with the selected comparables.", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "certification_report", uid: "2200.0038", value: "InteriorAndExterior", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "certification_scope", uid: "1000.0028", value: false, is_appraiser_confirmed: true },
      { entity_id: null, context_key: "certification_scope", uid: "2200.0062", value: false, is_appraiser_confirmed: true },
    ],
    completion: {},
  };
}

export function uadNativePdfSignerFixture() {
  return {
    signer_role: "appraiser",
    execution_date: "2026-08-21",
    credential_snapshot: {
      signer: { first_name: "Jordan", middle_name: null, last_name: "Freeman", suffix_name: null },
      organization: { legal_name: "HomeNode Real Estate", display_name: "HomeNode Real Estate" },
      license: {
        license_type: "LicensedResidential",
        license_number: "1350764-LR",
        jurisdiction: "TX",
        expires_on: "2027-06-30",
      },
    },
  };
}
