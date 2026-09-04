import { createHash, randomUUID } from "node:crypto";

import { loadCustomAppraisalPropertySnapshot } from "./customAppraisalReportPdf.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPRAISAL_WORKFLOWS = new Set(["custom_appraisal", "uad_3_6"]);
const CUSTOM_PROPERTY_SNAPSHOT_RELATIONS = Object.freeze([
  "core.value_summary_current",
  "core.market_values",
  "core.primary_improvements",
  "core.owner_summary",
  "core.owner_parties",
  "core.legal_description_current",
  "core.land_detail",
  "core.exemptions_summary",
  "core.secondary_improvements",
]);

export function normalizeAppraisalReportFileId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new Error("invalid_report_file_id");
  return id;
}

export function normalizeAppraisalWorkflow(value) {
  const workflow = String(value || "").trim();
  if (!APPRAISAL_WORKFLOWS.has(workflow)) throw new Error("invalid_appraisal_workflow");
  return workflow;
}

export function normalizeReplicationMode(value) {
  const mode = String(value || "").trim();
  if (!new Set(["same_assignment_alternate", "new_assignment_template"]).has(mode)) {
    throw new Error("invalid_replication_mode");
  }
  return mode;
}

function isoDate(value, code) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error(code);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(code);
  }
  return normalized;
}

function optionalUuid(value, code) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error(code);
  return normalized;
}

export function normalizeReplicationRequest(input = {}) {
  const mode = normalizeReplicationMode(input.mode);
  const targetWorkflow = normalizeAppraisalWorkflow(input.target_workflow_type);
  const sameAssignmentConfirmed = input.same_assignment_confirmed === true;
  if (mode === "same_assignment_alternate" && !sameAssignmentConfirmed) {
    throw new Error("same_assignment_confirmation_required");
  }
  const fileNumber = String(input.file_number || "").trim();
  if (fileNumber.length > 100 || /[\u0000-\u001f\u007f]/.test(fileNumber)) {
    throw new Error("invalid_file_number");
  }
  const clientRequestId = optionalUuid(input.client_request_id, "invalid_client_request_id");
  return Object.freeze({
    mode,
    targetWorkflow,
    fileNumber: fileNumber || null,
    effectiveDate: isoDate(input.effective_date, "invalid_effective_date"),
    inspectionDate: isoDate(input.inspection_date, "invalid_inspection_date"),
    sameAssignmentConfirmed,
    clientRequestId,
  });
}

async function reportFileForCapture(client, reportFileId, { lock = false } = {}) {
  const { rows } = await client.query(
    `SELECT report_file.*,
            custom_workfile.status AS custom_status,
            uad_workfile.status AS uad_status
       FROM app.report_files report_file
       LEFT JOIN app.custom_appraisal_workfiles custom_workfile
         ON custom_workfile.assignment_file_id = report_file.custom_assignment_file_id
       LEFT JOIN appraisal.uad_workfiles uad_workfile
         ON uad_workfile.id = report_file.uad_workfile_id
      WHERE report_file.id = $1
        AND report_file.workflow_type IN ('custom_appraisal', 'uad_3_6')
      ${lock ? "FOR UPDATE OF report_file" : ""}`,
    [reportFileId],
  );
  if (!rows.length) throw new Error("appraisal_report_file_not_found");
  return rows[0];
}

async function missingCustomPropertySnapshotRelations(client) {
  const { rows } = await client.query(
    `SELECT relation_name
       FROM unnest($1::text[]) AS required(relation_name)
      WHERE to_regclass(relation_name) IS NULL
      ORDER BY relation_name`,
    [CUSTOM_PROPERTY_SNAPSHOT_RELATIONS],
  );
  return rows.map((row) => row.relation_name);
}

