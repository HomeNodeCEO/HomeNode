import { createHash } from "node:crypto";

import {
  extractPdfEvidence,
  findZoningDescriptionInPages,
  normalizeDocumentType,
} from "./documentIntelligence.js";
import { sanitizeUadFileName } from "../modules/uad/r2Storage.js";

export const MAX_ASSIGNMENT_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_AUTOMATIC_DOCUMENT_ATTEMPTS = 5;
const STALE_PROCESSING_MINUTES = 15;

function cleanText(value, maximum = 4_000) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maximum) : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function buildAssignmentDocumentObjectKey({
  accountId,
  assignmentFileId = null,
  checksumSha256,
  fileName,
} = {}) {
  const account = sanitizeUadFileName(accountId || "unassigned-account");
  const assignment = positiveInteger(assignmentFileId) || "property-evidence";
  const checksum = String(checksumSha256 || "unverified")
    .replace(/[^a-f0-9]/gi, "")
    .toLowerCase()
    .slice(0, 64) || "unverified";
  return `organizations/unassigned/custom-appraisal/accounts/${account}`
    + `/assignment-files/${assignment}/documents/${checksum}/${sanitizeUadFileName(fileName || "document.pdf")}`;
}

function verifiedR2Object(inspected, { content, checksumSha256 }) {
  const actualSize = Number(inspected?.byte_size || 0);
  if (actualSize !== content.length) throw new Error("assignment_document_storage_size_mismatch");
  if (createHash("sha256").update(content).digest("hex") !== checksumSha256) {
    throw new Error("assignment_document_storage_checksum_mismatch");
  }
  return {
    storage_etag: cleanText(inspected?.etag, 500),
    storage_content_type: cleanText(inspected?.content_type, 200) || "application/pdf",
  };
}

export function assignmentDocumentRetryDelayMs(attempts) {
  const boundedAttempts = Math.max(1, Math.min(Number(attempts) || 1, 20));
  return Math.min(6 * 60 * 60 * 1_000, 30_000 * (2 ** (boundedAttempts - 1)));
}

export function assignmentDocumentCandidateReviewKey(candidate = {}) {
  const fieldKey = cleanText(candidate.field_key, 300) || "";
  const value = cleanText(candidate.normalized_value ?? candidate.raw_value, 4_000) || "";
  return `${fieldKey}\u0000${value}`;
}

export function retainedAssignmentDocumentReview(previousReviews = [], candidate = {}) {
  const key = assignmentDocumentCandidateReviewKey(candidate);
  const matching = previousReviews.find((review) => (
    review?.review_status !== "suggested" &&
    assignmentDocumentCandidateReviewKey(review) === key
  ));
  return matching ? {
    review_status: matching.review_status,
    confirmed_value: matching.confirmed_value,
    reviewer: matching.reviewer,
    reviewed_at: matching.reviewed_at,
  } : {
    review_status: "suggested",
    confirmed_value: null,
    reviewer: null,
    reviewed_at: null,
  };
}

function publicCandidate(row) {
  return {
    id: Number(row.id),
    document_id: Number(row.document_id),
    field_key: row.field_key,
    raw_value: row.raw_value,
    normalized_value: row.normalized_value,
    page_number: row.page_number == null ? null : Number(row.page_number),
    confidence: row.confidence == null ? null : Number(row.confidence),
    evidence_excerpt: row.evidence_excerpt,
    extraction_method: row.extraction_method,
    review_status: row.review_status,
    confirmed_value: row.confirmed_value,
    reviewer: row.reviewer,
    reviewed_at: row.reviewed_at,
  };
}

function publicCandidateReview(row) {
  return {
    id: Number(row.id),
    document_id: Number(row.document_id),
    candidate_id: row.candidate_id == null ? null : Number(row.candidate_id),
    field_key: row.field_key,
    raw_value: row.raw_value,
    normalized_value: row.normalized_value,
    review_status: row.review_status,
    confirmed_value: row.confirmed_value,
    reviewer: row.reviewer,
    reviewed_at: row.reviewed_at,
  };
}

