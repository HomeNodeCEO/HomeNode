import express from "express";

import { fetchParcelAreaSuggestion } from "../../services/parcelGis.js";
import { assertPropertyAttributeKey } from "../../util/nonDallasEnrichment.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;
const SUGGESTION_ID_PATTERN = /^\d+$/;
const SUGGESTION_DECISIONS = new Set(["approved", "rejected"]);

export function createEnrichmentMutationRouter({
  pool,
  propertyEnrichmentReady,
  trestleClient,
  getNonDallasAccount,
  requireEditor,
  fetchParcelSuggestion = fetchParcelAreaSuggestion,
  assertAttributeKey = assertPropertyAttributeKey,
  logger = console,
} = {}) {
  if (
    !pool
    || typeof pool.query !== "function"
    || typeof pool.connect !== "function"
  ) {
    throw new TypeError("enrichment_mutation_pool_required");
  }
  if (!propertyEnrichmentReady || typeof propertyEnrichmentReady.then !== "function") {
    throw new TypeError("enrichment_mutation_readiness_required");
  }
  if (!trestleClient || typeof trestleClient.findProperty !== "function") {
    throw new TypeError("enrichment_mutation_trestle_client_required");
  }
  if (typeof requireEditor !== "function") {
    throw new TypeError("enrichment_mutation_editor_policy_required");
  }
  if (
    typeof getNonDallasAccount !== "function"
    || typeof fetchParcelSuggestion !== "function"
    || typeof assertAttributeKey !== "function"
  ) {
    throw new TypeError("enrichment_mutation_dependency_required");
  }

  const router = express.Router();

  /** Save a verified non-Dallas attribute. No autosave and no source-row mutation. */
  router.patch("/api/accounts/:id/verified-attribute", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireEditor(req, res)) return undefined;
    let attributeKey;
    try {
      attributeKey = assertAttributeKey(req.body?.attribute_key);
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
      logger.error?.("verified attribute update failed", error);
      return res.status(500).json({ error: "verified_attribute_update_failed" });
    } finally {
      client.release();
    }
  });

  /** Calculate and store a review-only lot-area suggestion from official county GIS. */
  router.post("/api/accounts/:id/parcel-area-suggestion", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireEditor(req, res)) return undefined;
    try {
      await propertyEnrichmentReady;
      const account = await getNonDallasAccount(pool, id);
      if (!account) return res.status(404).json({ error: "account_not_found" });
      const suggestion = await fetchParcelSuggestion({
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
      logger.error?.("parcel area suggestion failed", error);
      return res.status(500).json({ error: message || "parcel_area_suggestion_failed" });
    }
  });

  router.post("/api/accounts/:id/parcel-area-suggestions/:suggestionId/decision", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const suggestionId = String(req.params.suggestionId || "").trim();
    const decision = String(req.body?.decision || "").trim().toLowerCase();
    if (!ACCOUNT_ID_PATTERN.test(id) || !SUGGESTION_ID_PATTERN.test(suggestionId)) {
      return res.status(400).json({ error: "invalid_suggestion_target" });
    }
    if (!SUGGESTION_DECISIONS.has(decision)) {
      return res.status(400).json({ error: "invalid_suggestion_decision" });
    }
    if (!requireEditor(req, res)) return undefined;
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
      logger.error?.("parcel suggestion decision failed", error);
      return res.status(500).json({ error: "parcel_suggestion_decision_failed" });
    } finally {
      client.release();
    }
  });

  /** Preview licensed Trestle data; activation remains off until credentials exist. */
  router.post("/api/accounts/:id/trestle-preview", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireEditor(req, res)) return undefined;
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
      logger.error?.("Trestle preview failed", error);
      return res.status(502).json({ error: message || "trestle_preview_failed" });
    }
  });

  return router;
}