async function currentSubjectData(client, reportFile) {
  const accountResult = await client.query(
    `SELECT to_jsonb(account) AS account
       FROM core.accounts account
      WHERE account.account_id = $1`,
    [reportFile.account_id],
  );
  if (!accountResult.rows.length) throw new Error("subject_account_not_found");

  if (reportFile.workflow_type === "custom_appraisal") {
    const unavailableRelations = await missingCustomPropertySnapshotRelations(client);
    const propertySnapshot = unavailableRelations.length
      ? {
        account: accountResult.rows[0].account,
        source_status: "partial",
        unavailable_relations: unavailableRelations,
        captured_at: new Date().toISOString(),
      }
      : await loadCustomAppraisalPropertySnapshot(client, {
        accountId: reportFile.account_id,
        assignmentFileId: Number(reportFile.custom_assignment_file_id),
      });
    const target = await client.query(
      `SELECT assignment.assignment_details,
              COALESCE(section.section_value, '{}'::jsonb) AS property_characteristics,
              assignment.revision,
              workfile.status,
              workfile.signed_at,
              signed.snapshot AS signed_snapshot
         FROM app.assignment_files assignment
         LEFT JOIN app.custom_appraisal_sections section
           ON section.assignment_file_id = assignment.id
          AND section.section_key = 'report.property_characteristics'
         LEFT JOIN app.custom_appraisal_workfiles workfile
           ON workfile.assignment_file_id = assignment.id
         LEFT JOIN app.custom_appraisal_signed_snapshots signed
           ON signed.assignment_file_id = assignment.id
        WHERE assignment.id = $1`,
      [reportFile.custom_assignment_file_id],
    );
    if (!target.rows.length) throw new Error("custom_appraisal_file_not_found");
    return {
      schema_version: 1,
      workflow_type: reportFile.workflow_type,
      account: accountResult.rows[0].account,
      assignment_details: target.rows[0].assignment_details || {},
      property_characteristics: target.rows[0].property_characteristics || {},
      custom_property_snapshot: propertySnapshot,
      custom_signed_snapshot: target.rows[0].signed_snapshot || null,
      target_revision: Number(target.rows[0].revision || 1),
      target_status: target.rows[0].status || "draft",
      target_signed_at: target.rows[0].signed_at || null,
    };
  }

  const target = await client.query(
    `SELECT workfile.current_revision, workfile.status,
            subject.subject_data, subject.source_manifest,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'entity_id', field.entity_id,
                'field_context', field.field_context,
                'uid', field.uad_uid,
                'report_field_id', field.report_field_id,
                'value', field.value,
                'source_type', field.source_type,
                'source_reference', field.source_reference,
                'source_observed_at', field.source_observed_at,
                'is_appraiser_confirmed', field.is_appraiser_confirmed
              ) ORDER BY field.field_context, field.uad_uid, field.entity_id)
                FROM appraisal.uad_field_values field
               WHERE field.workfile_id = workfile.id
            ), '[]'::jsonb) AS field_values,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', entity.id,
                'parent_entity_id', entity.parent_entity_id,
                'entity_type', entity.entity_type,
                'entity_identifier', entity.entity_identifier,
                'ordinal', entity.ordinal,
                'label', entity.label,
                'data', entity.data
              ) ORDER BY entity.entity_type, entity.ordinal, entity.id)
                FROM appraisal.uad_entities entity
               WHERE entity.workfile_id = workfile.id
            ), '[]'::jsonb) AS entities
       FROM appraisal.uad_workfiles workfile
       LEFT JOIN LATERAL (
         SELECT snapshot.subject_data, snapshot.source_manifest
           FROM appraisal.uad_subject_snapshots snapshot
          WHERE snapshot.workfile_id = workfile.id
          ORDER BY snapshot.snapshot_version DESC
          LIMIT 1
       ) subject ON true
      WHERE workfile.id = $1`,
    [reportFile.uad_workfile_id],
  );
  if (!target.rows.length) throw new Error("uad_workfile_not_found");
  return {
    schema_version: 1,
    workflow_type: reportFile.workflow_type,
    account: accountResult.rows[0].account,
    uad_subject_snapshot: target.rows[0].subject_data || {},
    uad_subject_source_manifest: target.rows[0].source_manifest || {},
    uad_field_values: target.rows[0].field_values || [],
    uad_entities: target.rows[0].entities || [],
    target_revision: Number(target.rows[0].current_revision || 1),
    target_status: target.rows[0].status || "draft",
  };
}

