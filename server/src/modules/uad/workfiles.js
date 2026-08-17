import { randomUUID } from "node:crypto";

import {
  CURRENT_UAD_RELEASE_KEY,
  INITIAL_UAD_INSPECTION_METHOD,
  INITIAL_UAD_PROPERTY_TYPE,
} from "./constants.js";
import { buildUadPrefillValues } from "./fieldCatalog.js";

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
  return `HN-UAD-${year}-${suffix}-${idSuffix}`;
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

export async function listUadWorkfiles(pool, accountIdValue) {
  const accountId = normalizeUadAccountId(accountIdValue);
  const { rows } = await pool.query(
    `SELECT *
       FROM appraisal.uad_workfiles
      WHERE account_id = $1
      ORDER BY updated_at DESC, id`,
    [accountId],
  );
  return rows.map(workfileResponse);
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

export async function createUadWorkfile(pool, accountIdValue, input = {}) {
  const accountId = normalizeUadAccountId(accountIdValue);
  const workfileId = randomUUID();
  const snapshotId = randomUUID();
  const propertyEntityId = randomUUID();
  const dwellingEntityId = randomUUID();
  const unitEntityId = randomUUID();
  const revisionId = randomUUID();
  const fileNumber = normalizeUadFileNumber(input.file_number, { accountId, workfileId });
  const organizationId = input.organization_id || null;
  const appraiserUserId = input.assigned_appraiser_user_id || null;
  const specificationReleaseKey = input.specification_release_key || CURRENT_UAD_RELEASE_KEY;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const subjectData = await loadSubjectSnapshot(client, accountId);

    const inserted = await client.query(
      `INSERT INTO appraisal.uad_workfiles (
         id, organization_id, account_id, file_number, specification_release_key,
         property_type, inspection_method, assignment_purpose,
         assigned_appraiser_user_id, created_by_user_id, updated_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)
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
      ],
    );

    await client.query(
      `INSERT INTO appraisal.uad_subject_snapshots (
         id, workfile_id, snapshot_version, source_account_updated_at,
         source_manifest, subject_data, created_by_user_id
       ) VALUES (
         $1, $2, 1, ($3->'account'->>'updated_at')::timestamptz,
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
        appraiserUserId,
      ],
    );

    await client.query(
      `INSERT INTO appraisal.uad_entities (
         id, workfile_id, parent_entity_id, entity_type, entity_identifier, ordinal, label
       ) VALUES
         ($1, $4, NULL, 'property', 'subject', 1, 'Subject Property'),
         ($2, $4, $1, 'dwelling', 'dwelling-1', 1, 'Dwelling 1'),
         ($3, $4, $2, 'unit', 'unit-1', 1, 'Unit 1')`,
      [propertyEntityId, dwellingEntityId, unitEntityId, workfileId],
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
          },
        }),
        appraiserUserId,
      ],
    );

    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, actor_user_id, event_type, entity_type, entity_id, after_data
       ) VALUES ($1, $2, 'uad_workfile.created', 'uad_workfile', $1::text, $3::jsonb)`,
      [workfileId, appraiserUserId, JSON.stringify({ account_id: accountId, file_number: fileNumber })],
    );

    await client.query("COMMIT");
    return workfileResponse(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
