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
  } finally {
    await pool.end();
  }
});
