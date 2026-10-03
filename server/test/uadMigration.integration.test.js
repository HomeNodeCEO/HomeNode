import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import {
  confirmAssignmentDocumentCandidates,
  confirmAssignmentDocumentDespiteSubjectMismatch,
  createAssignmentDocument,
  deleteAssignmentDocument,
  ensureAssignmentDocumentsSchema,
  migrateAssignmentDocumentStorageBatch,
  reviewAssignmentDocumentCandidate,
} from "../src/services/assignmentDocuments.js";
import { auditCustomSignedArtifacts } from "../src/services/customSignedArtifactAudit.js";
import { auditCustomSignedPdfContent } from "../src/services/customSignedPdfContentAudit.js";
import { auditCustomSignedPhotoCoverage } from "../src/services/customSignedPhotoCoverageAudit.js";
import {
  CUSTOM_SUBJECT_SECTION,
  CUSTOM_SUBJECT_EVIDENCE_SECTION,
  persistCustomSubjectApplication,
} from "../src/services/customSubjectApplication.js";
import { readSfrepDocuments } from "../src/services/sfrepDocumentTransfer.js";

const databaseUrl = process.env.DATABASE_URL;

test("reviewed Custom Subject and server-only receipts persist with migrated constraints and histories", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let client;
  try {
    client = await pool.connect();
    const identity = await client.query("SELECT current_database() AS database_name");
    assert.match(identity.rows[0].database_name, /_test$/);
    await client.query("BEGIN");
    const transactionClient = {
      query: (sql, ...args) => {
        assert.doesNotMatch(String(sql), /^\s*(?:BEGIN|COMMIT|END|ROLLBACK)\b/i,
          "the production writer must not end the rollback-only fixture transaction");
        return client.query(sql, ...args);
      },
    };
    await ensureAssignmentDocumentsSchema(transactionClient);
    const accountId = `subject-receipt-${randomUUID()}`;
    await client.query(
      `INSERT INTO core.accounts (account_id, address, city, postal_code)
       VALUES ($1, '100 Example Dr', 'Garland', '75041')`,
      [accountId],
    );
    const assignment = await client.query(
      `INSERT INTO app.assignment_files (account_id, file_number)
       VALUES ($1, $1) RETURNING *`,
      [accountId],
    );
    const assignmentFileId = Number(assignment.rows[0].id);
    await client.query(
      `INSERT INTO app.custom_appraisal_workfiles (assignment_file_id, canonical_file_name, status)
       VALUES ($1, $2, 'draft')`,
      [assignmentFileId, `${accountId}.homenode-appraisal.json`],
    );
    const content = Buffer.from("%PDF-SYNTHETIC-SUBJECT-RECEIPT-NOT-AN-APPRAISAL");
    const document = await client.query(
      `INSERT INTO app.assignment_documents
         (account_id, assignment_file_id, document_type, processing_status, title, file_name,
          checksum_sha256, file_size_bytes, content)
       VALUES ($1, $2, 'engagement_letter', 'reviewed', 'Synthetic Subject evidence', 'synthetic.pdf', $3, $4, $5)
       RETURNING *`,
      [accountId, assignmentFileId, createHash("sha256").update(content).digest("hex"), content.length, content],
    );
    const documentId = Number(document.rows[0].id);
    const candidateIds = new Map();
    for (const [field, value] of Object.entries({
      subject_property_address: "100 Example Dr, Garland, TX 75041",
      borrower_name: "Synthetic Borrower",
      tax_amount: "4321.50",
      lender_client_name: "Synthetic QA Bank",
    })) {
      const inserted = await client.query(
        `INSERT INTO app.assignment_document_field_candidates
           (document_id, field_key, raw_value, confirmed_value, review_status, reviewer, reviewed_at)
         VALUES ($1, $2, $3, $3, 'confirmed', 'Fixture appraiser', now()) RETURNING id`,
        [documentId, field, value],
      );
      candidateIds.set(field, Number(inserted.rows[0].id));
    }
    // Match the writer's required assignment -> workfile -> source lock order.
    await client.query("SELECT id FROM app.assignment_files WHERE id = $1 FOR UPDATE", [assignmentFileId]);
    await client.query("SELECT assignment_file_id FROM app.custom_appraisal_workfiles WHERE assignment_file_id = $1 FOR UPDATE", [assignmentFileId]);
    await client.query("SELECT id FROM app.assignment_documents WHERE id = $1 FOR UPDATE", [documentId]);
    const applied = await persistCustomSubjectApplication(transactionClient, {
      assignmentFile: { ...assignment.rows[0], workfile_status: "draft" },
      sourceDocument: document.rows[0], reviewer: "Fixture appraiser",
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.account_id, accountId);
    assert.equal(applied.assignment_file_id, assignmentFileId);
    assert.equal(applied.revision, Number(assignment.rows[0].revision) + 1);
    const stored = await client.query(
      `SELECT section_key, section_value, revision FROM app.custom_appraisal_sections
        WHERE assignment_file_id = $1 ORDER BY section_key`,
      [assignmentFileId],
    );
    assert.deepEqual(stored.rows.map(row => row.section_key), [CUSTOM_SUBJECT_EVIDENCE_SECTION, CUSTOM_SUBJECT_SECTION]);
    const subject = stored.rows.find(row => row.section_key === CUSTOM_SUBJECT_SECTION);
    const evidence = stored.rows.find(row => row.section_key === CUSTOM_SUBJECT_EVIDENCE_SECTION);
    assert.equal(subject.revision, 1);
    assert.equal(subject.section_value.property_location.address, "100 Example Dr");
    assert.equal(subject.section_value.urar_subject.borrower_name, "Synthetic Borrower");
    assert.equal(subject.section_value.urar_subject.tax_amount, "4321.50");
    assert.equal(evidence.revision, 1);
    assert.equal(evidence.section_value.fields.borrower_name.status, "current");
    assert.equal(evidence.section_value.fields.borrower_name.kind, "reviewed_document");
    assert.equal(evidence.section_value.fields.borrower_name.documentId, documentId);
    assert.equal(evidence.section_value.fields.borrower_name.candidateId, candidateIds.get("borrower_name"));
    const histories = await client.query(
      `SELECT section_key, section_value, revision, inspection_session_id, changed_path
         FROM app.custom_appraisal_section_history WHERE assignment_file_id = $1 ORDER BY section_key`,
      [assignmentFileId],
    );
    assert.equal(histories.rows.length, 2);
    for (const row of histories.rows) {
      assert.deepEqual(row.section_value, stored.rows.find(section => section.section_key === row.section_key).section_value);
      assert.equal(row.revision, 1);
      assert.equal(row.inspection_session_id, null);
      assert.deepEqual(row.changed_path, [row.section_key]);
    }
    const assignmentHistory = await client.query(
      `SELECT history.revision, history.assignment_details, assignment.assignment_details AS current_details
         FROM app.assignment_file_history history JOIN app.assignment_files assignment ON assignment.id = history.assignment_file_id
        WHERE history.assignment_file_id = $1`,
      [assignmentFileId],
    );
    assert.equal(assignmentHistory.rows.length, 1);
    assert.equal(assignmentHistory.rows[0].revision, applied.revision);
    assert.deepEqual(assignmentHistory.rows[0].assignment_details, assignmentHistory.rows[0].current_details);
    assert.equal(assignmentHistory.rows[0].assignment_details.lender_client_name, "Synthetic QA Bank");

    // The migration adds one receipt key without losing prior keys or allowing arbitrary ones.
    const insertSection = `INSERT INTO app.custom_appraisal_sections (assignment_file_id, section_key, section_value)
      VALUES ($1, $2, '{}'::jsonb)`;
    const insertHistory = `INSERT INTO app.custom_appraisal_section_history
      (assignment_file_id, section_key, section_value, revision, inspection_session_id, changed_path)
      VALUES ($1, $2, '{}'::jsonb, 1, NULL, ARRAY[$2]::text[])`;
    for (const [sql, constraint] of [
      [insertSection, "custom_appraisal_sections_section_key_check"],
      [insertHistory, "custom_appraisal_section_history_section_key_check"],
    ]) {
      await client.query(sql, [assignmentFileId, "report.property_characteristics"]);
      await client.query("SAVEPOINT invalid_subject_receipt_key");
      try {
        await assert.rejects(client.query(sql, [assignmentFileId, "report.unsupported_fixture_key"]),
          error => error.code === "23514" && error.constraint === constraint);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT invalid_subject_receipt_key");
        await client.query("RELEASE SAVEPOINT invalid_subject_receipt_key");
      }
    }
    const publicAccount = await client.query("SELECT address FROM core.accounts WHERE account_id = $1", [accountId]);
    assert.equal(publicAccount.rows[0].address, "100 Example Dr", "report application must not edit public account data");

    // Exercise the actual transfer SQL: multiple selected PDFs share one report
    // envelope, and oversized JSON never crosses the PostgreSQL client boundary.
    const secondContent = Buffer.from("%PDF-SYNTHETIC-SECOND-REFERENCE");
    const secondDocument = await client.query(
      `INSERT INTO app.assignment_documents
         (account_id, assignment_file_id, title, file_name, checksum_sha256, file_size_bytes, content)
       VALUES ($1, $2, 'Synthetic second reference', 'second.pdf', $3, $4, $5) RETURNING id`,
      [accountId, assignmentFileId, createHash("sha256").update(secondContent).digest("hex"), secondContent.length, secondContent],
    );
    const documentIds = [documentId, Number(secondDocument.rows[0].id)];
    let wireRows;
    const observedClient = { query: async query => {
      const response = await client.query(query);
      wireRows = structuredClone(response.rows);
      return response;
    } };
    const selected = await readSfrepDocuments(observedClient, { accountId, assignmentFileId, documentIds });
    assert.equal(wireRows.length, 1);
    assert.equal(wireRows[0].evidence_limit, false);
    assert.equal(wireRows[0].snapshot.documents.length, 2);
    assert.equal(wireRows[0].snapshot.saved_report.documents.length, 2);
    assert.equal(wireRows[0].snapshot.saved_report.subject.value.urar_subject.borrower_name, "Synthetic Borrower");
    assert.equal((JSON.stringify(wireRows).match(/"saved_report":/g) || []).length, 1);
    assert.ok(wireRows[0].snapshot.documents.every(row => !Object.hasOwn(row, "saved_report") && !Object.hasOwn(row, "content")));
    assert.ok(wireRows[0].snapshot.saved_report.documents.every(row => !Object.hasOwn(row, "content")));
    assert.deepEqual(selected.map(row => row.id), documentIds);
    assert.equal(selected.filter(row => Object.hasOwn(row, "saved_report")).length, 1);
    await client.query(
      "UPDATE app.assignment_document_field_candidates SET raw_value = repeat('x', $2) WHERE id = $1 AND document_id = $3",
      [candidateIds.get("borrower_name"), 8 * 1024 * 1024 + 1, documentId],
    );
    await assert.rejects(readSfrepDocuments(observedClient, { accountId, assignmentFileId, documentIds }), /sfrep_evidence_limit/);
    assert.deepEqual(wireRows, [{ snapshot: null, evidence_limit: true }]);
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    await pool.end();
  }
});

