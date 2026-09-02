import assert from "node:assert/strict";
import test from "node:test";

import {
  assignmentDetailsFromConfirmedDocument,
  assignmentDocumentCandidatesForContext,
  assignmentDocumentNeedsExtractionUpgrade,
  assignmentDocumentRequestedType,
  assignmentDocumentCandidateReviewKey,
  assignmentDocumentRetryDelayMs,
  buildAssignmentDocumentObjectKey,
  confirmAssignmentDocumentCandidates,
  confirmAssignmentDocumentDespiteSubjectMismatch,
  createAssignmentDocument,
  deleteAssignmentDocument,
  loadAssignmentDocumentContent,
  retainedAssignmentDocumentReview,
} from "../src/services/assignmentDocuments.js";

test("UAD purchase contracts omit the synthetic assignment-type review candidate", () => {
  const candidates = [
    { field_key: "assignment_type", normalized_value: "purchase_transaction" },
    { field_key: "contract_price", normalized_value: "282500.00" },
  ];
  assert.deepEqual(
    assignmentDocumentCandidatesForContext(candidates, {
      uadWorkfileId: "20000000-0000-4000-8000-000000000002",
      documentType: "purchase_contract",
    }),
    [candidates[1]],
  );
  assert.deepEqual(
    assignmentDocumentCandidatesForContext(candidates, {
      documentType: "purchase_contract",
    }),
    candidates,
  );
});

test("legacy reviewed purchase contracts receive one extraction-schema upgrade", () => {
  assert.equal(assignmentDocumentNeedsExtractionUpgrade({
    document_type: "purchase_contract",
    processing_status: "review_required",
    extraction_summary: {},
  }), true);
  assert.equal(assignmentDocumentNeedsExtractionUpgrade({
    document_type: "purchase_contract",
    processing_status: "review_required",
    extraction_summary: { extraction_schema_version: "2026-09-02-v3" },
  }), false);
  assert.equal(assignmentDocumentNeedsExtractionUpgrade({
    document_type: "engagement_letter",
    processing_status: "review_required",
    extraction_summary: {},
  }), false);
  assert.equal(assignmentDocumentNeedsExtractionUpgrade({
    document_type: "zoning_ordinance",
    processing_status: "review_required",
    file_name: "Contract.pdf",
    extraction_summary: {},
  }), true);
  assert.equal(assignmentDocumentNeedsExtractionUpgrade({
    document_type: "purchase_contract",
    processing_status: "processing",
    extraction_summary: {},
  }), false);
});

test("reprocessing preserves explicit types but reclassifies a legacy contract mistaken for zoning", () => {
  assert.equal(assignmentDocumentRequestedType({
    document_type: "zoning_ordinance",
    file_name: "Contract.pdf",
  }), "other");
  assert.equal(assignmentDocumentRequestedType({
    document_type: "purchase_contract",
    file_name: "Contract.pdf",
    extraction_summary: { requested_document_type: "other" },
  }), "other");
  assert.equal(assignmentDocumentRequestedType({
    document_type: "zoning_ordinance",
    file_name: "Garland zoning ordinance.pdf",
  }), "zoning_ordinance");
});

test("confirmed engagement evidence replaces a stale assignment type and persists client fields", () => {
  const result = assignmentDetailsFromConfirmedDocument({
    assignment_types: ["heloc"],
    lender_client_name: "",
    lender_client_address: "",
    occupancy: "owner",
  }, [
    { field_key: "lender_client_name", review_status: "confirmed", confirmed_value: "Bank of America" },
    { field_key: "lender_client_address", review_status: "confirmed", confirmed_value: "100 North Tryon Street, Charlotte, NC 28255" },
    { field_key: "assignment_type", review_status: "confirmed", confirmed_value: "purchase_transaction" },
    { field_key: "subject_property_address", review_status: "confirmed", confirmed_value: "513 Hardy Dr" },
  ], "engagement_letter");
  assert.equal(result.changed, true);
  assert.deepEqual(result.assignmentDetails.assignment_types, ["purchase_transaction"]);
  assert.equal(result.assignmentDetails.lender_client_name, "Bank of America");
  assert.equal(
    result.assignmentDetails.lender_client_address,
    "100 North Tryon Street, Charlotte, NC 28255",
  );
  assert.equal(result.assignmentDetails.occupancy, "owner");
});

