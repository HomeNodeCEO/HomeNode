import { createHash } from "node:crypto";
import pg from "pg";

import {
  APPENDIX_H1_MANIFEST,
  buildAppendixH1Coverage,
} from "../src/modules/uad/appendixH.js";
import { signUadWorkfile } from "../src/modules/uad/certifications.js";
import { getUadEditor } from "../src/modules/uad/editor.js";
import { generateUadXmlArtifact } from "../src/modules/uad/uadArtifacts.js";
import { generateUadSubmissionPackage } from "../src/modules/uad/uadPackageArtifacts.js";
import { generateUadPdfArtifact } from "../src/modules/uad/uadPdfArtifacts.js";
import { createUadPdfViewModel } from "../src/modules/uad/uadPdf.js";
import { runLocalUadValidation } from "../src/modules/uad/validation.js";
import { requireSalesRichUadDelivery } from "./lib/uadSalesDeliveryEvidence.js";
import { seedSalesRichUadDatabaseFixture } from "./lib/uadSalesRichDatabaseFixture.js";

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

async function seedValue(pool, workfileId, entityId, context, uid, reportFieldId, value) {
  const id = deterministicUuid(`uad-successful-delivery:value:${entityId || "root"}:${context}:${uid}`);
  await pool.query(
    `INSERT INTO appraisal.uad_field_values (
       id, workfile_id, entity_id, field_context, uad_uid, report_field_id,
       value, source_type, source_reference, source_observed_at,
       is_appraiser_confirmed, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, 'appraiser',
       'synthetic_successful_delivery', timestamptz '2026-08-21 12:00:00+00',
       true, timestamptz '2026-08-21 12:00:00+00', timestamptz '2026-08-21 12:00:00+00'
     ) ON CONFLICT DO NOTHING`,
    [id, workfileId, entityId, context, uid, reportFieldId, JSON.stringify(value)],
  );
  await pool.query(
    `UPDATE appraisal.uad_field_values
        SET report_field_id = $5, value = $6::jsonb, source_type = 'appraiser',
            source_reference = 'synthetic_successful_delivery',
            source_observed_at = timestamptz '2026-08-21 12:00:00+00',
            is_appraiser_confirmed = true, updated_at = now()
      WHERE workfile_id = $1 AND entity_id IS NOT DISTINCT FROM $2::uuid
        AND field_context = $3 AND uad_uid = $4`,
    [workfileId, entityId, context, uid, reportFieldId, JSON.stringify(value)],
  );
}