test("scheduled legacy migration leaves signed Custom document bytes and metadata untouched", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let client;
  try {
    client = await pool.connect();
    const identity = await client.query("SELECT current_database() AS database_name");
    assert.match(identity.rows[0].database_name, /_test$/);
    await client.query("BEGIN");
    let targetDocumentId = null;
    const transactionPool = {
      query: (sql, values) => {
        if (targetDocumentId && /SELECT id\s+FROM app\.assignment_documents/.test(String(sql))) {
          assert.match(sql, /assignment_file_id IS NULL/);
          // Restrict the real selector to this rollback-only fixture so other
          // migration tests cannot contribute eligible rows to the batch.
          return client.query(sql.replace("ORDER BY CASE", "AND id = $2 ORDER BY CASE"),
            [values[0], targetDocumentId]);
        }
        return client.query(sql, values);
      },
    };
    await ensureAssignmentDocumentsSchema(transactionPool);
    const suffix = randomUUID();
    const accountId = `held-migration-${suffix}`;
    await client.query("INSERT INTO core.accounts (account_id) VALUES ($1)", [accountId]);
    const assignment = await client.query(
      `INSERT INTO app.assignment_files (account_id, file_number)
       VALUES ($1, $2) RETURNING id`,
      [accountId, accountId],
    );
    const assignmentFileId = assignment.rows[0].id;
    await client.query(
      `INSERT INTO app.custom_appraisal_workfiles
         (assignment_file_id, canonical_file_name, status, signed_at, signed_by)
       VALUES ($1, $2, 'signed', now(), 'Fixture appraiser')`,
      [assignmentFileId, `${accountId}.homenode-appraisal.json`],
    );
    const content = Buffer.from("%PDF-signed-legacy");
    const checksum = createHash("sha256").update(content).digest("hex");
    const document = await client.query(
      `INSERT INTO app.assignment_documents
         (account_id, assignment_file_id, title, file_name,
          checksum_sha256, file_size_bytes, content)
       VALUES ($1, $2, 'Signed legacy evidence', 'evidence.pdf', $3, $4, $5)
       RETURNING id`,
      [accountId, assignmentFileId, checksum, content.length, content],
    );
    targetDocumentId = document.rows[0].id;
    let uploaded = false;
    const result = await migrateAssignmentDocumentStorageBatch(transactionPool, {
      configured: true,
      bucket: "fixture-private-bucket",
      async putObject() { uploaded = true; },
    });
    assert.equal(result.attempted, 0);
    assert.equal(uploaded, false);
    const unchanged = await client.query(
      `SELECT content, storage_provider, object_key, storage_last_error
         FROM app.assignment_documents WHERE id = $1`,
      [document.rows[0].id],
    );
    assert.deepEqual(unchanged.rows[0].content, content);
    assert.equal(unchanged.rows[0].storage_provider, "postgres");
    assert.equal(unchanged.rows[0].object_key, null);
    assert.equal(unchanged.rows[0].storage_last_error, null);
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    await pool.end();
  }
});