function publicDocument(row, candidates = undefined) {
  return {
    id: Number(row.id),
    account_id: row.account_id,
    assignment_file_id: row.assignment_file_id == null ? null : Number(row.assignment_file_id),
    document_type: row.document_type,
    title: row.title,
    file_name: row.file_name,
    content_type: row.content_type,
    checksum_sha256: row.checksum_sha256,
    file_size_bytes: Number(row.file_size_bytes || 0),
    page_count: row.page_count == null ? null : Number(row.page_count),
    processing_status: row.processing_status,
    processing_attempts: Number(row.processing_attempts || 0),
    processing_started_at: row.processing_started_at,
    next_processing_at: row.next_processing_at,
    last_processing_error: row.last_processing_error,
    extraction_method: row.extraction_method,
    extraction_summary: row.extraction_summary || {},
    source_kind: row.source_kind,
    source_url: row.source_url,
    storage_provider: row.storage_provider || "postgres",
    storage_status: row.storage_status || "stored",
    storage_verified_at: row.storage_verified_at,
    storage_last_error: row.storage_last_error,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at,
    processed_at: row.processed_at,
    reviewed_at: row.reviewed_at,
    content_url: `/api/documents/${row.id}/content`,
    ...(candidates === undefined ? {} : { candidates }),
  };
}

