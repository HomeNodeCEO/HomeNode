import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createAssignmentDocumentRouter } from "../src/modules/assignmentFiles/documentRouter.js";

const objectStorage = { configured: true };
const ocrProvider = { configured: true, provider: async () => ({ text: "" }) };

function createPool(query = async () => ({ rows: [] })) {
  return { query };
}

function options(overrides = {}) {
  const pool = overrides.pool || createPool();
  return {
    pool,
    objectStorage,
    ensureAvailable: async () => {},
    requireWorkflowAccess: () => true,
    requireEditor: () => true,
    requireAssignmentAccess: async () => true,
    authenticationRequired: false,
    ocrProvider,
    resolveAccountId: async (_pool, accountId) => `canonical-${accountId}`,
    normalizeFileId: (value) => value ? `file-${value}` : null,
    decideAccess: () => true,
    listDocuments: async () => [],
    createDocument: async () => ({ id: 1, processing_status: "complete" }),
    getDocument: async () => null,
    deleteDocument: async () => ({ deleted: true }),
    processDocument: async () => ({ id: 1, processing_status: "complete" }),
    confirmDespiteMismatch: async () => ({ document_id: 1 }),
    confirmCandidates: async () => ({ document_id: 1 }),
    reviewCandidate: async () => ({ id: 1 }),
    maxDocumentBytes: 1024 * 1024,
    logger: { error() {}, warn() {} },
    ...overrides,
    pool,
  };
}

async function startRouter(router, { mobileAuth } = {}) {
  const app = express();
  if (mobileAuth !== undefined) {
    app.use((req, _res, next) => {
      req.mobileAuth = mobileAuth;
      next();
    });
  }
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

function jsonRequest(method, body = {}) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("document listing preserves rollout and enforced assignment scope", async (context) => {
  const rolloutInputs = [];
  const rollout = await startRouter(createAssignmentDocumentRouter(options({
    listDocuments: async (pool, input) => {
      rolloutInputs.push([pool, input]);
      return [{ id: 1 }];
    },
  })));
  context.after(rollout.close);

  const rolloutResponse = await fetch(`${rollout.baseUrl}/api/accounts/%2042%20/documents`);
  assert.equal(rolloutResponse.status, 200);
  assert.deepEqual(await rolloutResponse.json(), {
    ok: true,
    account_id: "canonical-42",
    documents: [{ id: 1 }],
  });
  assert.deepEqual(rolloutInputs[0][1], {
    accountId: "canonical-42",
    assignmentFileId: null,
    includePropertyEvidence: true,
  });

  const enforcedInputs = [];
  const assignmentChecks = [];
  const enforcedOptions = options({
    authenticationRequired: true,
    requireAssignmentAccess: async (_req, _res, accountId, fileId, permission) => {
      assignmentChecks.push([accountId, fileId, permission]);
      return true;
    },
    listDocuments: async (_pool, input) => {
      enforcedInputs.push(input);
      return [];
    },
  });
  const enforced = await startRouter(
    createAssignmentDocumentRouter(enforcedOptions),
    { mobileAuth: { userId: "user-1" } },
  );
  context.after(enforced.close);
  const missing = await fetch(`${enforced.baseUrl}/api/accounts/42/documents`);
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "assignment_file_required" });
  assert.equal(enforcedInputs.length, 0);

  const scoped = await fetch(
    `${enforced.baseUrl}/api/accounts/42/documents?assignment_file_id=7`,
  );
  assert.equal(scoped.status, 200);
  assert.deepEqual(assignmentChecks, [["canonical-42", "file-7", "read"]]);
  assert.deepEqual(enforcedInputs, [{
    accountId: "canonical-42",
    assignmentFileId: "file-7",
    includePropertyEvidence: false,
  }]);
});