test("signed Custom document deletion, upload, and candidate review are denied against migrated PostgreSQL", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let client;
  try {
    client = await pool.connect();
    const identity = await client.query("SELECT current_database() AS database_name");
    assert.match(identity.rows[0].database_name, /_test$/);
    const transactionScopedPool = {
      query: (...args) => client.query(...args),
      connect: async () => ({
        query: (sql, ...args) => {
          if (sql === "BEGIN") return client.query("SAVEPOINT signed_document_delete");
          if (sql === "ROLLBACK") return client.query("ROLLBACK TO SAVEPOINT signed_document_delete");
          if (sql === "COMMIT") throw new Error("fixture_transaction_must_not_commit");
          return client.query(sql, ...args);
        },
        release() {},
      }),
    };
    await client.query("BEGIN");
    await ensureAssignmentDocumentsSchema(transactionScopedPool);
    const suffix = randomUUID();
    const accountId = `signed-document-${suffix}`;
    const fileNumber = `signed-document-${suffix}`;
    await client.query("INSERT INTO core.accounts (account_id) VALUES ($1)", [accountId]);
    const assignment = await client.query(
      `INSERT INTO app.assignment_files (account_id, file_number)
       VALUES ($1, $2) RETURNING id`,
      [accountId, fileNumber],
    );
    const assignmentFileId = assignment.rows[0].id;
    await client.query(
      `INSERT INTO app.custom_appraisal_workfiles
         (assignment_file_id, canonical_file_name, status, signed_at, signed_by)
       VALUES ($1, $2, 'signed', now(), 'Fixture appraiser')`,
      [assignmentFileId, `${fileNumber}.homenode-appraisal.json`],
    );
    const document = await client.query(
      `INSERT INTO app.assignment_documents
         (account_id, assignment_file_id, title, file_name, checksum_sha256,
          file_size_bytes, storage_provider, storage_bucket, object_key, storage_verified_at)
       VALUES ($1, $2, 'Signed evidence', 'evidence.pdf', repeat('a', 64),
               12, 'r2', 'fixture-bucket', $3, now()) RETURNING id`,
      [accountId, assignmentFileId, `fixtures/${suffix}.pdf`],
    );
    let deletedFromStorage = false;
    let uploadedToStorage = false;
    const storage = {
      configured: true,
      async deleteObject() { deletedFromStorage = true; },
      async putObject() { uploadedToStorage = true; },
    };
    await assert.rejects(
      deleteAssignmentDocument(transactionScopedPool, storage, document.rows[0].id),
      /custom_appraisal_workfile_signed/,
    );
    assert.equal(deletedFromStorage, false);
    const remaining = await client.query(
      "SELECT id FROM app.assignment_documents WHERE id = $1",
      [document.rows[0].id],
    );
    assert.equal(remaining.rows.length, 1);
    await assert.rejects(
      createAssignmentDocument(transactionScopedPool, {
        accountId, assignmentFileId, fileName: "new-evidence.pdf",
        content: Buffer.from("%PDF-new-evidence"), storage,
      }),
      /custom_appraisal_workfile_signed/,
    );
    assert.equal(uploadedToStorage, false);
    const documentCount = await client.query(
      "SELECT count(*)::integer AS total FROM app.assignment_documents WHERE assignment_file_id = $1",
      [assignmentFileId],
    );
    assert.equal(documentCount.rows[0].total, 1);
    const candidate = await client.query(
      `INSERT INTO app.assignment_document_field_candidates
         (document_id, field_key, raw_value)
       VALUES ($1, 'lender_client_name', 'Fixture lender') RETURNING id`,
      [document.rows[0].id],
    );
    const documentId = document.rows[0].id;
    const candidateId = candidate.rows[0].id;
    for (const review of [
      () => reviewAssignmentDocumentCandidate(transactionScopedPool, {
        documentId, candidateId, reviewStatus: "rejected", reviewer: "Fixture appraiser",
      }),
      () => confirmAssignmentDocumentCandidates(transactionScopedPool, {
        documentId, reviewer: "Fixture appraiser",
      }),
      () => confirmAssignmentDocumentDespiteSubjectMismatch(transactionScopedPool, {
        documentId, reviewer: "Fixture appraiser", actorUserId: "fixture-appraiser",
      }),
    ]) {
      await assert.rejects(review(), /custom_appraisal_workfile_signed/);
    }
    const reviewState = await client.query(
      `SELECT candidate.review_status,
              (SELECT count(*)::integer FROM app.assignment_document_candidate_reviews
                WHERE document_id = $1) AS review_count
         FROM app.assignment_document_field_candidates candidate WHERE candidate.id = $2`,
      [documentId, candidateId],
    );
    assert.equal(reviewState.rows[0].review_status, "suggested");
    assert.equal(reviewState.rows[0].review_count, 0);
  } finally {
    if (client) {
      await client.query("ROLLBACK");
      client.release();
    }
    await pool.end();
  }
});