export async function ensureAssignmentDocumentsSchema(pool) {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE TABLE IF NOT EXISTS app.assignment_documents (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL,
      assignment_file_id bigint REFERENCES app.assignment_files(id) ON DELETE SET NULL,
      document_type text NOT NULL DEFAULT 'other'
        CHECK (document_type IN (
          'zoning_map', 'zoning_ordinance', 'purchase_contract',
          'engagement_letter', 'mls_sheet', 'map', 'other'
        )),
      title text NOT NULL,
      file_name text NOT NULL,
      content_type text NOT NULL DEFAULT 'application/pdf',
      content bytea,
      checksum_sha256 text NOT NULL,
      file_size_bytes bigint NOT NULL,
      storage_provider text NOT NULL DEFAULT 'postgres'
        CHECK (storage_provider IN ('postgres', 'r2')),
      storage_status text NOT NULL DEFAULT 'stored'
        CHECK (storage_status IN ('stored', 'migration_failed')),
      storage_bucket text,
      object_key text,
      storage_etag text,
      storage_content_type text,
      storage_verified_at timestamptz,
      storage_last_error text,
      page_count integer,
      processing_status text NOT NULL DEFAULT 'uploaded'
        CHECK (processing_status IN (
          'uploaded', 'processing', 'review_required', 'ocr_required',
          'extraction_failed', 'reviewed'
        )),
      extraction_method text,
      extraction_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_kind text NOT NULL DEFAULT 'upload'
        CHECK (source_kind IN ('upload', 'official_url', 'zoning_cache')),
      source_url text,
      uploaded_by text,
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz,
      reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE app.assignment_documents
      ADD COLUMN IF NOT EXISTS processing_attempts integer NOT NULL DEFAULT 0;
    ALTER TABLE app.assignment_documents
      ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;
    ALTER TABLE app.assignment_documents
      ADD COLUMN IF NOT EXISTS next_processing_at timestamptz;
    ALTER TABLE app.assignment_documents
      ADD COLUMN IF NOT EXISTS last_processing_error text;
    ALTER TABLE app.assignment_documents ALTER COLUMN content DROP NOT NULL;
    ALTER TABLE app.assignment_documents
      ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'postgres';
    ALTER TABLE app.assignment_documents
      ADD COLUMN IF NOT EXISTS storage_status text NOT NULL DEFAULT 'stored';
    ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS storage_bucket text;
    ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS object_key text;
    ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS storage_etag text;
    ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS storage_content_type text;
    ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS storage_verified_at timestamptz;
    ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS storage_last_error text;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'assignment_documents_storage_provider_check'
          AND conrelid = 'app.assignment_documents'::regclass
      ) THEN
        ALTER TABLE app.assignment_documents
          ADD CONSTRAINT assignment_documents_storage_provider_check
          CHECK (storage_provider IN ('postgres', 'r2'));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'assignment_documents_storage_status_check'
          AND conrelid = 'app.assignment_documents'::regclass
      ) THEN
        ALTER TABLE app.assignment_documents
          ADD CONSTRAINT assignment_documents_storage_status_check
          CHECK (storage_status IN ('stored', 'migration_failed'));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'assignment_documents_storage_payload_check'
          AND conrelid = 'app.assignment_documents'::regclass
      ) THEN
        ALTER TABLE app.assignment_documents
          ADD CONSTRAINT assignment_documents_storage_payload_check
          CHECK (
            (storage_provider = 'postgres' AND content IS NOT NULL)
            OR
            (
              storage_provider = 'r2' AND content IS NULL
              AND storage_bucket IS NOT NULL AND object_key IS NOT NULL
              AND storage_verified_at IS NOT NULL
            )
          );
      END IF;
    END
    $$;
    CREATE UNIQUE INDEX IF NOT EXISTS assignment_documents_scope_checksum_uidx
      ON app.assignment_documents (
        account_id, COALESCE(assignment_file_id, 0), checksum_sha256
      );
    CREATE INDEX IF NOT EXISTS assignment_documents_account_idx
      ON app.assignment_documents (account_id, assignment_file_id, uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS assignment_documents_processing_idx
      ON app.assignment_documents (processing_status, uploaded_at)
      WHERE processing_status IN ('uploaded', 'processing', 'extraction_failed');
    CREATE INDEX IF NOT EXISTS assignment_documents_storage_migration_idx
      ON app.assignment_documents (storage_status, uploaded_at)
      WHERE storage_provider = 'postgres' AND content IS NOT NULL;

    CREATE TABLE IF NOT EXISTS app.assignment_document_pages (
      document_id bigint NOT NULL
        REFERENCES app.assignment_documents(id) ON DELETE CASCADE,
      page_number integer NOT NULL CHECK (page_number > 0),
      extracted_text text NOT NULL DEFAULT '',
      text_length integer NOT NULL DEFAULT 0,
      extraction_method text NOT NULL DEFAULT 'pdf_text',
      PRIMARY KEY (document_id, page_number)
    );

    CREATE TABLE IF NOT EXISTS app.assignment_document_field_candidates (
      id bigserial PRIMARY KEY,
      document_id bigint NOT NULL
        REFERENCES app.assignment_documents(id) ON DELETE CASCADE,
      field_key text NOT NULL,
      raw_value text NOT NULL,
      normalized_value text,
      page_number integer,
      confidence numeric(5,4),
      evidence_excerpt text,
      extraction_method text NOT NULL DEFAULT 'labeled_text',
      review_status text NOT NULL DEFAULT 'suggested'
        CHECK (review_status IN ('suggested', 'confirmed', 'rejected')),
      confirmed_value text,
      reviewer text,
      reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS assignment_document_candidates_idx
      ON app.assignment_document_field_candidates (document_id, field_key, review_status);

    CREATE TABLE IF NOT EXISTS app.assignment_document_candidate_reviews (
      id bigserial PRIMARY KEY,
      document_id bigint NOT NULL
        REFERENCES app.assignment_documents(id) ON DELETE CASCADE,
      candidate_id bigint,
      field_key text NOT NULL,
      raw_value text NOT NULL,
      normalized_value text,
      review_status text NOT NULL
        CHECK (review_status IN ('confirmed', 'rejected')),
      confirmed_value text,
      reviewer text NOT NULL,
      reviewed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS assignment_document_candidate_reviews_idx
      ON app.assignment_document_candidate_reviews (document_id, reviewed_at DESC, id DESC);
  `);
}

export async function createAssignmentDocument(pool, {
  accountId,
  assignmentFileId = null,
  documentType = "other",
  title,
  fileName,
  contentType,
  content,
  uploadedBy,
  storage = null,
  logger = console,
} = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  if (!Buffer.isBuffer(content) || !content.length) throw new Error("document_content_required");
  if (content.length > MAX_ASSIGNMENT_DOCUMENT_BYTES) throw new Error("document_too_large");
  if (content.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("document_not_pdf");
  const normalizedType = normalizeDocumentType(documentType);
  const safeFileName = cleanText(fileName, 255) || "document.pdf";
  const safeTitle = cleanText(title, 300) || safeFileName;
  const checksum = createHash("sha256").update(content).digest("hex");
  let storedContent = content;
  let storageProvider = "postgres";
  let storageStatus = "stored";
  let storageBucket = null;
  let objectKey = null;
  let storageEtag = null;
  let storageContentType = null;
  let storageVerifiedAt = null;
  let storageLastError = null;
  if (storage?.configured) {
    try {
      objectKey = buildAssignmentDocumentObjectKey({
        accountId,
        assignmentFileId,
        checksumSha256: checksum,
        fileName: safeFileName,
      });
      await storage.putObject({
        objectKey,
        contentType: "application/pdf",
        body: content,
      });
      const inspected = await storage.inspectObject({ objectKey });
      const verified = verifiedR2Object(inspected, { content, checksumSha256: checksum });
      storedContent = null;
      storageProvider = "r2";
      storageBucket = storage.bucket;
      storageEtag = verified.storage_etag;
      storageContentType = verified.storage_content_type;
      storageVerifiedAt = new Date();
    } catch (error) {
      storageStatus = "migration_failed";
      storageLastError = cleanText(error?.message || error, 2_000);
      logger.warn?.("[documents] private object upload failed; retaining PostgreSQL fallback", storageLastError);
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO app.assignment_documents (
       account_id, assignment_file_id, document_type, title, file_name,
       content_type, content, checksum_sha256, file_size_bytes, uploaded_by,
       storage_provider, storage_status, storage_bucket, object_key,
       storage_etag, storage_content_type, storage_verified_at, storage_last_error
     ) VALUES (
       $1, $2, $3, $4, $5, 'application/pdf', $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17
     )
     ON CONFLICT (
       account_id, (COALESCE(assignment_file_id, 0)), checksum_sha256
     ) DO UPDATE SET
       title = EXCLUDED.title,
       file_name = EXCLUDED.file_name,
       document_type = CASE
         WHEN app.assignment_documents.document_type = 'other' THEN EXCLUDED.document_type
         ELSE app.assignment_documents.document_type
       END,
       uploaded_by = COALESCE(EXCLUDED.uploaded_by, app.assignment_documents.uploaded_by),
       content = CASE
         WHEN EXCLUDED.storage_provider = 'r2' THEN NULL
         ELSE app.assignment_documents.content
       END,
       storage_provider = CASE
         WHEN EXCLUDED.storage_provider = 'r2' THEN EXCLUDED.storage_provider
         ELSE app.assignment_documents.storage_provider
       END,
       storage_status = CASE
         WHEN EXCLUDED.storage_provider = 'r2' THEN EXCLUDED.storage_status
         ELSE app.assignment_documents.storage_status
       END,
       storage_bucket = COALESCE(EXCLUDED.storage_bucket, app.assignment_documents.storage_bucket),
       object_key = COALESCE(EXCLUDED.object_key, app.assignment_documents.object_key),
       storage_etag = COALESCE(EXCLUDED.storage_etag, app.assignment_documents.storage_etag),
       storage_content_type = COALESCE(
         EXCLUDED.storage_content_type,
         app.assignment_documents.storage_content_type
       ),
       storage_verified_at = COALESCE(
         EXCLUDED.storage_verified_at,
         app.assignment_documents.storage_verified_at
       ),
       storage_last_error = CASE
         WHEN EXCLUDED.storage_provider = 'r2' THEN NULL
         ELSE app.assignment_documents.storage_last_error
       END,
       updated_at = now()
     RETURNING *`,
    [
      accountId,
      positiveInteger(assignmentFileId),
      normalizedType,
      safeTitle,
      safeFileName,
      storedContent,
      checksum,
      content.length,
      cleanText(uploadedBy, 200),
      storageProvider,
      storageStatus,
      storageBucket,
      objectKey,
      storageEtag,
      storageContentType,
      storageVerifiedAt,
      storageLastError,
    ],
  );
  return publicDocument(rows[0]);
}

export async function loadAssignmentDocumentContent(pool, documentId, { storage = null } = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const id = positiveInteger(documentId);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT * FROM app.assignment_documents WHERE id = $1`,
    [id],
  );
  const document = rows[0];
  if (!document) return null;
  if (Buffer.isBuffer(document.content) && document.content.length) return document;
  if (document.storage_provider !== "r2" || !document.object_key) {
    throw new Error("assignment_document_content_unavailable");
  }
  if (!storage?.configured) throw new Error("assignment_document_storage_not_configured");
  const downloaded = await storage.getObject({ objectKey: document.object_key });
  if (downloaded.byte_size !== Number(document.file_size_bytes || 0)) {
    throw new Error("assignment_document_storage_size_mismatch");
  }
  const checksum = createHash("sha256").update(downloaded.body).digest("hex");
  if (checksum !== document.checksum_sha256) {
    throw new Error("assignment_document_storage_checksum_mismatch");
  }
  return { ...document, content: downloaded.body };
}

export async function migrateAssignmentDocumentStorageBatch(pool, storage, {
  limit = 5,
  logger = console,
} = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 5, 25));
  if (!storage?.configured) {
    return { configured: false, attempted: 0, migrated: 0, failed: 0, results: [] };
  }
  const { rows } = await pool.query(
    `SELECT id
     FROM app.assignment_documents
     WHERE storage_provider = 'postgres' AND content IS NOT NULL
     ORDER BY CASE WHEN storage_status = 'migration_failed' THEN 0 ELSE 1 END,
              uploaded_at
     LIMIT $1`,
    [boundedLimit],
  );
  const results = [];
  for (const candidate of rows) {
    const id = Number(candidate.id);
    try {
      const current = await pool.query(
        `SELECT * FROM app.assignment_documents
         WHERE id = $1 AND storage_provider = 'postgres' AND content IS NOT NULL`,
        [id],
      );
      const document = current.rows[0];
      if (!document) continue;
      const objectKey = buildAssignmentDocumentObjectKey({
        accountId: document.account_id,
        assignmentFileId: document.assignment_file_id,
        checksumSha256: document.checksum_sha256,
        fileName: document.file_name,
      });
      await storage.putObject({
        objectKey,
        contentType: "application/pdf",
        body: document.content,
      });
      const inspected = await storage.inspectObject({ objectKey });
      const verified = verifiedR2Object(inspected, {
        content: document.content,
        checksumSha256: document.checksum_sha256,
      });
      const { rowCount } = await pool.query(
        `UPDATE app.assignment_documents
         SET content = NULL,
             storage_provider = 'r2', storage_status = 'stored',
             storage_bucket = $2, object_key = $3, storage_etag = $4,
             storage_content_type = $5, storage_verified_at = now(),
             storage_last_error = NULL, updated_at = now()
         WHERE id = $1 AND storage_provider = 'postgres' AND content IS NOT NULL`,
        [
          id,
          storage.bucket,
          objectKey,
          verified.storage_etag,
          verified.storage_content_type,
        ],
      );
      results.push({ id, ok: Boolean(rowCount), object_key: objectKey });
    } catch (error) {
      const message = cleanText(error?.message || error, 2_000);
      logger.warn?.(`[documents] storage migration failed for document ${id}`, message);
      await pool.query(
        `UPDATE app.assignment_documents
         SET storage_status = 'migration_failed', storage_last_error = $2, updated_at = now()
         WHERE id = $1 AND storage_provider = 'postgres'`,
        [id, message],
      ).catch(() => {});
      results.push({ id, ok: false, error: message });
    }
  }
  return {
    configured: true,
    attempted: results.length,
    migrated: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

export async function processAssignmentDocument(pool, documentId, {
  logger = console,
  force = false,
  storage = null,
  ocrProvider = null,
} = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const id = positiveInteger(documentId);
  if (!id) throw new Error("invalid_document_id");
  const { rows } = await pool.query(
    `UPDATE app.assignment_documents
     SET processing_status = 'processing',
         processing_attempts = processing_attempts + 1,
         processing_started_at = now(),
         next_processing_at = NULL,
         last_processing_error = NULL,
         updated_at = now()
     WHERE id = $1 AND (
       (
         $2::boolean
         AND (
           processing_status <> 'processing'
           OR COALESCE(processing_started_at, updated_at)
             < now() - ($3::integer * interval '1 minute')
         )
       )
       OR processing_status = 'uploaded'
       OR (processing_status = 'ocr_required' AND $4::boolean)
       OR (
         processing_status = 'extraction_failed'
         AND (next_processing_at IS NULL OR next_processing_at <= now())
       )
       OR (
         processing_status = 'processing'
         AND COALESCE(processing_started_at, updated_at)
           < now() - ($3::integer * interval '1 minute')
       )
     )
     RETURNING *`,
    [id, force === true, STALE_PROCESSING_MINUTES, Boolean(ocrProvider?.configured)],
  );
  const document = rows[0];
  if (!document) {
    const current = await pool.query(
      `SELECT processing_status, next_processing_at
       FROM app.assignment_documents WHERE id = $1`,
      [id],
    );
    if (!current.rows[0]) throw new Error("document_not_found");
    if (current.rows[0].processing_status === "processing") {
      throw new Error("document_processing_in_progress");
    }
    if (current.rows[0].next_processing_at) throw new Error("document_retry_not_due");
    throw new Error("document_not_processable");
  }
  try {
    const documentWithContent = Buffer.isBuffer(document.content) && document.content.length
      ? document
      : await loadAssignmentDocumentContent(pool, id, { storage });
    const extraction = await extractPdfEvidence(documentWithContent.content, {
      requestedType: document.document_type,
      fileName: document.file_name,
      ocrProvider,
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const previousReviewResult = await client.query(
        `SELECT field_key, raw_value, normalized_value, review_status,
                confirmed_value, reviewer, reviewed_at
         FROM app.assignment_document_field_candidates
         WHERE document_id = $1 AND review_status <> 'suggested'`,
        [id],
      );
      const previousReviews = previousReviewResult.rows;
      await client.query("DELETE FROM app.assignment_document_pages WHERE document_id = $1", [id]);
      await client.query("DELETE FROM app.assignment_document_field_candidates WHERE document_id = $1", [id]);
      for (let index = 0; index < extraction.pages.length; index += 1) {
        const pageText = extraction.pages[index];
        await client.query(
          `INSERT INTO app.assignment_document_pages (
             document_id, page_number, extracted_text, text_length, extraction_method
           ) VALUES ($1, $2, $3, $4, $5)`,
          [id, index + 1, pageText, pageText.length, extraction.extraction_method],
        );
      }
      let suggestedCandidateCount = 0;
      const storedCandidates = [];
      for (const candidate of extraction.candidates) {
        const retainedReview = retainedAssignmentDocumentReview(previousReviews, candidate);
        if (retainedReview.review_status === "suggested") suggestedCandidateCount += 1;
        const insertedCandidate = await client.query(
          `INSERT INTO app.assignment_document_field_candidates (
             document_id, field_key, raw_value, normalized_value, page_number,
             confidence, evidence_excerpt, extraction_method, review_status,
             confirmed_value, reviewer, reviewed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            id,
            candidate.field_key,
            candidate.raw_value,
            candidate.normalized_value,
            candidate.page_number,
            candidate.confidence,
            candidate.evidence_excerpt,
            candidate.extraction_method,
            retainedReview.review_status,
            retainedReview.confirmed_value,
            retainedReview.reviewer,
            retainedReview.reviewed_at,
          ],
        );
        storedCandidates.push(publicCandidate(insertedCandidate.rows[0]));
      }
      const processingStatus = extraction.candidates.length > 0 && suggestedCandidateCount === 0
        ? "reviewed"
        : extraction.extraction_status;
      const updated = await client.query(
        `UPDATE app.assignment_documents
         SET document_type = $2,
             page_count = $3,
             processing_status = $4,
             extraction_method = $5,
             extraction_summary = $6::jsonb,
             processing_started_at = NULL,
             next_processing_at = NULL,
             last_processing_error = NULL,
             processed_at = now(),
             reviewed_at = CASE WHEN $4 = 'reviewed' THEN COALESCE(reviewed_at, now()) ELSE NULL END,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          extraction.document_type,
          extraction.page_count,
          processingStatus,
          extraction.extraction_method,
          JSON.stringify({
            text_length: extraction.text_length,
            candidate_count: extraction.candidates.length,
            suggested_candidate_count: suggestedCandidateCount,
            review_reason: extraction.review_reason,
            ocr: extraction.ocr_metadata,
            processing_attempts: Number(document.processing_attempts || 0),
          }),
        ],
      );
      await client.query("COMMIT");
      return publicDocument(updated.rows[0], storedCandidates);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const message = String(error?.message || error).slice(0, 2_000);
    const attempts = Number(document.processing_attempts || 1);
    const nextProcessingAt = attempts >= MAX_AUTOMATIC_DOCUMENT_ATTEMPTS
      ? null
      : new Date(Date.now() + assignmentDocumentRetryDelayMs(attempts));
    logger.warn?.(`[documents] extraction failed for document ${id}`, message);
    await pool.query(
      `UPDATE app.assignment_documents
       SET processing_status = 'extraction_failed',
           extraction_summary = jsonb_build_object(
             'error', $2::text,
             'processing_attempts', processing_attempts,
             'automatic_retry_exhausted', $3::boolean
           ),
           processing_started_at = NULL,
           next_processing_at = $4,
           last_processing_error = $2,
           processed_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, message, attempts >= MAX_AUTOMATIC_DOCUMENT_ATTEMPTS, nextProcessingAt],
    );
    throw error;
  }
}

