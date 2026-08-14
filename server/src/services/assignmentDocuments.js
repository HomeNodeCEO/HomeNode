import { createHash } from "node:crypto";

import {
  extractPdfEvidence,
  findZoningDescriptionInPages,
  normalizeDocumentType,
} from "./documentIntelligence.js";

export const MAX_ASSIGNMENT_DOCUMENT_BYTES = 25 * 1024 * 1024;

function cleanText(value, maximum = 4_000) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maximum) : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
    extraction_method: row.extraction_method,
    extraction_summary: row.extraction_summary || {},
    source_kind: row.source_kind,
    source_url: row.source_url,
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
      content bytea NOT NULL,
      checksum_sha256 text NOT NULL,
      file_size_bytes bigint NOT NULL,
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
    CREATE UNIQUE INDEX IF NOT EXISTS assignment_documents_scope_checksum_uidx
      ON app.assignment_documents (
        account_id, COALESCE(assignment_file_id, 0), checksum_sha256
      );
    CREATE INDEX IF NOT EXISTS assignment_documents_account_idx
      ON app.assignment_documents (account_id, assignment_file_id, uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS assignment_documents_processing_idx
      ON app.assignment_documents (processing_status, uploaded_at)
      WHERE processing_status IN ('uploaded', 'processing', 'extraction_failed');

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
} = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  if (!Buffer.isBuffer(content) || !content.length) throw new Error("document_content_required");
  if (content.length > MAX_ASSIGNMENT_DOCUMENT_BYTES) throw new Error("document_too_large");
  if (content.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("document_not_pdf");
  const normalizedType = normalizeDocumentType(documentType);
  const safeFileName = cleanText(fileName, 255) || "document.pdf";
  const safeTitle = cleanText(title, 300) || safeFileName;
  const checksum = createHash("sha256").update(content).digest("hex");
  const { rows } = await pool.query(
    `INSERT INTO app.assignment_documents (
       account_id, assignment_file_id, document_type, title, file_name,
       content_type, content, checksum_sha256, file_size_bytes, uploaded_by
     ) VALUES ($1, $2, $3, $4, $5, 'application/pdf', $6, $7, $8, $9)
     ON CONFLICT (
       account_id, (COALESCE(assignment_file_id, 0)), checksum_sha256
     ) DO UPDATE SET
       title = EXCLUDED.title,
       file_name = EXCLUDED.file_name,
       uploaded_by = COALESCE(EXCLUDED.uploaded_by, app.assignment_documents.uploaded_by),
       updated_at = now()
     RETURNING *`,
    [
      accountId,
      positiveInteger(assignmentFileId),
      normalizedType,
      safeTitle,
      safeFileName,
      content,
      checksum,
      content.length,
      cleanText(uploadedBy, 200),
    ],
  );
  return publicDocument(rows[0]);
}

export async function processAssignmentDocument(pool, documentId, { logger = console } = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const id = positiveInteger(documentId);
  if (!id) throw new Error("invalid_document_id");
  const { rows } = await pool.query(
    `UPDATE app.assignment_documents
     SET processing_status = 'processing', updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id],
  );
  const document = rows[0];
  if (!document) throw new Error("document_not_found");
  try {
    const extraction = await extractPdfEvidence(document.content, {
      requestedType: document.document_type,
      fileName: document.file_name,
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
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
      for (const candidate of extraction.candidates) {
        await client.query(
          `INSERT INTO app.assignment_document_field_candidates (
             document_id, field_key, raw_value, normalized_value, page_number,
             confidence, evidence_excerpt, extraction_method
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            candidate.field_key,
            candidate.raw_value,
            candidate.normalized_value,
            candidate.page_number,
            candidate.confidence,
            candidate.evidence_excerpt,
            candidate.extraction_method,
          ],
        );
      }
      const updated = await client.query(
        `UPDATE app.assignment_documents
         SET document_type = $2,
             page_count = $3,
             processing_status = $4,
             extraction_method = $5,
             extraction_summary = $6::jsonb,
             processed_at = now(),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          extraction.document_type,
          extraction.page_count,
          extraction.extraction_status,
          extraction.extraction_method,
          JSON.stringify({
            text_length: extraction.text_length,
            candidate_count: extraction.candidates.length,
            review_reason: extraction.review_reason,
          }),
        ],
      );
      await client.query("COMMIT");
      return publicDocument(updated.rows[0], extraction.candidates);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const message = String(error?.message || error).slice(0, 2_000);
    logger.warn?.(`[documents] extraction failed for document ${id}`, message);
    await pool.query(
      `UPDATE app.assignment_documents
       SET processing_status = 'extraction_failed',
           extraction_summary = jsonb_build_object('error', $2::text),
           processed_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, message],
    );
    throw error;
  }
}

export async function processPendingAssignmentDocuments(pool, {
  limit = 10,
  logger = console,
} = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const { rows } = await pool.query(
    `SELECT id
     FROM app.assignment_documents
     WHERE processing_status IN ('uploaded', 'extraction_failed')
     ORDER BY uploaded_at
     LIMIT $1`,
    [boundedLimit],
  );
  const results = [];
  for (const row of rows) {
    try {
      const document = await processAssignmentDocument(pool, row.id, { logger });
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
       AND ($2::bigint IS NULL OR document.assignment_file_id = $2 OR document.assignment_file_id IS NULL)
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

export async function getAssignmentDocument(pool, documentId, { includeContent = false } = {}) {
  await ensureAssignmentDocumentsSchema(pool);
  const id = positiveInteger(documentId);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT * FROM app.assignment_documents WHERE id = $1`,
    [id],
  );
  const document = rows[0];
  if (!document) return null;
  if (includeContent) return document;
  const { rows: candidateRows } = await pool.query(
    `SELECT * FROM app.assignment_document_field_candidates
     WHERE document_id = $1
     ORDER BY page_number NULLS LAST, confidence DESC NULLS LAST, id`,
    [id],
  );
  return publicDocument(document, candidateRows.map(publicCandidate));
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
  const { rows } = await pool.query(
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
  const { rows: remaining } = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM app.assignment_document_field_candidates
     WHERE document_id = $1 AND review_status = 'suggested'`,
    [document],
  );
  if (Number(remaining[0]?.count || 0) === 0) {
    await pool.query(
      `UPDATE app.assignment_documents
       SET processing_status = 'reviewed', reviewed_at = now(), updated_at = now()
       WHERE id = $1`,
      [document],
    );
  }
  return publicCandidate(rows[0]);
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