async function ensureAppraisalCase(client, reportFile, input = {}) {
  if (reportFile.appraisal_case_id) return reportFile.appraisal_case_id;
  const id = randomUUID();
  await client.query(
    `INSERT INTO app.appraisal_cases (
       id, organization_id, account_id, effective_date, inspection_date,
       created_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8)`,
    [
      id,
      reportFile.organization_id || null,
      reportFile.account_id,
      input.effectiveDate || null,
      input.inspectionDate || null,
      input.actorUserId || reportFile.created_by_user_id || null,
      reportFile.created_at,
      reportFile.updated_at,
    ],
  );
  await client.query(
    `UPDATE app.report_files
        SET appraisal_case_id = $2, updated_at = greatest(updated_at, now())
      WHERE id = $1`,
    [reportFile.id, id],
  );
  reportFile.appraisal_case_id = id;
  return id;
}

export async function captureAppraisalSubjectSnapshot(client, reportFileIdValue, input = {}) {
  const reportFileId = normalizeAppraisalReportFileId(reportFileIdValue);
  const reportFile = await reportFileForCapture(client, reportFileId, { lock: true });
  const appraisalCaseId = await ensureAppraisalCase(client, reportFile, input);
  if (input.effectiveDate || input.inspectionDate) {
    await client.query(
      `UPDATE app.appraisal_cases
          SET effective_date = COALESCE(effective_date, $2::date),
              inspection_date = COALESCE(inspection_date, $3::date),
              updated_at = now()
        WHERE id = $1`,
      [appraisalCaseId, input.effectiveDate || null, input.inspectionDate || null],
    );
  }
  const subjectData = await currentSubjectData(client, reportFile);
  const serialized = JSON.stringify(subjectData);
  const checksum = createHash("sha256").update(serialized).digest("hex");
  const versionResult = await client.query(
    `SELECT COALESCE(max(snapshot_version), 0) + 1 AS next_version
       FROM app.appraisal_subject_snapshots
      WHERE appraisal_case_id = $1`,
    [appraisalCaseId],
  );
  const snapshotId = randomUUID();
  const snapshotVersion = Number(versionResult.rows[0].next_version);
  const targetStatus = String(subjectData.target_status || "draft");
  const verificationStatus = input.verificationStatus || (
    ["signed", "exported", "submitted"].includes(targetStatus) ? "confirmed" : "captured"
  );
  await client.query(
    `INSERT INTO app.appraisal_subject_snapshots (
       id, appraisal_case_id, snapshot_version, parent_snapshot_id,
       source_report_file_id, verification_status, effective_date, inspection_date,
       subject_data, source_manifest, checksum_sha256, created_by_user_id
     )
     SELECT $1, $2, $3, $4, $5, $6, case_record.effective_date, case_record.inspection_date,
            $7::jsonb, $8::jsonb, $9, $10
       FROM app.appraisal_cases case_record
      WHERE case_record.id = $2`,
    [
      snapshotId,
      appraisalCaseId,
      snapshotVersion,
      reportFile.subject_snapshot_id || null,
      reportFileId,
      verificationStatus,
      serialized,
      JSON.stringify({
        capture_reason: input.captureReason || "report_file_capture",
        report_file_id: reportFileId,
        captured_at: new Date().toISOString(),
        target_revision: subjectData.target_revision,
      }),
      checksum,
      input.actorUserId || reportFile.created_by_user_id || null,
    ],
  );
  await client.query(
    `UPDATE app.report_files
        SET subject_snapshot_id = $2, updated_at = greatest(updated_at, now())
      WHERE id = $1`,
    [reportFileId, snapshotId],
  );
  return Object.freeze({
    id: snapshotId,
    appraisalCaseId,
    snapshotVersion,
    verificationStatus,
    checksumSha256: checksum,
    subjectData,
  });
}

