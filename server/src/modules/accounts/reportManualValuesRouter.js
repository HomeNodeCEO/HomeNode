import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeHousingProfileUpdate } from "../../util/housingProfileEdit.js";
import { validateReportManualSection } from "../../util/reportManualValues.js";

export const REPORT_MANUAL_SECTION_KEYS = new Set([
  "report.subject_identification",
  "report.exemptions",
  "report.sales_history",
  "report.property_characteristics",
  "report.land_details",
  "report.appraisal_values",
  "report.assignment_details",
]);

const MAX_REPORT_SECTIONS_BYTES = 250_000;
const REPORT_ACCOUNT_ID = /^[0-9A-Za-z_-]{1,50}$/;

export function createReportManualValuesRouter({
  pool,
  propertyEnrichmentReady,
  requireEditor,
  resolveAccountId = resolveCanonicalAccountId,
  validateSection = validateReportManualSection,
  normalizeHousingProfile = normalizeHousingProfileUpdate,
  logger = console,
} = {}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("report_manual_values_pool_required");
  }
  if (!propertyEnrichmentReady || typeof propertyEnrichmentReady.then !== "function") {
    throw new TypeError("report_manual_values_readiness_required");
  }
  if (typeof requireEditor !== "function") {
    throw new TypeError("report_manual_values_editor_policy_required");
  }
  if (typeof resolveAccountId !== "function") {
    throw new TypeError("report_manual_values_resolver_required");
  }
  if (typeof validateSection !== "function") {
    throw new TypeError("report_manual_values_validator_required");
  }
  if (typeof normalizeHousingProfile !== "function") {
    throw new TypeError("report_manual_values_housing_normalizer_required");
  }

  const router = express.Router();

  router.patch("/api/accounts/:id/report-manual-values", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    if (!REPORT_ACCOUNT_ID.test(requestedId)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireEditor(req, res)) return undefined;
    const sections = req.body?.sections;
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
      return res.status(400).json({ error: "invalid_report_sections" });
    }
    const entries = Object.entries(sections);
    if (
      !entries.length ||
      entries.length > REPORT_MANUAL_SECTION_KEYS.size ||
      entries.some(([key, value]) =>
        !REPORT_MANUAL_SECTION_KEYS.has(key) || value === undefined
      )
    ) {
      return res.status(400).json({ error: "invalid_report_sections" });
    }
    const serializedSize = Buffer.byteLength(JSON.stringify(sections), "utf8");
    if (serializedSize > MAX_REPORT_SECTIONS_BYTES) {
      return res.status(413).json({ error: "report_sections_too_large" });
    }
    try {
      for (const [key, value] of entries) validateSection(key, value);
    } catch (error) {
      return res.status(400).json({
        error: error?.message || "invalid_report_section_value",
      });
    }

    const reviewer = String(req.body?.reviewer || "HomeNode editor")
      .trim()
      .slice(0, 200) || "HomeNode editor";
    const notes = String(req.body?.notes || "Property Report manual edit")
      .trim()
      .slice(0, 4000) || null;
    let housingUpdate = null;
    const characteristics = sections["report.property_characteristics"];
    if (
      characteristics?.housing_profile?.housing_type &&
      typeof characteristics.housing_profile === "object"
    ) {
      try {
        housingUpdate = normalizeHousingProfile({
          ...characteristics.housing_profile,
          notes,
        });
      } catch (error) {
        return res.status(400).json({
          error: error?.message || "invalid_housing_profile",
        });
      }
    }
    const client = await pool.connect();
    try {
      await propertyEnrichmentReady;
      await client.query("BEGIN");
      const canonicalId = await resolveAccountId(client, requestedId);
      const accountResult = await client.query(
        "SELECT 1 FROM core.accounts WHERE account_id = $1",
        [canonicalId],
      );
      if (!accountResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "account_not_found" });
      }

      if (housingUpdate) {
        await client.query(
          `INSERT INTO core.account_housing_profiles (
             account_id, structural_style, housing_type, attachment_type,
             architectural_style, source_name, observed_at, confidence, notes
           ) VALUES ($1,$2,$3,$4,$5,'HomeNode Property Report manual edit',now(),1.000,$6)
           ON CONFLICT (account_id) DO UPDATE SET
             structural_style = EXCLUDED.structural_style,
             housing_type = EXCLUDED.housing_type,
             attachment_type = EXCLUDED.attachment_type,
             architectural_style = EXCLUDED.architectural_style,
             source_name = EXCLUDED.source_name,
             observed_at = EXCLUDED.observed_at,
             confidence = EXCLUDED.confidence,
             notes = EXCLUDED.notes,
             updated_at = now()`,
          [
            canonicalId,
            housingUpdate.structuralStyle,
            housingUpdate.housingType,
            housingUpdate.attachmentType,
            housingUpdate.architecturalStyle,
            housingUpdate.notes,
          ],
        );
      }

      const savedEntries = [];
      for (const [attributeKey, attributeValue] of entries) {
        const { rows: currentRows } = await client.query(
          `SELECT revision FROM app.property_attribute_manual_values
           WHERE account_id = $1 AND attribute_key = $2 FOR UPDATE`,
          [canonicalId, attributeKey],
        );
        const revision = Number(currentRows[0]?.revision || 0) + 1;
        const valueJson = JSON.stringify(attributeValue);
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
           RETURNING attribute_key, attribute_value, revision, reviewer, notes, updated_at`,
          [canonicalId, attributeKey, valueJson, notes, reviewer, revision],
        );
        await client.query(
          `INSERT INTO app.property_attribute_manual_history (
             account_id, attribute_key, attribute_value, notes, reviewer, revision
           ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
          [canonicalId, attributeKey, valueJson, notes, reviewer, revision],
        );
        savedEntries.push([attributeKey, {
          value: rows[0].attribute_value,
          revision: Number(rows[0].revision),
          reviewer: rows[0].reviewer,
          notes: rows[0].notes,
          updated_at: rows[0].updated_at,
        }]);
      }
      await client.query("COMMIT");
      return res.json({
        ok: true,
        account_id: canonicalId,
        manual_values: Object.fromEntries(savedEntries),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error?.("/api/accounts/:id/report-manual-values failed", error);
      return res.status(500).json({ error: "report_manual_values_update_failed" });
    } finally {
      client.release();
    }
  });

  return router;
}
