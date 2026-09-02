import express from "express";

export function createSalesMediaRouter({ pool, logger = console } = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("sales_media_pool_required");
  }

  const router = express.Router();

  /** Lazily load an ordered gallery after the user opens a comparable image. */
  router.get("/api/sales/:sourceRecordId/photos", async (req, res) => {
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
      return res.json({
        ...sourceRows[0],
        photos,
      });
    } catch (error) {
      logger.error?.("/api/sales/:sourceRecordId/photos failed", error);
      return res.status(500).json({ error: "sale_photos_failed" });
    }
  });

  return router;
}
