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
  } finally {
    await pool.end();
  }
});
