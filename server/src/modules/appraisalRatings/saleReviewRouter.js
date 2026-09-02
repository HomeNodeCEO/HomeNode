import express from "express";

import { SALE_REVIEW_SELECT } from "../../services/appraisalRatings.js";
import { normalizeAppraisalRatingUpdate } from "../../util/appraisalRatings.js";

const SOURCE_RECORD_ID_PATTERN = /^\d+$/;

export function createSaleReviewRouter({
  pool,
  ratingsReady,
  requireEditor,
  normalizeRatingUpdate = normalizeAppraisalRatingUpdate,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("sale_review_pool_required");
  }
  if (!ratingsReady || typeof ratingsReady.then !== "function") {
    throw new TypeError("sale_review_readiness_required");
  }
  if (typeof requireEditor !== "function") {
    throw new TypeError("sale_review_editor_policy_required");
  }
  if (typeof normalizeRatingUpdate !== "function") {
    throw new TypeError("sale_review_normalizer_required");
  }

  const router = express.Router();

  /** Batch-load manually verified condition and quality ratings for MLS source rows. */
  router.get("/api/sales/reviews", async (req, res) => {
    const rawIds = String(req.query.source_record_ids || "").split(",");
    const sourceRecordIds = [...new Set(rawIds.map((value) => value.trim()))]
      .filter((value) => SOURCE_RECORD_ID_PATTERN.test(value))
      .slice(0, 200);
    if (!sourceRecordIds.length) return res.json({ reviews: [] });
    try {
      await ratingsReady;
      const { rows } = await pool.query(
        `${SALE_REVIEW_SELECT} WHERE source_record_id = ANY($1::bigint[])
         ORDER BY source_record_id`,
        [sourceRecordIds],
      );
      return res.json({ reviews: rows });
    } catch (error) {
      logger.error?.("/api/sales/reviews failed", error);
      return res.status(500).json({ error: "sale_reviews_failed" });
    }
  });

  /** Explicitly save a reviewed comparable rating without mutating its source MLS row. */
  router.patch("/api/sales/:sourceRecordId/review", async (req, res) => {
    const sourceRecordId = String(req.params.sourceRecordId || "").trim();
    if (!SOURCE_RECORD_ID_PATTERN.test(sourceRecordId)) {
      return res.status(400).json({ error: "invalid_source_record_id" });
    }
    if (!requireEditor(req, res)) return undefined;

    let update;
    try {
      update = normalizeRatingUpdate(req.body);
    } catch (error) {
      return res.status(400).json({ error: error?.message || "invalid_appraisal_rating" });
    }

    const client = await pool.connect();
    try {
      await ratingsReady;
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
        update.expectedRevision != null
        && update.expectedRevision !== currentRevision
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
      logger.error?.("/api/sales/:sourceRecordId/review failed", error);
      return res.status(500).json({ error: "sale_review_update_failed" });
    } finally {
      client.release();
    }
  });

  router.get("/api/sales/:sourceRecordId/review-history", async (req, res) => {
    const sourceRecordId = String(req.params.sourceRecordId || "").trim();
    if (!SOURCE_RECORD_ID_PATTERN.test(sourceRecordId)) {
      return res.status(400).json({ error: "invalid_source_record_id" });
    }
    try {
      await ratingsReady;
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
      logger.error?.("sale review history failed", error);
      return res.status(500).json({ error: "sale_review_history_failed" });
    }
  });

  return router;
}
