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
      { entity_id: null, context_key: "reconciliation", uid: "1300.0019", value: false, is_appraiser_confirmed: true },
      { entity_id: null, context_key: "reconciliation", uid: "1300.0021", value: "The sales comparison approach provides the most reliable indication for this synthetic assignment.", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market", uid: "3000.0008", value: "North: Belt Line Rd | South: Arapaho Rd | East: Jupiter Rd | West: Shiloh Rd", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market", uid: "3000.0010", value: "Detached single-family properties with similar age, design, site utility, and gross living area.", is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market_active_listings", uid: "3000.0018", value: 0, is_appraiser_confirmed: true },
      { entity_id: null, context_key: "market_pending_sales", uid: "3000.0024", value: 0, is_appraiser_confirmed: true },
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

export function uadSalesRichEditorFixture() {
  const editor = uadNativePdfEditorFixture();
  const comparables = [
    {
      id: "20000000-0000-4000-8000-000000000001",
      ordinal: 1,
      address: ["1810 Oak Bend Dr", "Garland", "TX", "75044"],
      listPrice: 489000,
      salePrice: 485000,
      saleDate: "2026-06-18",
      weight: "Most",
      adjustments: [
        ["sales_comparable_adjustment_overall_condition", 10000],
        ["sales_comparable_adjustment_sale_date", -5000],
      ],
    },
    {
      id: "20000000-0000-4000-8000-000000000002",
      ordinal: 2,
      address: ["1725 Creekview Ln", "Garland", "TX", "75044"],
      listPrice: 485000,
      salePrice: 480000,
      saleDate: "2026-05-29",
      weight: "Less",
      adjustments: [
        ["sales_comparable_adjustment_site_size", 5000],
        ["sales_comparable_adjustment_standard_above", 2500],
      ],
    },
    {
      id: "20000000-0000-4000-8000-000000000003",
      ordinal: 3,
      address: ["2204 Meadow Park Dr", "Garland", "TX", "75044"],
      listPrice: 497500,
      salePrice: 492000,
      saleDate: "2026-04-22",
      weight: "Less",
      adjustments: [
        ["sales_comparable_adjustment_overall_condition", 15000],
        ["sales_comparable_adjustment_sale_date", -7500],
      ],
    },
  ];
  editor.entities = comparables.map((comparable) => ({
    id: comparable.id,
    workfile_id: editor.workfile.id,
    parent_entity_id: null,
    entity_type: "sales_comparable",
    entity_identifier: `sales-comparable-${comparable.ordinal}`,
    ordinal: comparable.ordinal,
    label: `Sales Comparable ${comparable.ordinal}`,
    data: {},
  }));
  editor.values.push(
    { entity_id: null, context_key: "cost_approach_exclusion", uid: "1300.0002", value: ["NotNecessaryForCredibleResults"], is_appraiser_confirmed: true },
    { entity_id: null, context_key: "income_approach_exclusion", uid: "1300.0004", value: ["NotNecessaryForCredibleResults"], is_appraiser_confirmed: true },
    { entity_id: null, context_key: "sales_comparison_scope", uid: "1000.0032", value: true, is_appraiser_confirmed: true },
    { entity_id: null, context_key: "sales_comparison_summary", uid: "1300.0006", value: 491000, is_appraiser_confirmed: true },
    {
      entity_id: null,
      context_key: "sales_comparison_reconciliation",
      uid: "1800.0278",
      value: "Comparable 1 received the most weight due to its recent sale date, similar location, condition, site utility, and finished area. Comparables 2 and 3 bracket the conclusion after supported market-derived adjustments.",
      is_appraiser_confirmed: true,
    },
  );
  for (const comparable of comparables) {
    const netAdjustment = comparable.adjustments.reduce((total, [, amount]) => total + amount, 0);
    const values = [
      ["sales_comparable", "1800.0192", comparable.ordinal],
      ["sales_comparable_address", "1800.0001", comparable.address[0]],
      ["sales_comparable_address", "1800.0003", comparable.address[1]],
      ["sales_comparable_address", "1800.0005", comparable.address[2]],
      ["sales_comparable_address", "1800.0004", comparable.address[3]],
      ["sales_comparable_listing", "1800.0074", comparable.listPrice],
      ["sales_comparable_listing", "1800.0075", "SettledSale"],
      ["sales_comparable_sale", "1800.0272", comparable.salePrice],
      ["sales_comparable_sale", "1800.0342", comparable.saleDate],
      ["sales_comparable_summary", "1800.0313", netAdjustment],
      ["sales_comparable_summary", "1800.0309", comparable.salePrice + netAdjustment],
      ["sales_comparable_summary", "1800.0312", comparable.weight],
    ];
    for (const [context_key, uid, value] of values) {
      editor.values.push({ entity_id: comparable.id, context_key, uid, value, is_appraiser_confirmed: true });
    }
    for (const [context_key, value] of comparable.adjustments) {
      editor.values.push({
        entity_id: comparable.id,
        context_key,
        uid: "1800.0317",
        value,
        is_appraiser_confirmed: true,
      });
    }
  }
  return editor;
}

export function uadNativePdfSignerFixture() {
  return {
    signer_role: "appraiser",
    execution_date: "2026-08-21",
    credential_snapshot: {
      signer: { first_name: "Taylor", middle_name: null, last_name: "Appraiser", suffix_name: null },
      organization: {
        legal_name: "HomeNode Staging LLC",
        display_name: "HomeNode Staging",
        address_line_1: "100 Test Office Dr",
        city: "Garland",
        state_code: "TX",
        postal_code: "75044",
      },
      license: {
        license_type: "CertifiedResidential",
        license_number: "STAGING-CR-0001",
        jurisdiction: "TX",
        expires_on: "2028-12-31",
      },
    },
  };
}
