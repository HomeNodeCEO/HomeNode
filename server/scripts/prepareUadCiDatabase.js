import "dotenv/config";
import pg from "pg";

if (process.env.NODE_ENV !== "test") {
  throw new Error("prepareUadCiDatabase may only run with NODE_ENV=test");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const identity = await pool.query("SELECT current_database() AS database_name");
  if (!String(identity.rows[0].database_name).endsWith("_test")) {
    throw new Error("CI database name must end with _test");
  }
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE TABLE IF NOT EXISTS core.accounts (
      account_id text PRIMARY KEY,
      county text,
      address text,
      city text,
      postal_code text,
      neighborhood_code text,
      subdivision text,
      legal_description text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS core.account_locations (
      account_id text PRIMARY KEY REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      latitude double precision,
      longitude double precision,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      location_geom geometry(Point, 4326)
    );
    CREATE TABLE IF NOT EXISTS core.primary_improvements (
      account_id text PRIMARY KEY REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      year_built integer,
      living_area_sqft integer,
      bedroom_count integer,
      bath_count numeric,
      number_units integer
    );
    CREATE TABLE IF NOT EXISTS core.land_detail (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      tax_year integer NOT NULL,
      line_number integer NOT NULL,
      area_sqft numeric
    );
    CREATE TABLE IF NOT EXISTS core.secondary_improvements (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      sec_imp_number integer,
      sec_imp_type text,
      sec_imp_sqft integer
    );
  `);
  console.log(JSON.stringify({ prepared: true, database: identity.rows[0].database_name }));
} finally {
  await pool.end();
}