test("PDF upload preserves organization scope, decoded headers, bytes, and extraction scheduling", async (context) => {
  const calls = [];
  const pool = createPool(async (sql, params) => {
    calls.push(["query", sql, params]);
    return { rows: [{ organization_id: "org-1" }] };
  });
  const document = { id: 17, processing_status: "uploaded" };
  const server = await startRouter(createAssignmentDocumentRouter(options({
    pool,
    authenticationRequired: true,
    requireEditor: () => {
      calls.push("editor");
      return true;
    },
    requireAssignmentAccess: async (_req, _res, accountId, fileId, permission) => {
      calls.push(["assignment", accountId, fileId, permission]);
      return true;
    },
    createDocument: async (receivedPool, input) => {
      calls.push(["create", receivedPool, input]);
      return document;
    },
    processDocument: async (receivedPool, documentId, input) => {
      calls.push(["process", receivedPool, documentId, input]);
      return document;
    },
  })), { mobileAuth: { userId: "user-1" } });
  context.after(server.close);

  const content = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);
  const response = await fetch(`${server.baseUrl}/api/accounts/42/documents`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "x-assignment-file-id": "7",
      "x-document-type": encodeURIComponent("purchase_contract"),
      "x-document-title": encodeURIComponent("Purchase Contract"),
      "x-document-file-name": encodeURIComponent("Contract 17.pdf"),
      "x-document-uploaded-by": encodeURIComponent("Appraiser One"),
    },
    body: content,
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    account_id: "canonical-42",
    document,
  });
  assert.equal(calls[0], "editor");
  assert.match(calls[1][1], /SELECT organization_id FROM app\.assignment_files/);
  assert.deepEqual(calls[1][2], ["file-7", "canonical-42"]);
  assert.deepEqual(calls[2], ["assignment", "canonical-42", "file-7", "write"]);
  assert.equal(calls[3][0], "create");
  assert.equal(calls[3][1], pool);
  assert.deepEqual({ ...calls[3][2], content: undefined }, {
    organizationId: "org-1",
    accountId: "canonical-42",
    assignmentFileId: "file-7",
    documentType: "purchase_contract",
    title: "Purchase Contract",
    fileName: "Contract 17.pdf",
    contentType: "application/pdf",
    content: undefined,
    uploadedBy: "Appraiser One",
    storage: objectStorage,
  });
  assert.deepEqual([...calls[3][2].content], [...content]);
  assert.deepEqual(calls[4], ["process", pool, 17, { storage: objectStorage }]);
});

test("document access fails closed before reads in enforced mode", async (context) => {
  let getCalls = 0;
  const queryInputs = [];
  const pool = createPool(async (_sql, params) => {
    queryInputs.push(params);
    if (params[0] === 1) return { rows: [] };
    if (params[0] === 2) return { rows: [{ id: 2, assignment_file_id: null }] };
    return { rows: [{ id: 3, assignment_file_id: 7, organization_id: "org-1" }] };
  });
  const routerOptions = options({
    pool,
    authenticationRequired: true,
    decideAccess: (_auth, assignment, permission) => (
      assignment.id === 3 && permission === "read"
    ),
    getDocument: async () => {
      getCalls += 1;
      return { id: 3 };
    },
  });

  const anonymous = await startRouter(createAssignmentDocumentRouter(routerOptions));
  context.after(anonymous.close);
  const anonymousResponse = await fetch(`${anonymous.baseUrl}/api/documents/3`);
  assert.equal(anonymousResponse.status, 401);
  assert.equal(queryInputs.length, 0);

  const authenticated = await startRouter(
    createAssignmentDocumentRouter(routerOptions),
    { mobileAuth: { userId: "user-1" } },
  );
  context.after(authenticated.close);
  const invalid = await fetch(`${authenticated.baseUrl}/api/documents/not-a-number`);
  assert.equal(invalid.status, 400);
  const missing = await fetch(`${authenticated.baseUrl}/api/documents/1`);
  assert.equal(missing.status, 404);
  const unowned = await fetch(`${authenticated.baseUrl}/api/documents/2`);
  assert.equal(unowned.status, 403);
  assert.equal(unowned.headers.get("cache-control"), "no-store");
  const allowed = await fetch(`${authenticated.baseUrl}/api/documents/3`);
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { ok: true, document: { id: 3 } });
  assert.equal(getCalls, 1);
  assert.deepEqual(queryInputs, [[1], [2], [3]]);
});

