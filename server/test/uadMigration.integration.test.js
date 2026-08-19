import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;

test("UAD foundation migration creates isolated schemas and seeded roles", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const schemas = await pool.query(`
      SELECT schema_name
        FROM information_schema.schemata
       WHERE schema_name IN ('app_auth', 'appraisal', 'uad_ref')
       ORDER BY schema_name
    `);
    assert.deepEqual(schemas.rows.map((row) => row.schema_name), ["app_auth", "appraisal", "uad_ref"]);

    const roles = await pool.query("SELECT code FROM app_auth.roles ORDER BY code");
    assert.deepEqual(roles.rows.map((row) => row.code), [
      "appraiser",
      "homenode_admin",
      "organization_admin",
      "reviewer",
      "supervisory_appraiser",
    ]);

    const release = await pool.query(
      "SELECT status FROM uad_ref.specification_releases WHERE release_key = $1",
      ["uad-3.6-2026-08-13-h1.5"],
    );
    assert.equal(release.rows[0]?.status, "current");

    const tableCount = await pool.query(`
      SELECT count(*)::integer AS count
        FROM information_schema.tables
       WHERE table_schema IN ('app_auth', 'appraisal', 'uad_ref')
         AND table_type = 'BASE TABLE'
    `);
    assert.ok(tableCount.rows[0].count >= 20);

    const contextColumn = await pool.query(`
      SELECT is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'appraisal'
         AND table_name = 'uad_field_values'
         AND column_name = 'field_context'
    `);
    assert.equal(contextColumn.rows[0]?.is_nullable, "NO");

    const phaseOneFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number IN (2, 3)
    `);
    assert.ok(phaseOneFields.rows[0].count >= 50);

    const siteFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 4
    `);
    assert.ok(siteFields.rows[0].count >= 50);

    const siteRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-SITE-%'
    `);
    assert.equal(siteRules.rows[0].count, 2);

    const sketchFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 7
    `);
    assert.ok(sketchFields.rows[0].count >= 12);

    const sketchRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (rule_id IN ('UAD1676', 'UAD1677', 'UAD1678') OR rule_id LIKE 'HN-UAD-SKETCH-%')
    `);
    assert.equal(sketchRules.rows[0].count, 5);

    const dwellingExteriorFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 8
    `);
    assert.ok(dwellingExteriorFields.rows[0].count >= 70);

    const dwellingExteriorRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (rule_id IN ('UAD1048', 'UAD1050', 'UAD1060', 'UAD1687') OR rule_id LIKE 'HN-UAD-DWELLING-%')
    `);
    assert.equal(dwellingExteriorRules.rows[0].count, 8);

    const manufacturedHomeFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 9
    `);
    assert.ok(manufacturedHomeFields.rows[0].count >= 40);

    const manufacturedHomeRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (
           rule_id IN ('UAD1100', 'UAD1101', 'UAD1102', 'UAD1284', 'UAD1285', 'UAD1721')
           OR rule_id LIKE 'HN-UAD-MH-%'
         )
    `);
    assert.equal(manufacturedHomeRules.rows[0].count, 12);

    const unitInteriorFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 10
    `);
    assert.ok(unitInteriorFields.rows[0].count >= 75);

    const unitInteriorRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-UNIT-%'
    `);
    assert.equal(unitInteriorRules.rows[0].count, 8);

    const officialUnitInteriorRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1138', 'UAD1139', 'UAD1140', 'UAD1141', 'UAD1142', 'UAD1143',
           'UAD1144', 'UAD1145', 'UAD1146', 'UAD1147', 'UAD1148', 'UAD1149',
           'UAD1150', 'UAD1151', 'UAD1152', 'UAD1153', 'UAD1154', 'UAD1155',
           'UAD1156', 'UAD1157', 'UAD1158', 'UAD1160', 'UAD1161', 'UAD1162',
           'UAD1163', 'UAD1164', 'UAD1165', 'UAD1166', 'UAD1167', 'UAD1168',
           'UAD1169', 'UAD1170', 'UAD1171', 'UAD1173', 'UAD1174', 'UAD1175',
           'UAD1176', 'UAD1177', 'UAD1178', 'UAD1182', 'UAD1184', 'UAD1185',
           'UAD1186', 'UAD1187', 'UAD1188', 'UAD1189', 'UAD1190', 'UAD1484',
           'UAD1688', 'UAD1694', 'UAD1730', 'UAD1764'
         )
    `);
    assert.equal(officialUnitInteriorRules.rows[0].count, 52);

    const functionalObsolescenceFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 11
    `);
    assert.equal(functionalObsolescenceFields.rows[0].count, 4);

    const functionalObsolescenceRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (rule_id IN ('UAD1680', 'UAD1681') OR rule_id LIKE 'HN-UAD-FUNCTIONAL-%')
    `);
    assert.equal(functionalObsolescenceRules.rows[0].count, 4);

    const outbuildingFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 12
    `);
    assert.equal(outbuildingFields.rows[0].count, 36);

    const officialOutbuildingRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1047', 'UAD1055', 'UAD1056', 'UAD1057', 'UAD1058', 'UAD1059',
           'UAD1083', 'UAD1084', 'UAD1089', 'UAD1094', 'UAD1095', 'UAD1096',
           'UAD1103', 'UAD1692'
         )
    `);
    assert.equal(officialOutbuildingRules.rows[0].count, 14);

    const homeNodeOutbuildingRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-OUTBUILDING-%'
    `);
    assert.equal(homeNodeOutbuildingRules.rows[0].count, 8);

    const vehicleStorageFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 13
    `);
    assert.equal(vehicleStorageFields.rows[0].count, 18);

    const officialVehicleStorageRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1664', 'UAD1665', 'UAD1667', 'UAD1668', 'UAD1669', 'UAD1670',
           'UAD1671', 'UAD1672', 'UAD1673', 'UAD1675', 'UAD1686', 'UAD1736'
         )
    `);
    assert.equal(officialVehicleStorageRules.rows[0].count, 12);

    const homeNodeVehicleStorageRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-VEHICLE-STORAGE-%'
    `);
    assert.equal(homeNodeVehicleStorageRules.rows[0].count, 6);

    const unscaffoldedVehicleStorageWorkfiles = await pool.query(`
      SELECT count(*)::integer AS count
        FROM appraisal.uad_workfiles workfile
       WHERE NOT EXISTS (
         SELECT 1
           FROM appraisal.uad_entities entity
          WHERE entity.workfile_id = workfile.id
            AND entity.entity_type = 'vehicle_storage'
       )
    `);
    assert.equal(unscaffoldedVehicleStorageWorkfiles.rows[0].count, 0);

    const subjectAmenityFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 14
    `);
    assert.equal(subjectAmenityFields.rows[0].count, 48);

    const officialSubjectAmenityRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1045', 'UAD1046', 'UAD1685', 'UAD1739')
    `);
    assert.equal(officialSubjectAmenityRules.rows[0].count, 4);

    const homeNodeSubjectAmenityRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-SUBJECT-AMENITIES-%'
    `);
    assert.equal(homeNodeSubjectAmenityRules.rows[0].count, 8);

    const overallQualityConditionFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 15
    `);
    assert.equal(overallQualityConditionFields.rows[0].count, 3);

    const overallQualityConditionLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 15
    `);
    assert.equal(overallQualityConditionLocations.rows[0].count, 11);
    assert.equal(overallQualityConditionLocations.rows[0].redisplay_count, 8);

    const officialOverallQualityConditionRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1384', 'UAD1385', 'UAD1387')
    `);
    assert.equal(officialOverallQualityConditionRules.rows[0].count, 3);

    const homeNodeOverallQualityConditionRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-OVERALL-QC-%'
    `);
    assert.equal(homeNodeOverallQualityConditionRules.rows[0].count, 3);

    const highestBestUseFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 16
    `);
    assert.equal(highestBestUseFields.rows[0].count, 8);

    const highestBestUseLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (
           section_number = 16
           OR metadata->>'source_report_field_id' = '16.004'
         )
    `);
    assert.equal(highestBestUseLocations.rows[0].count, 9);
    assert.equal(highestBestUseLocations.rows[0].redisplay_count, 1);

    const officialHighestBestUseRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1659', 'UAD1660', 'UAD1661', 'UAD1662', 'UAD1663')
    `);
    assert.equal(officialHighestBestUseRules.rows[0].count, 5);

    const homeNodeHighestBestUseRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-HIGHEST-BEST-USE-%'
    `);
    assert.equal(homeNodeHighestBestUseRules.rows[0].count, 2);

    const marketFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 17
    `);
    assert.equal(marketFields.rows[0].count, 21);

    const marketLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 17
    `);
    assert.equal(marketLocations.rows[0].count, 24);
    assert.equal(marketLocations.rows[0].redisplay_count, 3);

    const officialMarketRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1626', 'UAD1627', 'UAD1629', 'UAD1630', 'UAD1631', 'UAD1632',
           'UAD1633', 'UAD1634', 'UAD1635', 'UAD1636', 'UAD1639', 'UAD1642',
           'UAD1643', 'UAD1644', 'UAD1645', 'UAD1646', 'UAD1647', 'UAD1648',
           'UAD1652', 'UAD1653', 'UAD1656', 'UAD1657'
         )
    `);
    assert.equal(officialMarketRules.rows[0].count, 22);

    const homeNodeMarketRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-MARKET-%'
    `);
    assert.equal(homeNodeMarketRules.rows[0].count, 5);

    const projectInformationFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 18
    `);
    assert.equal(projectInformationFields.rows[0].count, 95);

    const projectInformationLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 18
    `);
    assert.ok(projectInformationLocations.rows[0].count >= 90);
    assert.ok(projectInformationLocations.rows[0].redisplay_count >= 7);

    const officialProjectInformationRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (
           rule_id BETWEEN 'UAD1568' AND 'UAD1615'
           OR rule_id IN ('UAD1727', 'UAD1741')
         )
    `);
    assert.equal(officialProjectInformationRules.rows[0].count, 50);

    const homeNodeProjectInformationRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-PROJECT-%'
    `);
    assert.equal(homeNodeProjectInformationRules.rows[0].count, 4);

    const subjectListingFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 19
    `);
    assert.equal(subjectListingFields.rows[0].count, 21);

    const subjectListingLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 19
    `);
    assert.equal(subjectListingLocations.rows[0].count, 16);
    assert.equal(subjectListingLocations.rows[0].redisplay_count, 0);

    const officialSubjectListingRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1203', 'UAD1204', 'UAD1205', 'UAD1206',
           'UAD1207', 'UAD1208', 'UAD1209', 'UAD1725', 'UAD1726'
         )
    `);
    assert.equal(officialSubjectListingRules.rows[0].count, 9);

    const homeNodeSubjectListingRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-SUBJECT-LISTING-%'
    `);
    assert.equal(homeNodeSubjectListingRules.rows[0].count, 4);

    const salesContractFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 20
    `);
    assert.equal(salesContractFields.rows[0].count, 17);

    const salesContractLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (section_number = 20 OR (
           property_context = 'sales_contract' AND report_field_id IN (
             '1.007', '22.01.04', '22.15.03', '26.006', '22.01.05', '22.01.06'
           )
         ))
    `);
    assert.equal(salesContractLocations.rows[0].count, 24);
    assert.equal(salesContractLocations.rows[0].redisplay_count, 8);

    const officialSalesContractRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1127', 'UAD1128', 'UAD1129', 'UAD1130', 'UAD1131', 'UAD1132',
           'UAD1133', 'UAD1134', 'UAD1135', 'UAD1136', 'UAD1728'
         )
    `);
    assert.equal(officialSalesContractRules.rows[0].count, 11);

    const homeNodeSalesContractRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-SALES-CONTRACT-%'
    `);
    assert.equal(homeNodeSalesContractRules.rows[0].count, 4);

    const priorTransferFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 21
    `);
    assert.equal(priorTransferFields.rows[0].count, 45);

    const priorTransferLocations = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 21
    `);
    assert.equal(priorTransferLocations.rows[0].count, 29);

    const officialPriorTransferRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1191', 'UAD1192', 'UAD1193', 'UAD1194', 'UAD1195', 'UAD1196',
           'UAD1197', 'UAD1198', 'UAD1199', 'UAD1200', 'UAD1201', 'UAD1202',
           'UAD1431', 'UAD1432', 'UAD1436', 'UAD1439', 'UAD1440', 'UAD1442',
           'UAD1444', 'UAD1698', 'UAD1734', 'UAD1735', 'UAD1744'
         )
    `);
    assert.equal(officialPriorTransferRules.rows[0].count, 23);

    const homeNodePriorTransferRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-PRIOR-TRANSFER-%'
    `);
    assert.equal(homeNodePriorTransferRules.rows[0].count, 4);

    const priorTransferEntityConstraint = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'uad_entities_entity_type_check'
         AND conrelid = 'appraisal.uad_entities'::regclass
    `);
    assert.match(priorTransferEntityConstraint.rows[0].definition, /subject_prior_transfer/);
    assert.match(priorTransferEntityConstraint.rows[0].definition, /comparable_prior_transfer_data_source/);

    const salesComparisonFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 22
    `);
    assert.equal(salesComparisonFields.rows[0].count, 165);

    const salesComparisonLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 22
    `);
    // Earlier source-section migrations plus Sections 22A-22D provide the
    // canonical comparable/grid locations and their subject redisplays.
    assert.equal(salesComparisonLocations.rows[0].count, 174);
    assert.equal(salesComparisonLocations.rows[0].redisplay_count, 55);

    const officialSalesComparisonRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1218', 'UAD1275', 'UAD1390', 'UAD1391', 'UAD1392', 'UAD1393',
           'UAD1394', 'UAD1395', 'UAD1396', 'UAD1397', 'UAD1402', 'UAD1403',
           'UAD1404', 'UAD1428', 'UAD1433', 'UAD1469', 'UAD1477', 'UAD1481',
           'UAD1731', 'UAD1771', 'UAD1773'
         )
    `);
    assert.equal(officialSalesComparisonRules.rows[0].count, 21);

    const officialSalesComparisonSiteRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1398', 'UAD1399', 'UAD1400', 'UAD1401', 'UAD1445', 'UAD1446',
           'UAD1447', 'UAD1448', 'UAD1449', 'UAD1450', 'UAD1451', 'UAD1452',
           'UAD1476', 'UAD1769', 'UAD1770'
         )
    `);
    assert.equal(officialSalesComparisonSiteRules.rows[0].count, 15);

    const officialSalesComparisonWaterRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id = 'UAD1462'
    `);
    assert.equal(officialSalesComparisonWaterRules.rows[0].count, 1);

    const officialSubjectWaterRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1278', 'UAD1333', 'UAD1335', 'UAD1336',
           'UAD1337', 'UAD1338', 'UAD1339', 'UAD1340'
         )
    `);
    assert.equal(officialSubjectWaterRules.rows[0].count, 8);

    const homeNodeSalesComparisonRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-SALES-COMPARISON-%'
    `);
    assert.equal(homeNodeSalesComparisonRules.rows[0].count, 18);

    const salesComparisonEntityConstraint = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'uad_entities_entity_type_check'
         AND conrelid = 'appraisal.uad_entities'::regclass
    `);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_data_source/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_right_not_included/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_project_amenity/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_site_influence/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_body_of_water/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_waterfront_feature/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /site_body_of_water/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /site_waterfront_feature/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_site_view/);
  } finally {
    await pool.end();
  }
});