test("confirmed purchase-contract evidence marks the subject under contract without erasing other types", () => {
  const result = assignmentDetailsFromConfirmedDocument({
    assignment_types: ["rehab"],
    subject_under_contract: false,
  }, [
    { field_key: "contract_price", review_status: "confirmed", confirmed_value: "425000" },
    { field_key: "seller_name", review_status: "confirmed", confirmed_value: "Example Seller" },
    { field_key: "closing_date", review_status: "confirmed", confirmed_value: "2026-09-24" },
    { field_key: "contract_property_condition", review_status: "confirmed", confirmed_value: "seller_repairs" },
    { field_key: "contract_repairs", review_status: "confirmed", confirmed_value: "Repair the active plumbing leak." },
  ], "purchase_contract");
  assert.deepEqual(result.assignmentDetails.assignment_types, ["rehab", "purchase_transaction"]);
  assert.equal(result.assignmentDetails.subject_under_contract, true);
  assert.equal(result.assignmentDetails.contract_price, "425000");
  assert.equal(result.assignmentDetails.contract_seller_names, "Example Seller");
  assert.equal(result.assignmentDetails.contract_closing_date, "2026-09-24");
  assert.equal(result.assignmentDetails.contract_property_condition, "seller_repairs");
  assert.equal(result.assignmentDetails.contract_repairs, "Repair the active plumbing leak.");
});

test("assignment document object keys are assignment-scoped and content-addressed", () => {
  assert.equal(
    buildAssignmentDocumentObjectKey({
      organizationId: "10000000-0000-4000-8000-000000000001",
      accountId: "26272500060150000",
      assignmentFileId: 91,
      checksumSha256: "A".repeat(64),
      fileName: "Purchase Contract / Final.pdf",
    }),
    `organizations/10000000-0000-4000-8000-000000000001/custom-appraisal/accounts/26272500060150000/assignment-files/91/documents/${"a".repeat(64)}/Purchase-Contract-Final.pdf`,
  );
  assert.equal(
    buildAssignmentDocumentObjectKey({
      organizationId: "10000000-0000-4000-8000-000000000001",
      accountId: "26272500060150000",
      uadWorkfileId: "20000000-0000-4000-8000-000000000002",
      checksumSha256: "B".repeat(64),
      fileName: "Engagement Letter.pdf",
    }),
    `organizations/10000000-0000-4000-8000-000000000001/uad-3.6/accounts/26272500060150000/workfiles/20000000-0000-4000-8000-000000000002/documents/${"b".repeat(64)}/Engagement-Letter.pdf`,
  );
});

test("a verified private upload stores metadata without duplicating PDF bytes in PostgreSQL", async () => {
  const pdf = Buffer.from("%PDF-test-private-storage");
  let insertValues;
  const pool = {
    async query(sql, values) {
      if (/CREATE TABLE IF NOT EXISTS app\.assignment_documents/.test(sql)) return { rows: [] };
      insertValues = values;
      return {
        rows: [{
          id: 41,
          account_id: values[0],
          assignment_file_id: values[1],
          uad_workfile_id: values[2],
          report_file_id: values[3],
          document_type: values[4],
          title: values[5],
          file_name: values[6],
          content_type: "application/pdf",
          content: values[7],
          checksum_sha256: values[8],
          file_size_bytes: values[9],
          storage_provider: values[11],
          storage_status: values[12],
          storage_bucket: values[13],
          object_key: values[14],
          storage_etag: values[15],
          storage_content_type: values[16],
          storage_verified_at: values[17],
          processing_status: "uploaded",
          extraction_summary: {},
        }],
      };
    },
  };
  const storage = {
    configured: true,
    bucket: "private-evidence",
    async putObject() {},
    async inspectObject() {
      return { byte_size: pdf.length, etag: '"verified"', content_type: "application/pdf" };
    },
  };
  const result = await createAssignmentDocument(pool, {
    accountId: "26272500060150000",
    assignmentFileId: 91,
    fileName: "contract.pdf",
    content: pdf,
    storage,
  });
  assert.equal(insertValues[7], null);
  assert.equal(insertValues[11], "r2");
  assert.equal(result.storage_provider, "r2");
  assert.ok(result.storage_verified_at instanceof Date);
});