export async function processPendingAssignmentDocuments(pool, {
  limit = 10,
  logger = console,
  maximumAttempts = MAX_AUTOMATIC_DOCUMENT_ATTEMPTS,
  storage = null,
  ocrProvider = null,
} = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const boundedMaximumAttempts = Math.max(
    1,
    Math.min(Number(maximumAttempts) || MAX_AUTOMATIC_DOCUMENT_ATTEMPTS, 20),
  );
  await pool.query(
    `UPDATE app.assignment_documents
     SET processing_status = 'extraction_failed',
         processing_started_at = NULL,
         next_processing_at = NULL,
         last_processing_error = 'document_processing_interrupted_retry_exhausted',
         extraction_summary = extraction_summary || jsonb_build_object(
           'error', 'document_processing_interrupted_retry_exhausted',
           'processing_attempts', processing_attempts,
           'automatic_retry_exhausted', true
         ),
         updated_at = now()
     WHERE processing_status = 'processing'
       AND processing_attempts >= $1
       AND COALESCE(processing_started_at, updated_at)
         < now() - ($2::integer * interval '1 minute')`,
    [boundedMaximumAttempts, STALE_PROCESSING_MINUTES],
  );
  const { rows } = await pool.query(
    `SELECT id
     FROM app.assignment_documents
     WHERE processing_status = 'uploaded'
        OR (
          processing_status = 'ocr_required'
          AND $4::boolean
          AND processing_attempts < $2
        )
        OR (
          processing_status = 'extraction_failed'
          AND processing_attempts < $2
          AND (next_processing_at IS NULL OR next_processing_at <= now())
        )
        OR (
          processing_status = 'processing'
          AND processing_attempts < $2
          AND COALESCE(processing_started_at, updated_at)
            < now() - ($3::integer * interval '1 minute')
        )
     ORDER BY uploaded_at
     LIMIT $1`,
    [
      boundedLimit,
      boundedMaximumAttempts,
      STALE_PROCESSING_MINUTES,
      Boolean(ocrProvider?.configured),
    ],
  );
  const results = [];
  for (const row of rows) {
    try {
      const document = await processAssignmentDocument(pool, row.id, {
        logger,
        storage,
        ocrProvider,
      });
      results.push({ id: Number(row.id), ok: true, status: document.processing_status });
    } catch (error) {
      results.push({ id: Number(row.id), ok: false, error: String(error?.message || error) });
    }
  }
  return { attempted: rows.length, results };
}

