import { normalizeAccountId, normalizeUuid } from "./reportFiles.js";
import { canonicalJson } from "./sync.js";
import { normalizePropertyTaxWorkfileData } from "./targetFields.js";

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizeWorkfileData(value) {
  const normalized = normalizePropertyTaxWorkfileData(value);
  const serialized = canonicalJson(normalized);
  if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) throw new Error("invalid_property_tax_protest_workfile");
  return JSON.parse(serialized);
}

function response(row, extras = {}) {
  return {
    report_file_id: row.report_file_id,
    tax_protest_file_id: row.tax_protest_file_id,
    organization_id: row.organization_id,
    assigned_appraiser_user_id: row.assigned_appraiser_user_id || null,
    account_id: row.account_id,
    file_number: row.file_number,
    previous_file_id: row.previous_file_id || null,
    workfile_data: plainObject(row.workfile_data) ? row.workfile_data : {},
    status: row.status,
    revision: Number(row.revision),
    registry_revision: Number(row.registry_revision),
    is_current: Boolean(row.is_current),
    completed_at: row.completed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extras,
  };
}

async function selectFile(queryable, accountId, fileId = null, {
  lock = false,
  organizationIds = null,
} = {}) {
  const result = await queryable.query(
    `SELECT report_file.id AS report_file_id, report_file.registry_revision,
            report_file.is_current, report_file.organization_id,
            protest.id AS tax_protest_file_id, protest.account_id,
            protest.file_number, protest.previous_file_id, protest.workfile_data,
            protest.assigned_appraiser_user_id,
            protest.status, protest.revision, protest.completed_at,
            protest.created_at, protest.updated_at
       FROM app.report_files report_file
       JOIN app.tax_protest_files protest ON protest.id = report_file.tax_protest_file_id
      WHERE report_file.account_id = $1
        AND report_file.workflow_type = 'property_tax_protest'
        AND ($2::uuid IS NULL OR protest.id = $2)
        AND ($3::uuid[] IS NULL OR report_file.organization_id = ANY($3::uuid[]))
      ORDER BY report_file.is_current DESC, protest.updated_at DESC, protest.created_at DESC
      LIMIT 1
      ${lock ? "FOR UPDATE OF report_file, protest" : ""}`,
    [accountId, fileId, organizationIds],
  );
  return result.rows[0] || null;
}

export async function getDesktopPropertyTaxFile(pool, accountIdValue, fileIdValue = null, {
  organizationIds = null,
} = {}) {
  const accountId = normalizeAccountId(accountIdValue);
  const fileId = fileIdValue ? normalizeUuid(fileIdValue, "invalid_property_tax_protest_file_id") : null;
  const row = await selectFile(pool, accountId, fileId, { organizationIds });
  if (!row) return null;
  const [photos, sketch] = await Promise.all([
    pool.query(
      `SELECT photo.id, photo.category, photo.room_label, photo.caption,
              photo.position, photo.verified_at, photo.retention_until
         FROM app.inspection_photos photo
        WHERE photo.report_file_id = $1 AND photo.status = 'verified'
        ORDER BY photo.position, photo.created_at, photo.id`,
      [row.report_file_id],
    ),
    pool.query(
      `SELECT revision, summary, review_status, updated_at
         FROM app.inspection_sketches
        WHERE report_file_id = $1
        ORDER BY revision DESC, updated_at DESC, id DESC LIMIT 1`,
      [row.report_file_id],
    ),
  ]);
  return response(row, {
    photos: {
      verified_count: photos.rows.length,
      items: photos.rows.map((item) => ({ ...item, position: Number(item.position) })),
    },
    sketch: sketch.rows[0]
      ? { ...sketch.rows[0], revision: Number(sketch.rows[0].revision) }
      : null,
  });
}

export async function saveDesktopPropertyTaxFile(pool, accountIdValue, fileIdValue, input = {}) {
  const accountId = normalizeAccountId(accountIdValue);
  const fileId = normalizeUuid(fileIdValue, "invalid_property_tax_protest_file_id");
  if (!plainObject(input) || Object.keys(input).some((key) => !new Set(["expected_revision", "workfile_data", "reviewer"]).has(key))) {
    throw new Error("invalid_property_tax_protest_update");
  }
  const expectedRevision = Number(input.expected_revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("invalid_property_tax_protest_revision");
  const workfileData = normalizeWorkfileData(input.workfile_data);
  const reviewer = String(input.reviewer || "HomeNode desktop").trim().slice(0, 200) || "HomeNode desktop";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await selectFile(client, accountId, fileId, { lock: true });
    if (!row) throw new Error("property_tax_protest_file_not_found");
    if (Number(row.revision) !== expectedRevision) {
      const error = new Error("property_tax_protest_revision_conflict");
      error.currentRevision = Number(row.revision);
      throw error;
    }
    const nextRevision = expectedRevision + 1;
    const updated = await client.query(
      `UPDATE app.tax_protest_files
          SET workfile_data = $2::jsonb, revision = $3, status = 'in_progress', updated_at = now()
        WHERE id = $1 RETURNING *`,
      [fileId, JSON.stringify(workfileData), nextRevision],
    );
    await client.query(
      `INSERT INTO app.tax_protest_file_history (
         tax_protest_file_id, revision, workfile_data, status, change_summary
       ) VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [fileId, nextRevision, JSON.stringify(workfileData), updated.rows[0].status, `${reviewer} saved the desktop protest workfile`],
    );
    const registry = await client.query(
      `UPDATE app.report_files
          SET registry_revision = registry_revision + 1, updated_at = now()
        WHERE id = $1 RETURNING registry_revision`,
      [row.report_file_id],
    );
    const nextRegistryRevision = Number(registry.rows[0].registry_revision);
    await client.query(
      `INSERT INTO app.report_file_events (
         report_file_id, event_type, prior_registry_revision,
         next_registry_revision, changed_fields, metadata
       ) VALUES ($1, 'property_tax_protest.desktop_saved', $2, $3, $4::text[], $5::jsonb)`,
      [
        row.report_file_id,
        nextRegistryRevision - 1,
        nextRegistryRevision,
        ["property_tax_protest.workfile_data"],
        JSON.stringify({ tax_protest_revision: nextRevision, reviewer }),
      ],
    );
    await client.query("COMMIT");
    return response({
      ...row,
      ...updated.rows[0],
      report_file_id: row.report_file_id,
      tax_protest_file_id: fileId,
      registry_revision: nextRegistryRevision,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