async function seedCompletionValues(pool, workfileId) {
  const rootValues = [
    ["assignment", "1000.0034", "2.000", "Purchase"],
    ["appraiser_inspection", "2400.0080", "2.023", "2026-08-21"],
    ["subject", "0100.0020", "3.004", "Detached"],
    ["subject", "0100.0019", "3.006", 0],
    ["subject", "0100.0033", "3.008", false],
    ["subject", "0100.0054", "3.014", false],
    ["subject", "0100.0047", "3.015", false],
    ["subject", "0300.0010", "3.017", false],
    ["subject_ownership", "0100.0024", "3.019", "FeeSimple"],
    ["subject_ownership", "0100.0034", "3.027", true],
    ["site", "1500.0093", "4.000", { amount: 8400, unit: "SquareFeet" }],
    ["site_zoning", "1500.0125", "4.008", "Legal"],
    ["site_zoning", "1500.0122", "4.009", "SF-7"],
    ["site_zoning", "1500.0123", "4.010", "Single-family residential zoning"],
    ["site_zoning", "1500.0124", "4.014", "The synthetic site is a legal conforming use."],
    ["site_mixed_use", "1500.0034", "4.017", false],
    ["site_access", "1500.0055", "4.020", "PublicStreet"],
    ["site_access", "1500.0054", "4.023", true],
    ["site", "1500.0166", "4.067", true],
    ["site", "1500.0178", "4.099", false],
    ["disaster_mitigation", "3700.0002", "5.000", ["None"]],
    ["energy_green", "2600.0005", "6.000", false],
    ["energy_green", "2600.0004", "6.004", false],
    ["energy_green", "2600.0003", "6.010", false],
    ["sketch", "3300.0002", "7.000", true],
    ["sketch", "3300.0007", "7.001", "AmericanNationalStandardsInstitute"],
    ["scope_of_work", "1000.0027", "Does Not Display", false],
    ["scope_of_work", "1000.0030", "Does Not Display", false],
    ["income_approach_exclusion", "1300.0004", "26.003", ["NotNecessaryForCredibleResults"]],
    ["cost_approach_exclusion", "1300.0002", "26.005", ["NotNecessaryForCredibleResults"]],
    ["reconciliation", "1300.0017", "26.007", 445000],
    ["reconciliation", "1300.0010", "26.009", ["AsIs"]],
    ["reconciliation", "1300.0013", "26.010", 45],
    ["reconciliation", "1300.0012", "26.011", "2026-08-21"],
    ["reconciliation", "1300.0021", "26.019", "The sales comparison approach is the most reliable indicator for this synthetic assignment. Three settled sales bracket the conclusion after market-supported condition, sale-date, site, and finished-area adjustments."],
  ];
  for (const [context, uid, reportFieldId, value] of rootValues) {
    await seedValue(pool, workfileId, null, context, uid, reportFieldId, value);
  }

  const entities = await pool.query(
    `SELECT id, entity_type FROM appraisal.uad_entities
      WHERE workfile_id = $1 ORDER BY ordinal, id`,
    [workfileId],
  );
  for (const entity of entities.rows) {
    if (entity.entity_type === "site_parcel") {
      await seedValue(pool, workfileId, entity.id, "site_parcel", "1500.0023", "4.006", "LandWithDwelling");
      await seedValue(pool, workfileId, entity.id, "site_parcel", "1500.0022", "4.007", { amount: 8400, unit: "SquareFeet" });
    }
    if (entity.entity_type === "dwelling") {
      const values = [
        ["0300.0030", "8.004", "Ranch"],
        ["0300.0117", "8.005", "GroundLevel"],
        ["0300.0012", "8.010", false],
        ["0300.0034", "8.011", "SiteBuilt"],
        ["0300.0079", "8.012", false],
        ["0300.0114", "8.046", false],
        ["0300.0088", "8.049", ["ForcedWarmAir"]],
        ["0300.0086", "8.050", ["NaturalGas"]],
        ["0300.0022", "8.051", true],
        ["0300.0084", "8.051", ["Centralized"]],
        ["0300.0116", "8.052", false],
        ["3900.0097", "8.055", false],
      ];
      for (const [uid, reportFieldId, value] of values) {
        await seedValue(pool, workfileId, entity.id, "dwelling", uid, reportFieldId, value);
      }
    }
  }
  await pool.query(
    `DELETE FROM appraisal.uad_field_values
      WHERE workfile_id = $1 AND field_context = 'sales_comparable_dwelling'
        AND uad_uid = '1800.0373'`,
    [workfileId],
  );
}

async function cloneSalesComparable(pool, workfileId, sourceComparableId, ordinal) {
  const tree = await pool.query(
    `WITH RECURSIVE comparable_tree AS (
       SELECT entity.*, 0 AS depth
         FROM appraisal.uad_entities AS entity
        WHERE entity.workfile_id = $1 AND entity.id = $2
       UNION ALL
       SELECT child.*, parent.depth + 1
         FROM appraisal.uad_entities AS child
         JOIN comparable_tree AS parent ON child.parent_entity_id = parent.id
        WHERE child.workfile_id = $1
     )
     SELECT * FROM comparable_tree ORDER BY depth, entity_type, ordinal, id`,
    [workfileId, sourceComparableId],
  );
  if (!tree.rows.length) throw new Error("synthetic_sales_comparable_source_missing");
  const entityIds = new Map(tree.rows.map((entity) => [
    entity.id,
    deterministicUuid(`uad-successful-delivery:comparable:${ordinal}:${entity.id}`),
  ]));
  for (const entity of tree.rows) {
    const id = entityIds.get(entity.id);
    const parentEntityId = entity.id === sourceComparableId
      ? null
      : entityIds.get(entity.parent_entity_id);
    const entityIdentifier = entity.id === sourceComparableId
      ? `sales-comparable-${ordinal}`
      : `delivery-comparable-${ordinal}-${entity.entity_identifier}`;
    const label = entity.id === sourceComparableId
      ? `Sales Comparable ${ordinal}`
      : `${entity.label || entity.entity_type} (Comparable ${ordinal})`;
    await pool.query(
      `INSERT INTO appraisal.uad_entities (
         id, workfile_id, parent_entity_id, entity_type, entity_identifier,
         ordinal, label, data, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
         timestamptz '2026-08-21 12:00:00+00', timestamptz '2026-08-21 12:00:00+00'
       ) ON CONFLICT (id) DO UPDATE SET
         parent_entity_id = EXCLUDED.parent_entity_id,
         entity_type = EXCLUDED.entity_type,
         entity_identifier = EXCLUDED.entity_identifier,
         ordinal = EXCLUDED.ordinal,
         label = EXCLUDED.label,
         data = EXCLUDED.data,
         updated_at = EXCLUDED.updated_at`,
      [
        id,
        workfileId,
        parentEntityId,
        entity.entity_type,
        entityIdentifier,
        entity.id === sourceComparableId ? ordinal : entity.ordinal,
        label,
        JSON.stringify(entity.data || {}),
      ],
    );
  }
  const sourceValues = await pool.query(
    `SELECT * FROM appraisal.uad_field_values
      WHERE workfile_id = $1 AND entity_id = ANY($2::uuid[])
      ORDER BY created_at, id`,
    [workfileId, [...entityIds.keys()]],
  );
  for (const value of sourceValues.rows) {
    await seedValue(
      pool,
      workfileId,
      entityIds.get(value.entity_id),
      value.field_context,
      value.uad_uid,
      value.report_field_id,
      value.value,
    );
  }
  return { rootId: entityIds.get(sourceComparableId), entityIds };
}

