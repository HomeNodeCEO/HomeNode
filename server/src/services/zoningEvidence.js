import { createHash } from "node:crypto";

import { DALLAS_COUNTY_ZONING_JURISDICTIONS } from "./propertyZoningSources.js";

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 45_000;

function cleanText(value, maximum = 4_000) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maximum) : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function documentPageCount(buffer) {
  const source = buffer.toString("latin1");
  const matches = source.match(/\/Type\s*\/Page(?!s)\b/g);
  return matches?.length || null;
}

function jurisdictionForCity(city) {
  const normalized = String(city || "").trim().toUpperCase();
  return DALLAS_COUNTY_ZONING_JURISDICTIONS.find(
    (entry) => entry.city.toUpperCase() === normalized,
  ) || null;
}

function publicDocument(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    provider_key: row.provider_key,
    document_key: row.document_key,
    title: row.title,
    official_url: row.official_url,
    content_type: row.content_type,
    checksum_sha256: row.checksum_sha256,
    file_size_bytes: Number(row.file_size_bytes || 0),
    page_count: row.page_count == null ? null : Number(row.page_count),
    extraction_status: row.extraction_status,
    fetched_at: row.fetched_at,
    source_last_modified: row.source_last_modified,
    content_url: `/api/zoning-source-documents/${row.id}/content`,
  };
}

function publicVerification(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    account_id: row.account_id,
    assignment_file_id: row.assignment_file_id == null ? null : Number(row.assignment_file_id),
    provider_key: row.provider_key,
    source_document_id: row.source_document_id == null ? null : Number(row.source_document_id),
    source_type: row.source_type,
    zoning_code: row.zoning_code,
    zoning_description: row.zoning_description,
    page_number: row.page_number == null ? null : Number(row.page_number),
    confirmation_reference: row.confirmation_reference,
    notes: row.notes,
    reviewer: row.reviewer,
    verified_at: row.verified_at,
  };
}

