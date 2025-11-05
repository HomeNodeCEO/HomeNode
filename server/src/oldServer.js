import "dotenv/config";
import express from "express";
import cors from "cors";
import pg from "pg";
import { parseClassFilter } from "./util/parseClasses.js";

const app = express();
app.use(express.json());
// Support comma-separated list in CORS_ORIGIN env (e.g. "http://localhost:5173,http://127.0.0.1:5173")
const corsEnv = process.env.CORS_ORIGIN;
const corsOrigins = !corsEnv
  ? true
  : corsEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
app.use(cors({ origin: corsOrigins }));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// simple health
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * GET /api/accounts/:id
 * Returns an object compatible with the frontend's AccountDetail shape:
 *   { account: AccountRow, primary_improvements: {...} }
 */
app.get("/api/accounts/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "missing_id" });
  try {
    const accountSql = `
      SELECT
        a.account_id,
        a.address,
        a.county,
        a.neighborhood_code,
        a.subdivision,
        a.legal_description,
        COALESCE(vsc.certified_year, mv.tax_year)                 AS latest_tax_year,
        COALESCE(vsc.market_value, mv.total_value)                AS latest_market_value,
        COALESCE(vsc.improvement_value, mv.imp_value)             AS latest_improvement_value,
        COALESCE(vsc.land_value, mv.land_value)                   AS latest_land_value,
        COALESCE(vsc.capped_value, mv.homestead_cap_value)        AS latest_capped_value
      FROM core.accounts a
      LEFT JOIN core.value_summary_current vsc ON vsc.account_id = a.account_id
      LEFT JOIN LATERAL (
        SELECT m.* FROM core.market_values m
        WHERE m.account_id = a.account_id
        ORDER BY m.tax_year DESC
        LIMIT 1
      ) mv ON TRUE
      WHERE a.account_id = $1
    `;
    const { rows: accRows } = await pool.query(accountSql, [id]);
    if (!accRows.length) return res.status(404).json({ error: "not_found" });

    const impSql = `
      SELECT
        construction_type,
        percent_complete,
        year_built,
        effective_year_built,
        actual_age,
        depreciation,
        desirability,
        stories,
        living_area_sqft,
        total_living_area,
        bedroom_count,
        bath_count,
        basement,
        kitchens,
        wetbars,
        fireplaces,
        sprinkler,
        spa,
        pool,
        sauna,
        air_conditioning,
        heating,
        foundation,
        roof_material,
        roof_type,
        exterior_material,
        fence_type,
        number_units,
        building_class,
        total_area_sqft,
        baths_full,
        baths_half
      FROM core.primary_improvements WHERE account_id = $1
    `;
    const { rows: impRows } = await pool.query(impSql, [id]);

    // Latest owner summary (mailing + name)
    const ownerSql = `
      SELECT owner_name, mailing_address, tax_year
      FROM core.owner_summary
      WHERE account_id = $1
      ORDER BY tax_year DESC
      LIMIT 1
    `;
    const { rows: ownerRows } = await pool.query(ownerSql, [id]);

    // Current legal description info (deed date, lines/text)
    const legalSql = `
      SELECT tax_year, legal_lines, legal_text, deed_transfer_date
      FROM core.legal_description_current
      WHERE account_id = $1
      LIMIT 1
    `;
    const { rows: legalRows } = await pool.query(legalSql, [id]);
    const legalHistSql = `
      SELECT tax_year, legal_lines, legal_text, deed_transfer_date
      FROM core.legal_description_history
      WHERE account_id = $1 AND deed_transfer_date IS NOT NULL
      ORDER BY tax_year DESC
      LIMIT 1
    `;
    const { rows: legalHistRows } = await pool.query(legalHistSql, [id]);

    // Exemptions summary (latest year) to determine homestead
    const exSql = `
      SELECT tax_year, jurisdiction_key, taxing_jurisdiction, homestead_exemption, disabled_vet, taxable_value
      FROM core.exemptions_summary
      WHERE account_id = $1
      ORDER BY tax_year DESC
    `;
    const { rows: exRowsAll } = await pool.query(exSql, [id]);
    let exRows = [];
    let exYear = null;
    let homesteadYes = false;
    if (exRowsAll && exRowsAll.length) {
      exYear = exRowsAll[0].tax_year;
      exRows = exRowsAll.filter((r) => r.tax_year === exYear);
      homesteadYes = exRows.some((r) => Number(r.homestead_exemption || 0) > 0);
    }

    // Land detail for latest tax year
    let landRows = [];
    try {
      const landYearSql = `SELECT MAX(tax_year) AS y FROM core.land_detail WHERE account_id = $1`;
      const { rows: yRows } = await pool.query(landYearSql, [id]);
      const y = yRows?.[0]?.y;
      if (y) {
        const landSql = `
          SELECT line_number AS number,
                 state_code,
                 zoning,
                 frontage_ft,
                 depth_ft,
                 area_sqft,
                 pricing_method,
                 unit_price,
                 market_adjustment_pct,
                 adjusted_price,
                 ag_land
          FROM core.land_detail
          WHERE account_id = $1 AND tax_year = $2
          ORDER BY line_number
        `;
        const { rows } = await pool.query(landSql, [id, y]);
        landRows = rows || [];
      }
    } catch (e) {
      console.error('land_detail query failed', e);
    }
    const resp = {
      account: accRows[0],
      primary_improvements: impRows[0] || null,
      owner_summary: ownerRows[0] || null,
      legal_current: legalRows[0] || null,
      legal_history: legalHistRows[0] || null,
      exemptions_summary_year: exYear,
      exemptions_summary: exRows,
      homestead_yes: homesteadYes,
      land_detail: landRows,
      // Secondary improvements (all rows for account)
      additional_improvements: []
    };

    // Fetch secondary improvements
    try {
      const secSql = `
        SELECT
          sec_imp_number   AS number,
          sec_imp_type     AS improvement_type,
          sec_imp_cons_type AS construction,
          sec_imp_floor    AS floor,
          sec_imp_ext_wall AS exterior_wall,
          sec_imp_sqft     AS area_sqft,
          sec_imp_value    AS value,
          sec_imp_year_built AS year_built
        FROM core.secondary_improvements
        WHERE account_id = $1
        ORDER BY sec_imp_number NULLS LAST, id
      `;
      const { rows: secRows } = await pool.query(secSql, [id]);
      resp.additional_improvements = secRows || [];
    } catch (e) {
      console.error('secondary_improvements query failed', e);
    }
    res.json(resp);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "accounts_failed" });
  }
});

