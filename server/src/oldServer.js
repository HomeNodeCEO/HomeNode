import "dotenv/config";
import express from "express";
import cors from "cors";
import pg from "pg";
import nodemailer from "nodemailer";
import { parseClassFilter } from "./util/parseClasses.js";
import { parsePropertySearch } from "./util/propertySearch.js";
import {
  analyzeComparableOutliers,
  analysisWindow,
  applyRecommendationPolicy,
  DEFAULT_COMPARABLE_SCORING,
  DEFAULT_OUTLIER_ANALYSIS,
  DEFAULT_RECOMMENDATION_POLICY,
  filterComparablesForMarket,
  scoreComparable,
} from "./util/comparableScoring.js";
import {
  ensureAccountLocationsTable,
  refreshAccountLocations,
} from "./services/accountLocations.js";
import {
  ensureAccountQualitySchema,
  resolveCanonicalAccountId,
} from "./services/accountQuality.js";
import {
  editorKeyMatches,
  normalizeHousingProfileUpdate,
} from "./util/housingProfileEdit.js";
import { buildGroupedAnalysis } from "./util/groupedAnalysis.js";
import { parseGroupedAnalysisBreakdowns } from "./util/groupedAnalysisBreakdowns.js";
import {
  buildMarketConditionsAnalyses,
  getMarketContext,
  marketConditionsErrorStatus,
} from "./services/marketConditions.js";
import { getAccountSalesHistory } from "./services/accountSalesHistory.js";
import {
  ensureAppraisalRatingsSchema,
  SALE_REVIEW_SELECT,
  SUBJECT_RATING_SELECT,
} from "./services/appraisalRatings.js";
import {
  normalizeAppraisalRatingUpdate,
  normalizeEffectiveDate,
} from "./util/appraisalRatings.js";
import { ensurePropertyEnrichmentSchema } from "./services/propertyEnrichment.js";
import { TrestleClient } from "./services/trestleClient.js";
import {
  countyGisConfiguration,
  fetchParcelAreaSuggestion,
} from "./services/parcelGis.js";
import {
  assertNonDallasEnrichmentCounty,
  assertPropertyAttributeKey,
  NON_DALLAS_ENRICHMENT_COUNTIES,
} from "./util/nonDallasEnrichment.js";

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
const trestleClient = new TrestleClient();

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

const accountLocationsReady = ensureAccountLocationsTable(pool)
  .then(() => console.log("[init] core.account_locations ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensureAccountLocationsTable failed (will retry on request)",
      error?.message || error,
    );
  });

const accountQualityReady = ensureAccountQualitySchema(pool)
  .then(() => console.log("[init] DCAD account quality schema ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensureAccountQualitySchema failed (continuing)",
      error?.message || error,
    );
  });

const appraisalRatingsReady = ensureAppraisalRatingsSchema(pool)
  .then(() => console.log("[init] appraisal rating review schema ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensureAppraisalRatingsSchema failed (will retry on request)",
      error?.message || error,
    );
  });

const propertyEnrichmentReady = ensurePropertyEnrichmentSchema(pool)
  .then(() => console.log("[init] non-Dallas property enrichment schema ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensurePropertyEnrichmentSchema failed (will retry on request)",
      error?.message || error,
    );
  });

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
    await accountQualityReady;
    const canonicalId = await resolveCanonicalAccountId(pool, id);
    const accountSql = `
      SELECT
        a.account_id,
        COALESCE(NULLIF(BTRIM(a.address), ''), raw_loc.address) AS address,
        a.county,
        a.neighborhood_code,
        a.subdivision,
        a.legal_description,
        a.data_quality_status,
        a.data_quality_flags,
        a.canonical_account_id,
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
    const { rows: accRows } = await pool.query(accountSql, [canonicalId]);
    if (!accRows.length) return res.status(404).json({ error: "not_found" });

    // Sales history is core account data. Start its indexed lookup immediately
    // and include it in this response instead of making the frontend wait on
    // the general-purpose /api/sales view.
    const salesHistoryPromise = getAccountSalesHistory(pool, canonicalId);

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
    const { rows: impRows } = await pool.query(impSql, [canonicalId]);

    // The CAD improvement table does not contain a dependable detached/attached
    // field. Use the account-level profile, which fills structural and
    // architectural fields independently from the latest nonblank MLS
    // observations and supports source-attributed verified overrides.
    const housingSql = `
      SELECT
        structural_style,
        housing_type,
        attachment_type,
        architectural_style,
        source_name,
        source_url,
        source_record_reference,
        observed_at,
        confidence,
        profile_source
      FROM core.v_account_housing_profiles
      WHERE account_id = $1
    `;
    const { rows: housingRows } = await pool.query(housingSql, [canonicalId]);

    // Latest owner summary (mailing + name)
    const ownerSql = `
      SELECT owner_name, mailing_address, tax_year
      FROM core.owner_summary
      WHERE account_id = $1
      ORDER BY tax_year DESC
      LIMIT 1
    `;
    const { rows: ownerRows } = await pool.query(ownerSql, [canonicalId]);

    // Current legal description info (deed date, lines/text)
    const legalSql = `
      SELECT tax_year, legal_lines, legal_text, deed_transfer_date
      FROM core.legal_description_current
      WHERE account_id = $1
      LIMIT 1
    `;
    const { rows: legalRows } = await pool.query(legalSql, [canonicalId]);
    const legalHistSql = `
      SELECT tax_year, legal_lines, legal_text, deed_transfer_date
      FROM core.legal_description_history
      WHERE account_id = $1 AND deed_transfer_date IS NOT NULL
      ORDER BY tax_year DESC
      LIMIT 1
    `;
    const { rows: legalHistRows } = await pool.query(legalHistSql, [canonicalId]);

    // Exemptions summary (latest year) to determine homestead
    const exSql = `
      SELECT tax_year, jurisdiction_key, taxing_jurisdiction, homestead_exemption, disabled_vet, taxable_value
      FROM core.exemptions_summary
      WHERE account_id = $1
      ORDER BY tax_year DESC
    `;
    const { rows: exRowsAll } = await pool.query(exSql, [canonicalId]);
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
      const { rows: yRows } = await pool.query(landYearSql, [canonicalId]);
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
        const { rows } = await pool.query(landSql, [canonicalId, y]);
        landRows = rows || [];
      }
    } catch (e) {
      console.error('land_detail query failed', e);
    }
    const resp = {
      account: {
        ...accRows[0],
        requested_account_id: id,
        resolved_from_legacy: canonicalId !== id.toUpperCase(),
      },
      primary_improvements: impRows[0] || null,
      housing_profile: housingRows[0] || null,
      owner_summary: ownerRows[0] || null,
      legal_current: legalRows[0] || null,
      legal_history: legalHistRows[0] || null,
      exemptions_summary_year: exYear,
      exemptions_summary: exRows,
      homestead_yes: homesteadYes,
      land_detail: landRows,
      sales_history: await salesHistoryPromise,
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
      const { rows: secRows } = await pool.query(secSql, [canonicalId]);
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
 * GET /api/accounts/:id/photos
 * Returns the latest ordered MLS image gallery available for an account.
 * The source listing/sale record remains explicit so the UI never confuses
 * placeholder imagery with MLS evidence.
 */
app.get("/api/accounts/:id/photos", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  try {
    const { rows: sourceRows } = await pool.query(
      `
        SELECT
          src.id AS source_record_id,
          src.listing_key,
          src.listing_id,
          src.source_name,
          src.record_type,
          COALESCE(src.close_date, src.listing_contract_date) AS activity_date
        FROM core.sales_source_records src
        JOIN core.v_sales_media_summary media
          ON media.source_record_id = src.id
        WHERE src.primary_account_id = $1
        ORDER BY
          COALESCE(src.close_date, src.listing_contract_date) DESC NULLS LAST,
          (src.record_type = 'listing') DESC,
          src.updated_at DESC,
          src.id DESC
        LIMIT 1
      `,
      [id],
    );
    if (!sourceRows.length) {
      return res.json({
        account_id: id,
        source_record_id: null,
        listing_key: null,
        listing_id: null,
        source_name: null,
        photos: [],
      });
    }
    const source = sourceRows[0];
    const { rows: photos } = await pool.query(
      `
        SELECT
          id,
          source_record_id,
          media_url,
          order_number,
          preferred_photo_yn AS is_primary,
          short_description AS caption,
          mime_type,
          permission,
          modification_timestamp
        FROM core.sales_source_media
        WHERE source_record_id = $1
          AND media_category = 'image'
        ORDER BY
          preferred_photo_yn DESC,
          order_number NULLS LAST,
          id
      `,
      [source.source_record_id],
    );
    res.json({
      account_id: id,
      ...source,
      photos,
    });
  } catch (error) {
    console.error("/api/accounts/:id/photos failed", error);
    res.status(500).json({ error: "account_photos_failed" });
  }
});

/**
 * PATCH /api/accounts/:id/housing-profile
 * Saves a verified, account-level housing classification without changing the
 * immutable MLS source row. The profile becomes the fallback for every sale
 * linked to the same parcel.
 */
app.patch("/api/accounts/:id/housing-profile", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }

  const configuredEditorKey = String(process.env.HOMENODE_EDITOR_KEY || "");
  if (!configuredEditorKey) {
    return res.status(503).json({ error: "housing_profile_editor_not_configured" });
  }
  if (
    !editorKeyMatches(
      req.get("x-homenode-editor-key"),
      configuredEditorKey,
    )
  ) {
    return res.status(401).json({ error: "invalid_editor_key" });
  }

  let update;
  try {
    update = normalizeHousingProfileUpdate(req.body);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_housing_profile" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accountResult = await client.query(
      "SELECT 1 FROM core.accounts WHERE account_id = $1",
      [id],
    );
    if (!accountResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "account_not_found" });
    }

    await client.query(
      `
        INSERT INTO core.account_housing_profiles (
          account_id,
          structural_style,
          housing_type,
          attachment_type,
          architectural_style,
          source_name,
          source_url,
          source_record_reference,
          observed_at,
          confidence,
          notes
        ) VALUES (
          $1, $2, $3, $4, $5,
          'HomeNode manual comparable review',
          $6, $7, now(), 1.000, $8
        )
        ON CONFLICT (account_id) DO UPDATE SET
          structural_style = EXCLUDED.structural_style,
          housing_type = EXCLUDED.housing_type,
          attachment_type = EXCLUDED.attachment_type,
          architectural_style = EXCLUDED.architectural_style,
          source_name = EXCLUDED.source_name,
          source_url = EXCLUDED.source_url,
          source_record_reference = EXCLUDED.source_record_reference,
          observed_at = EXCLUDED.observed_at,
          confidence = EXCLUDED.confidence,
          notes = EXCLUDED.notes,
          updated_at = now()
      `,
      [
        id,
        update.structuralStyle,
        update.housingType,
        update.attachmentType,
        update.architecturalStyle,
        update.sourceUrl,
        update.sourceRecordReference,
        update.notes,
      ],
    );

    const { rows } = await client.query(
      `
        SELECT
          structural_style,
          housing_type,
          attachment_type,
          architectural_style,
          source_name,
          source_url,
          source_record_reference,
          observed_at,
          confidence,
          profile_source
        FROM core.v_account_housing_profiles
        WHERE account_id = $1
      `,
      [id],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, housing_profile: rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("/api/accounts/:id/housing-profile failed", error);
    return res.status(500).json({ error: "housing_profile_update_failed" });
  } finally {
    client.release();
  }
});

function requireEditor(req, res) {
  const configuredEditorKey = String(process.env.HOMENODE_EDITOR_KEY || "");
  if (!configuredEditorKey) {
    res.status(503).json({ error: "editor_not_configured" });
    return false;
  }
  if (!editorKeyMatches(req.get("x-homenode-editor-key"), configuredEditorKey)) {
    res.status(401).json({ error: "invalid_editor_key" });
    return false;
  }
  return true;
}

/** Batch-load manually verified condition and quality ratings for MLS source rows. */
app.get("/api/sales/reviews", async (req, res) => {
  const rawIds = String(req.query.source_record_ids || "").split(",");
  const sourceRecordIds = [...new Set(rawIds.map((value) => value.trim()))]
    .filter((value) => /^\d+$/.test(value))
    .slice(0, 200);
  if (!sourceRecordIds.length) return res.json({ reviews: [] });
  try {
    await appraisalRatingsReady;
    const { rows } = await pool.query(
      `${SALE_REVIEW_SELECT} WHERE source_record_id = ANY($1::bigint[])
       ORDER BY source_record_id`,
      [sourceRecordIds],
    );
    return res.json({ reviews: rows });
  } catch (error) {
    console.error("/api/sales/reviews failed", error);
    return res.status(500).json({ error: "sale_reviews_failed" });
  }
});

/** Explicitly save a reviewed comparable rating without mutating its source MLS row. */
app.patch("/api/sales/:sourceRecordId/review", async (req, res) => {
  const sourceRecordId = String(req.params.sourceRecordId || "").trim();
  if (!/^\d+$/.test(sourceRecordId)) {
    return res.status(400).json({ error: "invalid_source_record_id" });
  }
  if (!requireEditor(req, res)) return;

  let update;
  try {
    update = normalizeAppraisalRatingUpdate(req.body);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_appraisal_rating" });
  }

  const client = await pool.connect();
  try {
    await appraisalRatingsReady;
    await client.query("BEGIN");
    const { rows: sources } = await client.query(
      `SELECT id, listing_id FROM core.sales_source_records WHERE id = $1 FOR SHARE`,
      [sourceRecordId],
    );
    if (!sources.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "sale_source_record_not_found" });
    }
    const { rows: existingRows } = await client.query(
      `SELECT * FROM app.sale_characteristic_reviews
       WHERE source_record_id = $1 FOR UPDATE`,
      [sourceRecordId],
    );
    const existing = existingRows[0] || null;
    const currentRevision = Number(existing?.revision || 0);
    if (
      update.expectedRevision != null &&
      update.expectedRevision !== currentRevision
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "rating_revision_conflict",
        current_revision: currentRevision,
      });
    }
    const nextRevision = currentRevision + 1;
    const { rows } = await client.query(
      `INSERT INTO app.sale_characteristic_reviews (
         source_record_id, listing_id, condition_rating, quality_rating,
         notes, reviewer, revision
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_record_id) DO UPDATE SET
         listing_id = EXCLUDED.listing_id,
         condition_rating = EXCLUDED.condition_rating,
         quality_rating = EXCLUDED.quality_rating,
         notes = EXCLUDED.notes,
         reviewer = EXCLUDED.reviewer,
         revision = EXCLUDED.revision,
         updated_at = now()
       RETURNING *`,
      [
        sourceRecordId,
        sources[0].listing_id,
        update.conditionRating,
        update.qualityRating,
        update.notes,
        update.reviewer,
        nextRevision,
      ],
    );
    const review = rows[0];
    await client.query(
      `INSERT INTO app.sale_characteristic_review_history (
         source_record_id, listing_id, condition_rating, quality_rating,
         notes, reviewer, revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        review.source_record_id,
        review.listing_id,
        review.condition_rating,
        review.quality_rating,
        review.notes,
        review.reviewer,
        review.revision,
      ],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, review });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("/api/sales/:sourceRecordId/review failed", error);
    return res.status(500).json({ error: "sale_review_update_failed" });
  } finally {
    client.release();
  }
});

