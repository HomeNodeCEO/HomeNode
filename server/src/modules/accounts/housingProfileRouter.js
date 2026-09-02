import express from "express";

import { normalizeHousingProfileUpdate } from "../../util/housingProfileEdit.js";

export function createHousingProfileRouter({
  pool,
  accountIdAllowed,
  requireWorkflowAccess,
  normalizeUpdate = normalizeHousingProfileUpdate,
  logger = console,
} = {}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("housing_profile_pool_required");
  }
  if (typeof accountIdAllowed !== "function") {
    throw new TypeError("housing_profile_account_policy_required");
  }
  if (typeof requireWorkflowAccess !== "function") {
    throw new TypeError("housing_profile_workflow_policy_required");
  }
  if (typeof normalizeUpdate !== "function") {
    throw new TypeError("housing_profile_normalizer_required");
  }

  const router = express.Router();

  router.patch("/api/accounts/:id/housing-profile", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!accountIdAllowed(id)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "write")) return undefined;

    let update;
    try {
      update = normalizeUpdate(req.body);
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
      logger.error?.("/api/accounts/:id/housing-profile failed", error);
      return res.status(500).json({ error: "housing_profile_update_failed" });
    } finally {
      client.release();
    }
  });

  return router;
}
