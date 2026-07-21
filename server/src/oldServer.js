import "dotenv/config";
import express from "express";
import cors from "cors";
import pg from "pg";
import nodemailer from "nodemailer";
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

// Ensure a simple signups table exists (no external migrations required)
async function ensureSignupsTable() {
  const ddl = `
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE TABLE IF NOT EXISTS app.signups (
      id            bigserial PRIMARY KEY,
      created_at    timestamptz NOT NULL DEFAULT now(),
      source        text,
      account_id    text,
      owner_name    text NOT NULL,
      owner_telephone text NOT NULL,
      owner_email   text,
      user_agent    text,
      ip            text,
      meta          jsonb
    );
  `;
  try {
    await pool.query(ddl);
    console.log("[init] app.signups ensured");
  } catch (e) {
    console.warn("[init] ensureSignupsTable failed (continuing)", e?.message || e);
  }
}
void ensureSignupsTable();

// simple health
app.get("/health", (_req, res) => res.json({ ok: true }));

// SMTP status (non-sensitive): helps verify Render env is set correctly
app.get("/api/signup/smtp-status", (_req, res) => {
  const usingUrl = Boolean(process.env.SMTP_URL || process.env.SMTP_CONNECTION_URL);
  const hasHost = Boolean(process.env.SMTP_HOST);
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : null;
  const secure = process.env.SMTP_SECURE === "1" || process.env.SMTP_SECURE === "true";
  const hasUser = Boolean(process.env.SMTP_USER);
  const hasPass = Boolean(process.env.SMTP_PASS);
  const fromSet = Boolean(process.env.MAIL_FROM || process.env.SMTP_FROM);
  const cors = process.env.CORS_ORIGIN || process.env.CORS_ORIGINS || null;
  const configured = usingUrl || hasHost;
  res.json({
    ok: true,
    smtp: {
      configured,
      using_url: usingUrl,
      has_host: hasHost,
      port,
      secure,
      has_user: hasUser,
      has_pass: hasPass,
      from_set: fromSet,
    },
    cors_origin: cors,
  });
});

