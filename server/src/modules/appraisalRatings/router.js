import express from "express";

import { SUBJECT_RATING_SELECT } from "../../services/appraisalRatings.js";
import {
  normalizeAppraisalRatingUpdate,
  normalizeEffectiveDate,
  publicEffectiveDateErrorCode,
  publicRatingUpdateErrorCode,
} from "../../util/appraisalRatings.js";

function authenticatedReviewer(req) {
  const userId = String(req.mobileAuth?.userId || "").trim();
  if (!userId) return null;
  for (const value of [req.mobileAuth?.displayName, req.mobileAuth?.email, userId]) {
    const label = String(value || "").trim();
    if (label) return label.slice(0, 200);
  }
  return null;
}

function logFailure(logger, code) {
  try { logger.error?.(code); } catch { /* Preserve the fixed response. */ }
}

export function createAppraisalRatingsRouter({
  pool,
  ratingsReady,
  accountIdAllowed,
  requireEditor,
  normalizeDate = normalizeEffectiveDate,
  normalizeRatingUpdate = normalizeAppraisalRatingUpdate,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("appraisal_ratings_pool_required");
  }
  if (!ratingsReady || typeof ratingsReady.then !== "function") {
    throw new TypeError("appraisal_ratings_readiness_required");
  }
  if (typeof accountIdAllowed !== "function") {
    throw new TypeError("appraisal_ratings_account_policy_required");
  }
  if (typeof requireEditor !== "function") {
    throw new TypeError("appraisal_ratings_editor_policy_required");
  }
  if (typeof normalizeDate !== "function" || typeof normalizeRatingUpdate !== "function") {
    throw new TypeError("appraisal_ratings_normalizer_required");
  }

  const router = express.Router();

  router.get("/api/accounts/:id/appraisal-rating", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!accountIdAllowed(id)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    let effectiveDate;
    try {
      effectiveDate = normalizeDate(req.query.effective_date);
    } catch (error) {
      const code = publicEffectiveDateErrorCode(error);
      if (code) return res.status(400).json({ error: code });
      logFailure(logger, "subject_rating_validation_failed");
      return res.set("cache-control", "no-store")
        .status(500).json({ error: "subject_rating_failed" });
    }
    try {
      await ratingsReady;
      const { rows } = await pool.query(
        `${SUBJECT_RATING_SELECT}
         WHERE account_id = $1 AND effective_date = $2::date`,
        [id, effectiveDate],
      );
      return res.json({ rating: rows[0] || null });
    } catch {
      logFailure(logger, "subject_rating_load_failed");
      return res.status(500).json({ error: "subject_rating_failed" });
    }
  });

  router.put("/api/accounts/:id/appraisal-rating", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!accountIdAllowed(id)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireEditor(req, res)) return undefined;
    const reviewer = authenticatedReviewer(req);
    if (!reviewer) {
      return res.set("cache-control", "no-store")
        .status(401)
        .json({ error: "authentication_required" });
    }

    let effectiveDate;
    let update;
    try {
      effectiveDate = normalizeDate(req.body?.effective_date);
      update = normalizeRatingUpdate(req.body);
    } catch (error) {
      const code = publicEffectiveDateErrorCode(error) || publicRatingUpdateErrorCode(error);
      if (code) return res.status(400).json({ error: code });
      logFailure(logger, "subject_rating_validation_failed");
      return res.set("cache-control", "no-store")
        .status(500).json({ error: "subject_rating_update_failed" });
    }

    let client;
    try {
      await ratingsReady;
      client = await pool.connect();
      await client.query("BEGIN");
      const accountResult = await client.query(
        // Serialize the first rating too: the dated rating row may not exist yet.
        "SELECT 1 FROM core.accounts WHERE account_id = $1 FOR NO KEY UPDATE",
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
      if (update.expectedRevision != null && update.expectedRevision !== currentRevision) {
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
          reviewer,
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
    } catch {
      if (client) await client.query("ROLLBACK").catch(() => {});
      logFailure(logger, "subject_rating_update_failed");
      return res.status(500).json({ error: "subject_rating_update_failed" });
    } finally {
      client?.release();
    }
  });

  router.get("/api/accounts/:id/appraisal-rating-history", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!accountIdAllowed(id)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    try {
      await ratingsReady;
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
    } catch {
      logFailure(logger, "subject_rating_history_failed");
      return res.status(500).json({ error: "subject_rating_history_failed" });
    }
  });

  return router;
}