test("Custom document review waits on the workfile before locking the document row", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, statement_timeout: 10_000 });
  let holder;
  let assignmentFileId;
  let documentId;
  let accountId;
  let reviewPromise;
  try {
    const identity = await pool.query("SELECT current_database() AS database_name");
    assert.match(identity.rows[0].database_name, /_test$/);
    await ensureAssignmentDocumentsSchema(pool);
    const suffix = randomUUID();
    accountId = `document-lock-order-${suffix}`;
    await pool.query("INSERT INTO core.accounts (account_id) VALUES ($1)", [accountId]);
    const assignment = await pool.query(
      `INSERT INTO app.assignment_files (account_id, file_number)
       VALUES ($1, $2) RETURNING id`,
      [accountId, accountId],
    );
    assignmentFileId = assignment.rows[0].id;
    await pool.query(
      `INSERT INTO app.custom_appraisal_workfiles
         (assignment_file_id, canonical_file_name, status)
       VALUES ($1, $2, 'draft')`,
      [assignmentFileId, `${accountId}.homenode-appraisal.json`],
    );
    const content = Buffer.from("%PDF-fixture");
    const checksum = createHash("sha256").update(content).digest("hex");
    const document = await pool.query(
      `INSERT INTO app.assignment_documents
         (account_id, assignment_file_id, title, file_name, checksum_sha256, file_size_bytes, content, processing_status)
       VALUES ($1, $2, 'Draft evidence', 'evidence.pdf', $3, $4, $5, 'review_required')
       RETURNING id`,
      [accountId, assignmentFileId, checksum, content.length, content],
    );
    documentId = document.rows[0].id;
    const candidate = await pool.query(
      `INSERT INTO app.assignment_document_field_candidates
         (document_id, field_key, raw_value, normalized_value)
       VALUES ($1, 'lender_client_name', 'Lender: Fixture lender', 'Fixture lender') RETURNING id`,
      [documentId],
    );

    let preliminaryRead;
    const readStarted = new Promise((resolve) => { preliminaryRead = resolve; });
    const observedPool = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql, ...args) => {
            const result = await client.query(sql, ...args);
            if (/SELECT account_id, assignment_file_id/.test(String(sql))) preliminaryRead();
            return result;
          },
          release: () => client.release(),
        };
      },
    };
    await ensureAssignmentDocumentsSchema(observedPool);
    holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SET LOCAL lock_timeout = '750ms'");
    await holder.query(
      "SELECT assignment_file_id FROM app.custom_appraisal_workfiles WHERE assignment_file_id = $1 FOR UPDATE",
      [assignmentFileId],
    );
    reviewPromise = reviewAssignmentDocumentCandidate(observedPool, {
      documentId,
      candidateId: candidate.rows[0].id,
      reviewStatus: "rejected",
      reviewer: "Fixture appraiser",
    });
    let waitTimer;
    try {
      await Promise.race([
        readStarted,
        reviewPromise.then(
          () => { throw new Error("document_review_finished_before_scope_read"); },
          (error) => { throw error; },
        ),
        new Promise((_, reject) => {
          waitTimer = setTimeout(() => reject(new Error("document_scope_read_timeout")), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(waitTimer);
    }
    // If review locked the document first, this opposing workfile/document
    // transaction would hit lock_timeout instead of acquiring the row.
    await holder.query(
      "SELECT id FROM app.assignment_documents WHERE id = $1 FOR UPDATE",
      [documentId],
    );
    await holder.query("COMMIT");
    holder.release();
    holder = null;
    const reviewed = await reviewPromise;
    assert.equal(reviewed.review_status, "rejected");
    // Single-field approval must use the same normalized default as batch approval.
    const confirm = (confirmedValue) => reviewAssignmentDocumentCandidate(pool, {
      documentId, candidateId: candidate.rows[0].id, reviewStatus: "confirmed",
      reviewer: "Fixture appraiser", confirmedValue,
    });
    assert.equal((await confirm()).confirmed_value, "Fixture lender");
    assert.equal((await confirm("Appraiser correction")).confirmed_value, "Appraiser correction");
    await pool.query(
      "UPDATE app.assignment_document_field_candidates SET normalized_value = ' ' WHERE id = $1 AND document_id = $2",
      [candidate.rows[0].id, documentId],
    );
    assert.equal((await confirm()).confirmed_value, "Lender: Fixture lender");
  } finally {
    if (holder) {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
    if (reviewPromise) await reviewPromise.catch(() => {});
    if (documentId) await pool.query("DELETE FROM app.assignment_documents WHERE id = $1", [documentId]);
    if (assignmentFileId) {
      await pool.query("DELETE FROM app.custom_appraisal_section_history WHERE assignment_file_id = $1", [assignmentFileId]);
      await pool.query("DELETE FROM app.custom_appraisal_sections WHERE assignment_file_id = $1", [assignmentFileId]);
      await pool.query("DELETE FROM app.custom_appraisal_workfiles WHERE assignment_file_id = $1", [assignmentFileId]);
      await pool.query("DELETE FROM app.assignment_files WHERE id = $1", [assignmentFileId]);
    }
    if (accountId) await pool.query("DELETE FROM core.accounts WHERE account_id = $1", [accountId]);
    await pool.end();
  }
});

test("custom signed-photo coverage audit runs against migrated PostgreSQL without writes", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await auditCustomSignedPhotoCoverage(pool);
    assert.notEqual(result.code, "custom_signed_photo_coverage_schema_missing");
    assert.equal(Number.isSafeInteger(result.signed_file_count), true);
    assert.equal(Number.isSafeInteger(result.invalid_photo_manifest_file_count), true);
    assert.equal(Number.isSafeInteger(result.nonfinalized_photo_count_at_signing), true);
    assert.equal(Number.isSafeInteger(result.verified_photo_count), true);
  } finally {
    await pool.end();
  }
});

test("signed-photo byte diagnostics aggregate separate files against migrated PostgreSQL", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let client;
  try {
    client = await pool.connect();
    const identity = await client.query("SELECT current_database() AS database_name");
    assert.match(identity.rows[0].database_name, /_test$/);
    const baseline = await auditCustomSignedPhotoCoverage({
      connect: async () => ({
        query: (...args) => client.query(...args),
        release() {},
      }),
    });
    await client.query("BEGIN");
    const organizationId = randomUUID();
    await client.query(
      `INSERT INTO app_auth.organizations (id, legal_name, display_name)
       VALUES ($1, 'Audit fixture organization', 'Audit fixture organization')`,
      [organizationId],
    );
    for (const [photoCount, byteSize] of [[9, 8 * 1024 * 1024], [2, 1024 * 1024]]) {
      const suffix = randomUUID();
      const accountId = `audit-photo-${suffix}`;
      const fileNumber = `audit-${suffix}`;
      const reportId = randomUUID();
      await client.query("INSERT INTO core.accounts (account_id) VALUES ($1)", [accountId]);
      const assignment = await client.query(
        `INSERT INTO app.assignment_files (account_id, file_number, organization_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [accountId, fileNumber, organizationId],
      );
      const assignmentFileId = assignment.rows[0].id;
      await client.query(
        `INSERT INTO app.custom_appraisal_workfiles
           (assignment_file_id, canonical_file_name, status, signed_at, signed_by)
         VALUES ($1, $2, 'signed', now(), 'Audit fixture appraiser')`,
        [assignmentFileId, `${fileNumber}.homenode-appraisal.json`],
      );
      await client.query(
        `INSERT INTO app.report_files
           (id, organization_id, account_id, workflow_type, file_number, custom_assignment_file_id)
         VALUES ($1, $2, $3, 'custom_appraisal', $4, $5)`,
        [reportId, organizationId, accountId, fileNumber, assignmentFileId],
      );
      await client.query(
        `INSERT INTO app.custom_appraisal_signed_snapshots
           (assignment_file_id, canonical_file_name, schema_version, snapshot,
            checksum_sha256, signed_by, organization_id)
         VALUES ($1, $2, 1, $3::jsonb, repeat('a', 64), 'Audit fixture appraiser', $4)`,
        [assignmentFileId, `${fileNumber}.pdf`, JSON.stringify({ evidence: { inspection_photos: [] } }), organizationId],
      );
      await client.query(
        `INSERT INTO app.inspection_photos
           (id, report_file_id, organization_id, client_photo_id, request_sha256,
            workflow_type, category, category_source, caption_source, source,
            position, status, origin_channel, verified_at, retention_starts_at, retention_until)
         SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), repeat('b', 64),
                'custom_appraisal', 'Front', 'manual', 'category', 'camera',
                position, 'verified', 'desktop', now(), now(), now() + interval '6 years'
           FROM generate_series(1, $3::integer) AS series(position)`,
        [reportId, organizationId, photoCount],
      );
      await client.query(
        `INSERT INTO app.inspection_photo_objects
           (id, photo_id, client_object_id, variant, storage_bucket, object_key,
            original_file_name, content_type, expected_byte_size, byte_size,
            status, verified_at)
         SELECT gen_random_uuid(), photo.id, gen_random_uuid(), 'display',
                'ci-audit', 'audit/' || photo.id || '/display', 'display.jpg',
                'image/jpeg', $2, $2, 'verified', now()
           FROM app.inspection_photos photo WHERE photo.report_file_id = $1`,
        [reportId, byteSize],
      );
    }
    // Run the production aggregate SQL on this same transaction so the fixture
    // remains invisible to other tests and is removed by the final rollback.
    const transactionScopedPool = {
      connect: async () => ({
        query: (sql, ...args) => {
          if (sql === "BEGIN READ ONLY") return client.query("SAVEPOINT audit_fixture_read");
          if (sql === "ROLLBACK") return client.query("ROLLBACK TO SAVEPOINT audit_fixture_read");
          return client.query(sql, ...args);
        },
        release() {},
      }),
    };
    const result = await auditCustomSignedPhotoCoverage(transactionScopedPool);
    assert.equal(result.signed_file_count, baseline.signed_file_count + 2);
    assert.equal(result.signed_files_over_64mib_pdf_eligible_photo_metadata_count,
      baseline.signed_files_over_64mib_pdf_eligible_photo_metadata_count + 1);
    assert.equal(result.max_pdf_eligible_photo_metadata_bytes_per_file,
      Math.max(baseline.max_pdf_eligible_photo_metadata_bytes_per_file, 72 * 1024 * 1024));
  } finally {
    if (client) {
      await client.query("ROLLBACK");
      client.release();
    }
    await pool.end();
  }
});

test("custom signed-PDF byte audit verifies digest against migrated PostgreSQL without writes", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const builtInDigest = await pool.query("SELECT encode(sha256('abc'::bytea), 'hex') AS sha256");
    assert.equal(builtInDigest.rows[0].sha256,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const result = await auditCustomSignedPdfContent(pool);
    assert.notEqual(result.code, "custom_signed_pdf_content_schema_missing");
    assert.equal(Number.isSafeInteger(result.artifact_count), true);
    assert.equal(Number.isSafeInteger(result.content_digest_mismatch_count), true);
  } finally {
    await pool.end();
  }
});

test("custom signed-PDF parity audit runs against migrated PostgreSQL without writes", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await auditCustomSignedArtifacts(pool);
    assert.notEqual(result.code, "custom_signed_artifact_schema_missing");
    assert.equal(Number.isSafeInteger(result.signed_snapshot_count), true);
    assert.equal(Number.isSafeInteger(result.missing_artifact_count), true);
  } finally {
    await pool.end();
  }
});

test("UAD foundation migration creates isolated schemas and seeded roles", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const schemas = await pool.query(`
      SELECT schema_name
        FROM information_schema.schemata
       WHERE schema_name IN ('app_auth', 'appraisal', 'uad_ref')
       ORDER BY schema_name
    `);
    assert.deepEqual(schemas.rows.map((row) => row.schema_name), ["app_auth", "appraisal", "uad_ref"]);

    const roles = await pool.query("SELECT code FROM app_auth.roles ORDER BY code");
    assert.deepEqual(roles.rows.map((row) => row.code), [
      "appraiser",
      "homenode_admin",
      "office_assistant",
      "organization_admin",
      "read_only",
      "reviewer",
      "supervisory_appraiser",
    ]);

    const unifiedIdentity = await pool.query(`
      SELECT bool_and(to_regclass('app_auth.web_sessions') IS NOT NULL) AS web_sessions_ready,
             count(*) FILTER (
               WHERE column_name IN (
                 'organization_id',
                 'assigned_appraiser_user_id',
                 'supervisory_appraiser_user_id',
                 'created_by_user_id',
                 'updated_by_user_id'
               )
             )::integer AS assignment_identity_column_count
        FROM information_schema.columns
       WHERE table_schema = 'app'
         AND table_name = 'assignment_files'
    `);
    assert.equal(unifiedIdentity.rows[0]?.web_sessions_ready, true);
    assert.equal(unifiedIdentity.rows[0]?.assignment_identity_column_count, 5);

    const signatureHardening = await pool.query(`
      SELECT
        count(*) FILTER (
          WHERE column_name IN (
            'organization_id', 'signed_by_user_id', 'signature_event_id',
            'signed_from_ip', 'signed_user_agent', 'signature_hmac_sha256'
          )
        )::integer AS signature_column_count,
        EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgrelid = 'app.custom_appraisal_signed_snapshots'::regclass
             AND tgname = 'custom_appraisal_signed_snapshot_append_only'
             AND NOT tgisinternal
        ) AS append_only_trigger
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'custom_appraisal_signed_snapshots'
    `);
    assert.equal(signatureHardening.rows[0]?.signature_column_count, 6);
    assert.equal(signatureHardening.rows[0]?.append_only_trigger, true);

    const release = await pool.query(
      "SELECT status FROM uad_ref.specification_releases WHERE release_key = $1",
      ["uad-3.6-2026-08-13-h1.5"],
    );
    assert.equal(release.rows[0]?.status, "current");

    const tableCount = await pool.query(`
      SELECT count(*)::integer AS count
        FROM information_schema.tables
       WHERE table_schema IN ('app_auth', 'appraisal', 'uad_ref')
         AND table_type = 'BASE TABLE'
    `);
    assert.ok(tableCount.rows[0].count >= 20);

    const contextColumn = await pool.query(`
      SELECT is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'appraisal'
         AND table_name = 'uad_field_values'
         AND column_name = 'field_context'
    `);
    assert.equal(contextColumn.rows[0]?.is_nullable, "NO");

    const sellerEntityConstraint = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'appraisal.uad_entities'::regclass
         AND conname = 'uad_entities_entity_type_check'
    `);
    assert.match(sellerEntityConstraint.rows[0]?.definition || "", /assignment_seller/);
    assert.match(sellerEntityConstraint.rows[0]?.definition || "", /assignment_owner/);

    const sellerFieldMetadata = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND property_context = 'seller'
         AND metadata->>'repeatable_entity_type' = 'assignment_seller'
    `);
    assert.equal(sellerFieldMetadata.rows[0]?.count, 7);

    const ownerFieldMetadata = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND property_context = 'owner'
         AND metadata->>'repeatable_entity_type' = 'assignment_owner'
    `);
    assert.equal(ownerFieldMetadata.rows[0]?.count, 5);

    const phaseOneFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number IN (2, 3)
    `);
    assert.ok(phaseOneFields.rows[0].count >= 50);

    const siteFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 4
    `);
    assert.ok(siteFields.rows[0].count >= 50);

    const siteRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-SITE-%'
    `);
    assert.equal(siteRules.rows[0].count, 2);

    const sketchFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 7
    `);
    assert.ok(sketchFields.rows[0].count >= 12);

    const sketchRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (rule_id IN ('UAD1676', 'UAD1677', 'UAD1678') OR rule_id LIKE 'HN-UAD-SKETCH-%')
    `);
    assert.equal(sketchRules.rows[0].count, 5);

    const mobileEvidenceIndexes = await pool.query(`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'appraisal'
         AND indexname IN (
           'uad_assets_active_mobile_photo_uidx',
           'uad_assets_active_mobile_sketch_uidx',
           'uad_assets_mobile_evidence_lookup_idx'
         )
       ORDER BY indexname
    `);
    assert.deepEqual(mobileEvidenceIndexes.rows.map((row) => row.indexname), [
      "uad_assets_active_mobile_photo_uidx",
      "uad_assets_active_mobile_sketch_uidx",
      "uad_assets_mobile_evidence_lookup_idx",
    ]);

    const sketchEditorSchema = await pool.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'appraisal' AND table_name = 'uad_sketches'
             AND column_name = 'revision'
        ) AS has_revision,
        to_regclass('appraisal.uad_sketch_history') IS NOT NULL AS has_history,
        to_regclass('appraisal.uad_assets_active_sketch_editor_revision_uidx') IS NOT NULL AS has_editor_index
    `);
    assert.equal(sketchEditorSchema.rows[0].has_revision, true);
    assert.equal(sketchEditorSchema.rows[0].has_history, true);
    assert.equal(sketchEditorSchema.rows[0].has_editor_index, true);

    const dwellingExteriorFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 8
    `);
    assert.ok(dwellingExteriorFields.rows[0].count >= 70);

    const dwellingExteriorRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (rule_id IN ('UAD1048', 'UAD1050', 'UAD1060', 'UAD1687') OR rule_id LIKE 'HN-UAD-DWELLING-%')
    `);
    assert.equal(dwellingExteriorRules.rows[0].count, 8);

    const manufacturedHomeFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 9
    `);
    assert.ok(manufacturedHomeFields.rows[0].count >= 40);

    const manufacturedHomeRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (
           rule_id IN ('UAD1100', 'UAD1101', 'UAD1102', 'UAD1284', 'UAD1285', 'UAD1721')
           OR rule_id LIKE 'HN-UAD-MH-%'
         )
    `);
    assert.equal(manufacturedHomeRules.rows[0].count, 12);

    const unitInteriorFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 10
    `);
    assert.ok(unitInteriorFields.rows[0].count >= 75);

    const unitInteriorRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-UNIT-%'
    `);
    assert.equal(unitInteriorRules.rows[0].count, 8);

    const officialUnitInteriorRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1138', 'UAD1139', 'UAD1140', 'UAD1141', 'UAD1142', 'UAD1143',
           'UAD1144', 'UAD1145', 'UAD1146', 'UAD1147', 'UAD1148', 'UAD1149',
           'UAD1150', 'UAD1151', 'UAD1152', 'UAD1153', 'UAD1154', 'UAD1155',
           'UAD1156', 'UAD1157', 'UAD1158', 'UAD1160', 'UAD1161', 'UAD1162',
           'UAD1163', 'UAD1164', 'UAD1165', 'UAD1166', 'UAD1167', 'UAD1168',
           'UAD1169', 'UAD1170', 'UAD1171', 'UAD1173', 'UAD1174', 'UAD1175',
           'UAD1176', 'UAD1177', 'UAD1178', 'UAD1182', 'UAD1184', 'UAD1185',
           'UAD1186', 'UAD1187', 'UAD1188', 'UAD1189', 'UAD1190', 'UAD1484',
           'UAD1688', 'UAD1694', 'UAD1730', 'UAD1764'
         )
    `);
    assert.equal(officialUnitInteriorRules.rows[0].count, 52);

    const functionalObsolescenceFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 11
    `);
    assert.equal(functionalObsolescenceFields.rows[0].count, 4);

    const functionalObsolescenceRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (rule_id IN ('UAD1680', 'UAD1681') OR rule_id LIKE 'HN-UAD-FUNCTIONAL-%')
    `);
    assert.equal(functionalObsolescenceRules.rows[0].count, 4);

    const outbuildingFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 12
    `);
    assert.equal(outbuildingFields.rows[0].count, 36);

    const officialOutbuildingRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1047', 'UAD1055', 'UAD1056', 'UAD1057', 'UAD1058', 'UAD1059',
           'UAD1083', 'UAD1084', 'UAD1089', 'UAD1094', 'UAD1095', 'UAD1096',
           'UAD1103', 'UAD1692'
         )
    `);
    assert.equal(officialOutbuildingRules.rows[0].count, 14);

    const homeNodeOutbuildingRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-OUTBUILDING-%'
    `);
    assert.equal(homeNodeOutbuildingRules.rows[0].count, 8);

    const vehicleStorageFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 13
    `);
    assert.equal(vehicleStorageFields.rows[0].count, 18);

    const officialVehicleStorageRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1664', 'UAD1665', 'UAD1667', 'UAD1668', 'UAD1669', 'UAD1670',
           'UAD1671', 'UAD1672', 'UAD1673', 'UAD1675', 'UAD1686', 'UAD1736'
         )
    `);
    assert.equal(officialVehicleStorageRules.rows[0].count, 12);

    const homeNodeVehicleStorageRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-VEHICLE-STORAGE-%'
    `);
    assert.equal(homeNodeVehicleStorageRules.rows[0].count, 6);

    const unscaffoldedVehicleStorageWorkfiles = await pool.query(`
      SELECT count(*)::integer AS count
        FROM appraisal.uad_workfiles workfile
       WHERE NOT EXISTS (
         SELECT 1
           FROM appraisal.uad_entities entity
          WHERE entity.workfile_id = workfile.id
            AND entity.entity_type = 'vehicle_storage'
       )
    `);
    assert.equal(unscaffoldedVehicleStorageWorkfiles.rows[0].count, 0);

    const subjectAmenityFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 14
    `);
    assert.equal(subjectAmenityFields.rows[0].count, 48);

    const officialSubjectAmenityRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1045', 'UAD1046', 'UAD1685', 'UAD1739')
    `);
    assert.equal(officialSubjectAmenityRules.rows[0].count, 4);

    const homeNodeSubjectAmenityRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-SUBJECT-AMENITIES-%'
    `);
    assert.equal(homeNodeSubjectAmenityRules.rows[0].count, 8);

    const overallQualityConditionFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 15
    `);
    assert.equal(overallQualityConditionFields.rows[0].count, 3);

    const overallQualityConditionLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 15
    `);
    assert.equal(overallQualityConditionLocations.rows[0].count, 11);
    assert.equal(overallQualityConditionLocations.rows[0].redisplay_count, 8);

    const officialOverallQualityConditionRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1384', 'UAD1385', 'UAD1387')
    `);
    assert.equal(officialOverallQualityConditionRules.rows[0].count, 3);

    const homeNodeOverallQualityConditionRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-OVERALL-QC-%'
    `);
    assert.equal(homeNodeOverallQualityConditionRules.rows[0].count, 3);

    const highestBestUseFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 16
    `);
    assert.equal(highestBestUseFields.rows[0].count, 8);

    const highestBestUseLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (
           section_number = 16
           OR metadata->>'source_report_field_id' = '16.004'
         )
    `);
    assert.equal(highestBestUseLocations.rows[0].count, 9);
    assert.equal(highestBestUseLocations.rows[0].redisplay_count, 1);

    const officialHighestBestUseRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1659', 'UAD1660', 'UAD1661', 'UAD1662', 'UAD1663')
    `);
    assert.equal(officialHighestBestUseRules.rows[0].count, 5);

    const homeNodeHighestBestUseRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-HIGHEST-BEST-USE-%'
    `);
    assert.equal(homeNodeHighestBestUseRules.rows[0].count, 2);

    const marketFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 17
    `);
    assert.equal(marketFields.rows[0].count, 21);

    const marketLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 17
    `);
    assert.equal(marketLocations.rows[0].count, 24);
    assert.equal(marketLocations.rows[0].redisplay_count, 3);

    const officialMarketRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1626', 'UAD1627', 'UAD1629', 'UAD1630', 'UAD1631', 'UAD1632',
           'UAD1633', 'UAD1634', 'UAD1635', 'UAD1636', 'UAD1639', 'UAD1642',
           'UAD1643', 'UAD1644', 'UAD1645', 'UAD1646', 'UAD1647', 'UAD1648',
           'UAD1652', 'UAD1653', 'UAD1656', 'UAD1657'
         )
    `);
    assert.equal(officialMarketRules.rows[0].count, 22);

    const homeNodeMarketRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-MARKET-%'
    `);
    assert.equal(homeNodeMarketRules.rows[0].count, 5);

    const projectInformationFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 18
    `);
    assert.equal(projectInformationFields.rows[0].count, 95);

    const projectInformationLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 18
    `);
    assert.ok(projectInformationLocations.rows[0].count >= 90);
    assert.ok(projectInformationLocations.rows[0].redisplay_count >= 7);

    const officialProjectInformationRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (
           rule_id BETWEEN 'UAD1568' AND 'UAD1615'
           OR rule_id IN ('UAD1727', 'UAD1741')
         )
    `);
    assert.equal(officialProjectInformationRules.rows[0].count, 50);

    const homeNodeProjectInformationRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-PROJECT-%'
    `);
    assert.equal(homeNodeProjectInformationRules.rows[0].count, 4);

    const subjectListingFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 19
    `);
    assert.equal(subjectListingFields.rows[0].count, 21);

    const subjectListingLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 19
    `);
    assert.equal(subjectListingLocations.rows[0].count, 16);
    assert.equal(subjectListingLocations.rows[0].redisplay_count, 0);

    const officialSubjectListingRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1203', 'UAD1204', 'UAD1205', 'UAD1206',
           'UAD1207', 'UAD1208', 'UAD1209', 'UAD1725', 'UAD1726'
         )
    `);
    assert.equal(officialSubjectListingRules.rows[0].count, 9);

    const homeNodeSubjectListingRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-SUBJECT-LISTING-%'
    `);
    assert.equal(homeNodeSubjectListingRules.rows[0].count, 4);

    const salesContractFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 20
    `);
    assert.equal(salesContractFields.rows[0].count, 17);

    const salesContractLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND (section_number = 20 OR (
           property_context = 'sales_contract' AND report_field_id IN (
             '1.007', '22.01.04', '22.15.03', '26.006', '22.01.05', '22.01.06'
           )
         ))
    `);
    assert.equal(salesContractLocations.rows[0].count, 24);
    assert.equal(salesContractLocations.rows[0].redisplay_count, 8);

    const officialSalesContractRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1127', 'UAD1128', 'UAD1129', 'UAD1130', 'UAD1131', 'UAD1132',
           'UAD1133', 'UAD1134', 'UAD1135', 'UAD1136', 'UAD1728'
         )
    `);
    assert.equal(officialSalesContractRules.rows[0].count, 11);

    const homeNodeSalesContractRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-SALES-CONTRACT-%'
    `);
    assert.equal(homeNodeSalesContractRules.rows[0].count, 4);

    const priorTransferFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 21
    `);
    assert.equal(priorTransferFields.rows[0].count, 45);

    const priorTransferLocations = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 21
    `);
    assert.equal(priorTransferLocations.rows[0].count, 29);

    const officialPriorTransferRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1191', 'UAD1192', 'UAD1193', 'UAD1194', 'UAD1195', 'UAD1196',
           'UAD1197', 'UAD1198', 'UAD1199', 'UAD1200', 'UAD1201', 'UAD1202',
           'UAD1431', 'UAD1432', 'UAD1436', 'UAD1439', 'UAD1440', 'UAD1442',
           'UAD1444', 'UAD1698', 'UAD1734', 'UAD1735', 'UAD1744'
         )
    `);
    assert.equal(officialPriorTransferRules.rows[0].count, 23);

    const homeNodePriorTransferRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-PRIOR-TRANSFER-%'
    `);
    assert.equal(homeNodePriorTransferRules.rows[0].count, 4);

    const priorTransferEntityConstraint = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'uad_entities_entity_type_check'
         AND conrelid = 'appraisal.uad_entities'::regclass
    `);
    assert.match(priorTransferEntityConstraint.rows[0].definition, /subject_prior_transfer/);
    assert.match(priorTransferEntityConstraint.rows[0].definition, /comparable_prior_transfer_data_source/);

    const salesComparisonFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 22
    `);
    assert.equal(salesComparisonFields.rows[0].count, 405);

    const salesComparisonLocations = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE location_role = 'redisplay')::integer AS redisplay_count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 22
    `);
    // Earlier source-section migrations plus Sections 22A-22Q provide the
    // canonical comparable/grid locations and their subject redisplays.
    assert.equal(salesComparisonLocations.rows[0].count, 542);
    assert.equal(salesComparisonLocations.rows[0].redisplay_count, 221);

    const officialSalesComparisonRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1218', 'UAD1275', 'UAD1390', 'UAD1391', 'UAD1392', 'UAD1393',
           'UAD1394', 'UAD1395', 'UAD1396', 'UAD1397', 'UAD1402', 'UAD1403',
           'UAD1404', 'UAD1428', 'UAD1433', 'UAD1469', 'UAD1477', 'UAD1481',
           'UAD1731', 'UAD1771', 'UAD1773'
         )
    `);
    assert.equal(officialSalesComparisonRules.rows[0].count, 21);

    const officialSalesComparisonSiteRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1398', 'UAD1399', 'UAD1400', 'UAD1401', 'UAD1445', 'UAD1446',
           'UAD1447', 'UAD1448', 'UAD1449', 'UAD1450', 'UAD1451', 'UAD1452',
           'UAD1476', 'UAD1769', 'UAD1770'
         )
    `);
    assert.equal(officialSalesComparisonSiteRules.rows[0].count, 15);

    const officialSalesComparisonWaterRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id = 'UAD1462'
    `);
    assert.equal(officialSalesComparisonWaterRules.rows[0].count, 1);

    const officialSubjectWaterRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1278', 'UAD1333', 'UAD1335', 'UAD1336',
           'UAD1337', 'UAD1338', 'UAD1339', 'UAD1340'
         )
    `);
    assert.equal(officialSubjectWaterRules.rows[0].count, 8);

    const officialSalesComparisonDwellingRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1097', 'UAD1416', 'UAD1418', 'UAD1421', 'UAD1422', 'UAD1423',
           'UAD1424', 'UAD1425', 'UAD1467', 'UAD1774', 'UAD1775'
         )
    `);
    assert.equal(officialSalesComparisonDwellingRules.rows[0].count, 11);

    const officialSalesComparisonUnitRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1463', 'UAD1464', 'UAD1465', 'UAD1482', 'UAD1483',
           'UAD1772', 'UAD1776', 'UAD1777', 'UAD1778', 'UAD1779'
         )
    `);
    assert.equal(officialSalesComparisonUnitRules.rows[0].count, 10);

    const officialSalesComparisonExteriorRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1426', 'UAD1427', 'UAD1473')
    `);
    assert.equal(officialSalesComparisonExteriorRules.rows[0].count, 3);

    const officialSalesComparisonInteriorRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1419', 'UAD1420')
    `);
    assert.equal(officialSalesComparisonInteriorRules.rows[0].count, 2);

    const officialSalesComparisonAduInteriorRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1415', 'UAD1419', 'UAD1420')
    `);
    assert.equal(officialSalesComparisonAduInteriorRules.rows[0].count, 3);

    const officialSalesComparisonOverallQualityRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1434', 'UAD1435')
    `);
    assert.equal(officialSalesComparisonOverallQualityRules.rows[0].count, 2);

    const officialSalesComparisonVehicleStorageRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1405', 'UAD1407', 'UAD1408', 'UAD1409',
           'UAD1410', 'UAD1411', 'UAD1412', 'UAD1414'
         )
    `);
    assert.equal(officialSalesComparisonVehicleStorageRules.rows[0].count, 8);

    const officialSalesComparisonOutbuildingRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1415', 'UAD1758')
    `);
    assert.equal(officialSalesComparisonOutbuildingRules.rows[0].count, 2);

    const officialSalesComparisonSummaryRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1253', 'UAD1456', 'UAD1457', 'UAD1458',
           'UAD1459', 'UAD1460', 'UAD1461'
         )
    `);
    assert.equal(officialSalesComparisonSummaryRules.rows[0].count, 7);

    const officialSalesComparisonReconciliationRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN ('UAD1485', 'UAD1704', 'UAD1760')
    `);
    assert.equal(officialSalesComparisonReconciliationRules.rows[0].count, 3);

    const certificationFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND section_number = 29
    `);
    assert.equal(certificationFields.rows[0].count, 25);

    const certificationProfileFields = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND property_context IN ('appraiser_party', 'supervisory_appraiser_party')
         AND metadata->>'system_owned' = 'true'
    `);
    assert.equal(certificationProfileFields.rows[0].count, 28);

    const certificationRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id IN (
           'UAD1505', 'UAD1506', 'UAD1507', 'UAD1508', 'UAD1509', 'UAD1510',
           'UAD1511', 'UAD1512', 'UAD1513', 'UAD1514', 'UAD1515', 'UAD1516',
           'UAD1517', 'UAD1518', 'UAD1523', 'UAD1535', 'UAD1536'
         )
    `);
    assert.equal(certificationRules.rows[0].count, 17);

    const signatureColumns = await pool.query(`
      SELECT count(*)::integer AS count
        FROM information_schema.columns
       WHERE table_schema = 'appraisal'
         AND table_name = 'uad_signatures'
         AND column_name IN (
           'execution_date', 'workfile_input_digest_sha256',
           'credential_snapshot_sha256', 'attestation'
         )
    `);
    assert.equal(signatureColumns.rows[0].count, 4);

    const systemPackageFields = await pool.query(`
      SELECT count(*)::integer AS count,
             count(*) FILTER (WHERE metadata->>'system_owned' = 'true')::integer AS system_owned_count
        FROM uad_ref.fields
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND property_context = 'system_package'
    `);
    assert.equal(systemPackageFields.rows[0].count, 12);
    assert.equal(systemPackageFields.rows[0].system_owned_count, 12);

    const systemPackageLocations = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.field_report_locations
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND property_context = 'system_package'
    `);
    assert.equal(systemPackageLocations.rows[0].count, 12);

    const complianceExchangeColumns = await pool.query(`
      SELECT count(*)::integer AS count
        FROM information_schema.columns
       WHERE table_schema = 'appraisal'
         AND table_name = 'uad_compliance_exchanges'
         AND column_name IN (
           'validation_run_id', 'provider', 'environment',
           'request_correlation_id', 'request_artifact_id',
           'request_checksum_sha256', 'response_http_status',
           'response_checksum_sha256', 'response_payload',
           'provider_correlation_id', 'exchange_status', 'error_code'
         )
    `);
    assert.equal(complianceExchangeColumns.rows[0].count, 12);

    const deliveryHubTables = await pool.query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'appraisal'
         AND table_name IN ('delivery_destinations', 'delivery_attempts')
       ORDER BY table_name
    `);
    assert.deepEqual(deliveryHubTables.rows.map((row) => row.table_name), [
      "delivery_attempts",
      "delivery_destinations",
    ]);

    const deliveryAttemptColumns = await pool.query(`
      SELECT count(*)::integer AS count
        FROM information_schema.columns
       WHERE table_schema = 'appraisal'
         AND table_name = 'delivery_attempts'
         AND column_name IN (
           'destination_id', 'workfile_id', 'revision_number', 'artifact_id',
           'idempotency_key', 'delivery_mode', 'status', 'external_order_id',
           'external_delivery_id', 'receipt_reference', 'package_byte_size',
           'package_checksum_sha256', 'failure_code', 'metadata'
         )
    `);
    assert.equal(deliveryAttemptColumns.rows[0].count, 14);

    const homeNodeSalesComparisonRules = await pool.query(`
      SELECT count(*)::integer AS count
        FROM uad_ref.compliance_rules
       WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
         AND rule_id LIKE 'HN-UAD-SALES-COMPARISON-%'
    `);
    assert.equal(homeNodeSalesComparisonRules.rows[0].count, 75);

    const salesComparisonEntityConstraint = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'uad_entities_entity_type_check'
         AND conrelid = 'appraisal.uad_entities'::regclass
    `);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_data_source/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparison_additional_property/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_right_not_included/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_project_amenity/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_site_influence/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_body_of_water/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_waterfront_feature/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_dwelling/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_construction_method/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_heating_system/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_cooling_system/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_functional_issue/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_disaster_mitigation/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_renewable_energy_component/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_green_certification/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_efficiency_rating/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_outbuilding/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_outbuilding_room/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_unit/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_unit_accessibility_feature/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_exterior_component/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparison_subject_exterior_quality_summary/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_kitchen/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_interior_component/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparison_subject_unit_interior_summary/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparison_subject_kitchen_summary/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparison_subject_interior_quality_summary/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparison_subject_interior_condition_summary/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_amenity/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_vehicle_storage/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /site_body_of_water/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /site_waterfront_feature/);
    assert.match(salesComparisonEntityConstraint.rows[0].definition, /sales_comparable_site_view/);
  } finally {
    await pool.end();
  }
});