export async function registerOriginalAppraisalReport(client, reportFileIdValue, input = {}) {
  const reportFileId = normalizeAppraisalReportFileId(reportFileIdValue);
  const reportFile = await reportFileForCapture(client, reportFileId, { lock: true });
  if (reportFile.appraisal_case_id && reportFile.subject_snapshot_id) {
    return Object.freeze({
      appraisalCaseId: reportFile.appraisal_case_id,
      snapshotId: reportFile.subject_snapshot_id,
      created: false,
    });
  }
  const snapshot = await captureAppraisalSubjectSnapshot(client, reportFileId, {
    ...input,
    captureReason: input.captureReason || "report_file_created",
  });
  return Object.freeze({
    appraisalCaseId: snapshot.appraisalCaseId,
    snapshotId: snapshot.id,
    created: true,
  });
}

function numeric(value) {
  const parsed = typeof value === "number"
    ? value
    : Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function uadValue(subjectData, uid, context = null) {
  const row = uadValues(subjectData, uid, context)[0];
  return row?.value ?? null;
}

function uadValues(subjectData, uid, context = null) {
  return (Array.isArray(subjectData?.uad_field_values) ? subjectData.uad_field_values : [])
    .filter((item) => item?.uid === uid && (!context || item?.field_context === context));
}

function measurementSquareFeet(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const amount = numeric(value.value ?? value.amount ?? value.measurement);
    if (amount === null) return null;
    const unit = String(value.unit || value.units || "SquareFeet").toLowerCase();
    if (unit === "acres" || unit === "acre") return amount * 43_560;
    if (unit === "hectares" || unit === "hectare") return amount * 107_639.104;
    if (unit === "squaremeters" || unit === "square_meters") return amount * 10.7639104;
    return amount;
  }
  return numeric(value);
}

function customLandRows(subjectData) {
  const propertyRows = subjectData?.property_characteristics?.land_detail;
  const signedProperty = subjectData?.custom_signed_snapshot?.evidence?.property_report_data;
  const currentProperty = signedProperty || subjectData?.custom_property_snapshot;
  const manualRows = currentProperty?.report_manual_values?.["report.land_details"]?.attribute_value?.land_detail;
  const capturedRows = currentProperty?.land;
  const publicRows = subjectData?.uad_subject_snapshot?.land_details;
  return Array.isArray(propertyRows) && propertyRows.length
    ? propertyRows
    : Array.isArray(manualRows) && manualRows.length
      ? manualRows
      : Array.isArray(capturedRows) && capturedRows.length
        ? capturedRows
        : Array.isArray(publicRows) ? publicRows : [];
}