test("document uploads accept only non-empty PDF buffers", async () => {
  const pool = {
    async query(sql) {
      if (/CREATE TABLE IF NOT EXISTS app\.assignment_documents/.test(sql)) return { rows: [] };
      throw new Error("unexpected_database_write");
    },
  };
  for (const content of ["%PDF-string", [37, 80, 68, 70], new Uint8Array([37, 80, 68, 70])]) {
    await assert.rejects(
      createAssignmentDocument(pool, { accountId: "1", fileName: "invalid.pdf", content }),
      /document_content_required/,
    );
  }
  await assert.rejects(
    createAssignmentDocument(pool, { accountId: "1", fileName: "invalid.pdf", content: Buffer.from("not-pdf") }),
    /document_not_pdf/,
  );
});

test("private document reads fail closed when downloaded bytes do not match the checksum", async () => {
  const expected = Buffer.from("%PDF-expected");
  const pool = {
    async query(sql) {
      if (/CREATE TABLE IF NOT EXISTS app\.assignment_documents/.test(sql)) return { rows: [] };
      return {
        rows: [{
          id: 42,
          file_size_bytes: expected.length,
          checksum_sha256: "0".repeat(64),
          storage_provider: "r2",
          object_key: "documents/42.pdf",
          content: null,
        }],
      };
    },
  };
  const storage = {
    configured: true,
    async getObject() {
      return { body: expected, byte_size: expected.length };
    },
  };
  await assert.rejects(
    loadAssignmentDocumentContent(pool, 42, { storage }),
    /storage_checksum_mismatch/,
  );
});