app.get("/api/sales/:sourceRecordId/review-history", async (req, res) => {
  const sourceRecordId = String(req.params.sourceRecordId || "").trim();
  if (!/^\d+$/.test(sourceRecordId)) {
    return res.status(400).json({ error: "invalid_source_record_id" });
  }
  try {
    await appraisalRatingsReady;
    const { rows } = await pool.query(
      `SELECT source_record_id, listing_id, condition_rating, quality_rating,
              notes, reviewer, revision, changed_at
       FROM app.sale_characteristic_review_history
       WHERE source_record_id = $1
       ORDER BY revision DESC, changed_at DESC`,
      [sourceRecordId],
    );
    return res.json({ history: rows });
  } catch (error) {
    console.error("sale review history failed", error);
    return res.status(500).json({ error: "sale_review_history_failed" });
  }
});

/** Load the subject's saved rating for the appraisal effective date. */
app.get("/api/accounts/:id/appraisal-rating", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  let effectiveDate;
  try {
    effectiveDate = normalizeEffectiveDate(req.query.effective_date);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_effective_date" });
  }
  try {
    await appraisalRatingsReady;
    const { rows } = await pool.query(
      `${SUBJECT_RATING_SELECT}
       WHERE account_id = $1 AND effective_date = $2::date`,
      [id, effectiveDate],
    );
    return res.json({ rating: rows[0] || null });
  } catch (error) {
    console.error("subject appraisal rating load failed", error);
    return res.status(500).json({ error: "subject_rating_failed" });
  }
});

