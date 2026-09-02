import { randomUUID } from "node:crypto";

import {
  CURRENT_UAD_RELEASE_KEY,
  INITIAL_UAD_INSPECTION_METHOD,
  INITIAL_UAD_PROPERTY_TYPE,
} from "./constants.js";
import { buildUadPrefillValues } from "./fieldCatalog.js";
import { registerOriginalAppraisalReport } from "../../services/appraisalHistory.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeUadAccountId(value) {
  const accountId = String(value ?? "").trim();
  if (!accountId || accountId.length > 64 || /[\u0000-\u001f\u007f]/.test(accountId)) {
    throw new Error("invalid_account_id");
  }
  return accountId;
}

export function normalizeUadWorkfileId(value) {
  const id = String(value ?? "").trim();
  if (!UUID_PATTERN.test(id)) throw new Error("invalid_uad_workfile_id");
  return id;
}

export function normalizeUadFileNumber(value, { accountId, workfileId } = {}) {
  const supplied = String(value ?? "").trim();
  if (supplied) {
    if (supplied.length > 100 || /[\u0000-\u001f\u007f]/.test(supplied)) {
      throw new Error("invalid_uad_file_number");
    }
    return supplied;
  }

  const suffix = String(accountId || "subject").replace(/[^A-Za-z0-9]/g, "").slice(-8) || "subject";
  const idSuffix = String(workfileId || randomUUID()).replaceAll("-", "").slice(0, 8);
  const year = new Date().getUTCFullYear();
  return `3.6-${year}-${suffix}-${idSuffix}`;
}