async function configureComparableScenario(pool, workfileId, comparableId, scenario) {
  const rootValues = [
    ["sales_comparable", "1800.0192", "21.007", scenario.ordinal],
    ["sales_comparable_address", "1800.0001", "22.01.17", scenario.address],
    ["sales_comparable_address", "1800.0003", "22.01.17", "Garland"],
    ["sales_comparable_address", "1800.0005", "22.01.17", "TX"],
    ["sales_comparable_address", "1800.0004", "22.01.17", "75044"],
    ["sales_comparable_listing", "1800.0074", "22.01.20", scenario.listPrice],
    ["sales_comparable_listing", "1800.0075", "22.01.21", "SettledSale"],
    ["sales_comparable_sale", "1800.0272", "22.01.23", scenario.salePrice],
    ["sales_comparable_sale", "1800.0342", "22.01.32", scenario.saleDate],
    ["sales_comparable_property", "1800.0196", "22.11.05", scenario.condition],
    ["sales_comparable_summary", "1800.0312", "22.15.14", scenario.weight],
  ];
  for (const [context, uid, reportFieldId, value] of rootValues) {
    await seedValue(pool, workfileId, comparableId, context, uid, reportFieldId, value);
  }
  for (const [context, reportFieldId, amount] of scenario.adjustments) {
    await seedValue(pool, workfileId, comparableId, context, "1800.0317", reportFieldId, amount);
  }
  const related = await pool.query(
    `WITH RECURSIVE comparable_tree AS (
       SELECT id, parent_entity_id, entity_type, ordinal
         FROM appraisal.uad_entities WHERE id = $1 AND workfile_id = $2
       UNION ALL
       SELECT child.id, child.parent_entity_id, child.entity_type, child.ordinal
         FROM appraisal.uad_entities AS child
         JOIN comparable_tree AS parent ON child.parent_entity_id = parent.id
        WHERE child.workfile_id = $2
     )
     SELECT entity.id, entity.entity_type, entity.ordinal,
            adu.value #>> '{}' AS adu_indicator
       FROM comparable_tree AS entity
       LEFT JOIN appraisal.uad_field_values AS adu
         ON adu.workfile_id = $2 AND adu.entity_id = entity.id
        AND adu.field_context = 'sales_comparable_unit' AND adu.uad_uid = '1800.0287'
      WHERE entity.entity_type IN ('sales_comparable_dwelling', 'sales_comparable_unit')
      ORDER BY entity.entity_type, entity.ordinal`,
    [comparableId, workfileId],
  );
  for (const entity of related.rows) {
    if (entity.entity_type === "sales_comparable_dwelling") {
      await seedValue(pool, workfileId, entity.id, "sales_comparable_dwelling", "1800.0185", "22.08.23", scenario.condition);
    }
    if (entity.entity_type === "sales_comparable_unit") {
      await seedValue(pool, workfileId, entity.id, "sales_comparable_unit", "1800.0157", "22.09.25", scenario.condition);
      if (entity.adu_indicator === "false") {
        await seedValue(pool, workfileId, entity.id, "sales_comparable_unit", "1800.0390", "22.07.30", {
          amount: scenario.finishedArea,
          unit: "SquareFeet",
        });
      }
    }
  }
}