/**
 * GET /api/search?q=&limit=&offset=
 * Simple search by address (ILIKE) or exact 17-char account_id.
 * Returns an array of AccountRow objects for the frontend.
 */
app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(parseInt(String(req.query.limit || "25"), 10) || 25, 100);
    const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);

    if (!q) return res.json([]);

    const isExactId = /^\d{17}$/.test(q);
    const params = [];
    let where = "";
    if (isExactId) {
      where = `a.account_id = $${params.push(q)}`;
    } else {
      where = `a.address ILIKE $${params.push('%' + q.replace(/%/g, '').replace(/_/g, '') + '%')}`;
    }

    const sql = `
      SELECT
        a.account_id,
        a.address,
        a.county,
        a.neighborhood_code,
        a.subdivision,
        a.legal_description,
        COALESCE(vsc.certified_year, mv.tax_year)                 AS latest_tax_year,
        COALESCE(vsc.market_value, mv.total_value)                AS latest_market_value,
        COALESCE(vsc.improvement_value, mv.imp_value)             AS latest_improvement_value,
        COALESCE(vsc.land_value, mv.land_value)                   AS latest_land_value,
        COALESCE(vsc.capped_value, mv.homestead_cap_value)        AS latest_capped_value
      FROM core.accounts a
      LEFT JOIN core.value_summary_current vsc ON vsc.account_id = a.account_id
      LEFT JOIN LATERAL (
        SELECT m.* FROM core.market_values m
        WHERE m.account_id = a.account_id
        ORDER BY m.tax_year DESC
        LIMIT 1
      ) mv ON TRUE
      WHERE ${where}
      ORDER BY a.account_id
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "search_failed" });
  }
});

/**
 * Helper to build WHERE for classes (numeric ranges + labels).
 * Returns { whereSql, params } pieces to plug into the main query.
 */
function buildClassWhere({ classes, county, neighborhoods }) {
  const { exact, lows, highs, labels } = parseClassFilter(String(classes || ""));
  const counties = String(county || "").split(",").map(s => s.trim()).filter(Boolean);
  const nbhds   = String(neighborhoods || "").split(",").map(s => s.trim()).filter(Boolean);

  const where = [];
  const params = [];

  // Build the class OR-group
  const classParts = [];
  if (exact.length || lows.length || highs.length) {
    classParts.push(
      `matches_classes_lohi(c.building_class_int, $${params.push(exact)}::int[], $${params.push(lows)}::int[], $${params.push(highs)}::int[])`
    );
  }
  if (labels.length) {
    classParts.push(`UPPER(c.building_class) = ANY($${params.push(labels.map(l => l.toUpperCase()))}::text[])`);
  }
  if (classParts.length) where.push(`(${classParts.join(" OR ")})`);

  if (counties.length) where.push(`p.county = ANY($${params.push(counties)}::text[])`);
  if (nbhds.length)    where.push(`p.neighborhood_code = ANY($${params.push(nbhds)}::text[])`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, params };
}

/**
 * GET /api/properties/search
 * Query:
 *   - classes: e.g. "14" or "7,12,25; 2-3; 5-6" or "CONDOMINIUM; LAND ONLY"
 *   - limit: number (default 100, max 1000)
 *   - county, neighborhoods: optional comma-separated lists
 */
app.get("/api/properties/search", async (req, res) => {
  try {
    const { classes = "", limit = "100", county = "", neighborhoods = "" } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 100, 1000);

    const { whereSql, params } = buildClassWhere({ classes, county, neighborhoods });

    // If literally no filters, you can choose to return an error or everything. We’ll just return first N.
    const sql = `
      SELECT p.account_id, p.county, p.situs_address,
             c.building_class, c.building_class_int
      FROM properties p
      JOIN primary_building_class c USING (account_id)
      ${whereSql}
      ORDER BY p.account_id
      LIMIT $${params.push(lim)}
    `;

    const { rows } = await pool.query(sql, params);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "query_failed" });
  }
});

/**
 * GET /api/stats/class-distribution
 * Same filters as /search; returns grouped counts by class label & code.
 */
app.get("/api/stats/class-distribution", async (req, res) => {
  try {
    const { classes = "", county = "", neighborhoods = "" } = req.query;
    const { whereSql, params } = buildClassWhere({ classes, county, neighborhoods });

    const sql = `
      SELECT
        c.building_class       AS class_label,
        c.building_class_int   AS class_code_int,
        COUNT(*)::bigint       AS n
      FROM properties p
      JOIN primary_building_class c USING (account_id)
      ${whereSql}
      GROUP BY c.building_class, c.building_class_int
      ORDER BY n DESC, class_label NULLS LAST
    `;

    const { rows } = await pool.query(sql, params);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "stats_failed" });
  }
});

const port = parseInt(process.env.PORT || "4000", 10);
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
