import { createHash } from "node:crypto";
import pg from "pg";

import { signUadWorkfile } from "../src/modules/uad/certifications.js";
import { generateUadXmlArtifact } from "../src/modules/uad/uadArtifacts.js";
import { generateUadSubmissionPackage } from "../src/modules/uad/uadPackageArtifacts.js";
import { generateUadPdfArtifact } from "../src/modules/uad/uadPdfArtifacts.js";
import { runLocalUadValidation } from "../src/modules/uad/validation.js";

const ACCOUNT_ID = "UAD-STAGING-SFR-0001";
const APPRAISER_ID = "00000000-0000-4000-8000-000000000902";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000901";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_SHA256 = createHash("sha256").update(PNG).digest("hex");

if (process.env.NODE_ENV !== "test") throw new Error("successful delivery database verification is test-only");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

function deterministicUuid(value) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  const normalized = hex.join("");
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

function memoryStorage(objects) {
  return {
    configured: true,
    provider: "r2",
    bucket: "homenode-uad-delivery-test",
    async putObject({ objectKey, contentType, body }) {
      const value = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body);
      objects.set(objectKey, { body: value, content_type: contentType });
      return { byte_size: value.length, etag: `synthetic-${createHash("sha256").update(value).digest("hex").slice(0, 16)}` };
    },
    async getObject({ objectKey }) {
      const value = objects.get(objectKey);
      if (!value) throw new Error("synthetic_object_not_found");
      return { body: Buffer.from(value.body), byte_size: value.body.length, content_type: value.content_type };
    },
    createDownloadUrl({ objectKey }) {
      return { url: `https://download.invalid/${encodeURIComponent(objectKey)}`, expires_in_seconds: 300 };
    },
  };
}

async function seedAsset(pool, objects, workfileId, entityId, sectionNumber, captionType, ordinal, assetKind = "photo") {
  const identity = `${entityId || "root"}:${sectionNumber}:${captionType}:${ordinal}`;
  const id = deterministicUuid(`uad-successful-delivery:${identity}`);
  const objectKey = `synthetic-only/uad-successful-delivery/${id}/fixture.png`;
  objects.set(objectKey, { body: PNG, content_type: "image/png" });
  await pool.query(
    `INSERT INTO appraisal.uad_assets (
       id, workfile_id, entity_id, asset_kind, section_number, caption_type,
       caption, storage_provider, storage_bucket, object_key, original_file_name,
       content_type, byte_size, checksum_sha256, status, capture_metadata,
       uploaded_at, verified_at, created_by_user_id, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'Synthetic successful-delivery evidence',
       'r2', 'homenode-uad-delivery-test', $7, $8, 'image/png', $9, $10,
       'verified', '{"synthetic":true,"environment":"test"}'::jsonb,
       timestamptz '2026-08-21 12:00:00+00', timestamptz '2026-08-21 12:00:00+00',
       $11, timestamptz '2026-08-21 12:00:00+00', timestamptz '2026-08-21 12:00:00+00'
     )
     ON CONFLICT (id) DO UPDATE SET
       entity_id = EXCLUDED.entity_id,
       section_number = EXCLUDED.section_number,
       caption_type = EXCLUDED.caption_type,
       byte_size = EXCLUDED.byte_size,
       checksum_sha256 = EXCLUDED.checksum_sha256,
       status = 'verified'`,
    [
      id, workfileId, entityId, assetKind, sectionNumber, captionType,
      objectKey, `${captionType}-${ordinal}.png`, PNG.length, PNG_SHA256, APPRAISER_ID,
    ],
  );
}

