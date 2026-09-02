import express from "express";

import { SUBJECT_RATING_SELECT } from "../../services/appraisalRatings.js";
import {
  normalizeAppraisalRatingUpdate,
  normalizeEffectiveDate,
} from "../../util/appraisalRatings.js";

export function createAppraisalRatingsRouter({
  pool,
  ratingsReady,
  accountIdAllowed,
  requireEditor,
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

  const router = express.Router();

  router.get("/api/accounts/:id/appraisal-rating", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!accountIdAllowed(id)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    let effectiveDate;
    try {
      effectiveDate = normalizeEffectiveDate(req.query.effective_date);
    } catch (error) {
      return res.status(400).json({ error: error?.message || "invalid_effective_date" });
    }
    try {
      await ratingsReady;
      const { rows } = await pool.query(
        `${SUBJECT_RATING_SELECT}
         WHERE account_id = $1 AND effective_date = $2::date`,
        [id, effectiveDate],
      );
      return res.json({ rating: rows[0] || null });
    } catch (error) {
      logger.error?.("subject appraisal rating load failed", error);
      return res.status(500).json({ error: "subject_rating_failed" });
    }
  });

  router.put("/api/accounts/:id/appraisal-rating", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!accountIdAllowed(id)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireEditor(req, res)) return undefined;

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
      await ratingsReady;
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
      logger.error?.("subject appraisal rating update failed", error);
      return res.status(500).json({ error: "subject_rating_update_failed" });
    } finally {
      client.release();
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
    } catch (error) {
      logger.error?.("subject appraisal rating history failed", error);
      return res.status(500).json({ error: "subject_rating_history_failed" });
    }
  });

  return router;
}
