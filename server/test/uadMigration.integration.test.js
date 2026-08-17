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
  } finally {
    await pool.end();
  }
});