async function seedRequiredAssets(pool, objects, workfileId) {
  await seedAsset(pool, objects, workfileId, null, 4, "WaterFrontage", 1);
  await seedAsset(pool, objects, workfileId, null, 7, "SubjectPropertyImprovementSketch", 1, "sketch");
  const result = await pool.query(
    `SELECT entity.id, entity.entity_type,
            value.value #>> '{}' AS subtype
       FROM appraisal.uad_entities AS entity
       LEFT JOIN LATERAL (
         SELECT field.value
           FROM appraisal.uad_field_values AS field
          WHERE field.workfile_id = entity.workfile_id
            AND field.entity_id = entity.id
            AND field.uad_uid IN ('0700.0035', '0700.0046')
          ORDER BY CASE field.uad_uid WHEN '0700.0035' THEN 0 ELSE 1 END
          LIMIT 1
       ) AS value ON true
      WHERE entity.workfile_id = $1
      ORDER BY entity.ordinal, entity.id`,
    [workfileId],
  );
  let ordinal = 10;
  for (const entity of result.rows) {
    const assets = [];
    if (entity.entity_type === "dwelling") assets.push([8, "DwellingFront"]);
    if (entity.entity_type === "outbuilding") assets.push([12, "OutbuildingFront"], [12, "OutbuildingInterior"]);
    if (entity.entity_type === "outbuilding_room") assets.push([12, "OutbuildingRoom"]);
    if (entity.entity_type === "vehicle_storage") assets.push([13, "VehicleStorage"]);
    if (entity.entity_type === "amenity") assets.push([14, "SubjectPropertyAmenity"]);
    if (entity.entity_type === "unit_room" && entity.subtype) assets.push([10, entity.subtype]);
    if (entity.entity_type === "unit_interior_feature" && entity.subtype) assets.push([10, entity.subtype]);
    if (entity.entity_type === "sales_comparable") assets.push([22, "PropertyPhoto"]);
    for (const [section, caption] of assets) {
      await seedAsset(pool, objects, workfileId, entity.id, section, caption, ordinal);
      ordinal += 1;
    }
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const objects = new Map();
try {
  const identity = await pool.query("SELECT current_database() AS database_name");
  const databaseName = String(identity.rows[0]?.database_name || "");
  if (!databaseName.endsWith("_test")) throw new Error("successful delivery verification refused a non-test database");
  const workfileResult = await pool.query(
    `SELECT id FROM appraisal.uad_workfiles
      WHERE account_id = $1 ORDER BY created_at, id LIMIT 1`,
    [ACCOUNT_ID],
  );
  if (!workfileResult.rows.length) throw new Error("synthetic_sfr_workfile_missing");
  const workfileId = workfileResult.rows[0].id;

  await pool.query("DELETE FROM appraisal.uad_generated_artifacts WHERE workfile_id = $1", [workfileId]);
  await pool.query("DELETE FROM appraisal.uad_signatures WHERE workfile_id = $1", [workfileId]);
  await pool.query("DELETE FROM appraisal.uad_validation_runs WHERE workfile_id = $1", [workfileId]);
  await pool.query("DELETE FROM appraisal.uad_assets WHERE workfile_id = $1", [workfileId]);
  await pool.query(
    `UPDATE appraisal.uad_workfiles
        SET organization_id = $2, assigned_appraiser_user_id = $3,
            supervisory_appraiser_user_id = NULL, status = 'draft',
            signed_at = NULL, updated_at = now()
      WHERE id = $1`,
    [workfileId, ORGANIZATION_ID, APPRAISER_ID],
  );
  await pool.query(
    `UPDATE appraisal.uad_field_values
        SET source_type = 'appraiser', source_reference = 'synthetic_successful_delivery',
            is_appraiser_confirmed = true, updated_at = now()
      WHERE workfile_id = $1`,
    [workfileId],
  );
  await seedRequiredAssets(pool, objects, workfileId);

  const validation = await runLocalUadValidation(pool, workfileId);
  if (validation.status !== "passed") {
    console.log(JSON.stringify({
      ok: false,
      gate: "local_compliance",
      fatal_count: validation.fatal_count,
      warning_count: validation.warning_count,
      findings: validation.findings.map((finding) => ({
        rule_id: finding.rule_id,
        entity_id: finding.entity_id,
        report_field_id: finding.report_field_id,
        message: finding.message,
      })),
    }, null, 2));
    process.exitCode = 1;
  } else {
    const executionDate = new Date().toISOString().slice(0, 10);
    const signature = await signUadWorkfile(pool, workfileId, {
      userId: APPRAISER_ID,
      issuer: "synthetic-test",
      subject: "synthetic-test-appraiser",
    }, { authentication_method: "session", execution_date: executionDate });
    const storage = memoryStorage(objects);
    const pdf = await generateUadPdfArtifact(pool, storage, workfileId);
    const xml = await generateUadXmlArtifact(pool, storage, workfileId);
    if (xml.schema_validation?.status !== "passed") {
      throw Object.assign(new Error("synthetic_delivery_schema_failed"), { details: xml.schema_validation?.findings });
    }
    const deliveryPackage = await generateUadSubmissionPackage(pool, storage, workfileId);
    const evidence = {
      ok: true,
      synthetic_only: true,
      database: databaseName,
      workfile_id: workfileId,
      local_compliance: {
        status: validation.status,
        fatal_count: validation.fatal_count,
        warning_count: validation.warning_count,
      },
      signature: { workfile_status: signature.workfile_status, signer_role: signature.signature.signer_role },
      pdf: {
        status: pdf.artifact.generation_status,
        checksum_sha256: pdf.artifact.checksum_sha256,
        page_count: pdf.artifact.metadata.page_count,
        signer_count: pdf.artifact.metadata.signer_count,
      },
      xml: {
        status: xml.artifact.generation_status,
        checksum_sha256: xml.artifact.checksum_sha256,
        schema_status: xml.schema_validation.status,
        schema_fatal_count: xml.schema_validation.fatal_count,
      },
      package: {
        status: deliveryPackage.package.generation_status,
        checksum_sha256: deliveryPackage.package.checksum_sha256,
        entry_count: deliveryPackage.package.metadata.entry_count,
        manifest_status: deliveryPackage.manifest.generation_status,
      },
    };
    console.log(JSON.stringify(evidence, null, 2));
  }
} finally {
  await pool.end();
}