/** Explicitly save the subject's condition/quality for one appraisal date. */
app.put("/api/accounts/:id/appraisal-rating", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;

  let effectiveDate;
  let update;
  try {
    effectiveDate = normalizeEffectiveDate(req.body?.effective_date);
    update = normalizeAppraisalRatingUpdate(req.body);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_appraisal_rating" });
  }

  const client = await pool.connect();
  try {
    await appraisalRatingsReady;
    await client.query("BEGIN");
    const accountResult = await client.query(
      "SELECT 1 FROM core.accounts WHERE account_id = $1 FOR SHARE",
      [id],
    );
    if (!accountResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "account_not_found" });
    }
    const { rows: existingRows } = await client.query(
      `SELECT * FROM app.subject_appraisal_ratings
       WHERE account_id = $1 AND effective_date = $2::date FOR UPDATE`,
      [id, effectiveDate],
    );
    const currentRevision = Number(existingRows[0]?.revision || 0);
    if (
      update.expectedRevision != null &&
      update.expectedRevision !== currentRevision
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "rating_revision_conflict",
        current_revision: currentRevision,
      });
    }
    const nextRevision = currentRevision + 1;
    const { rows } = await client.query(
      `INSERT INTO app.subject_appraisal_ratings (
         account_id, effective_date, condition_rating, quality_rating,
         notes, reviewer, revision
       ) VALUES ($1,$2::date,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id, effective_date) DO UPDATE SET
         condition_rating = EXCLUDED.condition_rating,
         quality_rating = EXCLUDED.quality_rating,
         notes = EXCLUDED.notes,
         reviewer = EXCLUDED.reviewer,
         revision = EXCLUDED.revision,
         updated_at = now()
       RETURNING *`,
      [
        id,
        effectiveDate,
        update.conditionRating,
        update.qualityRating,
        update.notes,
        update.reviewer,
        nextRevision,
      ],
    );
    const rating = rows[0];
    await client.query(
      `INSERT INTO app.subject_appraisal_rating_history (
         account_id, effective_date, condition_rating, quality_rating,
         notes, reviewer, revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        rating.account_id,
        rating.effective_date,
        rating.condition_rating,
        rating.quality_rating,
        rating.notes,
        rating.reviewer,
        rating.revision,
      ],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, rating });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("subject appraisal rating update failed", error);
    return res.status(500).json({ error: "subject_rating_update_failed" });
  } finally {
    client.release();
  }
});

app.get("/api/accounts/:id/appraisal-rating-history", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  try {
    await appraisalRatingsReady;
    const { rows } = await pool.query(
      `SELECT account_id, effective_date, condition_rating, quality_rating,
              notes, reviewer, revision, changed_at
       FROM app.subject_appraisal_rating_history
       WHERE account_id = $1
       ORDER BY effective_date DESC, revision DESC, changed_at DESC
       LIMIT 100`,
      [id],
    );
    return res.json({ history: rows });
  } catch (error) {
    console.error("subject appraisal rating history failed", error);
    return res.status(500).json({ error: "subject_rating_history_failed" });
  }
});

async function getNonDallasAccount(client, accountId) {
  const { rows } = await client.query(
    `SELECT account_id, county FROM core.accounts WHERE account_id = $1`,
    [accountId],
  );
  if (!rows.length) return null;
  return {
    ...rows[0],
    normalized_county: assertNonDallasEnrichmentCounty(rows[0].county),
  };
}

/** Non-sensitive activation status for the additive non-Dallas pipeline. */
app.get("/api/enrichment/status", (_req, res) => {
  const gis = Object.fromEntries(
    NON_DALLAS_ENRICHMENT_COUNTIES.map((county) => {
      const configuration = countyGisConfiguration(county);
      return [county, { configured: configuration.configured }];
    }),
  );
  return res.json({
    dallas_county_isolated: true,
    supported_counties: NON_DALLAS_ENRICHMENT_COUNTIES,
    trestle: trestleClient.status(),
    gis,
    resolution_order: ["manual_verified", "trestle", "cad", "manual_review"],
  });
});

/** Load verified overrides, review flags, and pending GIS suggestions for an account. */
app.get("/api/accounts/:id/enrichment", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  try {
    await propertyEnrichmentReady;
    const account = await getNonDallasAccount(pool, id);
    if (!account) return res.status(404).json({ error: "account_not_found" });
    const [manualResult, reviewResult, gisResult] = await Promise.all([
      pool.query(
        `SELECT attribute_key, attribute_value, notes, reviewer, revision,
                created_at, updated_at
         FROM app.property_attribute_manual_values
         WHERE account_id = $1 ORDER BY attribute_key`,
        [id],
      ),
      pool.query(
        `SELECT attribute_key, reason, status, evidence, first_flagged_at,
                updated_at, resolved_at
         FROM app.enrichment_review_queue
         WHERE account_id = $1 ORDER BY status, attribute_key`,
        [id],
      ),
      pool.query(
        `SELECT id, area_square_feet, area_acres, source_url, status,
                reviewed_by, reviewed_at, created_at
         FROM app.parcel_geometry_suggestions
         WHERE account_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [id],
      ),
    ]);
    return res.json({
      account_id: id,
      county: account.normalized_county,
      manual_values: manualResult.rows,
      review_queue: reviewResult.rows,
      parcel_area_suggestions: gisResult.rows,
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "dallas_enrichment_isolated") {
      return res.status(409).json({ error: message });
    }
    console.error("account enrichment load failed", error);
    return res.status(500).json({ error: "account_enrichment_failed" });
  }
});