async function seedSalesRichFixture(pool, workfileId) {
  const source = await pool.query(
    `SELECT id FROM appraisal.uad_entities
      WHERE workfile_id = $1 AND entity_type = 'sales_comparable'
      ORDER BY ordinal, id LIMIT 1`,
    [workfileId],
  );
  if (!source.rows.length) throw new Error("synthetic_sales_comparable_missing");
  const sourceId = source.rows[0].id;
  const second = await cloneSalesComparable(pool, workfileId, sourceId, 2);
  const third = await cloneSalesComparable(pool, workfileId, sourceId, 3);
  const scenarios = [
    {
      id: sourceId, ordinal: 1, address: "1250 Forest Lane", listPrice: 449000,
      salePrice: 442500, saleDate: "2026-06-25", condition: "C4", finishedArea: 2050,
      weight: "Most",
      adjustments: [
        ["sales_comparable_adjustment_overall_condition", "22.11.06", 7500],
        ["sales_comparable_adjustment_sale_date", "22.01.33", -2500],
      ],
    },
    {
      id: second.rootId, ordinal: 2, address: "1275 Forest Lane", listPrice: 435000,
      salePrice: 430000, saleDate: "2026-05-28", condition: "C4", finishedArea: 1950,
      weight: "Less",
      adjustments: [
        ["sales_comparable_adjustment_overall_condition", "22.11.06", 15000],
        ["sales_comparable_adjustment_standard_above", "22.07.31", 5000],
        ["sales_comparable_adjustment_sale_date", "22.01.33", -2500],
      ],
    },
    {
      id: third.rootId, ordinal: 3, address: "1310 Forest Lane", listPrice: 461000,
      salePrice: 455000, saleDate: "2026-04-16", condition: "C2", finishedArea: 2200,
      weight: "Less",
      adjustments: [
        ["sales_comparable_adjustment_overall_condition", "22.11.06", -10000],
        ["sales_comparable_adjustment_standard_above", "22.07.31", -5000],
        ["sales_comparable_adjustment_sale_date", "22.01.33", -5000],
      ],
    },
  ];
  for (const scenario of scenarios) {
    await configureComparableScenario(pool, workfileId, scenario.id, scenario);
  }
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
  await seedSalesRichUadDatabaseFixture(pool, workfileId, {
    namespace: "uad-successful-delivery",
    observedAt: "2026-08-21T12:00:00.000Z",
    sourceReference: "synthetic_successful_delivery",
  });
  await seedRequiredAssets(pool, objects, workfileId);

  const unsignedEditor = await getUadEditor(pool, workfileId);
  const salesComparison = requireSalesRichUadDelivery(unsignedEditor);
  const unsignedPdfView = createUadPdfViewModel(unsignedEditor, {
    assets: await pool.query(
      "SELECT * FROM appraisal.uad_assets WHERE workfile_id = $1 ORDER BY section_number, id",
      [workfileId],
    ).then((result) => result.rows),
  });
  const pdfComparableGroupCount = unsignedPdfView.sections
    .find((section) => section.number === 22)
    ?.groups.filter((group) => group.entity?.entity_type === "sales_comparable").length || 0;
  if (pdfComparableGroupCount < salesComparison.comparable_count) {
    throw new Error("synthetic_delivery_pdf_sales_grid_missing");
  }

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
    const officialRuleCoverage = await pool.query(
      `SELECT rule_id, local_evaluation_status
         FROM uad_ref.compliance_rules
        WHERE release_key = (
          SELECT specification_release_key FROM appraisal.uad_workfiles WHERE id = $1
        )
          AND rule_id ~ '^UAD[0-9]+$'`,
      [workfileId],
    );
    const appendixHCoverage = buildAppendixH1Coverage(officialRuleCoverage.rows);
    const executionDate = new Date().toISOString().slice(0, 10);
    const storage = memoryStorage(objects);
    const unsignedPdf = await generateUadPdfArtifact(pool, storage, workfileId);
    const signature = await signUadWorkfile(pool, workfileId, {
      userId: APPRAISER_ID,
      issuer: "synthetic-test",
      subject: "synthetic-test-appraiser",
    }, { authentication_method: "session", execution_date: executionDate });
    const pdf = await generateUadPdfArtifact(pool, storage, workfileId);
    const xml = await generateUadXmlArtifact(pool, storage, workfileId);
    if (xml.schema_validation?.status !== "passed") {
      console.log(JSON.stringify({
        ok: false,
        gate: "official_schema",
        fatal_count: xml.schema_validation?.fatal_count ?? null,
        warning_count: xml.schema_validation?.warning_count ?? null,
        findings: (xml.schema_validation?.findings || []).map((finding) => ({
          rule_id: finding.rule_id,
          report_field_id: finding.report_field_id,
          message: finding.message,
          path: finding.path,
        })),
      }, null, 2));
      throw Object.assign(new Error("synthetic_delivery_schema_failed"), { details: xml.schema_validation?.findings });
    }
    const xmlObject = objects.get(xml.artifact.object_key);
    if (!xmlObject) throw new Error("synthetic_delivery_xml_object_missing");
    const xmlText = xmlObject.body.toString("utf8");
    const deliveryPackage = await generateUadSubmissionPackage(pool, storage, workfileId);
    const evidence = {
      ok: true,
      synthetic_only: true,
      database: databaseName,
      workfile_id: workfileId,
      validation_scope: {
        home_node_local_engine: "passed",
        official_gse_subschema: "passed",
        published_urar_appendix_h_rule_count: APPENDIX_H1_MANIFEST.active_rule_count,
        official_appendix_h_catalog_rule_count: appendixHCoverage.cataloged_rule_count,
        official_appendix_h_catalog_complete: appendixHCoverage.catalog_complete,
        reference_only_rule_count: appendixHCoverage.reference_only_rule_count,
        mapped_unverified_rule_count: appendixHCoverage.mapped_unverified_rule_count,
        locally_verified_official_rule_count: appendixHCoverage.locally_verified_rule_count,
        local_gse_equivalence_complete: appendixHCoverage.local_gse_equivalence_complete,
        fannie_uad_compliance_api: "not_executed_credentials_required",
        freddie_uad_compliance_api: "not_executed_credentials_required",
        ucdp_and_collateral_underwriter: "not_executed_lender_submission_required",
        gse_acceptance_claimed: false,
      },
      local_compliance: {
        status: validation.status,
        fatal_count: validation.fatal_count,
        warning_count: validation.warning_count,
      },
      sales_comparison: salesComparison,
      signature: { workfile_status: signature.workfile_status, signer_role: signature.signature.signer_role },
      pre_signature_review: {
        pdf_status: unsignedPdf.artifact.generation_status,
        pdf_signer_count: unsignedPdf.artifact.metadata.signer_count,
      },
      pdf: {
        status: pdf.artifact.generation_status,
        checksum_sha256: pdf.artifact.checksum_sha256,
        page_count: pdf.artifact.metadata.page_count,
        signer_count: pdf.artifact.metadata.signer_count,
        sales_comparable_group_count: pdfComparableGroupCount,
      },
      xml: {
        status: xml.artifact.generation_status,
        checksum_sha256: xml.artifact.checksum_sha256,
        schema_status: xml.schema_validation.status,
        schema_fatal_count: xml.schema_validation.fatal_count,
        sales_comparable_count: (xmlText.match(/ValuationUseType="SalesComparable"/g) || []).length,
        adjustment_count: (xmlText.match(/<ComparableAdjustmentAmount>/g) || []).length,
        reconciliation_count: (xmlText.match(/<SalesComparisonCommentDescription>/g) || []).length,
      },
      package: {
        status: deliveryPackage.package.generation_status,
        checksum_sha256: deliveryPackage.package.checksum_sha256,
        entry_count: deliveryPackage.package.metadata.entry_count,
        manifest_status: deliveryPackage.manifest.generation_status,
      },
    };
    if (evidence.xml.sales_comparable_count < salesComparison.comparable_count) {
      throw new Error("synthetic_delivery_xml_sales_comparables_missing");
    }
    if (evidence.xml.adjustment_count < salesComparison.nonzero_adjustment_count) {
      throw new Error("synthetic_delivery_xml_adjustments_missing");
    }
    if (evidence.xml.reconciliation_count < 1) {
      throw new Error("synthetic_delivery_xml_sales_reconciliation_missing");
    }
    console.log(JSON.stringify(evidence, null, 2));
  }
} finally {
  await pool.end();
}
