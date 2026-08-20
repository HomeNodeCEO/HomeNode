import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { getUadEditor } from "../src/modules/uad/editor.js";

const databaseUrl = process.env.DATABASE_URL;

test("UAD staging bootstrap supports site-built and manufactured-home search tiles", {
  skip: !databaseUrl || !databaseUrl.toLowerCase().includes("staging"),
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query(`
      SELECT
        a.account_id,
        a.address,
        a.street_name,
        a.city,
        a.postal_code,
        a.county,
        a.neighborhood_code,
        a.subdivision,
        a.legal_description,
        a.data_quality_status,
        a.data_quality_flags,
        a.canonical_account_id,
        native_identifier.native_account_id,
        COALESCE(vsc.certified_year, mv.tax_year) AS latest_tax_year,
        COALESCE(vsc.market_value, mv.total_value) AS latest_market_value,
        COALESCE(vsc.improvement_value, mv.imp_value) AS latest_improvement_value,
        COALESCE(vsc.land_value, mv.land_value) AS latest_land_value,
        COALESCE(vsc.capped_value, mv.homestead_cap_value) AS latest_capped_value
      FROM core.accounts a
      LEFT JOIN LATERAL (
        SELECT identifier.native_account_id
          FROM app.county_account_identifiers identifier
         WHERE identifier.account_id = a.account_id
         ORDER BY
           (identifier.verification_source = 'collin_cad_open_data') DESC,
           identifier.updated_at DESC
         LIMIT 1
      ) native_identifier ON TRUE
      LEFT JOIN core.value_summary_current vsc ON vsc.account_id = a.account_id
      LEFT JOIN LATERAL (
        SELECT value.*
          FROM core.market_values value
         WHERE value.account_id = a.account_id
         ORDER BY value.tax_year DESC
         LIMIT 1
      ) mv ON TRUE
      LEFT JOIN LATERAL (
        SELECT raw.raw
          FROM core.dcad_json_raw raw
         WHERE raw.account_id = a.account_id
         ORDER BY raw.tax_year DESC, raw.fetched_at DESC
         LIMIT 1
      ) raw_record ON TRUE
      WHERE a.account_id IN ('UAD-STAGING-SFR-0001', 'UAD-STAGING-MH-0001')
      ORDER BY a.account_id
    `);

    assert.equal(rows.length, 2);
    const byAccount = new Map(rows.map((row) => [row.account_id, row]));
    assert.equal(byAccount.get("UAD-STAGING-SFR-0001")?.address, "100 Test Subject Dr");
    assert.equal(byAccount.get("UAD-STAGING-SFR-0001")?.street_name, "TEST SUBJECT DR");
    assert.equal(byAccount.get("UAD-STAGING-SFR-0001")?.latest_tax_year, 2026);
    assert.equal(Number(byAccount.get("UAD-STAGING-SFR-0001")?.latest_market_value), 425000);
    assert.equal(byAccount.get("UAD-STAGING-MH-0001")?.address, "200 Factory Home Way");
    assert.equal(byAccount.get("UAD-STAGING-MH-0001")?.street_name, "FACTORY HOME WAY");
    assert.equal(byAccount.get("UAD-STAGING-MH-0001")?.latest_tax_year, 2026);
    assert.equal(Number(byAccount.get("UAD-STAGING-MH-0001")?.latest_market_value), 240000);

    const realRows = await pool.query(
      `SELECT count(*)::integer AS count
         FROM core.accounts
        WHERE NOT (account_id = ANY($1::text[]))`,
      [["UAD-STAGING-SFR-0001", "UAD-STAGING-MH-0001"]],
    );
    assert.equal(realRows.rows[0].count, 0);

    const mobilePrincipal = await pool.query(
      `SELECT users.email, users.display_name, memberships.status, roles.role_code,
              profiles.profile_status, profiles.signature_policy,
              users.metadata ->> 'synthetic' AS synthetic
         FROM app_auth.users users
         JOIN app_auth.organization_memberships memberships ON memberships.user_id = users.id
         JOIN app_auth.membership_roles roles
           ON roles.organization_id = memberships.organization_id AND roles.user_id = memberships.user_id
         JOIN app_auth.appraiser_profiles profiles ON profiles.user_id = users.id
        WHERE users.id = '00000000-0000-4000-8000-000000000902'`,
    );
    assert.equal(mobilePrincipal.rows.length, 1);
    assert.equal(mobilePrincipal.rows[0].email, "mobile-appraiser@staging.homenode.invalid");
    assert.equal(mobilePrincipal.rows[0].display_name, "Mobile Staging Appraiser");
    assert.equal(mobilePrincipal.rows[0].status, "active");
    assert.equal(mobilePrincipal.rows[0].role_code, "appraiser");
    assert.equal(mobilePrincipal.rows[0].profile_status, "active");
    assert.equal(mobilePrincipal.rows[0].signature_policy, "reauthentication");
    assert.equal(mobilePrincipal.rows[0].synthetic, "true");

    const manufacturedWorkfile = await pool.query(
      `SELECT w.id, w.file_number, w.property_type, v.value #>> '{}' AS construction_method
         FROM appraisal.uad_workfiles w
         JOIN appraisal.uad_entities dwelling
           ON dwelling.workfile_id = w.id
          AND dwelling.entity_type = 'dwelling'
          AND dwelling.ordinal = 1
         JOIN appraisal.uad_field_values v
           ON v.workfile_id = w.id
          AND v.entity_id = dwelling.id
          AND v.field_context = 'dwelling'
          AND v.uad_uid = '0300.0034'
        WHERE w.account_id = 'UAD-STAGING-MH-0001'
          AND lower(w.file_number) = lower('HN-UAD-STAGING-MH-0001')`,
    );
    assert.equal(manufacturedWorkfile.rows.length, 1);
    assert.equal(manufacturedWorkfile.rows[0].property_type, "manufactured_home");
    assert.equal(manufacturedWorkfile.rows[0].construction_method, "Manufactured");

    const editor = await getUadEditor(pool, manufacturedWorkfile.rows[0].id);
    const section9 = editor.sections.find((section) => section.officialSectionNumber === 9);
    assert.equal(section9?.key, "manufactured_home");
    assert.equal(section9?.applicable, true);
    assert.ok(section9.groups.reduce((count, group) => count + group.fields.length, 0) >= 32);
    assert.ok(editor.completion.manufactured_home.required > 0);

    const siteBuiltWorkfile = await pool.query(
      `SELECT id
         FROM appraisal.uad_workfiles
        WHERE account_id = 'UAD-STAGING-SFR-0001'
          AND lower(file_number) = lower('HN-UAD-STAGING-SFR-0001')`,
    );
    assert.equal(siteBuiltWorkfile.rows.length, 1);
    const siteBuiltEditor = await getUadEditor(pool, siteBuiltWorkfile.rows[0].id);
    const section10 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 10);
    assert.equal(section10?.key, "unit_interior");
    assert.equal(section10?.applicable, true);
    assert.ok(section10.groups.reduce((count, group) => count + group.fields.length, 0) >= 70);
    assert.ok(siteBuiltEditor.entities.some((entity) => entity.entity_type === "unit_level"));
    assert.ok(siteBuiltEditor.entities.filter((entity) => entity.entity_type === "unit_room").length >= 6);
    assert.ok(siteBuiltEditor.entities.some((entity) => entity.entity_type === "unit_interior_feature"));
    assert.ok(siteBuiltEditor.completion.unit_interior.required > 0);
    const section11 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 11);
    assert.equal(section11?.key, "functional_obsolescence");
    assert.equal(section11?.applicable, true);
    assert.equal(section11.groups.reduce((count, group) => count + group.fields.length, 0), 3);
    assert.deepEqual(
      siteBuiltEditor.values.find((value) => (
        value.context_key === "functional_obsolescence" && value.uid === "3600.0002"
      ))?.value,
      ["None"],
    );
    assert.equal(siteBuiltEditor.completion.functional_obsolescence.percent, 100);
    const section12 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 12);
    assert.equal(section12?.key, "outbuilding");
    assert.equal(section12?.applicable, true);
    assert.ok(section12.groups.reduce((count, group) => count + group.fields.length, 0) >= 34);
    const stagingOutbuilding = siteBuiltEditor.entities.find((entity) => entity.entity_type === "outbuilding");
    assert.ok(stagingOutbuilding);
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === stagingOutbuilding.id
        && value.context_key === "outbuilding"
        && value.uid === "0300.0025"
      ))?.value,
      "Shed",
    );
    assert.ok(siteBuiltEditor.completion.outbuilding.required > 0);
    const section13 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 13);
    assert.equal(section13?.key, "vehicle_storage");
    assert.equal(section13?.applicable, true);
    assert.equal(section13.groups.reduce((count, group) => count + group.fields.length, 0), 16);
    const stagingVehicleStorage = siteBuiltEditor.entities.find((entity) => entity.entity_type === "vehicle_storage");
    assert.ok(stagingVehicleStorage);
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === stagingVehicleStorage.id
        && value.context_key === "vehicle_storage"
        && value.uid === "3200.0006"
      ))?.value,
      "Garage",
    );
    assert.ok(siteBuiltEditor.completion.vehicle_storage.required > 0);
    const section14 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 14);
    assert.equal(section14?.key, "subject_property_amenities");
    assert.equal(section14?.applicable, true);
    assert.equal(section14.groups.reduce((count, group) => count + group.fields.length, 0), 41);
    const stagingAmenity = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "amenity" && entity.data?.amenity_category === "OutdoorLiving"
    ));
    assert.ok(stagingAmenity);
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === stagingAmenity.id
        && value.context_key === "amenity_outdoor_living"
        && value.uid === "0200.0023"
      ))?.value,
      "Deck",
    );
    assert.ok(siteBuiltEditor.completion.subject_property_amenities.required > 0);
    assert.equal(siteBuiltEditor.completion.subject_property_amenities.percent, 100);
    const section15 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 15);
    assert.equal(section15?.key, "overall_quality_condition");
    assert.equal(section15?.applicable, true);
    assert.equal(section15.groups.reduce((count, group) => count + group.fields.length, 0), 3);
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === null
        && value.context_key === "subject"
        && value.uid === "1600.0007"
      ))?.value,
      "Q3",
    );
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === null
        && value.context_key === "subject"
        && value.uid === "1600.0006"
      ))?.value,
      "C3",
    );
    assert.equal(siteBuiltEditor.completion.overall_quality_condition.required, 9);
    assert.equal(siteBuiltEditor.completion.overall_quality_condition.percent, 100);
    const section16 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 16);
    assert.equal(section16?.key, "highest_best_use");
    assert.equal(section16?.applicable, true);
    assert.equal(section16.groups.reduce((count, group) => count + group.fields.length, 0), 6);
    for (const uid of ["3100.0004", "3100.0006", "3100.0003", "3100.0005", "3100.0007"]) {
      assert.equal(
        siteBuiltEditor.values.find((value) => (
          value.entity_id === null
          && value.context_key === "highest_best_use"
          && value.uid === uid
        ))?.value,
        true,
      );
    }
    assert.equal(siteBuiltEditor.completion.highest_best_use.required, 5);
    assert.equal(siteBuiltEditor.completion.highest_best_use.percent, 100);
    const section17 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 17);
    assert.equal(section17?.key, "market");
    assert.equal(section17?.applicable, true);
    assert.equal(section17.groups.reduce((count, group) => count + group.fields.length, 0), 19);
    const marketSource = siteBuiltEditor.entities.find((entity) => entity.entity_type === "market_price_trend_source");
    assert.ok(marketSource);
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === marketSource.id
        && value.context_key === "market_price_trend_source"
        && value.uid === "3000.0051"
      ))?.value,
      "Synthetic MLS Market Dataset",
    );
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === null
        && value.context_key === "market_total_sales"
        && value.uid === "3000.0029"
      ))?.value,
      418000,
    );
    assert.equal(siteBuiltEditor.completion.market.required, 18);
    assert.equal(siteBuiltEditor.completion.market.percent, 100);
    const section18 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 18);
    assert.equal(section18?.key, "project_information");
    assert.equal(section18?.applicable, true);
    assert.ok(section18.groups.reduce((count, group) => count + group.fields.length, 0) >= 80);
    const projectDataSource = siteBuiltEditor.entities.find((entity) => entity.entity_type === "project_data_source");
    const projectAmenity = siteBuiltEditor.entities.find((entity) => entity.entity_type === "project_amenity");
    const projectUtility = siteBuiltEditor.entities.find((entity) => entity.entity_type === "project_utility");
    assert.ok(projectDataSource);
    assert.ok(projectAmenity);
    assert.ok(projectUtility);
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === projectDataSource.id
        && value.context_key === "project_data_source"
        && value.uid === "0700.0125"
      ))?.value,
      "HomeownersAssociation",
    );
    assert.equal(siteBuiltEditor.completion.project_information.required, 8);
    assert.equal(siteBuiltEditor.completion.project_information.percent, 100);
    const section19 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 19);
    assert.equal(section19?.key, "subject_listing_information");
    assert.equal(section19?.applicable, true);
    assert.equal(section19.groups.reduce((count, group) => count + group.fields.length, 0), 14);
    const subjectListing = siteBuiltEditor.entities.find((entity) => entity.entity_type === "subject_listing");
    assert.ok(subjectListing);
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === subjectListing.id
        && value.context_key === "subject_listing"
        && value.uid === "0900.0011"
      ))?.value,
      "NTREIS-SYNTHETIC-19001",
    );
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === null
        && value.context_key === "subject_listing_summary"
        && value.uid === "0900.0003"
      ))?.value,
      30,
    );
    assert.equal(siteBuiltEditor.completion.subject_listing_information.required, 8);
    assert.equal(siteBuiltEditor.completion.subject_listing_information.percent, 100);
    const section20 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 20);
    assert.equal(section20?.key, "sales_contract");
    assert.equal(section20?.applicable, true);
    assert.equal(section20.groups.reduce((count, group) => count + group.fields.length, 0), 14);
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === null
        && value.context_key === "sales_contract"
        && value.uid === "0600.0008"
      ))?.value,
      435000,
    );
    assert.equal(
      siteBuiltEditor.values.find((value) => (
        value.entity_id === null
        && value.context_key === "sales_contract"
        && value.uid === "0600.0011"
      ))?.value,
      7500,
    );
    assert.equal(siteBuiltEditor.completion.sales_contract.required, 11);
    assert.equal(siteBuiltEditor.completion.sales_contract.percent, 100);
    const section21 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 21);
    assert.equal(section21?.key, "prior_sale_transfer_history");
    assert.equal(section21?.applicable, true);
    assert.equal(section21.groups.reduce((count, group) => count + group.fields.length, 0), 27);
    const subjectTransfer = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "subject_prior_transfer"
      && entity.entity_identifier === "subject-prior-transfer-1"
    ));
    const subjectTransferSource = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "subject_prior_transfer_data_source"
      && entity.parent_entity_id === subjectTransfer?.id
    ));
    assert.ok(subjectTransfer);
    assert.ok(subjectTransferSource);
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === subjectTransfer.id
        && item.context_key === "subject_prior_transfer"
        && item.uid === "0800.0012"
      ))?.value,
      375000,
    );
    assert.equal(siteBuiltEditor.completion.prior_sale_transfer_history.required, 11);
    assert.equal(siteBuiltEditor.completion.prior_sale_transfer_history.percent, 100);
    const section22 = siteBuiltEditor.sections.find((section) => section.officialSectionNumber === 22);
    assert.equal(section22?.key, "sales_comparison");
    assert.equal(section22?.applicable, true);
    assert.equal(section22.groups.reduce((count, group) => count + group.fields.length, 0), 314);
    const salesComparable = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable"
      && entity.entity_identifier === "sales-comparable-1"
    ));
    const salesComparableSource = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_data_source"
      && entity.parent_entity_id === salesComparable?.id
    ));
    const salesComparableProjectAmenity = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_project_amenity"
      && entity.parent_entity_id === salesComparable?.id
    ));
    const salesComparableAmenity = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_amenity"
      && entity.parent_entity_id === salesComparable?.id
      && entity.data?.amenity_category === "OutdoorLiving"
    ));
    const salesComparableVehicleStorage = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_vehicle_storage"
      && entity.parent_entity_id === salesComparable?.id
    ));
    const salesComparableOutbuilding = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_outbuilding"
      && entity.parent_entity_id === salesComparable?.id
    ));
    const salesComparableOutbuildingRoom = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_outbuilding_room"
      && entity.parent_entity_id === salesComparableOutbuilding?.id
    ));
    const salesComparableInfluence = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_site_influence"
      && entity.parent_entity_id === salesComparable?.id
      && entity.entity_identifier === "sales-comparable-site-influence-1"
    ));
    const salesComparableWaterInfluence = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_site_influence"
      && entity.parent_entity_id === salesComparable?.id
      && entity.entity_identifier === "sales-comparable-site-influence-2"
    ));
    const salesComparableBodyOfWater = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_body_of_water"
      && entity.parent_entity_id === salesComparableWaterInfluence?.id
    ));
    const salesComparableWaterfrontFeature = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_waterfront_feature"
      && entity.parent_entity_id === salesComparableBodyOfWater?.id
    ));
    const salesComparableView = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_site_view"
      && entity.parent_entity_id === salesComparable?.id
    ));
    const salesComparableDwelling = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_dwelling"
      && entity.parent_entity_id === salesComparable?.id
    ));
    const salesComparableConstruction = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_construction_method"
      && entity.parent_entity_id === salesComparableDwelling?.id
    ));
    const salesComparableHeating = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_heating_system"
      && entity.parent_entity_id === salesComparableDwelling?.id
    ));
    const salesComparableCooling = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_cooling_system"
      && entity.parent_entity_id === salesComparableDwelling?.id
    ));
    const salesComparableRenewableEnergy = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_renewable_energy_component"
      && entity.parent_entity_id === salesComparable?.id
    ));
    const salesComparableGreenCertification = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_green_certification"
      && entity.parent_entity_id === salesComparable?.id
    ));
    const salesComparableEfficiencyRating = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_efficiency_rating"
      && entity.parent_entity_id === salesComparable?.id
    ));
    const salesComparableUnit = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_unit"
      && entity.parent_entity_id === salesComparableDwelling?.id
      && entity.entity_identifier === "sales-comparable-unit-1"
    ));
    const salesComparableAdu = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_unit"
      && entity.parent_entity_id === salesComparableDwelling?.id
      && entity.entity_identifier === "sales-comparable-adu-1"
    ));
    const salesComparableAccessibility = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparable_unit_accessibility_feature"
      && entity.parent_entity_id === salesComparableUnit?.id
    ));
    const salesComparableExteriorComponents = siteBuiltEditor.entities.filter((entity) => (
      entity.entity_type === "sales_comparable_exterior_component"
      && entity.parent_entity_id === salesComparableDwelling?.id
    ));
    const subjectWindows = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "dwelling_exterior_feature"
      && siteBuiltEditor.values.some((item) => (
        item.entity_id === entity.id
        && item.context_key === "dwelling_exterior_feature"
        && item.uid === "0300.0055"
        && item.value === "Windows"
      ))
    ));
    const subjectWindowsSummary = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparison_subject_exterior_quality_summary"
      && entity.parent_entity_id === subjectWindows?.id
    ));
    const salesComparableKitchens = siteBuiltEditor.entities.filter((entity) => (
      entity.entity_type === "sales_comparable_kitchen"
      && entity.parent_entity_id === salesComparableUnit?.id
    ));
    const salesComparableInteriorComponents = siteBuiltEditor.entities.filter((entity) => (
      entity.entity_type === "sales_comparable_interior_component"
      && entity.parent_entity_id === salesComparableUnit?.id
    ));
    const salesComparableAduKitchens = siteBuiltEditor.entities.filter((entity) => (
      entity.entity_type === "sales_comparable_kitchen"
      && entity.parent_entity_id === salesComparableAdu?.id
    ));
    const salesComparableAduInteriorComponents = siteBuiltEditor.entities.filter((entity) => (
      entity.entity_type === "sales_comparable_interior_component"
      && entity.parent_entity_id === salesComparableAdu?.id
    ));
    const subjectUnitInteriorSummary = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparison_subject_unit_interior_summary"
    ));
    const subjectKitchenSummary = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparison_subject_kitchen_summary"
    ));
    const subjectInteriorQualitySummaries = siteBuiltEditor.entities.filter((entity) => (
      entity.entity_type === "sales_comparison_subject_interior_quality_summary"
    ));
    const subjectInteriorConditionSummaries = siteBuiltEditor.entities.filter((entity) => (
      entity.entity_type === "sales_comparison_subject_interior_condition_summary"
    ));
    assert.ok(salesComparable);
    assert.ok(salesComparableSource);
    assert.ok(salesComparableProjectAmenity);
    assert.ok(salesComparableAmenity);
    assert.ok(salesComparableVehicleStorage);
    assert.ok(salesComparableOutbuilding);
    assert.ok(salesComparableOutbuildingRoom);
    assert.ok(salesComparableInfluence);
    assert.ok(salesComparableWaterInfluence);
    assert.ok(salesComparableBodyOfWater);
    assert.ok(salesComparableWaterfrontFeature);
    assert.ok(salesComparableView);
    assert.ok(salesComparableDwelling);
    assert.ok(salesComparableConstruction);
    assert.ok(salesComparableHeating);
    assert.ok(salesComparableCooling);
    assert.ok(salesComparableRenewableEnergy);
    assert.ok(salesComparableGreenCertification);
    assert.ok(salesComparableEfficiencyRating);
    assert.ok(salesComparableUnit);
    assert.ok(salesComparableAdu);
    assert.ok(salesComparableAccessibility);
    assert.equal(salesComparableExteriorComponents.length, 4);
    assert.ok(subjectWindows);
    assert.ok(subjectWindowsSummary);
    assert.equal(salesComparableKitchens.length, 1);
    assert.equal(salesComparableInteriorComponents.length, 2);
    assert.equal(salesComparableAduKitchens.length, 1);
    assert.equal(salesComparableAduInteriorComponents.length, 2);
    assert.ok(subjectUnitInteriorSummary);
    assert.ok(subjectKitchenSummary);
    assert.equal(subjectInteriorQualitySummaries.length, 2);
    assert.equal(subjectInteriorConditionSummaries.length, 1);
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_sale"
        && item.uid === "1800.0272"
      ))?.value,
      442500,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_summary"
        && item.uid === "1800.0313"
      ))?.value,
      0,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_summary"
        && item.uid === "1800.0309"
      ))?.value,
      442500,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_summary"
        && item.uid === "1800.0315"
      ))?.value,
      169,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_summary"
        && item.uid === "1800.0313"
      ))?.source_type,
      "calculated",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_summary"
        && item.uid === "1800.0312"
      ))?.value,
      "Most",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === null
        && item.context_key === "sales_comparison_summary"
        && item.uid === "1300.0006"
      ))?.value,
      445000,
    );
    const additionalAnalyzedProperty = siteBuiltEditor.entities.find((entity) => (
      entity.entity_type === "sales_comparison_additional_property"
      && entity.entity_identifier === "sales-comparison-additional-property-1"
    ));
    assert.ok(additionalAnalyzedProperty);
    assert.match(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === null
        && item.context_key === "sales_comparison_reconciliation"
        && item.uid === "1800.0278"
      ))?.value,
      /Most weight/,
    );
    assert.deepEqual(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === additionalAnalyzedProperty.id
        && item.context_key === "sales_comparison_additional_property"
        && item.uid === "1900.0011"
      ))?.value,
      ["Proximity", "DatedSale"],
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableSource.id
        && item.context_key === "sales_comparable_data_source"
        && item.uid === "1800.0347"
      ))?.value,
      "NTREIS-SYNTHETIC-22001",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_project"
        && item.uid === "1800.0353"
      ))?.value,
      125,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableProjectAmenity.id
        && item.context_key === "sales_comparable_project_amenity"
        && item.uid === "1800.0056"
      ))?.value,
      "Clubhouse",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableInfluence.id
        && item.context_key === "sales_comparable_site_influence"
        && item.uid === "1800.0233"
      ))?.value,
      "Residential",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableDwelling.id
        && item.context_key === "sales_comparable_dwelling"
        && item.uid === "1800.0128"
      ))?.value,
      "2004",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableConstruction.id
        && item.context_key === "sales_comparable_construction_method"
        && item.uid === "1800.0171"
      ))?.value,
      "SiteBuilt",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableHeating.id
        && item.context_key === "sales_comparable_heating_system"
        && item.uid === "1800.0165"
      ))?.value,
      "ForcedWarmAir",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableCooling.id
        && item.context_key === "sales_comparable_cooling_system"
        && item.uid === "1800.0161"
      ))?.value,
      "Centralized",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_energy_green"
        && item.uid === "1800.0108"
      ))?.value,
      true,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableRenewableEnergy.id
        && item.context_key === "sales_comparable_renewable_energy_component"
        && item.uid === "1800.0113"
      ))?.value,
      "Solar",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableGreenCertification.id
        && item.context_key === "sales_comparable_green_certification"
        && item.uid === "1800.0110"
      ))?.value,
      "NGBS Green",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableEfficiencyRating.id
        && item.context_key === "sales_comparable_efficiency_rating"
        && item.uid === "1800.0112"
      ))?.value,
      "62",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableUnit.id
        && item.context_key === "sales_comparable_unit"
        && item.uid === "1800.0330"
      ))?.value,
      3,
    );
    assert.deepEqual(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableUnit.id
        && item.context_key === "sales_comparable_unit"
        && item.uid === "1800.0390"
      ))?.value,
      { amount: 2050, unit: "SquareFeet" },
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableAccessibility.id
        && item.context_key === "sales_comparable_unit_accessibility_feature"
        && item.uid === "1800.0134"
      ))?.value,
      "None",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_property"
        && item.uid === "1800.0364"
      ))?.value,
      true,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_property"
        && item.uid === "1800.0197"
      ))?.value,
      "Q3",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_adjustment_overall_condition"
        && item.uid === "1800.0317"
      ))?.value,
      0,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableOutbuilding.id
        && item.context_key === "sales_comparable_outbuilding"
        && item.uid === "1800.0126"
      ))?.value,
      "Shed",
    );
    assert.deepEqual(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableOutbuilding.id
        && item.context_key === "sales_comparable_outbuilding"
        && item.uid === "1800.0387"
      ))?.value,
      { amount: 260, unit: "SquareFeet" },
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableOutbuildingRoom.id
        && item.context_key === "sales_comparable_outbuilding_room"
        && item.uid === "1800.0388"
      ))?.value,
      "Kitchen",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_adjustment_outbuilding"
        && item.uid === "1800.0317"
      ))?.value,
      0,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableVehicleStorage.id
        && item.context_key === "sales_comparable_vehicle_storage"
        && item.uid === "1800.0095"
      ))?.value,
      "Garage",
    );
    assert.deepEqual(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableVehicleStorage.id
        && item.context_key === "sales_comparable_vehicle_storage"
        && item.uid === "1800.0397"
      ))?.value,
      { amount: 480, unit: "SquareFeet" },
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_adjustment_vehicle_storage"
        && item.uid === "1800.0317"
      ))?.value,
      0,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableAmenity.id
        && item.context_key === "sales_comparable_amenity_outdoor_living"
        && item.uid === "1800.0258"
      ))?.value,
      "Deck",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparable.id
        && item.context_key === "sales_comparable_adjustment_outdoor_living_amenity"
        && item.uid === "1800.0317"
      ))?.value,
      0,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableDwelling.id
        && item.context_key === "sales_comparable_dwelling"
        && item.uid === "1800.0186"
      ))?.value,
      "Q3",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableAdu.id
        && item.context_key === "sales_comparable_unit"
        && item.uid === "1800.0287"
      ))?.value,
      true,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableAdu.id
        && item.context_key === "sales_comparable_unit"
        && item.uid === "1800.0158"
      ))?.value,
      "Q3",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableAduKitchens[0].id
        && item.context_key === "sales_comparable_kitchen"
        && item.uid === "1800.0327"
      ))?.value,
      "Typical compact kitchen finishes",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === subjectWindowsSummary.id
        && item.context_key === "sales_comparison_subject_exterior_quality_summary"
        && item.uid === "1800.0295"
      ))?.value,
      "Typical builder-grade vinyl double-pane windows",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableUnit.id
        && item.context_key === "sales_comparable_unit"
        && item.uid === "1800.0158"
      ))?.value,
      "Q3",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableKitchens[0].id
        && item.context_key === "sales_comparable_kitchen"
        && item.uid === "1800.0327"
      ))?.value,
      "Typical builder-grade cabinets and counters",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === subjectKitchenSummary.id
        && item.context_key === "sales_comparison_subject_kitchen_summary"
        && item.uid === "1800.0323"
      ))?.value,
      "Typical builder-grade cabinets and counters",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableBodyOfWater.id
        && item.context_key === "sales_comparable_site_influence"
        && item.uid === "1800.0279"
      ))?.value,
      true,
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableWaterfrontFeature.id
        && item.context_key === "sales_comparable_waterfront_feature"
        && item.uid === "1800.0230"
      ))?.value,
      "Dock",
    );
    assert.equal(
      siteBuiltEditor.values.find((item) => (
        item.entity_id === salesComparableView.id
        && item.context_key === "sales_comparable_site_view"
        && item.uid === "1800.0243"
      ))?.value,
      "Residential",
    );
    assert.ok(siteBuiltEditor.completion.sales_comparison.required > 0);
    assert.ok(siteBuiltEditor.completion.sales_comparison.percent < 100);
  } finally {
    await pool.end();
  }
});