/** Save a verified non-Dallas attribute. No autosave and no source-row mutation. */
app.patch("/api/accounts/:id/verified-attribute", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  let attributeKey;
  try {
    attributeKey = assertPropertyAttributeKey(req.body?.attribute_key);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_attribute" });
  }
  if (req.body?.attribute_value === undefined) {
    return res.status(400).json({ error: "missing_attribute_value" });
  }
  const notes = String(req.body?.notes || "").trim().slice(0, 4000) || null;
  const reviewer = String(req.body?.reviewer || "HomeNode editor").trim().slice(0, 200);
  const expectedRevision = req.body?.expected_revision == null
    ? null
    : Number(req.body.expected_revision);
  if (expectedRevision != null && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    return res.status(400).json({ error: "invalid_expected_revision" });
  }

  const client = await pool.connect();
  try {
    await propertyEnrichmentReady;
    await client.query("BEGIN");
    const account = await getNonDallasAccount(client, id);
    if (!account) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "account_not_found" });
    }
    const { rows: existingRows } = await client.query(
      `SELECT revision FROM app.property_attribute_manual_values
       WHERE account_id = $1 AND attribute_key = $2 FOR UPDATE`,
      [id, attributeKey],
    );
    const currentRevision = Number(existingRows[0]?.revision || 0);
    if (expectedRevision != null && expectedRevision !== currentRevision) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "attribute_revision_conflict",
        current_revision: currentRevision,
      });
    }
    const nextRevision = currentRevision + 1;
    const valueJson = JSON.stringify(req.body.attribute_value);
    const { rows } = await client.query(
      `INSERT INTO app.property_attribute_manual_values (
         account_id, attribute_key, attribute_value, notes, reviewer, revision
       ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
       ON CONFLICT (account_id, attribute_key) DO UPDATE SET
         attribute_value = EXCLUDED.attribute_value,
         notes = EXCLUDED.notes,
         reviewer = EXCLUDED.reviewer,
         revision = EXCLUDED.revision,
         updated_at = now()
       RETURNING *`,
      [id, attributeKey, valueJson, notes, reviewer, nextRevision],
    );
    const manualValue = rows[0];
    await client.query(
      `INSERT INTO app.property_attribute_manual_history (
         account_id, attribute_key, attribute_value, notes, reviewer, revision
       ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
      [id, attributeKey, valueJson, notes, reviewer, nextRevision],
    );
    await client.query(
      `UPDATE app.enrichment_review_queue
       SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE account_id = $1 AND attribute_key = $2`,
      [id, attributeKey],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, manual_value: manualValue });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const message = String(error?.message || "");
    if (message === "dallas_enrichment_isolated") {
      return res.status(409).json({ error: message });
    }
    console.error("verified attribute update failed", error);
    return res.status(500).json({ error: "verified_attribute_update_failed" });
  } finally {
    client.release();
  }
});

/** Calculate and store a review-only lot-area suggestion from official county GIS. */
app.post("/api/accounts/:id/parcel-area-suggestion", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    await propertyEnrichmentReady;
    const account = await getNonDallasAccount(pool, id);
    if (!account) return res.status(404).json({ error: "account_not_found" });
    const suggestion = await fetchParcelAreaSuggestion({
      county: account.normalized_county,
      accountId: id,
    });
    if (!suggestion) return res.status(404).json({ error: "parcel_geometry_not_found" });
    const { rows } = await pool.query(
      `INSERT INTO app.parcel_geometry_suggestions (
         account_id, county, source_url, geometry, area_square_feet,
         area_acres, source_attributes, status
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,'pending')
       RETURNING id, account_id, county, source_url, area_square_feet,
                 area_acres, status, created_at`,
      [
        id,
        suggestion.county,
        suggestion.source_url,
        JSON.stringify(suggestion.geometry),
        suggestion.area_square_feet,
        suggestion.area_acres,
        JSON.stringify(suggestion.source_attributes),
      ],
    );
    await pool.query(
      `INSERT INTO app.enrichment_review_queue (
         account_id, county, attribute_key, reason, evidence
       ) VALUES ($1,$2,'site_size_sqft','gis_site_area_requires_approval',$3::jsonb)
       ON CONFLICT (account_id, attribute_key) DO UPDATE SET
         county = EXCLUDED.county,
         reason = EXCLUDED.reason,
         status = 'pending',
         evidence = EXCLUDED.evidence,
         resolved_at = NULL,
         updated_at = now()`,
      [id, suggestion.county, JSON.stringify({ suggestion_id: rows[0].id })],
    );
    return res.json({ ok: true, suggestion: rows[0] });
  } catch (error) {
    const message = String(error?.message || "");
    if (["dallas_enrichment_isolated", "county_gis_not_configured"].includes(message)) {
      return res.status(409).json({ error: message });
    }
    console.error("parcel area suggestion failed", error);
    return res.status(500).json({ error: message || "parcel_area_suggestion_failed" });
  }
});

app.post("/api/accounts/:id/parcel-area-suggestions/:suggestionId/decision", async (req, res) => {
  const id = String(req.params.id || "").trim();
  const suggestionId = String(req.params.suggestionId || "").trim();
  const decision = String(req.body?.decision || "").trim().toLowerCase();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(id) || !/^\d+$/.test(suggestionId)) {
    return res.status(400).json({ error: "invalid_suggestion_target" });
  }
  if (!new Set(["approved", "rejected"]).has(decision)) {
    return res.status(400).json({ error: "invalid_suggestion_decision" });
  }
  if (!requireEditor(req, res)) return;
  const reviewer = String(req.body?.reviewer || "HomeNode editor").trim().slice(0, 200);
  const client = await pool.connect();
  try {
    await propertyEnrichmentReady;
    await client.query("BEGIN");
    const account = await getNonDallasAccount(client, id);
    if (!account) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "account_not_found" });
    }
    const { rows } = await client.query(
      `SELECT * FROM app.parcel_geometry_suggestions
       WHERE id = $1 AND account_id = $2 FOR UPDATE`,
      [suggestionId, id],
    );
    const suggestion = rows[0];
    if (!suggestion) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "parcel_suggestion_not_found" });
    }
    if (suggestion.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "parcel_suggestion_already_reviewed" });
    }
    await client.query(
      `UPDATE app.parcel_geometry_suggestions
       SET status = $3, reviewed_by = $4, reviewed_at = now()
       WHERE id = $1 AND account_id = $2`,
      [suggestionId, id, decision, reviewer],
    );
    if (decision === "approved") {
      const valueJson = JSON.stringify(Number(suggestion.area_square_feet));
      const { rows: existingRows } = await client.query(
        `SELECT revision FROM app.property_attribute_manual_values
         WHERE account_id = $1 AND attribute_key = 'site_size_sqft' FOR UPDATE`,
        [id],
      );
      const revision = Number(existingRows[0]?.revision || 0) + 1;
      const notes = `Approved official county GIS suggestion ${suggestionId}.`;
      await client.query(
        `INSERT INTO app.property_attribute_manual_values (
           account_id, attribute_key, attribute_value, notes, reviewer, revision
         ) VALUES ($1,'site_size_sqft',$2::jsonb,$3,$4,$5)
         ON CONFLICT (account_id, attribute_key) DO UPDATE SET
           attribute_value = EXCLUDED.attribute_value,
           notes = EXCLUDED.notes,
           reviewer = EXCLUDED.reviewer,
           revision = EXCLUDED.revision,
           updated_at = now()`,
        [id, valueJson, notes, reviewer, revision],
      );
      await client.query(
        `INSERT INTO app.property_attribute_manual_history (
           account_id, attribute_key, attribute_value, notes, reviewer, revision
         ) VALUES ($1,'site_size_sqft',$2::jsonb,$3,$4,$5)`,
        [id, valueJson, notes, reviewer, revision],
      );
    }
    await client.query(
      `UPDATE app.enrichment_review_queue
       SET status = $2, resolved_at = now(), updated_at = now()
       WHERE account_id = $1 AND attribute_key = 'site_size_sqft'`,
      [id, decision === "approved" ? "approved" : "rejected"],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, decision });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const message = String(error?.message || "");
    if (message === "dallas_enrichment_isolated") {
      return res.status(409).json({ error: message });
    }
    console.error("parcel suggestion decision failed", error);
    return res.status(500).json({ error: "parcel_suggestion_decision_failed" });
  } finally {
    client.release();
  }
});

/** Preview licensed Trestle data; activation remains off until credentials exist. */
app.post("/api/accounts/:id/trestle-preview", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    const account = await getNonDallasAccount(pool, id);
    if (!account) return res.status(404).json({ error: "account_not_found" });
    const preview = await trestleClient.findProperty({
      listingKey: req.body?.listing_key,
      listingId: req.body?.listing_id,
      originatingSystemName: req.body?.originating_system_name,
    });
    return res.json({ account_id: id, county: account.normalized_county, preview });
  } catch (error) {
    const message = String(error?.message || "");
    if (
      [
        "dallas_enrichment_isolated",
        "trestle_disabled",
        "trestle_credentials_missing",
        "missing_listing_identifier",
        "ambiguous_listing_id",
      ].includes(message)
    ) {
      return res.status(409).json({ error: message });
    }
    console.error("Trestle preview failed", error);
    return res.status(502).json({ error: message || "trestle_preview_failed" });
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
 * Search by exact account ID or indexed address/street/city metadata. Queries
 * beginning with a house number remain full-address prefixes so every
 * keystroke narrows the same autocomplete results.
 * Returns an array of AccountRow objects for the frontend.
 */
app.get("/api/search", async (req, res) => {
  try {
    await accountQualityReady;
    const q = String(req.query.q || "").trim();
    const limit = Math.min(parseInt(String(req.query.limit || "25"), 10) || 25, 100);
    const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);

    if (!q) return res.json([]);

    const parsed = parsePropertySearch(q);
    if (!parsed.isAccountId && !parsed.normalizedAddress) return res.json([]);

    const params = [];
    const bind = (value) => `$${params.push(value)}`;
    let where;
    let matchSql;
    let orderSql;
    let requestedLegacyAccountId = null;

    if (parsed.isAccountId) {
      const canonicalAccountId = await resolveCanonicalAccountId(pool, q);
      if (canonicalAccountId !== q.toUpperCase()) {
        requestedLegacyAccountId = q.toUpperCase();
      }
      where = `a.account_id = ${bind(canonicalAccountId)}`;
      matchSql = `'exact_account'`;
      orderSql = "a.account_id";
    } else if (parsed.isAddressPrefix) {
      const addressLineSql = `upper(btrim(split_part(a.address, ',', 1))) COLLATE "C"`;
      const normalizedAddressPlaceholder = bind(parsed.normalizedAddress);
      const addressPrefixPlaceholder = bind(`${parsed.normalizedAddress}%`);
      const cityWhere = parsed.city
        ? `AND upper(a.city) = ${bind(parsed.city)}`
        : "";

      where = `
        a.address IS NOT NULL
        AND a.canonical_account_id IS NULL
        AND ${addressLineSql} LIKE ${addressPrefixPlaceholder}
        ${cityWhere}
      `;
      matchSql = `
        CASE
          WHEN ${addressLineSql} = ${normalizedAddressPlaceholder} THEN 'exact_address'
          ELSE 'address_prefix'
        END
      `;
      orderSql = `
        ${addressLineSql},
        upper(COALESCE(a.city, '')) COLLATE "C",
        a.account_id
      `;
    } else {
      const streetSql = `upper(a.street_name) COLLATE "C"`;
      const citySql = `upper(COALESCE(a.city, '')) COLLATE "C"`;
      const addressLineSql = `upper(btrim(split_part(a.address, ',', 1))) COLLATE "C"`;
      const streetPlaceholder = bind(`${parsed.streetName}%`);
      const cityWhere = parsed.city ? `AND upper(a.city) = ${bind(parsed.city)}` : "";

      where = `
        a.street_name IS NOT NULL
        AND a.canonical_account_id IS NULL
        AND ${streetSql} LIKE ${streetPlaceholder}
        ${cityWhere}
      `;
      matchSql = `'same_street'`;
      orderSql = `
        ${streetSql},
        ${citySql},
        ${addressLineSql},
        a.account_id
      `;
    }

    const sql = `
      SELECT
        a.account_id,
        COALESCE(NULLIF(BTRIM(a.address), ''), raw_loc.address) AS address,
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
        ${matchSql} AS search_match,
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
      ORDER BY ${orderSql}
      LIMIT ${bind(limit)} OFFSET ${bind(offset)}
    `;
    const { rows } = await pool.query(sql, params);
    res.json(
      requestedLegacyAccountId
        ? rows.map((row) => ({
            ...row,
            requested_account_id: requestedLegacyAccountId,
            resolved_from_legacy: true,
            data_quality_status: "legacy_resolved",
          }))
        : rows,
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "search_failed" });
  }
});

/**
 * GET /api/sales/recommendations
 *
 * Ranks matched CAD sales using parcel-centroid distance (40%), continuous
 * living-area similarity (30%), and closing-date recency (30%). The default
 * 12-month analysis period excludes older sales unless the caller explicitly
 * expands the period to 24 or 36 months. The response also returns lower-ranked
 * one-year challengers and a price-per-square-foot outlier audit for sales at
 * or above the requested score floor. Statistical flags require at least 30
 * distinct properties plus adequate data and time coverage.
 */
app.get("/api/sales/recommendations", async (req, res) => {
  try {
    await accountLocationsReady;
    await ensureAccountLocationsTable(pool);

    const subjectAccountId = String(
      req.query.subject_account_id || "",
    ).trim();
    const dateFrom = String(req.query.date_from || "").trim();
    const dateTo = String(req.query.date_to || "").trim();
    const requestedAnalysisAsOf = String(
      req.query.analysis_as_of ||
      dateTo ||
      new Date().toISOString().slice(0, 10),
    ).trim();
    const requestedPeriodMonths = Number(
      req.query.period_months ||
      DEFAULT_RECOMMENDATION_POLICY.periodMonths,
    );
    const marketBreakdownValue = String(
      req.query.market_breakdown || "",
    ).trim();
    const resultLimit = Math.min(
      Math.max(
        parseInt(String(req.query.limit || "25"), 10) || 25,
        DEFAULT_RECOMMENDATION_POLICY.count,
      ),
      100,
    );
    if (!/^[0-9A-Za-z]{17}$/.test(subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      return res.status(400).json({ error: "invalid_date_from" });
    }
    if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return res.status(400).json({ error: "invalid_date_to" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedAnalysisAsOf)) {
      return res.status(400).json({ error: "invalid_analysis_as_of" });
    }
    if (
      !Number.isInteger(requestedPeriodMonths) ||
      ![12, 24, 36].includes(requestedPeriodMonths)
    ) {
      return res.status(400).json({ error: "invalid_analysis_period" });
    }
    const requestedWindow = analysisWindow(
      requestedAnalysisAsOf,
      requestedPeriodMonths,
    );
    if (!requestedWindow) {
      return res.status(400).json({ error: "invalid_analysis_period" });
    }
    const effectiveDateFrom =
      dateFrom || requestedWindow.analysisStartDate;
    const effectiveDateTo =
      dateTo || requestedWindow.analysisAsOf;
    let marketBreakdown = null;
    if (marketBreakdownValue) {
      try {
        const parsedBreakdowns = parseGroupedAnalysisBreakdowns(
          marketBreakdownValue,
        );
        if (parsedBreakdowns.length !== 1) {
          return res.status(400).json({
            error: "invalid_market_breakdown",
          });
        }
        [marketBreakdown] = parsedBreakdowns;
      } catch {
        return res.status(400).json({
          error: "invalid_market_breakdown",
        });
      }
    }

    const parseTunableNumber = (value, fallback, minimum, maximum) => {
      if (value === undefined || value === null || value === "") return fallback;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error("invalid_scoring_configuration");
      }
      return parsed;
    };
    const scoringConfig = {
      locationWeight: parseTunableNumber(
        req.query.location_weight,
        DEFAULT_COMPARABLE_SCORING.locationWeight,
        0,
        1,
      ),
      squareFootageWeight: parseTunableNumber(
        req.query.square_footage_weight,
        DEFAULT_COMPARABLE_SCORING.squareFootageWeight,
        0,
        1,
      ),
      salesDateWeight: parseTunableNumber(
        req.query.sales_date_weight,
        DEFAULT_COMPARABLE_SCORING.salesDateWeight,
        0,
        1,
      ),
      locationScaleMiles: parseTunableNumber(
        req.query.location_scale_miles,
        DEFAULT_COMPARABLE_SCORING.locationScaleMiles,
        0.05,
        25,
      ),
      squareFootageScaleRatio: parseTunableNumber(
        req.query.square_footage_scale_ratio,
        DEFAULT_COMPARABLE_SCORING.squareFootageScaleRatio,
        0.01,
        1,
      ),
      salesDateScaleDays: parseTunableNumber(
        req.query.sales_date_scale_days,
        DEFAULT_COMPARABLE_SCORING.salesDateScaleDays,
        30,
        1095,
      ),
    };
    const outlierScoreThreshold = parseTunableNumber(
      req.query.outlier_score_threshold,
      DEFAULT_OUTLIER_ANALYSIS.scoreThreshold,
      0,
      100,
    );
    if (
      scoringConfig.locationWeight +
        scoringConfig.squareFootageWeight +
        scoringConfig.salesDateWeight <=
      0
    ) {
      return res.status(400).json({ error: "invalid_scoring_configuration" });
    }

    const loadSubject = async () => {
      const { rows } = await pool.query(
        `
          SELECT
            account.account_id,
            account.address,
            account.city,
            account.county,
            NULLIF(
              LEFT(
                REGEXP_REPLACE(COALESCE(account.postal_code, ''), '\\D', '', 'g'),
                5
              ),
              ''
            ) AS postal_code,
            account.neighborhood_code,
            COALESCE(improvement.living_area_sqft, improvement.total_living_area) AS living_area_sqft,
            location.latitude,
            location.longitude,
            location.status AS location_status,
            location.source AS location_source,
            location.precision AS location_precision,
            location.confidence AS location_confidence,
            location.review_required AS location_review_required,
            location.review_reason AS location_review_reason,
            location.geocoded_at
          FROM core.accounts account
          LEFT JOIN core.primary_improvements improvement
            ON improvement.account_id = account.account_id
          LEFT JOIN core.account_locations location
            ON location.account_id = account.account_id
          WHERE account.account_id = $1
        `,
        [subjectAccountId],
      );
      return rows[0] || null;
    };

    let subject = await loadSubject();
    if (!subject) {
      return res.status(404).json({ error: "subject_not_found" });
    }
    if (
      subject.location_status !== "matched" ||
      subject.latitude == null ||
      subject.longitude == null
    ) {
      await refreshAccountLocations(pool, [subject], { batchSize: 1 });
      subject = await loadSubject();
    }
    if (
      subject?.location_status !== "matched" ||
      subject?.latitude == null ||
      subject?.longitude == null
    ) {
      return res.status(422).json({
        error: "subject_location_unavailable",
        subject_account_id: subjectAccountId,
      });
    }
    if (!Number.isFinite(Number(subject.living_area_sqft)) || Number(subject.living_area_sqft) <= 0) {
      return res.status(422).json({
        error: "subject_living_area_unavailable",
        subject_account_id: subjectAccountId,
      });
    }

    const candidateParams = [subjectAccountId];
    const candidateWhere = [
      "sale.primary_account_id IS NOT NULL",
      "sale.primary_account_id <> $1",
      "sale.record_type = 'closed_sale'",
      "sale.attachment_type NOT IN ('attached', 'mixed')",
    ];
    if (marketBreakdown) {
      candidateWhere.push(
        "sale.sale_price >= 10000",
        "sale.multi_parcel_status = 'single'",
      );
    }
    candidateParams.push(effectiveDateFrom);
    candidateWhere.push(
      `sale.closing_date >= $${candidateParams.length}::date`,
    );
    candidateParams.push(effectiveDateTo);
    candidateWhere.push(
      `sale.closing_date <= $${candidateParams.length}::date`,
    );

    const missingLocations = await pool.query(
      `
        SELECT
          sale.primary_account_id AS account_id,
          MAX(account.address) AS address,
          MAX(account.county) AS county,
          MAX(sale.closing_date) AS latest_sale_date
        FROM core.v_sales_enriched sale
        JOIN core.accounts account
          ON account.account_id = sale.primary_account_id
        LEFT JOIN core.account_locations location
          ON location.account_id = sale.primary_account_id
        WHERE ${candidateWhere.join(" AND ")}
          AND (
            account.county IS NULL
            OR account.county ILIKE '%dallas%'
          )
          AND (
            location.account_id IS NULL
            OR (
              location.status <> 'matched'
              AND location.geocoded_at < now() - interval '7 days'
            )
          )
        GROUP BY sale.primary_account_id
        ORDER BY MAX(sale.closing_date) DESC NULLS LAST
        LIMIT 250
      `,
      candidateParams,
    );
    if (missingLocations.rows.length) {
      try {
        await refreshAccountLocations(pool, missingLocations.rows, {
          batchSize: 50,
        });
      } catch (error) {
        console.warn(
          "[recommendations] candidate location refresh failed; using cached coverage",
          error?.message || error,
        );
      }
    }

    const candidateSql = `
      SELECT
        sale.sale_id,
        sale.source_record_id,
        (
          SELECT source_record.listing_id
          FROM core.sales_source_records source_record
          WHERE source_record.id = sale.source_record_id
        ) AS listing_id,
        sale.primary_account_id,
        sale.county,
        account.county AS account_county,
        account.neighborhood_code,
        account.subdivision,
        COALESCE(NULLIF(BTRIM(sale.address), ''), NULLIF(BTRIM(account.address), '')) AS address,
        COALESCE(NULLIF(BTRIM(sale.city), ''), NULLIF(BTRIM(account.city), '')) AS city,
        sale.state,
        COALESCE(NULLIF(BTRIM(sale.zip), ''), NULLIF(BTRIM(account.postal_code), '')) AS zip,
        sale.closing_date,
        sale.sale_price,
        sale.days_on_market,
        sale.concessions,
        sale.seller_contributions,
        sale.listing_contract_date,
        sale.buyer_financing,
        sale.mls_status,
        sale.record_type,
        sale.structural_style,
        sale.housing_type,
        sale.attachment_type,
        sale.architectural_style,
        sale.source,
        sale.source_filename,
        sale.source_row_number,
        sale.match_status,
        sale.has_multiple_parcel_numbers,
        sale.multi_parcel_status,
        sale.has_unresolved_parcel,
        sale.requires_additional_review,
        sale.data_quality_flags,
        sale.provided_parcel_fields,
        sale.resolved_account_count,
        sale.linked_parcels,
        sale.mls_bedrooms_total,
        sale.mls_bathrooms_total_integer,
        sale.mls_bathrooms_full,
        sale.mls_bathrooms_half,
        sale.mls_living_area,
        sale.mls_lot_size_area,
        sale.mls_year_built,
        sale.mls_garage_spaces,
        sale.mls_garage_yn,
        sale.mls_pool_yn,
        sale.ratio_current_price_by_living_area,
        sale.ratio_close_price_by_list_price,
        sale.ratio_close_price_by_original_list_price,
        sale.ratio_close_price_by_living_area,
        sale.cad_bedroom_count,
        sale.cad_bath_count,
        sale.cad_baths_full,
        sale.cad_baths_half,
        sale.cad_living_area_sqft,
        sale.cad_total_area_sqft,
        sale.cad_year_built,
        sale.cad_effective_year_built,
        sale.cad_stories,
        sale.cad_pool,
        sale.cad_building_class,
        sale.cad_land_value,
        sale.cad_improvement_value,
        sale.cad_market_value,
        media.primary_photo_url,
        COALESCE(media.photo_count, 0) AS photo_count,
        location.latitude,
        location.longitude,
        location.status AS location_status,
        location.source AS location_source,
        location.precision AS location_precision,
        location.confidence AS location_confidence,
        location.review_required AS location_review_required,
        location.review_reason AS location_review_reason,
        location.geocoded_at AS location_geocoded_at
      FROM core.v_sales_enriched sale
      JOIN core.accounts account
        ON account.account_id = sale.primary_account_id
      LEFT JOIN core.account_locations location
        ON location.account_id = sale.primary_account_id
      LEFT JOIN core.v_sales_media_summary media
        ON media.source_record_id = sale.source_record_id
      WHERE ${candidateWhere.join(" AND ")}
      ORDER BY sale.closing_date DESC NULLS LAST,
               sale.source_record_id DESC NULLS LAST,
               sale.sale_id DESC NULLS LAST
      LIMIT 10000
    `;
    const { rows: candidates } = await pool.query(
      candidateSql,
      candidateParams,
    );

    let missingLocationCount = 0;
    let unsupportedCountyCount = 0;
    let missingSquareFootageCount = 0;
    const scored = [];
    for (const candidate of candidates) {
      if (
        candidate.location_status !== "matched" ||
        candidate.latitude == null ||
        candidate.longitude == null
      ) {
        const candidateCounty = String(candidate.account_county || "")
          .trim()
          .toLowerCase();
        if (candidateCounty && !candidateCounty.includes("dallas")) {
          unsupportedCountyCount += 1;
        } else {
          missingLocationCount += 1;
        }
        continue;
      }
      const comparableSquareFeet =
        candidate.cad_living_area_sqft ?? candidate.mls_living_area;
      if (
        !Number.isFinite(Number(comparableSquareFeet)) ||
        Number(comparableSquareFeet) <= 0
      ) {
        missingSquareFootageCount += 1;
        continue;
      }
      const score = scoreComparable(
        {
          subjectLatitude: subject.latitude,
          subjectLongitude: subject.longitude,
          comparableLatitude: candidate.latitude,
          comparableLongitude: candidate.longitude,
          subjectSquareFeet: subject.living_area_sqft,
          comparableSquareFeet,
          closingDate: candidate.closing_date,
          referenceDate: effectiveDateTo,
        },
        scoringConfig,
      );
      if (!score) continue;
      scored.push({
        ...candidate,
        ...score,
        comparable_square_feet: Number(comparableSquareFeet),
        score_requires_review:
          Boolean(candidate.requires_additional_review) ||
          Boolean(candidate.location_review_required),
      });
    }

    const scoped = filterComparablesForMarket(
      scored,
      subject,
      marketBreakdown,
    );

    scoped.sort(
      (left, right) =>
        right.comparableScore - left.comparableScore ||
        left.distanceMiles - right.distanceMiles ||
        left.squareFootageDifferenceRatio -
          right.squareFootageDifferenceRatio ||
        String(right.closing_date || "").localeCompare(
          String(left.closing_date || ""),
        ),
    );
    scoped.forEach((candidate, index) => {
      candidate.score_rank = index + 1;
    });
    const recommendationResult = applyRecommendationPolicy(scoped, {
      referenceDate: effectiveDateTo,
      policy: {
        ...DEFAULT_RECOMMENDATION_POLICY,
        periodMonths: requestedPeriodMonths,
      },
    });
    const outlierResult = analyzeComparableOutliers(
      recommendationResult.sales,
      {
        ...DEFAULT_OUTLIER_ANALYSIS,
        scoreThreshold: outlierScoreThreshold,
      },
    );
    const analyzedSales = outlierResult.sales;
    const recommendedSales = analyzedSales.filter((sale) => sale.recommended);
    const competitiveSales = analyzedSales.filter(
      (sale) =>
        sale.insideAnalysisPeriod &&
        sale.soldWithinOneYear &&
        !sale.recommended,
    );

    const marketLabel = !marketBreakdown
      ? "All eligible sales"
      : marketBreakdown.scope === "city"
        ? [subject.city, subject.county].filter(Boolean).join(", ")
        : marketBreakdown.scope === "zip"
          ? `ZIP ${subject.postal_code}`
          : `Within ${marketBreakdown.radiusMiles} mile${marketBreakdown.radiusMiles === 1 ? "" : "s"} of ${subject.address || subject.account_id}`;

    res.json({
      subject: {
        account_id: subject.account_id,
        address: subject.address,
        city: subject.city,
        county: subject.county,
        postal_code: subject.postal_code,
        neighborhood_code: subject.neighborhood_code,
        living_area_sqft: Number(subject.living_area_sqft),
        latitude: Number(subject.latitude),
        longitude: Number(subject.longitude),
        location_source: subject.location_source,
        location_precision: subject.location_precision,
        location_confidence: subject.location_confidence,
        location_review_required: subject.location_review_required,
        location_review_reason: subject.location_review_reason,
        location_geocoded_at: subject.geocoded_at,
      },
      scoring: {
        ...scoringConfig,
        locationWeightPercent: Math.round(scoringConfig.locationWeight * 100),
        squareFootageWeightPercent: Math.round(
          scoringConfig.squareFootageWeight * 100,
        ),
        salesDateWeightPercent: Math.round(
          scoringConfig.salesDateWeight * 100,
        ),
        squareFootageScalePercent: Math.round(
          scoringConfig.squareFootageScaleRatio * 100,
        ),
        salesDateScaleDays: Math.round(scoringConfig.salesDateScaleDays),
        squareFootageIsHardFilter: false,
      },
      coverage: {
        candidate_count: candidates.length,
        eligible_count: scoped.length,
        total_scored_count: scored.length,
        scope_eligible_count: scoped.length,
        missing_location_count: missingLocationCount,
        unsupported_county_count: unsupportedCountyCount,
        missing_square_footage_count: missingSquareFootageCount,
        recommended_count: recommendedSales.length,
        older_than_two_years_count: analyzedSales.filter(
          (sale) => sale.soldOverTwoYears,
        ).length,
        older_than_one_year_count: analyzedSales.filter(
          (sale) => sale.soldOverOneYear,
        ).length,
        recent_high_score_count:
          recommendationResult.policy.recentHighScoreCount,
      },
      recommendation_policy: recommendationResult.policy,
      statistical_analysis: outlierResult.analysis,
      analysis_period: {
        analysis_as_of: effectiveDateTo,
        date_from: effectiveDateFrom,
        period_months: requestedPeriodMonths,
      },
      study_market: {
        key: marketBreakdown?.key || null,
        scope: marketBreakdown?.scope || null,
        radius_miles: marketBreakdown?.radiusMiles || null,
        label: marketLabel,
      },
      recommended_sales: recommendedSales,
      competitive_sales: competitiveSales.slice(0, resultLimit),
      sales: analyzedSales.slice(0, resultLimit),
    });
  } catch (err) {
    const message = err?.message || "comparable_recommendations_failed";
    if (String(message).startsWith("invalid_")) {
      return res.status(400).json({ error: message });
    }
    console.error("/api/sales/recommendations failed", err);
    res.status(500).json({ error: "comparable_recommendations_failed" });
  }
});

/**
 * GET /api/sales
 * Search transaction-level sales from core.v_sales_enriched.
 *
 * Supported filters:
 *   q, account_id, exclude_account_id, neighborhood_code, date_from,
 *   date_to, min_price, max_price, matched, review, multi_parcel,
 *   record_type, include_attached, limit, offset
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
    const recordType = String(req.query.record_type || "closed_sale").trim().toLowerCase();
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
    const includeAttached =
      parseOptionalBoolean(req.query.include_attached, "include_attached") ?? false;
    if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      return res.status(400).json({ error: "invalid_date_from" });
    }
    if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return res.status(400).json({ error: "invalid_date_to" });
    }
    if (multiParcel && !["single", "possible", "confirmed"].includes(multiParcel)) {
      return res.status(400).json({ error: "invalid_multi_parcel" });
    }
    if (!["closed_sale", "listing", "all"].includes(recordType)) {
      return res.status(400).json({ error: "invalid_record_type" });
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
    const activityDateColumn =
      recordType === "listing"
        ? "v.listing_contract_date"
        : recordType === "all"
          ? "COALESCE(v.closing_date, v.listing_contract_date)"
          : "v.closing_date";
    if (dateFrom) where.push(`${activityDateColumn} >= ${bind(dateFrom)}::date`);
    if (dateTo) where.push(`${activityDateColumn} <= ${bind(dateTo)}::date`);
    if (minPrice !== null) where.push(`v.sale_price >= ${bind(minPrice)}`);
    if (maxPrice !== null) where.push(`v.sale_price <= ${bind(maxPrice)}`);
    if (matched !== null) {
      where.push(matched ? "v.primary_account_id IS NOT NULL" : "v.primary_account_id IS NULL");
    }
    if (review !== null) where.push(`v.requires_additional_review = ${bind(review)}`);
    if (multiParcel) where.push(`v.multi_parcel_status = ${bind(multiParcel)}`);
    if (recordType !== "all") where.push(`v.record_type = ${bind(recordType)}`);
    if (!includeAttached) {
      where.push("v.attachment_type NOT IN ('attached', 'mixed')");
    }

    const sql = `
      SELECT
        v.sale_id,
        v.source_record_id,
        (
          SELECT source_record.listing_id
          FROM core.sales_source_records source_record
          WHERE source_record.id = v.source_record_id
        ) AS listing_id,
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
        v.record_type,
        v.structural_style,
        v.housing_type,
        v.attachment_type,
        v.architectural_style,
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
        v.cad_market_value,
        media.primary_photo_url,
        COALESCE(media.photo_count, 0) AS photo_count
      FROM core.v_sales_enriched v
      LEFT JOIN core.accounts sale_account
        ON sale_account.account_id = v.primary_account_id
      LEFT JOIN core.v_sales_media_summary media
        ON media.source_record_id = v.source_record_id
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
 * GET /api/sales/grouped-analysis
 *
 * Builds one-year grouped adjustment studies for any requested combination of
 * the subject's city, ZIP code, and cumulative one-through-five-mile radii.
 * Closed, single-parcel sales are grouped by total bathrooms, garage spaces,
 * pool presence, and ten ordered living-area bands. Missing garage spaces are
 * treated as zero only when the MLS explicitly says the property has no
 * garage.
 */
app.get("/api/sales/grouped-analysis", async (req, res) => {
  try {
    const subjectAccountId = String(
      req.query.subject_account_id || "",
    ).trim();
    const asOfDate = String(req.query.as_of || "").trim();
    const multipleBreakdownsRequested = req.query.breakdowns !== undefined;
    if (!/^[0-9A-Za-z]{17}$/.test(subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      return res.status(400).json({ error: "invalid_as_of" });
    }

    let requestedBreakdowns;
    try {
      requestedBreakdowns = parseGroupedAnalysisBreakdowns(
        req.query.breakdowns,
      );
    } catch (error) {
      return res.status(400).json({
        error: error?.message || "invalid_grouped_analysis_breakdown",
      });
    }

    await accountLocationsReady;
    const loadSubject = async () => {
      const subjectResult = await pool.query(
        `
          SELECT
            account.account_id,
            account.address,
            account.city,
            account.county,
            NULLIF(
              LEFT(
                REGEXP_REPLACE(COALESCE(account.postal_code, ''), '\\D', '', 'g'),
                5
              ),
              ''
            ) AS postal_code,
            location.latitude,
            location.longitude,
            location.status AS location_status
          FROM core.accounts account
          LEFT JOIN core.account_locations location
            ON location.account_id = account.account_id
          WHERE account.account_id = $1
        `,
        [subjectAccountId],
      );
      return subjectResult.rows[0] || null;
    };

    let subject = await loadSubject();
    if (!subject) {
      return res.status(404).json({ error: "subject_not_found" });
    }

    const radiusRequested = requestedBreakdowns.some(
      (breakdown) => breakdown.scope === "radius",
    );
    if (
      radiusRequested &&
      (
        subject.location_status !== "matched" ||
        subject.latitude == null ||
        subject.longitude == null
      )
    ) {
      try {
        await refreshAccountLocations(pool, [subject], { batchSize: 1 });
        subject = await loadSubject();
      } catch (error) {
        console.warn(
          "[grouped-analysis] subject location refresh failed; radius studies may be unavailable",
          error?.message || error,
        );
      }
    }

    const unavailableBreakdowns = [];
    const availableBreakdowns = requestedBreakdowns.filter((breakdown) => {
      if (breakdown.scope === "city" && !String(subject.city || "").trim()) {
        unavailableBreakdowns.push({
          key: breakdown.key,
          label: "Citywide",
          reason: "The subject city is unavailable.",
        });
        return false;
      }
      if (breakdown.scope === "zip" && !subject.postal_code) {
        unavailableBreakdowns.push({
          key: breakdown.key,
          label: "Subject ZIP code",
          reason: "The subject ZIP code is unavailable.",
        });
        return false;
      }
      if (
        breakdown.scope === "radius" &&
        (
          subject?.location_status !== "matched" ||
          subject?.latitude == null ||
          subject?.longitude == null
        )
      ) {
        unavailableBreakdowns.push({
          key: breakdown.key,
          label: `Within ${breakdown.radiusMiles} mile${breakdown.radiusMiles === 1 ? "" : "s"}`,
          reason: "The subject parcel location is unavailable.",
        });
        return false;
      }
      return true;
    });

    if (!multipleBreakdownsRequested && unavailableBreakdowns.length) {
      return res.status(422).json({
        error: "subject_market_area_unavailable",
        subject_account_id: subjectAccountId,
      });
    }

    const analyses = [];
    for (const breakdown of availableBreakdowns) {
      const { rows } = await pool.query(
      `
        WITH parameters AS (
          SELECT
            COALESCE(NULLIF($1, '')::date, CURRENT_DATE) AS period_end,
            BTRIM($2) AS subject_city,
            NULLIF(BTRIM($3), '') AS subject_county,
            NULLIF(BTRIM($4), '') AS subject_postal_code,
            $5::double precision AS subject_latitude,
            $6::double precision AS subject_longitude,
            $7::text AS breakdown_scope,
            $8::double precision AS radius_miles
        ),
        eligible AS (
          SELECT
            sale.sale_price::numeric AS sale_price,
            sale.closing_date,
            sale.mls_bathrooms_total_integer::integer AS bathrooms_total,
            CASE
              WHEN sale.mls_garage_spaces IS NOT NULL
                THEN ROUND(sale.mls_garage_spaces)::integer
              WHEN sale.mls_garage_yn = false
                THEN 0
              ELSE NULL
            END AS garage_spaces,
            COALESCE(sale.mls_pool_yn, sale.cad_pool) AS pool_yn,
            COALESCE(
              NULLIF(sale.mls_living_area, 0),
              NULLIF(sale.cad_living_area_sqft, 0)
            )::numeric AS living_area,
            sale.days_on_market
          FROM core.v_sales_enriched sale
          JOIN core.accounts sale_account
            ON sale_account.account_id = sale.primary_account_id
          LEFT JOIN core.account_locations sale_location
            ON sale_location.account_id = sale.primary_account_id
          CROSS JOIN parameters
          WHERE sale.record_type = 'closed_sale'
            AND sale.closing_date >=
              (parameters.period_end - INTERVAL '1 year')::date
            AND sale.closing_date <= parameters.period_end
            AND sale.sale_price >= 10000
            AND sale.multi_parcel_status = 'single'
            AND sale.attachment_type NOT IN ('attached', 'mixed')
            AND (
              (
                parameters.breakdown_scope = 'city'
                AND LOWER(BTRIM(sale_account.city)) =
                  LOWER(parameters.subject_city)
                AND (
                  parameters.subject_county IS NULL
                  OR REGEXP_REPLACE(
                    LOWER(BTRIM(sale_account.county)),
                    '\\s+county$',
                    ''
                  ) = REGEXP_REPLACE(
                    LOWER(parameters.subject_county),
                    '\\s+county$',
                    ''
                  )
                )
              )
              OR (
                parameters.breakdown_scope = 'zip'
                AND parameters.subject_postal_code IS NOT NULL
                AND NULLIF(
                  LEFT(
                    REGEXP_REPLACE(
                      COALESCE(
                        NULLIF(BTRIM(sale_account.postal_code), ''),
                        NULLIF(BTRIM(sale.zip), '')
                      ),
                      '\\D',
                      '',
                      'g'
                    ),
                    5
                  ),
                  ''
                ) = parameters.subject_postal_code
              )
              OR (
                parameters.breakdown_scope = 'radius'
                AND parameters.subject_latitude IS NOT NULL
                AND parameters.subject_longitude IS NOT NULL
                AND parameters.radius_miles IS NOT NULL
                AND sale_location.status = 'matched'
                AND sale_location.latitude IS NOT NULL
                AND sale_location.longitude IS NOT NULL
                AND (
                  3958.7613 * ACOS(
                    LEAST(
                      1.0,
                      GREATEST(
                        -1.0,
                        COS(RADIANS(parameters.subject_latitude)) *
                        COS(RADIANS(sale_location.latitude)) *
                        COS(
                          RADIANS(sale_location.longitude) -
                          RADIANS(parameters.subject_longitude)
                        ) +
                        SIN(RADIANS(parameters.subject_latitude)) *
                        SIN(RADIANS(sale_location.latitude))
                      )
                    )
                  )
                ) <= parameters.radius_miles
              )
            )
        ),
        living_area_ranked AS (
          SELECT
            eligible.*,
            NTILE(10) OVER (
              ORDER BY living_area, sale_price, closing_date
            ) AS living_area_group
          FROM eligible
          WHERE living_area > 0
        ),
        coverage AS (
          SELECT
            COUNT(*)::integer AS eligible_sale_count,
            COUNT(bathrooms_total)::integer AS bathroom_sale_count,
            COUNT(garage_spaces)::integer AS garage_sale_count,
            COUNT(pool_yn)::integer AS pool_sale_count,
            (COUNT(living_area) FILTER (WHERE living_area > 0))::integer
              AS living_area_sale_count,
            (SELECT period_end FROM parameters) AS period_end,
            (
              SELECT (period_end - INTERVAL '1 year')::date
              FROM parameters
            ) AS period_start
          FROM eligible
        ),
        dimension_rows AS (
          SELECT
            'bathrooms'::text AS dimension,
            bathrooms_total::text AS group_value,
            COUNT(*)::integer AS sample_size,
            MIN(sale_price) AS minimum_sale_price,
            MAX(sale_price) AS maximum_sale_price,
            AVG(sale_price) AS average_sale_price,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price) AS median_sale_price,
            percentile_cont(0.25) WITHIN GROUP
              (ORDER BY sale_price) AS lower_quartile_sale_price,
            percentile_cont(0.75) WITHIN GROUP
              (ORDER BY sale_price) AS upper_quartile_sale_price,
            stddev_samp(sale_price) AS sale_price_standard_deviation,
            AVG(sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS average_price_per_square_foot,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS median_price_per_square_foot,
            AVG(living_area) FILTER (WHERE living_area > 0)
              AS average_living_area,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY living_area)
              FILTER (WHERE living_area > 0) AS median_living_area,
            MIN(living_area) FILTER (WHERE living_area > 0)
              AS minimum_living_area,
            MAX(living_area) FILTER (WHERE living_area > 0)
              AS maximum_living_area,
            AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
              AS average_days_on_market,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
              FILTER (WHERE days_on_market >= 0) AS median_days_on_market
          FROM eligible
          WHERE bathrooms_total >= 1
          GROUP BY bathrooms_total

          UNION ALL

          SELECT
            'garage'::text AS dimension,
            garage_spaces::text AS group_value,
            COUNT(*)::integer AS sample_size,
            MIN(sale_price) AS minimum_sale_price,
            MAX(sale_price) AS maximum_sale_price,
            AVG(sale_price) AS average_sale_price,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price) AS median_sale_price,
            percentile_cont(0.25) WITHIN GROUP
              (ORDER BY sale_price) AS lower_quartile_sale_price,
            percentile_cont(0.75) WITHIN GROUP
              (ORDER BY sale_price) AS upper_quartile_sale_price,
            stddev_samp(sale_price) AS sale_price_standard_deviation,
            AVG(sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS average_price_per_square_foot,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS median_price_per_square_foot,
            AVG(living_area) FILTER (WHERE living_area > 0)
              AS average_living_area,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY living_area)
              FILTER (WHERE living_area > 0) AS median_living_area,
            MIN(living_area) FILTER (WHERE living_area > 0)
              AS minimum_living_area,
            MAX(living_area) FILTER (WHERE living_area > 0)
              AS maximum_living_area,
            AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
              AS average_days_on_market,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
              FILTER (WHERE days_on_market >= 0) AS median_days_on_market
          FROM eligible
          WHERE garage_spaces >= 0
          GROUP BY garage_spaces

          UNION ALL

          SELECT
            'pool'::text AS dimension,
            pool_yn::text AS group_value,
            COUNT(*)::integer AS sample_size,
            MIN(sale_price) AS minimum_sale_price,
            MAX(sale_price) AS maximum_sale_price,
            AVG(sale_price) AS average_sale_price,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price) AS median_sale_price,
            percentile_cont(0.25) WITHIN GROUP
              (ORDER BY sale_price) AS lower_quartile_sale_price,
            percentile_cont(0.75) WITHIN GROUP
              (ORDER BY sale_price) AS upper_quartile_sale_price,
            stddev_samp(sale_price) AS sale_price_standard_deviation,
            AVG(sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS average_price_per_square_foot,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS median_price_per_square_foot,
            AVG(living_area) FILTER (WHERE living_area > 0)
              AS average_living_area,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY living_area)
              FILTER (WHERE living_area > 0) AS median_living_area,
            MIN(living_area) FILTER (WHERE living_area > 0)
              AS minimum_living_area,
            MAX(living_area) FILTER (WHERE living_area > 0)
              AS maximum_living_area,
            AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
              AS average_days_on_market,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
              FILTER (WHERE days_on_market >= 0) AS median_days_on_market
          FROM eligible
          WHERE pool_yn IS NOT NULL
          GROUP BY pool_yn

          UNION ALL

          SELECT
            'living_area'::text AS dimension,
            living_area_group::text AS group_value,
            COUNT(*)::integer AS sample_size,
            MIN(sale_price) AS minimum_sale_price,
            MAX(sale_price) AS maximum_sale_price,
            AVG(sale_price) AS average_sale_price,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price) AS median_sale_price,
            percentile_cont(0.25) WITHIN GROUP
              (ORDER BY sale_price) AS lower_quartile_sale_price,
            percentile_cont(0.75) WITHIN GROUP
              (ORDER BY sale_price) AS upper_quartile_sale_price,
            stddev_samp(sale_price) AS sale_price_standard_deviation,
            AVG(sale_price / living_area)
              AS average_price_per_square_foot,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price / living_area)
              AS median_price_per_square_foot,
            AVG(living_area) AS average_living_area,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY living_area) AS median_living_area,
            MIN(living_area) AS minimum_living_area,
            MAX(living_area) AS maximum_living_area,
            AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
              AS average_days_on_market,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
              FILTER (WHERE days_on_market >= 0) AS median_days_on_market
          FROM living_area_ranked
          GROUP BY living_area_group
        )
        SELECT dimension_rows.*, coverage.*
        FROM dimension_rows
        CROSS JOIN coverage
        ORDER BY
          CASE dimension
            WHEN 'bathrooms' THEN 1
            WHEN 'garage' THEN 2
            WHEN 'pool' THEN 3
            ELSE 4
          END,
          CASE
            WHEN dimension = 'pool' AND group_value = 'false' THEN 0
            WHEN dimension = 'pool' AND group_value = 'true' THEN 1
            ELSE group_value::integer
          END
      `,
      [
        asOfDate,
        String(subject.city || ""),
        String(subject.county || ""),
        String(subject.postal_code || ""),
        subject.latitude == null ? null : Number(subject.latitude),
        subject.longitude == null ? null : Number(subject.longitude),
        breakdown.scope,
        breakdown.radiusMiles,
      ],
    );

      const coverageRow = rows[0] || {};
      const marketLabel =
        breakdown.scope === "city"
          ? [subject.city, subject.county].filter(Boolean).join(", ")
          : breakdown.scope === "zip"
            ? `ZIP ${subject.postal_code}`
            : `Within ${breakdown.radiusMiles} mile${breakdown.radiusMiles === 1 ? "" : "s"} of ${subject.address || subject.account_id}`;
      analyses.push({
        subject: {
          account_id: subject.account_id,
          address: subject.address,
        },
        market: {
          key: breakdown.key,
          scope: breakdown.scope,
          city: subject.city,
          county: subject.county,
          postal_code: subject.postal_code,
          radius_miles: breakdown.radiusMiles,
          label: marketLabel,
        },
        period: {
          start: coverageRow.period_start || null,
          end: coverageRow.period_end || asOfDate || null,
        },
        population: {
          eligible_sale_count: Number(coverageRow.eligible_sale_count || 0),
          bathroom_sale_count: Number(coverageRow.bathroom_sale_count || 0),
          garage_sale_count: Number(coverageRow.garage_sale_count || 0),
          pool_sale_count: Number(coverageRow.pool_sale_count || 0),
          living_area_sale_count: Number(coverageRow.living_area_sale_count || 0),
        },
        filters: {
          record_type: "closed_sale",
          minimum_sale_price: 10000,
          multi_parcel_status: "single",
          attached_housing_excluded: true,
          period_years: 1,
        },
        dimensions: buildGroupedAnalysis(rows),
      });
    }

    if (!multipleBreakdownsRequested) {
      return res.json(analyses[0]);
    }

    res.json({
      subject: {
        account_id: subject.account_id,
        address: subject.address,
        city: subject.city,
        county: subject.county,
        postal_code: subject.postal_code,
        latitude: subject.latitude == null ? null : Number(subject.latitude),
        longitude: subject.longitude == null ? null : Number(subject.longitude),
      },
      analyses,
      unavailable_breakdowns: unavailableBreakdowns,
    });
  } catch (error) {
    console.error("/api/sales/grouped-analysis failed", error);
    res.status(500).json({
      error: "grouped_analysis_failed",
      ...(process.env.GROUPED_ANALYSIS_DEBUG === "true"
        ? {
            detail: error?.message || String(error),
            database_code: error?.code || null,
          }
        : {}),
    });
  }
});

/**
 * GET /api/sales/market-context
 *
 * Returns the subject location and market identifiers needed to center the
 * market-conditions map before a study is run.
 */
app.get("/api/sales/market-context", async (req, res) => {
  const subjectAccountId = String(
    req.query.subject_account_id || "",
  ).trim();
  try {
    const subject = await getMarketContext(pool, subjectAccountId);
    res.json({ subject });
  } catch (error) {
    const message = error?.message || "market_context_failed";
    console.error("/api/sales/market-context failed", error);
    res.status(marketConditionsErrorStatus(message)).json({
      error: message,
      ...(error?.detail ? { detail: error.detail } : {}),
    });
  }
});

/**
 * POST /api/sales/market-analysis
 *
 * Builds independent market-conditions studies for any requested combination
 * of city, ZIP, cumulative one-through-five-mile radii, and an appraiser-drawn
 * GeoJSON polygon. These areas do not filter comparable recommendations.
 */
app.post("/api/sales/market-analysis", async (req, res) => {
  try {
    const result = await buildMarketConditionsAnalyses(pool, {
      subjectAccountId: String(
        req.body?.subject_account_id || "",
      ).trim(),
      areaKeys: req.body?.area_keys,
      asOfDate: String(req.body?.as_of || "").trim(),
      periodMonths: req.body?.period_months ?? 24,
      customGeometry: req.body?.custom_geometry || null,
    });
    res.json(result);
  } catch (error) {
    const message = error?.message || "market_analysis_failed";
    console.error("/api/sales/market-analysis failed", error);
    res.status(marketConditionsErrorStatus(message)).json({
      error: message,
      ...(error?.detail ? { detail: error.detail } : {}),
    });
  }
});

/**
 * GET /api/sales/:sourceRecordId/photos
 * Lazily loads an ordered gallery after the user opens a comparable image.
 */
app.get("/api/sales/:sourceRecordId/photos", async (req, res) => {
  const sourceRecordId = String(req.params.sourceRecordId || "").trim();
  if (!/^[1-9][0-9]*$/.test(sourceRecordId)) {
    return res.status(400).json({ error: "invalid_source_record_id" });
  }
  try {
    const { rows: sourceRows } = await pool.query(
      `
        SELECT id AS source_record_id, listing_key, listing_id, source_name
        FROM core.sales_source_records
        WHERE id = $1
      `,
      [sourceRecordId],
    );
    if (!sourceRows.length) {
      return res.status(404).json({ error: "sale_source_record_not_found" });
    }
    const { rows: photos } = await pool.query(
      `
        SELECT
          id,
          source_record_id,
          media_url,
          order_number,
          preferred_photo_yn AS is_primary,
          short_description AS caption,
          mime_type,
          permission,
          modification_timestamp
        FROM core.sales_source_media
        WHERE source_record_id = $1
          AND media_category = 'image'
        ORDER BY
          preferred_photo_yn DESC,
          order_number NULLS LAST,
          id
      `,
      [sourceRecordId],
    );
    res.json({
      ...sourceRows[0],
      photos,
    });
  } catch (error) {
    console.error("/api/sales/:sourceRecordId/photos failed", error);
    res.status(500).json({ error: "sale_photos_failed" });
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