export function summarizeAppraisalHistoryRow(row) {
  const subjectData = row.subject_data || {};
  const assignment = subjectData.assignment_details || {};
  const characteristics = subjectData.property_characteristics || {};
  const signedProperty = subjectData?.custom_signed_snapshot?.evidence?.property_report_data;
  const currentProperty = signedProperty || subjectData?.custom_property_snapshot || {};
  const manualCharacteristics = currentProperty?.report_manual_values?.["report.property_characteristics"]
    ?.attribute_value || {};
  const improvement = characteristics.main_improvement
    || manualCharacteristics.main_improvement
    || currentProperty.improvement
    || subjectData.uad_subject_snapshot?.primary_improvements
    || {};
  const landRows = customLandRows(subjectData);
  const entities = Array.isArray(subjectData.uad_entities) ? subjectData.uad_entities : [];
  const uadParcelCount = entities.filter((entity) => entity?.entity_type === "site_parcel").length;
  const landSquareFeet = landRows.reduce((total, item) => {
    const value = numeric(item?.area_sqft ?? item?.land_size ?? item?.size_sqft);
    return total + (value && value > 0 ? value : 0);
  }, 0);
  const uadArea = uadValues(subjectData, "1500.0022", "site_parcel")
    .reduce((total, row) => total + (measurementSquareFeet(row.value) || 0), 0);
  const siteSquareFeet = landSquareFeet || uadArea || null;
  const gla = numeric(
    improvement.living_area_sqft
      ?? improvement.total_living_area
      ?? improvement.gross_living_area
      ?? improvement.area_sqft,
  );
  const condition = assignment.subject_condition_rating
    || uadValue(subjectData, "1600.0006", "subject")
    || null;
  const quality = assignment.subject_quality_rating
    || uadValue(subjectData, "1600.0007", "subject")
    || null;
  const account = subjectData.account || currentProperty.account || subjectData.uad_subject_snapshot?.account || {};
  const manualLegal = currentProperty?.report_manual_values?.["report.subject_identification"]
    ?.attribute_value?.legal_description?.lines;
  const capturedLegal = currentProperty?.legal?.lines
    || currentProperty?.legal?.legal_description
    || currentProperty?.account?.legal_description;
  const uadLegal = uadValue(subjectData, "0100.0067", "subject_legal");
  const legalDescriptions = [...new Set([
    account.legal_description,
    ...(Array.isArray(manualLegal) ? manualLegal : []),
    ...(Array.isArray(capturedLegal) ? capturedLegal : [capturedLegal]),
    uadLegal,
    ...(Array.isArray(account.legal_descriptions) ? account.legal_descriptions : []),
  ].map((value) => String(value || "").trim()).filter(Boolean))];
  const targetId = row.custom_assignment_file_id ?? row.uad_workfile_id;
  return {
    id: row.id,
    appraisal_case_id: row.appraisal_case_id || null,
    subject_snapshot_id: row.subject_snapshot_id || null,
    snapshot_version: row.snapshot_version == null ? null : Number(row.snapshot_version),
    snapshot_verification_status: row.verification_status || null,
    workflow_type: row.workflow_type,
    file_number: row.file_number,
    status: row.custom_status || row.uad_status || "draft",
    current_revision: Number(row.custom_revision || row.uad_revision || row.registry_revision || 1),
    is_current: Boolean(row.is_current),
    effective_date: row.effective_date || null,
    inspection_date: row.inspection_date || null,
    property_type: row.property_type || null,
    inspection_method: row.inspection_method || null,
    summary: {
      condition_rating: condition,
      quality_rating: quality,
      gross_living_area_sqft: gla,
      site_area_sqft: siteSquareFeet,
      site_area_acres: siteSquareFeet ? siteSquareFeet / 43_560 : null,
      parcel_count: uadParcelCount || (landRows.length || null),
      legal_descriptions: legalDescriptions,
      photo_count: Number(row.photo_count || 0),
      has_confirmed_sketch: Boolean(row.has_confirmed_sketch),
    },
    replication: row.replication_mode && row.replication_mode !== "original" ? {
      mode: row.replication_mode,
      source_report_file_id: row.source_report_file_id || null,
      source_file_number: row.source_file_number || null,
      change_review_required: Boolean(row.change_review_required),
    } : null,
    target_id: targetId == null ? null : String(targetId),
    view_url: row.workflow_type === "custom_appraisal"
      ? `/report/${encodeURIComponent(row.account_id)}?assignmentFileId=${encodeURIComponent(String(targetId))}`
      : `/uad-3.6/${encodeURIComponent(row.account_id)}?workfileId=${encodeURIComponent(String(targetId))}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listPreviousAppraisalFiles(pool, accountIdValue, accessScope = null) {
  const accountId = String(accountIdValue || "").trim();
  if (!accountId || accountId.length > 100) throw new Error("invalid_account_id");
  const { rows } = await pool.query(
    `SELECT report_file.*,
            case_record.effective_date,
            case_record.inspection_date,
            snapshot.snapshot_version,
            snapshot.verification_status,
            snapshot.subject_data,
            custom_workfile.status AS custom_status,
            custom_assignment.revision AS custom_revision,
            uad_workfile.status AS uad_status,
            uad_workfile.current_revision AS uad_revision,
            uad_workfile.property_type,
            uad_workfile.inspection_method,
            replication.source_report_file_id,
            replication.change_review_required,
            source_file.file_number AS source_file_number,
            COALESCE(photo_summary.photo_count, 0) AS photo_count,
            COALESCE(sketch_summary.has_confirmed_sketch, false) AS has_confirmed_sketch
       FROM app.report_files report_file
       LEFT JOIN app.appraisal_cases case_record ON case_record.id = report_file.appraisal_case_id
       LEFT JOIN app.appraisal_subject_snapshots snapshot ON snapshot.id = report_file.subject_snapshot_id
       LEFT JOIN app.appraisal_file_replications replication
         ON replication.target_report_file_id = report_file.id
       LEFT JOIN app.report_files source_file ON source_file.id = replication.source_report_file_id
       LEFT JOIN app.custom_appraisal_workfiles custom_workfile
         ON custom_workfile.assignment_file_id = report_file.custom_assignment_file_id
       LEFT JOIN app.assignment_files custom_assignment
         ON custom_assignment.id = report_file.custom_assignment_file_id
       LEFT JOIN appraisal.uad_workfiles uad_workfile
         ON uad_workfile.id = report_file.uad_workfile_id
       LEFT JOIN LATERAL (
         SELECT (
           (SELECT count(*)
              FROM app.inspection_photos photo
             WHERE photo.report_file_id = report_file.id
               AND photo.status = 'verified')
           +
           (SELECT count(*)
              FROM appraisal.uad_assets asset
             WHERE asset.workfile_id = report_file.uad_workfile_id
               AND asset.status = 'verified'
               AND asset.asset_kind IN ('photo', 'image'))
         )::integer AS photo_count
       ) photo_summary ON true
       LEFT JOIN LATERAL (
         SELECT bool_or(sketch.review_status = 'appraiser_confirmed') AS has_confirmed_sketch
           FROM app.inspection_sessions session
           JOIN app.inspection_sketches sketch ON sketch.inspection_session_id = session.id
          WHERE session.report_file_id = report_file.id
       ) sketch_summary ON true
      WHERE report_file.account_id = $1
        AND report_file.workflow_type IN ('custom_appraisal', 'uad_3_6')
        AND (
          $2::uuid[] IS NULL
          OR $6::boolean = true
          OR (
            report_file.organization_id = ANY($2::uuid[])
            AND (
              (report_file.workflow_type = 'custom_appraisal' AND (
                report_file.organization_id = ANY($3::uuid[])
                OR custom_assignment.assigned_appraiser_user_id = $5::uuid
                OR custom_assignment.supervisory_appraiser_user_id = $5::uuid
              ))
              OR
              (report_file.workflow_type = 'uad_3_6' AND (
                report_file.organization_id = ANY($4::uuid[])
                OR uad_workfile.assigned_appraiser_user_id = $5::uuid
                OR uad_workfile.supervisory_appraiser_user_id = $5::uuid
              ))
            )
          )
        )
      ORDER BY report_file.updated_at DESC, report_file.created_at DESC, report_file.id`,
    [
      accountId,
      accessScope?.organizationIds || null,
      accessScope?.customOrganizationWideReadIds || [],
      accessScope?.uadOrganizationWideReadIds || [],
      accessScope?.userId || null,
      Boolean(accessScope?.platformAdministrator),
    ],
  );
  const currentRows = [];
  for (const row of rows) {
    try {
      currentRows.push({ ...row, subject_data: await currentSubjectData(pool, row) });
    } catch {
      // Historical snapshots remain readable even if an optional live source is
      // temporarily unavailable. Replication always performs a fresh capture.
      currentRows.push(row);
    }
  }
  return {
    account_id: accountId,
    files: currentRows.map(summarizeAppraisalHistoryRow),
  };
}
