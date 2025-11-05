/* eslint-disable no-console */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// --- CORS ---
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim());
app.use(cors({ origin: corsOrigins, credentials: false }));
app.use(express.json());

// --- DB ---
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required, e.g. postgresql://postgres:postgres@127.0.0.1:5432/mooolah_inc');
  process.exit(1);
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : false
});

// --- utils ---
function isAccountId(q) {
  const s = String(q || '').trim();
  return /^[0-9A-Za-z]{17}$/.test(s);
}

// --- health ---
app.get('/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok;');
    res.json({ ok: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/search?q=&limit=
 * - If q looks like a 17-char account_id, search by account_id
 * - Otherwise, search address case-insensitively
 * Returns: account basics + latest market value snapshot
 */
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(parseInt(String(req.query.limit || '25'), 10) || 25, 200);

  if (!q) return res.status(400).json({ error: 'Missing q' });

  const byId = isAccountId(q);
  const params = [];
  let where = 'TRUE';

  if (byId) {
    params.push(q);
    where = 'a.account_id = $1';
  } else {
    params.push(`%${q}%`);
    where = 'a.address ILIKE $1';
  }
  params.push(limit);

  const sql = `
    SELECT
      a.account_id,
      a.address,
      a.county,
      a.neighborhood_code,
      a.subdivision,
      a.legal_description,
      mv.tax_year   AS latest_tax_year,
      mv.total_value AS latest_market_value,
      mv.imp_value   AS latest_improvement_value,
      mv.land_value  AS latest_land_value,
      mv.homestead_cap_value AS latest_capped_value
    FROM core.accounts a
    LEFT JOIN LATERAL (
      SELECT tax_year, total_value, imp_value, land_value, homestead_cap_value
      FROM core.market_values mv
      WHERE mv.account_id = a.account_id
      ORDER BY tax_year DESC
      LIMIT 1
    ) mv ON TRUE
    WHERE ${where}
    ORDER BY a.account_id
    LIMIT $${params.length};
  `;

  try {
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/accounts/:id
 * Returns account basics + latest market values + primary improvements
 */
app.get('/api/accounts/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!isAccountId(id)) return res.status(400).json({ error: 'Invalid account_id' });

  const detailSql = `
    SELECT
      a.account_id, a.address, a.county, a.neighborhood_code, a.subdivision, a.legal_description,
      mv.tax_year   AS latest_tax_year,
      mv.total_value AS latest_market_value,
      mv.imp_value   AS latest_improvement_value,
      mv.land_value  AS latest_land_value,
      mv.homestead_cap_value AS latest_capped_value
    FROM core.accounts a
    LEFT JOIN LATERAL (
      SELECT tax_year, total_value, imp_value, land_value, homestead_cap_value
      FROM core.market_values mv
      WHERE mv.account_id = a.account_id
      ORDER BY tax_year DESC
      LIMIT 1
    ) mv ON TRUE
    WHERE a.account_id = $1;
  `;

  const improvSql = `
    SELECT
      construction_type, percent_complete, year_built, effective_year_built, actual_age,
      depreciation, desirability, stories, living_area_sqft, total_living_area, bedroom_count,
      bath_count, basement, kitchens, wetbars, fireplaces, sprinkler, spa, pool, sauna,
      air_conditioning, heating, foundation, roof_material, roof_type, exterior_material,
      fence_type, number_units
    FROM core.primary_improvements
    WHERE account_id = $1;
  `;

  try {
    const [detail, improv] = await Promise.all([
      pool.query(detailSql, [id]),
      pool.query(improvSql, [id]),
    ]);
    if (detail.rows.length === 0) return res.status(404).json({ error: 'Account not found' });

    res.json({
      account: detail.rows[0],
      primary_improvements: improv.rows[0] || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