function workfileResponse(row) {
  return {
    id: row.id,
    organization_id: row.organization_id || null,
    account_id: row.account_id,
    file_number: row.file_number,
    specification_release_key: row.specification_release_key,
    status: row.status,
    property_type: row.property_type,
    inspection_method: row.inspection_method,
    assignment_purpose: row.assignment_purpose || null,
    assigned_appraiser_user_id: row.assigned_appraiser_user_id || null,
    supervisory_appraiser_user_id: row.supervisory_appraiser_user_id || null,
    current_revision: Number(row.current_revision || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listUadWorkfiles(pool, accountIdValue, accessScope = null) {
  const accountId = normalizeUadAccountId(accountIdValue);
  const restricted = Boolean(accessScope && !accessScope.platformAdministrator);
  const readableOrganizationIds = restricted ? accessScope.readableOrganizationIds : [];
  const organizationWideReadIds = restricted ? accessScope.organizationWideReadIds : [];
  if (restricted && !readableOrganizationIds.length) return [];
  const { rows } = await pool.query(
    `SELECT *
       FROM appraisal.uad_workfiles
      WHERE account_id = $1
        AND (
          NOT $2::boolean
          OR organization_id = ANY($4::uuid[])
          OR (
            organization_id = ANY($3::uuid[])
            AND (assigned_appraiser_user_id = $5::uuid OR supervisory_appraiser_user_id = $5::uuid)
          )
        )
      ORDER BY updated_at DESC, id`,
    [
      accountId,
      restricted,
      readableOrganizationIds,
      organizationWideReadIds,
      restricted ? accessScope.userId : null,
    ],
  );
  return rows.map(workfileResponse);
}

export async function getUadSubjectSummary(pool, accountIdValue) {
  const accountId = normalizeUadAccountId(accountIdValue);
  const { rows } = await pool.query(
    `SELECT account_id, address, city, postal_code, county,
            neighborhood_code, subdivision, legal_description
       FROM core.accounts
      WHERE account_id = $1`,
    [accountId],
  );
  if (!rows.length) throw new Error("subject_account_not_found");
  return rows[0];
}

export async function getUadWorkfile(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const { rows } = await pool.query(
    `SELECT w.*,
            s.subject_data,
            s.source_manifest AS subject_source_manifest,
            s.snapshot_version
       FROM appraisal.uad_workfiles w
       LEFT JOIN LATERAL (
         SELECT subject_data, source_manifest, snapshot_version
           FROM appraisal.uad_subject_snapshots
          WHERE workfile_id = w.id
          ORDER BY snapshot_version DESC
          LIMIT 1
       ) s ON true
      WHERE w.id = $1`,
    [workfileId],
  );
  if (!rows.length) return null;
  return {
    ...workfileResponse(rows[0]),
    subject_snapshot: rows[0].subject_data || null,
    subject_source_manifest: rows[0].subject_source_manifest || {},
    subject_snapshot_version: Number(rows[0].snapshot_version || 0),
  };
}

async function loadSubjectSnapshot(client, accountId) {
  const { rows } = await client.query(
    `SELECT
       to_jsonb(a) AS account,
       to_jsonb(l) - 'location_geom' AS location,
       to_jsonb(p) AS primary_improvements,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(ld) ORDER BY ld.tax_year DESC, ld.line_number)
           FROM core.land_detail ld
          WHERE ld.account_id = a.account_id
       ), '[]'::jsonb) AS land_details,
       COALESCE((
         SELECT jsonb_agg(to_jsonb(si) ORDER BY si.sec_imp_number NULLS LAST, si.id)
           FROM core.secondary_improvements si
          WHERE si.account_id = a.account_id
       ), '[]'::jsonb) AS secondary_improvements
     FROM core.accounts a
     LEFT JOIN core.account_locations l ON l.account_id = a.account_id
     LEFT JOIN core.primary_improvements p ON p.account_id = a.account_id
     WHERE a.account_id = $1`,
    [accountId],
  );
  if (!rows.length) throw new Error("subject_account_not_found");
  return rows[0];
}

export async function createUadWorkfileWithClient(client, accountIdValue, input = {}) {
  const accountId = normalizeUadAccountId(accountIdValue);
  const workfileId = randomUUID();
  const snapshotId = randomUUID();
  const propertyEntityId = randomUUID();
  const dwellingEntityId = randomUUID();
  const unitEntityId = randomUUID();
  const siteParcelEntityId = randomUUID();
  const vehicleStorageEntityId = randomUUID();
  const revisionId = randomUUID();
  const fileNumber = normalizeUadFileNumber(input.file_number, { accountId, workfileId });
  const organizationId = input.organization_id || null;
  const appraiserUserId = input.assigned_appraiser_user_id || null;
  const actorUserId = input.actor_user_id || appraiserUserId;
  const specificationReleaseKey = input.specification_release_key || CURRENT_UAD_RELEASE_KEY;

  const subjectData = await loadSubjectSnapshot(client, accountId);
  const reportedLivingUnits = Number(subjectData?.primary_improvements?.number_units);
  const dwellingLivingUnits = Number.isInteger(reportedLivingUnits) && reportedLivingUnits > 0 ? reportedLivingUnits : 1;
  const reportedYearBuilt = Number(subjectData?.primary_improvements?.year_built);
  const dwellingYearBuilt = Number.isInteger(reportedYearBuilt) && reportedYearBuilt >= 1000 && reportedYearBuilt <= 9999
    ? String(reportedYearBuilt)
    : null;

    const inserted = await client.query(
      `INSERT INTO appraisal.uad_workfiles (
         id, organization_id, account_id, file_number, specification_release_key,
         property_type, inspection_method, assignment_purpose,
         assigned_appraiser_user_id, created_by_user_id, updated_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        workfileId,
        organizationId,
        accountId,
        fileNumber,
        specificationReleaseKey,
        INITIAL_UAD_PROPERTY_TYPE,
        INITIAL_UAD_INSPECTION_METHOD,
        input.assignment_purpose || null,
        appraiserUserId,
        actorUserId,
      ],
    );

    await client.query(
      `INSERT INTO appraisal.uad_subject_snapshots (
         id, workfile_id, snapshot_version, source_account_updated_at,
         source_manifest, subject_data, created_by_user_id
       ) VALUES (
         $1, $2, 1, (($3::jsonb)->'account'->>'updated_at')::timestamptz,
         $4::jsonb, $3::jsonb, $5
       )`,
      [
        snapshotId,
        workfileId,
        JSON.stringify(subjectData),
        JSON.stringify({
          source: "homenodedb",
          captured_at: new Date().toISOString(),
          tables: [
            "core.accounts",
            "core.account_locations",
            "core.primary_improvements",
            "core.land_detail",
            "core.secondary_improvements",
          ],
        }),
        actorUserId,
      ],
    );

    await client.query(
      `INSERT INTO appraisal.uad_entities (
         id, workfile_id, parent_entity_id, entity_type, entity_identifier, ordinal, label
       ) VALUES
         ($1, $4, NULL, 'property', 'subject', 1, 'Subject Property'),
         ($2, $4, $1, 'dwelling', 'dwelling-1', 1, 'Dwelling 1'),
         ($3, $4, $2, 'unit', 'unit-1', 1, 'Unit 1'),
         ($5, $4, $1, 'site_parcel', 'site-parcel-1', 1, 'Parcel 1'),
         ($6, $4, NULL, 'vehicle_storage', 'vehicle-storage-1', 1, 'Vehicle Storage 1')`,
      [
        propertyEntityId,
        dwellingEntityId,
        unitEntityId,
        workfileId,
        siteParcelEntityId,
        vehicleStorageEntityId,
      ],
    );

    for (const { field, value, sourceReference } of buildUadPrefillValues(subjectData)) {
      const sourceType = sourceReference?.startsWith("subject_snapshot.") ? "homenode" : "calculated";
      await client.query(
        `INSERT INTO appraisal.uad_field_values (
           id, workfile_id, field_context, uad_uid, report_field_id, value,
           source_type, source_reference, source_observed_at, is_appraiser_confirmed
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now(), false)`,
        [
          randomUUID(),
          workfileId,
          field.contextKey,
          field.uid,
          field.reportFieldId,
          JSON.stringify(value),
          sourceType,
          sourceReference,
        ],
      );
    }

    await client.query(
      `INSERT INTO appraisal.uad_field_values (
         id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value,
         source_type, source_reference, source_observed_at, is_appraiser_confirmed
       ) VALUES
         ($1, $3, NULL, 'site', '1500.0094', '4.002', '1'::jsonb,
          'calculated', 'uad_workfile.initial_site_parcel_count', now(), false),
         ($2, $3, $4, 'site_parcel', '1500.0027', '4.005', to_jsonb($5::text),
          'public_record', 'subject_snapshot.account.account_id', now(), false)`,
      [randomUUID(), randomUUID(), workfileId, siteParcelEntityId, accountId],
    );

    await client.query(
      `INSERT INTO appraisal.uad_field_values (
         id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value,
         source_type, source_reference, source_observed_at, is_appraiser_confirmed
       ) VALUES (
         $1, $2, $3, 'dwelling', '0300.0063', '8.001', $4::jsonb,
         'public_record', 'subject_snapshot.primary_improvements.number_units', now(), false
       )`,
      [randomUUID(), workfileId, dwellingEntityId, JSON.stringify(dwellingLivingUnits)],
    );
    if (dwellingYearBuilt) {
      await client.query(
        `INSERT INTO appraisal.uad_field_values (
           id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value,
           source_type, source_reference, source_observed_at, is_appraiser_confirmed
         ) VALUES (
           $1, $2, $3, 'dwelling', '0300.0011', '8.010', $4::jsonb,
           'public_record', 'subject_snapshot.primary_improvements.year_built', now(), false
         )`,
        [randomUUID(), workfileId, dwellingEntityId, JSON.stringify(dwellingYearBuilt)],
      );
    }

    await client.query(
      `INSERT INTO appraisal.uad_revisions (
         id, workfile_id, revision_number, specification_release_key,
         document, change_summary, created_by_user_id
       ) VALUES ($1, $2, 1, $3, $4::jsonb, 'Initial HomeNode subject snapshot', $5)`,
      [
        revisionId,
        workfileId,
        specificationReleaseKey,
        JSON.stringify({
          assignment: {
            property_type: INITIAL_UAD_PROPERTY_TYPE,
            inspection_method: INITIAL_UAD_INSPECTION_METHOD,
            purpose: input.assignment_purpose || null,
          },
          subject_snapshot_id: snapshotId,
          entity_ids: {
            property: propertyEntityId,
            dwelling: dwellingEntityId,
            unit: unitEntityId,
            site_parcel: siteParcelEntityId,
            vehicle_storage: vehicleStorageEntityId,
          },
        }),
        actorUserId,
      ],
    );

    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, actor_user_id, event_type, entity_type, entity_id, after_data
       ) VALUES (
         $1::uuid, $2::uuid, 'uad_workfile.created', 'uad_workfile',
         ($1::uuid)::text, $3::jsonb
       )`,
      [workfileId, actorUserId, JSON.stringify({ account_id: accountId, file_number: fileNumber })],
    );

  return workfileResponse(inserted.rows[0]);
}

export async function createUadWorkfile(pool, accountIdValue, input = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workfile = await createUadWorkfileWithClient(client, accountIdValue, input);
    const reportRegistry = await client.query(
      "SELECT to_regclass('app.report_files') AS table_name",
    );
    if (reportRegistry.rows[0]?.table_name) {
      const reportFileId = randomUUID();
      const registered = await client.query(
        `INSERT INTO app.report_files (
           id, organization_id, account_id, workflow_type, file_number,
           uad_workfile_id, is_current, registry_revision, created_by_user_id
         ) VALUES ($1, $2, $3, 'uad_3_6', $4, $5, true, 1, $6)
         ON CONFLICT (uad_workfile_id) WHERE uad_workfile_id IS NOT NULL
         DO UPDATE SET updated_at = now()
         RETURNING id`,
        [
          reportFileId,
          workfile.organization_id || null,
          workfile.account_id,
          workfile.file_number,
          workfile.id,
          input.actor_user_id || workfile.assigned_appraiser_user_id || null,
        ],
      );
      await client.query(
        `UPDATE app.report_files
            SET is_current = (id = $3), updated_at = CASE WHEN id = $3 THEN now() ELSE updated_at END
          WHERE account_id = $1 AND workflow_type = 'uad_3_6'
            AND (organization_id IS NOT DISTINCT FROM $2::uuid)`,
        [workfile.account_id, workfile.organization_id || null, registered.rows[0].id],
      );
      const historyRegistry = await client.query(
        "SELECT to_regclass('app.appraisal_cases') AS table_name",
      );
      if (historyRegistry.rows[0]?.table_name) {
        await registerOriginalAppraisalReport(client, registered.rows[0].id, {
          actorUserId: input.actor_user_id || workfile.assigned_appraiser_user_id || null,
          captureReason: "desktop_uad_workfile_created",
        });
      }
    }
    await client.query("COMMIT");
    return workfile;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
