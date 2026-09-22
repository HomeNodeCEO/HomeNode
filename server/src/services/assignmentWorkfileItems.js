import { createHash, randomUUID } from "node:crypto";
import { assertLockedUadWorkfileMutable } from "../modules/uad/workfileLifecycle.js";

export const MAX_ASSIGNMENT_WORKFILE_ITEM_BYTES = 100 * 1024 * 1024;

const SAFE_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
  "text/rtf",
  "text/plain",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
  "application/octet-stream",
]);

const SAFE_EXTENSIONS = new Set([
  ".pdf", ".xls", ".xlsx", ".csv", ".doc", ".docx", ".rtf", ".txt",
  ".jpg", ".jpeg", ".png", ".webp", ".svg",
]);

function cleanText(value, maximum = 300) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, maximum);
}

function safeFileName(value) {
  const fileName = cleanText(value, 255).replace(/[\\/:*?"<>|]/g, "-");
  if (!fileName || fileName === "." || fileName === "..") throw new Error("invalid_workfile_file_name");
  return fileName;
}

function fileExtension(fileName) {
  const match = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] || "";
}

function normalizeContentType(value, fileName) {
  const contentType = cleanText(value, 200).toLowerCase().split(";")[0];
  if (!SAFE_CONTENT_TYPES.has(contentType) || !SAFE_EXTENSIONS.has(fileExtension(fileName))) {
    throw new Error("unsupported_workfile_file_type");
  }
  return contentType;
}

function normalizeScope(scope) {
  const assignmentFileId = Number(scope?.assignmentFileId);
  const uadWorkfileId = cleanText(scope?.uadWorkfileId, 80).toLowerCase();
  if (Number.isSafeInteger(assignmentFileId) && assignmentFileId > 0 && !uadWorkfileId) {
    return { assignmentFileId, uadWorkfileId: null, scopeType: "custom", scopeId: String(assignmentFileId) };
  }
  if (!scope?.assignmentFileId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uadWorkfileId)) {
    return { assignmentFileId: null, uadWorkfileId, scopeType: "uad", scopeId: uadWorkfileId };
  }
  throw new Error("invalid_workfile_item_scope");
}

function normalizedItem(row) {
  return {
    id: row.id,
    item_type: row.item_type,
    title: row.title,
    original_file_name: row.original_file_name,
    content_type: row.content_type,
    file_size_bytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
    checksum_sha256: row.checksum_sha256,
    external_url: row.external_url,
    created_by_user_id: row.created_by_user_id,
    created_at: row.created_at,
  };
}

async function assertMutableScope(client, normalized) {
  if (normalized.assignmentFileId) {
    const { rows } = await client.query(
      `SELECT assignment_file_id, status
         FROM app.custom_appraisal_workfiles
        WHERE assignment_file_id = $1
        FOR UPDATE`,
      [normalized.assignmentFileId],
    );
    if (!rows.length) throw new Error("assignment_workfile_not_found");
    if (rows[0].status !== "draft") throw new Error("assignment_workfile_status_locked");
    return;
  }
  const { rows } = await client.query(
    `SELECT id, status, signed_at
       FROM appraisal.uad_workfiles
      WHERE id = $1
      FOR UPDATE`,
    [normalized.uadWorkfileId],
  );
  if (!rows.length) throw new Error("uad_workfile_not_found");
  await assertLockedUadWorkfileMutable(client, rows[0]);
}

async function transact(pool, operation) {
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  try {
    if (client !== pool) await client.query("BEGIN");
    const result = await operation(client);
    if (client !== pool) await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client !== pool) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (client !== pool) client.release();
  }
}

export async function listAssignmentWorkfileItems(pool, scope) {
  const normalized = normalizeScope(scope);
  const column = normalized.assignmentFileId ? "assignment_file_id" : "uad_workfile_id";
  const value = normalized.assignmentFileId || normalized.uadWorkfileId;
  const { rows } = await pool.query(
    `SELECT id, item_type, title, original_file_name, content_type,
            file_size_bytes, checksum_sha256, external_url,
            created_by_user_id, created_at
       FROM app.assignment_workfile_items
      WHERE ${column} = $1
      ORDER BY created_at DESC, id DESC`,
    [value],
  );
  return rows.map(normalizedItem);
}