test("document content retains immutable PDF headers and private storage input", async (context) => {
  const inputs = [];
  const content = Buffer.from("%PDF-private-evidence");
  const pool = createPool();
  const server = await startRouter(createAssignmentDocumentRouter(options({
    pool,
    getDocument: async (receivedPool, id, input) => {
      inputs.push([receivedPool, id, input]);
      return {
        id: 9,
        file_name: "unsafe\"\r\nname.pdf",
        checksum_sha256: "abc123",
        content,
      };
    },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/documents/9/content`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="unsafe___name.pdf"');
  assert.equal(response.headers.get("etag"), '"abc123"');
  assert.equal(response.headers.get("cache-control"), "private, max-age=86400, immutable");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  assert.deepEqual(inputs, [[pool, "9", {
    includeContent: true,
    storage: objectStorage,
  }]]);
});

test("delete and reprocess preserve storage, OCR, and no-store contracts", async (context) => {
  const calls = [];
  const pool = createPool();
  const server = await startRouter(createAssignmentDocumentRouter(options({
    pool,
    deleteDocument: async (...args) => {
      calls.push(["delete", ...args]);
      return { document_id: 4 };
    },
    processDocument: async (...args) => {
      calls.push(["process", ...args]);
      return { id: 4, processing_status: "complete" };
    },
  })));
  context.after(server.close);

  const deleted = await fetch(`${server.baseUrl}/api/documents/4`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.headers.get("cache-control"), "no-store");
  assert.deepEqual(await deleted.json(), { ok: true, document_id: 4 });
  const reprocessed = await fetch(
    `${server.baseUrl}/api/documents/4/reprocess`,
    jsonRequest("POST"),
  );
  assert.equal(reprocessed.status, 200);
  assert.deepEqual((await reprocessed.json()).document, {
    id: 4,
    processing_status: "complete",
  });
  assert.deepEqual(calls, [
    ["delete", pool, objectStorage, "4"],
    ["process", pool, "4", { force: true, storage: objectStorage, ocrProvider }],
  ]);
});

test("document review routes preserve exact appraiser decisions", async (context) => {
  const calls = [];
  const pool = createPool();
  const reviewedDocument = { id: 5, candidates: [] };
  const server = await startRouter(createAssignmentDocumentRouter(options({
    pool,
    confirmDespiteMismatch: async (receivedPool, input) => {
      calls.push(["override", receivedPool, input]);
      return {
        document_id: 5,
        subject_address_override: { reviewer: input.reviewer },
        assignment_application: { applied: true },
      };
    },
    confirmCandidates: async (receivedPool, input) => {
      calls.push(["confirm", receivedPool, input]);
      return { document_id: 5, assignment_application: { applied: true } };
    },
    reviewCandidate: async (receivedPool, input) => {
      calls.push(["candidate", receivedPool, input]);
      return { id: "candidate-1", review_status: input.reviewStatus };
    },
    getDocument: async (receivedPool, id) => {
      calls.push(["get", receivedPool, id]);
      return reviewedDocument;
    },
  })));
  context.after(server.close);
  const reviewBody = {
    reviewer: "Appraiser One",
    report_subject_address: "123 Main St",
    candidate_values: { client_name: "Client" },
  };

  const override = await fetch(
    `${server.baseUrl}/api/documents/5/subject-address-override`,
    jsonRequest("POST", reviewBody),
  );
  assert.equal(override.status, 200);
  assert.deepEqual((await override.json()).document, reviewedDocument);
  const confirmed = await fetch(
    `${server.baseUrl}/api/documents/5/confirm-all`,
    jsonRequest("POST", reviewBody),
  );
  assert.equal(confirmed.status, 200);
  const candidateBody = {
    review_status: "confirmed",
    confirmed_value: "Client",
    reviewer: "Appraiser One",
  };
  const candidate = await fetch(
    `${server.baseUrl}/api/documents/5/candidates/candidate-1`,
    jsonRequest("PATCH", candidateBody),
  );
  assert.equal(candidate.status, 200);
  assert.deepEqual((await candidate.json()).candidate, {
    id: "candidate-1",
    review_status: "confirmed",
  });

  const serviceInput = {
    documentId: "5",
    reviewer: "Appraiser One",
    reportSubjectAddress: "123 Main St",
    candidateValues: { client_name: "Client" },
  };
  assert.deepEqual(calls, [
    ["override", pool, serviceInput],
    ["get", pool, 5],
    ["confirm", pool, serviceInput],
    ["get", pool, 5],
    ["candidate", pool, {
      documentId: "5",
      candidateId: "candidate-1",
      reviewStatus: "confirmed",
      confirmedValue: "Client",
      reviewer: "Appraiser One",
    }],
  ]);
});

test("document routes retain stable client, conflict, unavailable, and bounded errors", async (context) => {
  const logs = [];
  const server = await startRouter(createAssignmentDocumentRouter(options({
    listDocuments: async () => { throw new Error("account_not_found"); },
    createDocument: async () => { throw new Error("document_not_pdf"); },
    getDocument: async () => { throw new Error("database_diagnostic"); },
    deleteDocument: async () => {
      throw new Error("assignment_document_storage_not_configured");
    },
    processDocument: async () => { throw new Error("document_not_processable"); },
    confirmCandidates: async () => { throw new Error("document_subject_address_mismatch"); },
    reviewCandidate: async () => { throw new Error("invalid_document_review_status"); },
    logger: { error: (...args) => logs.push(args), warn() {} },
  })));
  context.after(server.close);

  const cases = [
    [fetch(`${server.baseUrl}/api/accounts/42/documents`), 404, "account_not_found"],
    [fetch(`${server.baseUrl}/api/accounts/42/documents`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: Uint8Array.from([1]),
    }), 400, "document_not_pdf"],
    [fetch(`${server.baseUrl}/api/documents/5`), 500, "assignment_document_lookup_failed"],
    [fetch(`${server.baseUrl}/api/documents/5`, { method: "DELETE" }), 503,
      "assignment_document_storage_not_configured"],
    [fetch(`${server.baseUrl}/api/documents/5/reprocess`, jsonRequest("POST")), 409,
      "document_not_processable"],
    [fetch(`${server.baseUrl}/api/documents/5/confirm-all`, jsonRequest("POST")), 409,
      "document_subject_address_mismatch"],
    [fetch(
      `${server.baseUrl}/api/documents/5/candidates/candidate-1`,
      jsonRequest("PATCH"),
    ), 400, "invalid_document_review_status"],
  ];
  for (const [responsePromise, status, error] of cases) {
    const response = await responsePromise;
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].slice(0, 1), ["assignment document lookup failed"]);
});

test("document router validates composition and replaces every inline route", () => {
  assert.throws(
    () => createAssignmentDocumentRouter(),
    /assignment_document_router_pool_required/,
  );
  assert.throws(
    () => createAssignmentDocumentRouter(options({ objectStorage: null })),
    /assignment_document_router_storage_required/,
  );
  assert.throws(
    () => createAssignmentDocumentRouter(options({ authenticationRequired: undefined })),
    /assignment_document_router_authentication_mode_required/,
  );
  assert.throws(
    () => createAssignmentDocumentRouter(options({ ensureAvailable: null })),
    /assignment_document_router_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const photos = source.indexOf("app.use(createAssignmentPhotoRouter(");
  const documents = source.indexOf("app.use(createAssignmentDocumentRouter(");
  const salesMedia = source.indexOf("app.use(createSalesMediaRouter({ pool }));");
  assert.ok(photos > 0);
  assert.ok(documents > photos);
  assert.ok(salesMedia > documents);
  assert.equal(source.includes('app.get("/api/accounts/:id/documents"'), false);
  assert.equal(source.includes('app.post("/api/accounts/:id/documents"'), false);
  assert.equal(source.includes('app.get("/api/documents/:id"'), false);
  assert.equal(source.includes('app.delete("/api/documents/:id"'), false);
  assert.equal(
    source.includes('app.patch("/api/documents/:documentId/candidates/:candidateId"'),
    false,
  );
});