test("deleting a private assignment document removes its R2 object before cascading the database row", async () => {
  const events = [];
  const client = {
    async query(sql) {
      events.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (/SELECT id, storage_provider, object_key/.test(sql)) {
        return { rows: [{ id: 42, storage_provider: "r2", object_key: "documents/42.pdf" }] };
      }
      if (/DELETE FROM app\.assignment_documents/.test(sql)) return { rows: [{ id: 42 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {
      events.push("RELEASE");
    },
  };
  const pool = {
    async query(sql) {
      if (/CREATE TABLE IF NOT EXISTS app\.assignment_documents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      return client;
    },
  };
  const storage = {
    configured: true,
    async deleteObject({ objectKey }) {
      events.push(`DELETE_OBJECT ${objectKey}`);
    },
  };
  assert.deepEqual(await deleteAssignmentDocument(pool, storage, 42), {
    document_id: 42,
    deleted: true,
    storage_deleted: true,
  });
  assert.ok(events.indexOf("DELETE_OBJECT documents/42.pdf") < events.findIndex((event) => (
    /DELETE FROM app\.assignment_documents/.test(event)
  )));
  assert.ok(events.includes("COMMIT"));
});

test("a private document remains in the database when object deletion fails", async () => {
  const events = [];
  const client = {
    async query(sql) {
      events.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      if (/SELECT id, storage_provider, object_key/.test(sql)) {
        return { rows: [{ id: 43, storage_provider: "r2", object_key: "documents/43.pdf" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      if (/CREATE TABLE IF NOT EXISTS app\.assignment_documents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      return client;
    },
  };
  await assert.rejects(
    deleteAssignmentDocument(pool, {
      configured: true,
      async deleteObject() {
        throw new Error("object_delete_failed");
      },
    }, 43),
    /object_delete_failed/,
  );
  assert.ok(events.includes("ROLLBACK"));
  assert.equal(events.some((event) => /DELETE FROM app\.assignment_documents/.test(event)), false);
});

test("document extraction retries use bounded exponential backoff", () => {
  assert.equal(assignmentDocumentRetryDelayMs(1), 30_000);
  assert.equal(assignmentDocumentRetryDelayMs(2), 60_000);
  assert.equal(assignmentDocumentRetryDelayMs(5), 480_000);
  assert.equal(assignmentDocumentRetryDelayMs(50), 6 * 60 * 60 * 1_000);
});

test("candidate identity follows the field and normalized source value", () => {
  assert.equal(
    assignmentDocumentCandidateReviewKey({
      field_key: "contract_price",
      raw_value: "$425,000",
      normalized_value: "425000.00",
    }),
    "contract_price\u0000425000.00",
  );
});

test("reprocessing retains an exact appraiser review but not a changed extraction", () => {
  const reviews = [{
    field_key: "contract_price",
    raw_value: "$425,000",
    normalized_value: "425000.00",
    review_status: "confirmed",
    confirmed_value: "425000",
    reviewer: "Appraiser Example",
    reviewed_at: "2026-08-19T12:00:00.000Z",
  }];
  assert.deepEqual(
    retainedAssignmentDocumentReview(reviews, {
      field_key: "contract_price",
      raw_value: "$425,000.00",
      normalized_value: "425000.00",
    }),
    {
      review_status: "confirmed",
      confirmed_value: "425000",
      reviewer: "Appraiser Example",
      reviewed_at: "2026-08-19T12:00:00.000Z",
    },
  );
  assert.equal(
    retainedAssignmentDocumentReview(reviews, {
      field_key: "contract_price",
      raw_value: "$430,000",
      normalized_value: "430000.00",
    }).review_status,
    "suggested",
  );
});

test("an engagement address override is audited and confirms visible suggestions", async () => {
  const queries = [];
  const candidateRows = [
    {
      id: 500,
      document_id: 44,
      field_key: "assignment_type",
      raw_value: "Purchase",
      normalized_value: "purchase_transaction",
      page_number: 1,
      confidence: 0.99,
      evidence_excerpt: "Loan Purpose: Purchase",
      extraction_method: "labeled_text",
      review_status: "confirmed",
      confirmed_value: "purchase_transaction",
      reviewer: "Jordan Freeman",
      reviewed_at: "2026-09-01T16:00:00.000Z",
    },
    {
      id: 501,
      document_id: 44,
      field_key: "lender_client_name",
      raw_value: "Bank of America",
      normalized_value: "Bank of America",
      page_number: 1,
      confidence: 0.99,
      evidence_excerpt: "Client: Bank of America",
      extraction_method: "labeled_text",
      review_status: "suggested",
      confirmed_value: null,
      reviewer: null,
      reviewed_at: null,
    },
    {
      id: 502,
      document_id: 44,
      field_key: "subject_property_address",
      raw_value: "513 HARDY DR, Garland, TX 75041-3536",
      normalized_value: "513 HARDY DR, Garland, TX 75041-3536",
      page_number: 2,
      confidence: 0.99,
      evidence_excerpt: "Property Address: 513 HARDY DR",
      extraction_method: "labeled_text",
      review_status: "suggested",
      confirmed_value: null,
      reviewer: null,
      reviewed_at: null,
    },
  ];
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (/SELECT \* FROM app\.assignment_documents WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return {
          rows: [{
            id: 44,
            document_type: "engagement_letter",
            extraction_summary: { candidate_count: 3 },
          }],
        };
      }
      if (/SELECT \* FROM app\.assignment_document_field_candidates/.test(sql)) {
        return { rows: candidateRows };
      }
      if (/UPDATE app\.assignment_document_field_candidates/.test(sql)) {
        const candidate = candidateRows.find((row) => row.id === values[1]);
        return {
          rows: [{
            ...candidate,
            review_status: "confirmed",
            confirmed_value: values[2],
            reviewer: values[3],
          }],
        };
      }
      if (/INSERT INTO app\.assignment_document_candidate_reviews/.test(sql)) return { rows: [] };
      if (/UPDATE app\.assignment_documents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      if (/CREATE TABLE IF NOT EXISTS app\.assignment_documents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      return client;
    },
  };
  const result = await confirmAssignmentDocumentDespiteSubjectMismatch(pool, {
    documentId: 44,
    reviewer: "Jordan Freeman",
    reportSubjectAddress: "1909 SNOWMASS LN, GARLAND, TX 75044",
    candidateValues: { 501: "Bank of America" },
  });
  assert.equal(result.document_id, 44);
  assert.equal(result.confirmed_candidates.length, 2);
  assert.equal(result.subject_address_override.acknowledged, true);
  assert.equal(result.subject_address_override.reviewer, "Jordan Freeman");
  assert.equal(
    result.subject_address_override.document_subject_address,
    "513 HARDY DR, Garland, TX 75041-3536",
  );
  assert.equal(
    result.subject_address_override.report_subject_address,
    "1909 SNOWMASS LN, GARLAND, TX 75044",
  );
  assert.deepEqual(result.subject_address_override.confirmed_candidate_ids, [500, 501, 502]);
  const documentUpdate = queries.find(({ sql }) => /SET processing_status = CASE/.test(sql));
  const summary = JSON.parse(documentUpdate.values[1]);
  assert.equal(summary.candidate_count, 3);
  assert.equal(summary.subject_address_override.acknowledged, true);
  assert.equal(queries.filter(({ sql }) => /INSERT INTO app\.assignment_document_candidate_reviews/.test(sql)).length, 2);
});

test("approve all confirms every pending field in one audited transaction", async () => {
  const queries = [];
  const candidateRows = [
    {
      id: 601,
      document_id: 45,
      field_key: "subject_property_address",
      raw_value: "513 HARDY DR, GARLAND, TX 75041",
      normalized_value: "513 HARDY DR, GARLAND, TX 75041",
      page_number: 1,
      confidence: 0.99,
      review_status: "suggested",
    },
    {
      id: 602,
      document_id: 45,
      field_key: "lender_client_name",
      raw_value: "Bank of America Lender: Bank of America",
      normalized_value: "Bank of America",
      page_number: 1,
      confidence: 0.98,
      review_status: "suggested",
    },
  ];
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (/SELECT \* FROM app\.assignment_documents WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return {
          rows: [{
            id: 45,
            document_type: "engagement_letter",
            extraction_summary: { candidate_count: 2 },
          }],
        };
      }
      if (/SELECT \* FROM app\.assignment_document_field_candidates/.test(sql)) {
        return { rows: candidateRows };
      }
      if (/UPDATE app\.assignment_document_field_candidates/.test(sql)) {
        const candidate = candidateRows.find((row) => row.id === values[1]);
        return {
          rows: [{
            ...candidate,
            review_status: "confirmed",
            confirmed_value: values[2],
            reviewer: values[3],
          }],
        };
      }
      if (/INSERT INTO app\.assignment_document_candidate_reviews/.test(sql)) return { rows: [] };
      if (/UPDATE app\.assignment_documents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      if (/CREATE TABLE IF NOT EXISTS app\.assignment_documents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      return client;
    },
  };

  const result = await confirmAssignmentDocumentCandidates(pool, {
    documentId: 45,
    reviewer: "Jordan Freeman",
    reportSubjectAddress: "513 Hardy Drive, Garland, TX 75041",
    candidateValues: { 602: "Bank of America" },
  });

  assert.equal(result.document_id, 45);
  assert.equal(result.confirmed_candidates.length, 2);
  assert.equal(result.confirmed_candidates[1].confirmed_value, "Bank of America");
  assert.equal(queries.filter(({ sql }) => /INSERT INTO app\.assignment_document_candidate_reviews/.test(sql)).length, 2);
  assert.equal(queries.filter(({ sql }) => sql === "COMMIT").length, 1);
});

test("approving assignment-scoped engagement evidence updates the exact file and audit history", async () => {
  const queries = [];
  const candidate = {
    id: 610,
    document_id: 47,
    field_key: "lender_client_name",
    raw_value: "Bank of America",
    normalized_value: "Bank of America",
    page_number: 1,
    confidence: 0.99,
    review_status: "suggested",
  };
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [] };
      if (/SELECT \* FROM app\.assignment_documents WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return { rows: [{
          id: 47,
          account_id: "26355500170360000",
          assignment_file_id: 91,
          document_type: "engagement_letter",
          extraction_summary: {},
        }] };
      }
      if (/SELECT \* FROM app\.assignment_document_field_candidates/.test(sql)) return { rows: [candidate] };
      if (/UPDATE app\.assignment_document_field_candidates/.test(sql)) {
        return { rows: [{ ...candidate, review_status: "confirmed", confirmed_value: values[2] }] };
      }
      if (/INSERT INTO app\.assignment_document_candidate_reviews/.test(sql)) return { rows: [] };
      if (/FROM app\.assignment_files assignment_file/.test(sql)) {
        return { rows: [{
          id: 91,
          account_id: "26355500170360000",
          file_number: "2026-239-01",
          assignment_details: { assignment_types: ["purchase_transaction"] },
          revision: 4,
          workfile_status: "draft",
        }] };
      }
      if (/UPDATE app\.assignment_files/.test(sql)) return { rows: [] };
      if (/INSERT INTO app\.assignment_file_history/.test(sql)) return { rows: [] };
      if (/UPDATE app\.assignment_documents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      if (/CREATE TABLE IF NOT EXISTS app\.assignment_documents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() { return client; },
  };
  const result = await confirmAssignmentDocumentCandidates(pool, {
    documentId: 47,
    reviewer: "Jordan Freeman",
    reportSubjectAddress: "513 Hardy Dr, Garland, TX 75041",
  });
  assert.equal(result.assignment_application.applied, true);
  assert.equal(result.assignment_application.revision, 5);
  const update = queries.find(({ sql }) => /UPDATE app\.assignment_files/.test(sql));
  assert.equal(JSON.parse(update.values[0]).lender_client_name, "Bank of America");
  assert.equal(update.values[2], 5);
  assert.equal(queries.filter(({ sql }) => /INSERT INTO app\.assignment_file_history/.test(sql)).length, 1);
});

test("approve all refuses an unacknowledged engagement-address mismatch", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      if (/SELECT \* FROM app\.assignment_documents WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return {
          rows: [{
            id: 46,
            document_type: "engagement_letter",
            extraction_summary: { candidate_count: 1 },
          }],
        };
      }
      if (/SELECT \* FROM app\.assignment_document_field_candidates/.test(sql)) {
        return {
          rows: [{
            id: 603,
            document_id: 46,
            field_key: "subject_property_address",
            raw_value: "513 HARDY DR, GARLAND, TX 75041",
            normalized_value: "513 HARDY DR, GARLAND, TX 75041",
            review_status: "suggested",
          }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      if (/CREATE TABLE IF NOT EXISTS app\.assignment_documents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      return client;
    },
  };

  await assert.rejects(
    confirmAssignmentDocumentCandidates(pool, {
      documentId: 46,
      reviewer: "Jordan Freeman",
      reportSubjectAddress: "1909 Snowmass Ln, Garland, TX 75044",
    }),
    /document_subject_address_mismatch/,
  );
  assert.equal(queries.filter((sql) => /UPDATE app\.assignment_document_field_candidates/.test(sql)).length, 0);
  assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1);
});