export async function ensureZoningEvidenceSchema(pool) {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS gis;
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE TABLE IF NOT EXISTS gis.zoning_source_documents (
      id bigserial PRIMARY KEY,
      provider_key text NOT NULL
        REFERENCES gis.zoning_source_registry(provider_key) ON DELETE CASCADE,
      document_key text NOT NULL,
      title text NOT NULL,
      official_url text NOT NULL,
      content_type text NOT NULL DEFAULT 'application/pdf',
      content bytea NOT NULL,
      checksum_sha256 text NOT NULL,
      file_size_bytes bigint NOT NULL,
      page_count integer,
      extraction_status text NOT NULL DEFAULT 'review_required'
        CHECK (extraction_status IN ('machine_readable', 'review_required', 'extraction_failed')),
      extracted_text text,
      extraction jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_etag text,
      source_last_modified text,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      is_current boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider_key, document_key, checksum_sha256)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS zoning_source_documents_current_uidx
      ON gis.zoning_source_documents (provider_key, document_key)
      WHERE is_current;
    CREATE INDEX IF NOT EXISTS zoning_source_documents_provider_idx
      ON gis.zoning_source_documents (provider_key, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS app.property_zoning_verifications (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL,
      assignment_file_id bigint REFERENCES app.assignment_files(id) ON DELETE SET NULL,
      provider_key text NOT NULL
        REFERENCES gis.zoning_source_registry(provider_key) ON DELETE RESTRICT,
      source_document_id bigint
        REFERENCES gis.zoning_source_documents(id) ON DELETE SET NULL,
      source_type text NOT NULL
        CHECK (source_type IN ('map_pdf', 'interactive_map', 'city_confirmation', 'official_gis', 'manual')),
      zoning_code text NOT NULL,
      zoning_description text,
      page_number integer,
      confirmation_reference text,
      notes text,
      reviewer text NOT NULL,
      verified_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS property_zoning_verifications_scope_uidx
      ON app.property_zoning_verifications (
        account_id, COALESCE(assignment_file_id, 0)
      );
    CREATE INDEX IF NOT EXISTS property_zoning_verifications_account_idx
      ON app.property_zoning_verifications (account_id, verified_at DESC);
  `);
}

async function fetchOfficialPdf(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("zoning_document_requires_https");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/pdf",
        "user-agent": "HomeNode zoning evidence cache/1.0",
      },
    });
    if (!response.ok) throw new Error(`zoning_document_http_${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
      throw new Error("zoning_document_too_large");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_DOCUMENT_BYTES) {
      throw new Error(buffer.length ? "zoning_document_too_large" : "zoning_document_empty");
    }
    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("zoning_document_not_pdf");
    }
    return {
      buffer,
      contentType: "application/pdf",
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncOfficialZoningDocuments(pool, { logger = console } = {}) {
  await ensureZoningEvidenceSchema(pool);
  const results = [];
  for (const jurisdiction of DALLAS_COUNTY_ZONING_JURISDICTIONS) {
    for (const document of jurisdiction.documents || []) {
      try {
        const fetched = await fetchOfficialPdf(document.url);
        const checksum = createHash("sha256").update(fetched.buffer).digest("hex");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const existing = await client.query(
            `SELECT id FROM gis.zoning_source_documents
             WHERE provider_key = $1 AND document_key = $2 AND checksum_sha256 = $3`,
            [jurisdiction.providerKey, document.key, checksum],
          );
          let documentId = existing.rows[0]?.id || null;
          if (documentId) {
            await client.query(
              `UPDATE gis.zoning_source_documents
               SET fetched_at = now(), source_etag = $2, source_last_modified = $3,
                   official_url = $4, title = $5, is_current = true
               WHERE id = $1`,
              [documentId, fetched.etag, fetched.lastModified, document.url, document.title],
            );
          } else {
            await client.query(
              `UPDATE gis.zoning_source_documents
               SET is_current = false
               WHERE provider_key = $1 AND document_key = $2 AND is_current`,
              [jurisdiction.providerKey, document.key],
            );
            const inserted = await client.query(
              `INSERT INTO gis.zoning_source_documents (
                 provider_key, document_key, title, official_url, content_type,
                 content, checksum_sha256, file_size_bytes, page_count,
                 extraction_status, source_etag, source_last_modified
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'review_required', $10, $11)
               RETURNING id`,
              [
                jurisdiction.providerKey,
                document.key,
                document.title,
                document.url,
                fetched.contentType,
                fetched.buffer,
                checksum,
                fetched.buffer.length,
                documentPageCount(fetched.buffer),
                fetched.etag,
                fetched.lastModified,
              ],
            );
            documentId = inserted.rows[0].id;
          }
          await client.query("COMMIT");
          results.push({ city: jurisdiction.city, document_key: document.key, ok: true, document_id: Number(documentId) });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        const message = String(error?.message || error);
        logger.warn?.(`[zoning-documents] ${jurisdiction.city} ${document.key} failed; retained prior version`, message);
        results.push({ city: jurisdiction.city, document_key: document.key, ok: false, error: message });
      }
    }
  }
  return {
    ok: results.every((result) => result.ok),
    attempted: results.length,
    cached: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

export async function getPropertyZoningEvidence(pool, {
  accountId,
  assignmentFileId = null,
} = {}) {
  await ensureZoningEvidenceSchema(pool);
  const { rows: accountRows } = await pool.query(
    `SELECT account_id, address, city, county
     FROM core.accounts
     WHERE account_id = $1`,
    [accountId],
  );
  const account = accountRows[0];
  if (!account) throw new Error("account_not_found");
  const jurisdiction = jurisdictionForCity(account.city);
  if (!jurisdiction) {
    return {
      account,
      jurisdiction: null,
      review_required: true,
      review_reason: "No Dallas County municipal zoning source is registered for the account city.",
      documents: [],
      verification: null,
    };
  }
  const [{ rows: documentRows }, { rows: verificationRows }, { rows: automaticRows }] = await Promise.all([
    pool.query(
      `SELECT id, provider_key, document_key, title, official_url, content_type,
              checksum_sha256, file_size_bytes, page_count, extraction_status,
              fetched_at, source_last_modified
       FROM gis.zoning_source_documents
       WHERE provider_key = $1 AND is_current
       ORDER BY document_key`,
      [jurisdiction.providerKey],
    ),
    pool.query(
      `SELECT * FROM app.property_zoning_verifications
       WHERE account_id = $1
         AND ($2::bigint IS NULL OR assignment_file_id = $2 OR assignment_file_id IS NULL)
       ORDER BY CASE WHEN assignment_file_id = $2 THEN 0 ELSE 1 END,
                verified_at DESC
       LIMIT 1`,
      [accountId, assignmentFileId],
    ),
    pool.query(
      `SELECT zoning.zoning_code, zoning.zoning_description, zoning.provider_key,
              zoning.source_updated_at, zoning.synced_at
       FROM core.account_locations location
       JOIN gis.zoning_districts zoning
         ON ST_Covers(zoning.geom, ST_SetSRID(ST_MakePoint(location.longitude, location.latitude), 4326))
       WHERE location.account_id = $1
         AND location.latitude IS NOT NULL AND location.longitude IS NOT NULL
       ORDER BY zoning.synced_at DESC
       LIMIT 1`,
      [accountId],
    ),
  ]);
  return {
    account,
    jurisdiction: {
      city: jurisdiction.city,
      provider_key: jurisdiction.providerKey,
      provider_label: jurisdiction.providerLabel,
      automation_status: jurisdiction.automationStatus,
      reference_url: jurisdiction.referenceUrl,
      contact: jurisdiction.contact,
    },
    review_required: jurisdiction.automationStatus !== "automatic" && !verificationRows[0],
    review_reason: jurisdiction.automationStatus === "automatic"
      ? null
      : "The city does not expose a verified queryable zoning polygon. Confirm the map or contact the city before relying on the result.",
    documents: documentRows.map(publicDocument),
    automatic_result: automaticRows[0] || null,
    verification: publicVerification(verificationRows[0]),
  };
}

export async function getZoningDocumentContent(pool, documentId) {
  await ensureZoningEvidenceSchema(pool);
  const { rows } = await pool.query(
    `SELECT id, title, content_type, content, checksum_sha256
     FROM gis.zoning_source_documents WHERE id = $1`,
    [documentId],
  );
  return rows[0] || null;
}

export async function savePropertyZoningVerification(pool, {
  accountId,
  assignmentFileId = null,
  input,
} = {}) {
  await ensureZoningEvidenceSchema(pool);
  const jurisdiction = jurisdictionForCity(input?.jurisdiction_city);
  if (!jurisdiction) throw new Error("invalid_zoning_jurisdiction");
  const zoningCode = cleanText(input?.zoning_code, 200);
  const reviewer = cleanText(input?.reviewer, 200);
  const sourceType = cleanText(input?.source_type, 40);
  if (!zoningCode) throw new Error("zoning_code_required");
  if (!reviewer) throw new Error("zoning_reviewer_required");
  if (!["map_pdf", "interactive_map", "city_confirmation", "official_gis", "manual"].includes(sourceType)) {
    throw new Error("invalid_zoning_source_type");
  }
  const sourceDocumentId = positiveInteger(input?.source_document_id);
  if (sourceDocumentId) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM gis.zoning_source_documents
       WHERE id = $1 AND provider_key = $2`,
      [sourceDocumentId, jurisdiction.providerKey],
    );
    if (!rowCount) throw new Error("invalid_zoning_source_document");
  }
  const { rows } = await pool.query(
    `INSERT INTO app.property_zoning_verifications (
       account_id, assignment_file_id, provider_key, source_document_id,
       source_type, zoning_code, zoning_description, page_number,
       confirmation_reference, notes, reviewer
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (account_id, (COALESCE(assignment_file_id, 0))) DO UPDATE SET
       provider_key = EXCLUDED.provider_key,
       source_document_id = EXCLUDED.source_document_id,
       source_type = EXCLUDED.source_type,
       zoning_code = EXCLUDED.zoning_code,
       zoning_description = EXCLUDED.zoning_description,
       page_number = EXCLUDED.page_number,
       confirmation_reference = EXCLUDED.confirmation_reference,
       notes = EXCLUDED.notes,
       reviewer = EXCLUDED.reviewer,
       verified_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      accountId,
      assignmentFileId,
      jurisdiction.providerKey,
      sourceDocumentId,
      sourceType,
      zoningCode,
      cleanText(input?.zoning_description, 2_000),
      positiveInteger(input?.page_number),
      cleanText(input?.confirmation_reference, 1_000),
      cleanText(input?.notes, 4_000),
      reviewer,
    ],
  );
  return publicVerification(rows[0]);
}