export async function createAssignmentWorkfileFile(pool, storage, scope, input) {
  const normalized = normalizeScope(scope);
  const organizationId = cleanText(input?.organizationId, 80).toLowerCase();
  if (!organizationId) throw new Error("workfile_item_organization_required");
  const content = Buffer.isBuffer(input?.content) ? input.content : Buffer.from(input?.content || "");
  if (!content.length) throw new Error("workfile_file_content_required");
  if (content.length > MAX_ASSIGNMENT_WORKFILE_ITEM_BYTES) throw new Error("workfile_file_too_large");
  if (!storage?.configured || typeof storage.putObject !== "function") throw new Error("workfile_storage_not_configured");
  const fileName = safeFileName(input?.fileName);
  const contentType = normalizeContentType(input?.contentType, fileName);
  const checksum = createHash("sha256").update(content).digest("hex");
  const id = randomUUID();
  const objectKey = `organizations/${organizationId}/workfiles/${normalized.scopeType}/${normalized.scopeId}/items/${id}/${checksum}/${encodeURIComponent(fileName)}`;
  await storage.putObject({ objectKey, contentType, body: content });
  try {
    return await transact(pool, async client => {
      await assertMutableScope(client, normalized);
      const { rows } = await client.query(
        `INSERT INTO app.assignment_workfile_items (
           id, organization_id, assignment_file_id, uad_workfile_id, item_type,
           title, original_file_name, content_type, file_size_bytes,
           checksum_sha256, object_key, created_by_user_id
         ) VALUES ($1, $2, $3, $4, 'file', $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, item_type, title, original_file_name, content_type,
                   file_size_bytes, checksum_sha256, external_url,
                   created_by_user_id, created_at`,
        [
          id,
          organizationId,
          normalized.assignmentFileId,
          normalized.uadWorkfileId,
          cleanText(input?.title, 300) || fileName,
          fileName,
          contentType,
          content.length,
          checksum,
          objectKey,
          input?.createdByUserId || null,
        ],
      );
      return normalizedItem(rows[0]);
    });
  } catch (error) {
    await storage.deleteObject?.({ objectKey }).catch(() => undefined);
    throw error;
  }
}

export async function createAssignmentWorkfileLink(pool, scope, input) {
  const normalized = normalizeScope(scope);
  const organizationId = cleanText(input?.organizationId, 80).toLowerCase();
  if (!organizationId) throw new Error("workfile_item_organization_required");
  let externalUrl;
  try {
    externalUrl = new URL(String(input?.externalUrl || "").trim());
  } catch {
    throw new Error("invalid_workfile_link");
  }
  if (!new Set(["https:", "http:"]).has(externalUrl.protocol) || externalUrl.username || externalUrl.password) {
    throw new Error("invalid_workfile_link");
  }
  const title = cleanText(input?.title, 300);
  if (!title) throw new Error("workfile_link_title_required");
  return transact(pool, async client => {
    await assertMutableScope(client, normalized);
    const { rows } = await client.query(
      `INSERT INTO app.assignment_workfile_items (
         id, organization_id, assignment_file_id, uad_workfile_id, item_type,
         title, external_url, created_by_user_id
       ) VALUES ($1, $2, $3, $4, 'link', $5, $6, $7)
       RETURNING id, item_type, title, original_file_name, content_type,
                 file_size_bytes, checksum_sha256, external_url,
                 created_by_user_id, created_at`,
      [
        randomUUID(),
        organizationId,
        normalized.assignmentFileId,
        normalized.uadWorkfileId,
        title,
        externalUrl.toString(),
        input?.createdByUserId || null,
      ],
    );
    return normalizedItem(rows[0]);
  });
}

export async function getAssignmentWorkfileFile(pool, storage, scope, itemId) {
  const normalized = normalizeScope(scope);
  const column = normalized.assignmentFileId ? "assignment_file_id" : "uad_workfile_id";
  const value = normalized.assignmentFileId || normalized.uadWorkfileId;
  const { rows } = await pool.query(
    `SELECT id, title, original_file_name, content_type, file_size_bytes,
            checksum_sha256, object_key
       FROM app.assignment_workfile_items
      WHERE id = $1 AND ${column} = $2 AND item_type = 'file'`,
    [itemId, value],
  );
  if (!rows.length) throw new Error("workfile_item_not_found");
  if (!storage?.configured || typeof storage.getObject !== "function") throw new Error("workfile_storage_not_configured");
  const item = rows[0];
  const object = await storage.getObject({
    objectKey: item.object_key,
    maxBytes: Math.min(Number(item.file_size_bytes) + 1, MAX_ASSIGNMENT_WORKFILE_ITEM_BYTES + 1),
  });
  const body = Buffer.isBuffer(object?.body) ? object.body : Buffer.from(object?.body || "");
  if (body.length !== Number(item.file_size_bytes)
      || createHash("sha256").update(body).digest("hex") !== item.checksum_sha256) {
    throw new Error("workfile_file_integrity_failed");
  }
  return { ...item, body };
}

export async function deleteAssignmentWorkfileItem(pool, storage, scope, itemId) {
  const normalized = normalizeScope(scope);
  const column = normalized.assignmentFileId ? "assignment_file_id" : "uad_workfile_id";
  const value = normalized.assignmentFileId || normalized.uadWorkfileId;
  let removed;
  await transact(pool, async client => {
    await assertMutableScope(client, normalized);
    const { rows } = await client.query(
      `DELETE FROM app.assignment_workfile_items
        WHERE id = $1 AND ${column} = $2
        RETURNING id, item_type, object_key`,
      [itemId, value],
    );
    if (!rows.length) throw new Error("workfile_item_not_found");
    [removed] = rows;
  });
  // Database deletion is authoritative. A failed object cleanup must not make
  // a successfully removed item reappear; bucket lifecycle cleanup can safely
  // collect a rare orphaned object later.
  if (removed.object_key && storage?.configured && typeof storage.deleteObject === "function") {
    await storage.deleteObject({ objectKey: removed.object_key }).catch(() => undefined);
  }
  return { id: removed.id };
}