export async function listAssignmentDocuments(pool, {
  accountId,
  assignmentFileId = null,
} = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const { rows } = await pool.query(
    `SELECT document.*,
            COUNT(candidate.id)::integer AS candidate_count,
            COUNT(candidate.id) FILTER (WHERE candidate.review_status = 'suggested')::integer
              AS suggested_candidate_count
     FROM app.assignment_documents document
     LEFT JOIN app.assignment_document_field_candidates candidate
       ON candidate.document_id = document.id
     WHERE document.account_id = $1
       AND (
         ($2::bigint IS NULL AND document.assignment_file_id IS NULL)
         OR (
           $2::bigint IS NOT NULL
           AND (document.assignment_file_id = $2 OR document.assignment_file_id IS NULL)
         )
       )
     GROUP BY document.id
     ORDER BY CASE WHEN document.assignment_file_id = $2 THEN 0 ELSE 1 END,
              document.uploaded_at DESC`,
    [accountId, positiveInteger(assignmentFileId)],
  );
  return rows.map((row) => ({
    ...publicDocument(row),
    candidate_count: Number(row.candidate_count || 0),
    suggested_candidate_count: Number(row.suggested_candidate_count || 0),
  }));
}

export async function getAssignmentDocument(pool, documentId, {
  includeContent = false,
  storage = null,
} = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const id = positiveInteger(documentId);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT * FROM app.assignment_documents WHERE id = $1`,
    [id],
  );
  const document = rows[0];
  if (!document) return null;
  if (includeContent) return loadAssignmentDocumentContent(pool, id, { storage });
  const { rows: candidateRows } = await pool.query(
    `SELECT * FROM app.assignment_document_field_candidates
     WHERE document_id = $1
     ORDER BY page_number NULLS LAST, confidence DESC NULLS LAST, id`,
    [id],
  );
  const { rows: reviewRows } = await pool.query(
    `SELECT * FROM app.assignment_document_candidate_reviews
     WHERE document_id = $1
     ORDER BY reviewed_at DESC, id DESC
     LIMIT 200`,
    [id],
  );
  return {
    ...publicDocument(document, candidateRows.map(publicCandidate)),
    review_history: reviewRows.map(publicCandidateReview),
  };
}

export async function reviewAssignmentDocumentCandidate(pool, {
  documentId,
  candidateId,
  reviewStatus,
  confirmedValue,
  reviewer,
} = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const document = positiveInteger(documentId);
  const candidate = positiveInteger(candidateId);
  if (!document || !candidate) throw new Error("invalid_document_candidate");
  const status = String(reviewStatus || "").trim().toLowerCase();
  if (!new Set(["confirmed", "rejected"]).has(status)) throw new Error("invalid_document_review_status");
  const reviewerName = cleanText(reviewer, 200);
  if (!reviewerName) throw new Error("document_reviewer_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE app.assignment_document_field_candidates
       SET review_status = $3,
           confirmed_value = CASE WHEN $3 = 'confirmed'
             THEN COALESCE(NULLIF($4, ''), raw_value)
             ELSE NULL
           END,
           reviewer = $5,
           reviewed_at = now(),
           updated_at = now()
       WHERE id = $2 AND document_id = $1
       RETURNING *`,
      [document, candidate, status, cleanText(confirmedValue, 4_000), reviewerName],
    );
    if (!rows[0]) throw new Error("document_candidate_not_found");
    await client.query(
      `INSERT INTO app.assignment_document_candidate_reviews (
         document_id, candidate_id, field_key, raw_value, normalized_value,
         review_status, confirmed_value, reviewer, reviewed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        document,
        candidate,
        rows[0].field_key,
        rows[0].raw_value,
        rows[0].normalized_value,
        rows[0].review_status,
        rows[0].confirmed_value,
        reviewerName,
      ],
    );
    const { rows: remaining } = await client.query(
      `SELECT COUNT(*)::integer AS count
       FROM app.assignment_document_field_candidates
       WHERE document_id = $1 AND review_status = 'suggested'`,
      [document],
    );
    if (Number(remaining[0]?.count || 0) === 0) {
      await client.query(
        `UPDATE app.assignment_documents
         SET processing_status = 'reviewed', reviewed_at = now(), updated_at = now()
         WHERE id = $1`,
        [document],
      );
    }
    await client.query("COMMIT");
    return publicCandidate(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getAssignmentDocumentZoningSuggestion(pool, {
  documentId,
  zoningCode,
} = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const id = positiveInteger(documentId);
  if (!id) throw new Error("invalid_document_id");
  const { rows } = await pool.query(
    `SELECT page_number, extracted_text
     FROM app.assignment_document_pages
     WHERE document_id = $1
     ORDER BY page_number`,
    [id],
  );
  return findZoningDescriptionInPages(rows.map((row) => row.extracted_text), zoningCode);
}