// Lightweight email submission endpoint for Sign Up form
// Expects JSON: { ownerName: string, ownerTelephone: string, accountId?: string }
app.post("/api/signup/email", async (req, res) => {
  try {
    const { ownerName, ownerTelephone, accountId } = req.body || {};
    if (!ownerName || !ownerTelephone) {
      return res.status(400).json({ error: "missing_owner_fields" });
    }

    // Configure transporter from env. Prefer SMTP_URL if provided; otherwise fall back to host/port/user/pass.
    const smtpUrl = process.env.SMTP_URL || process.env.SMTP_CONNECTION_URL;
    let transporter;
    if (smtpUrl) {
      transporter = nodemailer.createTransport(smtpUrl);
    } else if (process.env.SMTP_HOST) {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        secure: process.env.SMTP_SECURE === "1" || process.env.SMTP_SECURE === "true",
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
      });
    }

    const to = "homenodeceo@gmail.com";
    const subject = `New Enrollment Submission${accountId ? ` - ${accountId}` : ""}`;
    const text = `A new enrollment was submitted.\n\nOwner Name: ${ownerName}\nTelephone: ${ownerTelephone}\n${accountId ? `Account ID: ${accountId}\n` : ""}`;

    // Persist signup in DB regardless of email status
    let id = null;
    try {
      const ua = req.headers["user-agent"] || null;
      const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.ip || null;
      const meta = { referer: req.headers.referer || null };
      const { rows } = await pool.query(
        `INSERT INTO app.signups (source, account_id, owner_name, owner_telephone, owner_email, user_agent, ip, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          "web-signup",
          accountId || null,
          ownerName,
          ownerTelephone,
          (req.body && req.body.ownerEmail) || null,
          ua,
          ip,
          meta,
        ]
      );
      id = rows?.[0]?.id ?? null;
    } catch (e) {
      console.error("[signup] DB insert failed", e);
      // Continue to try email even if DB failed
    }

    // Try to send email if SMTP is configured; do not fail the request if mail fails
    let emailSent = false;
    let emailError = null;
    if (transporter) {
      try {
        await transporter.sendMail({
          to,
          from: process.env.MAIL_FROM || process.env.SMTP_FROM || "no-reply@homenode",
          subject,
          text,
        });
        emailSent = true;
      } catch (e) {
        emailError = e?.message || String(e);
      }
    }

    // Always return success for the signup capture; include email status for transparency
    res.json({ ok: true, id, email_sent: emailSent, email_error: emailError });
  } catch (err) {
    const msg = err?.message || "unknown_error";
    const code = err?.code || null;
    const responseCode = err?.responseCode || null;
    const command = err?.command || null;
    console.error("/api/signup/email failed", { message: msg, code, responseCode, command });
    res.status(500).json({ error: "email_failed", message: msg, code, responseCode, command });
  }
});

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
        COALESCE(NULLIF(BTRIM(a.address), ''), raw_loc.address) AS address,
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
      LEFT JOIN LATERAL (
        SELECT COALESCE(
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
               ) AS address
        FROM core.dcad_json_raw r
        WHERE r.account_id = a.account_id
          AND COALESCE(
                NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
                NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
              ) IS NOT NULL
        ORDER BY r.tax_year DESC, r.fetched_at DESC
        LIMIT 1
      ) raw_loc ON NULLIF(BTRIM(a.address), '') IS NULL
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
 * GET /api/accounts/:id/market_value_history
 * Returns market value history rows ordered by tax_year desc
 */
app.get("/api/accounts/:id/market_value_history", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "missing_id" });
  try {
    // Helper: pick a likely market value column from a row object
    const pickMarketValueKey = (row) => {
      const keys = Object.keys(row || {});
      const lc = (s) => String(s || '').toLowerCase();
      const score = (k) => {
        const s = lc(k);
        let sc = 0;
        if (s.includes('market') || s.includes('mkt')) sc += 3;
        if (s.includes('total') || s.includes('tot')) sc += 2;
        if (s.includes('value') || s.includes('val')) sc += 2;
        if (s === 'market_value' || s === 'total_market' || s === 'total_value') sc += 5;
        return sc;
      };
      const candidates = keys
        .filter(k => k !== 'tax_year' && k !== 'account_id')
        .sort((a, b) => score(b) - score(a));
      return candidates[0];
    };

    // Attempt 1: use core.market_value_history and infer the market value column name
    try {
      const { rows } = await pool.query(
        `SELECT * FROM core.market_value_history WHERE account_id = $1 ORDER BY tax_year DESC`,
        [id]
      );
      if (rows && rows.length) {
        const key = pickMarketValueKey(rows[0]);
        if (!key) return res.json(rows.map(r => ({ tax_year: r.tax_year, market_value: null })));
        return res.json(rows.map(r => ({ tax_year: r.tax_year, market_value: r[key] })));
      }
      return res.json([]);
    } catch (err) {
      // 42P01 = undefined_table; fall back to core.market_values
      if (err && err.code !== '42P01') throw err;
      const { rows } = await pool.query(
        `SELECT * FROM core.market_values WHERE account_id = $1 ORDER BY tax_year DESC`,
        [id]
      );
      if (rows && rows.length) {
        const key = pickMarketValueKey(rows[0]);
        if (!key) return res.json(rows.map(r => ({ tax_year: r.tax_year, market_value: null })));
        return res.json(rows.map(r => ({ tax_year: r.tax_year, market_value: r[key] })));
      }
      return res.json([]);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || "history_failed" });
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

    // Accept 17-character alphanumeric account IDs (some end with a letter)
    const isExactId = /^[0-9A-Za-z]{17}$/.test(q);
    // Guard against very short address fragments to avoid expensive wide scans
    if (!isExactId && q.length < 3) return res.json([]);
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
        COALESCE(NULLIF(BTRIM(a.address), ''), raw_loc.address) AS address,
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
      LEFT JOIN LATERAL (
        SELECT COALESCE(
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
               ) AS address
        FROM core.dcad_json_raw r
        WHERE r.account_id = a.account_id
          AND COALESCE(
                NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
                NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
              ) IS NOT NULL
        ORDER BY r.tax_year DESC, r.fetched_at DESC
        LIMIT 1
      ) raw_loc ON NULLIF(BTRIM(a.address), '') IS NULL
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
 * GET /api/sales
 * Search transaction-level sales from core.v_sales_enriched.
 *
 * Supported filters:
 *   q, account_id, exclude_account_id, neighborhood_code, date_from,
 *   date_to, min_price, max_price, matched, review, multi_parcel,
 *   limit, offset
 *
 * A multi-parcel transaction is returned once. Its sale price must never be
 * multiplied by the number of linked parcels.
 */
app.get("/api/sales", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const accountId = String(req.query.account_id || "").trim();
    const excludeAccountId = String(req.query.exclude_account_id || "").trim();
    const neighborhoodCode = String(req.query.neighborhood_code || "").trim();
    const dateFrom = String(req.query.date_from || "").trim();
    const dateTo = String(req.query.date_to || "").trim();
    const multiParcel = String(req.query.multi_parcel || "").trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "25"), 10) || 25, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);

    const parseOptionalBoolean = (value, name) => {
      if (value === undefined || value === null || value === "") return null;
      const normalized = String(value).trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) return true;
      if (["false", "0", "no"].includes(normalized)) return false;
      throw new Error(`invalid_${name}`);
    };

    const matched = parseOptionalBoolean(req.query.matched, "matched");
    const review = parseOptionalBoolean(req.query.review, "review");
    if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      return res.status(400).json({ error: "invalid_date_from" });
    }
    if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return res.status(400).json({ error: "invalid_date_to" });
    }
    if (multiParcel && !["single", "possible", "confirmed"].includes(multiParcel)) {
      return res.status(400).json({ error: "invalid_multi_parcel" });
    }

    const parsePrice = (value, name) => {
      if (value === undefined || value === null || value === "") return null;
      const parsed = Number(String(value).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid_${name}`);
      return parsed;
    };
    const minPrice = parsePrice(req.query.min_price, "min_price");
    const maxPrice = parsePrice(req.query.max_price, "max_price");
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
      return res.status(400).json({ error: "invalid_price_range" });
    }

    const params = [];
    const where = [];
    const bind = (value) => `$${params.push(value)}`;
    const addAccountFilter = (id) => {
      const placeholder = bind(id);
      where.push(`(
        v.primary_account_id = ${placeholder}
        OR EXISTS (
          SELECT 1
          FROM core.sale_parcels sp
          WHERE sp.source_record_id = v.source_record_id
            AND sp.account_id = ${placeholder}
        )
      )`);
    };

    if (accountId) addAccountFilter(accountId);
    if (excludeAccountId) {
      const placeholder = bind(excludeAccountId);
      where.push(`(
        v.primary_account_id IS DISTINCT FROM ${placeholder}
        AND NOT EXISTS (
          SELECT 1
          FROM core.sale_parcels excluded_sp
          WHERE excluded_sp.source_record_id = v.source_record_id
            AND excluded_sp.account_id = ${placeholder}
        )
      )`);
    }
    if (neighborhoodCode) where.push(`sale_account.neighborhood_code = ${bind(neighborhoodCode)}`);
    if (q) {
      if (/^[0-9A-Za-z]{17}$/.test(q)) {
        addAccountFilter(q);
      } else {
        const pattern = bind(`%${q.replace(/%/g, "").replace(/_/g, "")}%`);
        where.push(`(
          v.address ILIKE ${pattern}
          OR sale_account.address ILIKE ${pattern}
          OR v.city ILIKE ${pattern}
          OR v.source ILIKE ${pattern}
        )`);
      }
    }
    if (dateFrom) where.push(`v.closing_date >= ${bind(dateFrom)}::date`);
    if (dateTo) where.push(`v.closing_date <= ${bind(dateTo)}::date`);
    if (minPrice !== null) where.push(`v.sale_price >= ${bind(minPrice)}`);
    if (maxPrice !== null) where.push(`v.sale_price <= ${bind(maxPrice)}`);
    if (matched !== null) {
      where.push(matched ? "v.primary_account_id IS NOT NULL" : "v.primary_account_id IS NULL");
    }
    if (review !== null) where.push(`v.requires_additional_review = ${bind(review)}`);
    if (multiParcel) where.push(`v.multi_parcel_status = ${bind(multiParcel)}`);

    const sql = `
      SELECT
        v.sale_id,
        v.source_record_id,
        v.primary_account_id,
        v.county,
        sale_account.neighborhood_code,
        sale_account.subdivision,
        COALESCE(NULLIF(BTRIM(v.address), ''), NULLIF(BTRIM(sale_account.address), '')) AS address,
        v.city,
        v.state,
        v.zip,
        v.closing_date,
        v.sale_price,
        v.days_on_market,
        v.concessions,
        v.seller_contributions,
        v.listing_contract_date,
        v.buyer_financing,
        v.mls_status,
        v.source,
        v.source_filename,
        v.source_row_number,
        v.match_status,
        v.has_multiple_parcel_numbers,
        v.multi_parcel_status,
        v.has_unresolved_parcel,
        v.requires_additional_review,
        v.data_quality_flags,
        v.provided_parcel_fields,
        v.resolved_account_count,
        v.linked_parcels,
        v.mls_bedrooms_total,
        v.mls_bathrooms_total_integer,
        v.mls_bathrooms_full,
        v.mls_bathrooms_half,
        v.mls_living_area,
        v.mls_lot_size_area,
        v.mls_year_built,
        v.mls_garage_spaces,
        v.mls_garage_yn,
        v.mls_pool_yn,
        v.ratio_current_price_by_living_area,
        v.ratio_close_price_by_list_price,
        v.ratio_close_price_by_original_list_price,
        v.ratio_close_price_by_living_area,
        v.cad_bedroom_count,
        v.cad_bath_count,
        v.cad_baths_full,
        v.cad_baths_half,
        v.cad_living_area_sqft,
        v.cad_total_area_sqft,
        v.cad_year_built,
        v.cad_effective_year_built,
        v.cad_stories,
        v.cad_pool,
        v.cad_building_class,
        v.cad_land_value,
        v.cad_improvement_value,
        v.cad_market_value
      FROM core.v_sales_enriched v
      LEFT JOIN core.accounts sale_account
        ON sale_account.account_id = v.primary_account_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY v.closing_date DESC NULLS LAST,
               v.source_record_id DESC NULLS LAST,
               v.sale_id DESC NULLS LAST
      LIMIT ${bind(limit)} OFFSET ${bind(offset)}
    `;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    const message = err?.message || "sales_search_failed";
    if (String(message).startsWith("invalid_")) {
      return res.status(400).json({ error: message });
    }
    console.error("/api/sales failed", err);
    res.status(500).json({ error: "sales_search_failed" });
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
