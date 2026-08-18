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
  } finally {
    await pool.end();
  }
});
