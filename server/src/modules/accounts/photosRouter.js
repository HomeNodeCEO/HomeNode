import express from "express";

export function createAccountPhotosRouter({
  pool,
  accountIdAllowed,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("account_photos_query_client_required");
  }
  if (typeof accountIdAllowed !== "function") {
    throw new TypeError("account_photos_account_policy_required");
  }

  const router = express.Router();

  router.get("/api/accounts/:id/photos", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!accountIdAllowed(id)) {
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
      return res.json({
        account_id: id,
        ...source,
        photos,
      });
    } catch (error) {
      logger.error?.("/api/accounts/:id/photos failed", error);
      return res.status(500).json({ error: "account_photos_failed" });
    }
  });

  return router;
}
