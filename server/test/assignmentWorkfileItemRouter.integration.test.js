import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import express from "express";

import { createAssignmentWorkfileItemRouter } from "../src/modules/assignmentFiles/workfileItemRouter.js";

const auth = { userId: "22222222-2222-4222-8222-222222222222" };
const storage = { configured: true };

function options(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [{ organization_id: "org-1" }] }) },
    sharedObjectStorage: storage,
    uadObjectStorage: storage,
    requireWorkflowAccess: () => true,
    requireAssignmentAccess: async () => true,
    resolveAccountId: async (_pool, value) => `canonical-${value}`,
    normalizeFileId: value => Number(value),
    authorizeUad: async (_pool, _auth, id) => ({ id, organization_id: "org-uad" }),
    listItems: async () => [],
    createFile: async () => ({ id: "44444444-4444-4444-8444-444444444444", item_type: "file" }),
    createLink: async () => ({ id: "55555555-5555-4555-8555-555555555555", item_type: "link" }),
    getFile: async () => ({ original_file_name: "market.xlsx", content_type: "application/octet-stream", body: Buffer.from("sheet") }),
    deleteItem: async () => ({ id: "44444444-4444-4444-8444-444444444444" }),
    maxFileBytes: 1024,
    logger: { error() {} },
    ...overrides,
  };
}

async function start(router) {
  const app = express();
  app.use((req, _res, next) => { req.mobileAuth = auth; next(); });
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test("custom workfile listing enforces workflow and exact assignment access", async context => {
  const calls = [];
  const server = await start(createAssignmentWorkfileItemRouter(options({
    requireWorkflowAccess: (_req, _res, workflow, permission) => { calls.push([workflow, permission]); return true; },
    requireAssignmentAccess: async (_req, _res, accountId, fileId, permission) => { calls.push([accountId, fileId, permission]); return true; },
    listItems: async (_pool, scope) => { calls.push(scope); return [{ id: "one" }]; },
  })));
  context.after(server.close);
  const response = await fetch(`${server.baseUrl}/api/accounts/42/assignment-files/7/workfile/items`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, items: [{ id: "one" }] });
  assert.deepEqual(calls, [
    ["custom_appraisal", "read"],
    ["canonical-42", 7, "read"],
    { assignmentFileId: 7 },
  ]);
});

test("UAD file upload uses its isolated scope and storage", async context => {
  const calls = [];
  const uadStorage = { configured: true, isolated: true };
  const server = await start(createAssignmentWorkfileItemRouter(options({
    uadObjectStorage: uadStorage,
    authorizeUad: async (_pool, identity, id, access) => {
      calls.push([identity, id, access]);
      return { id, organization_id: "org-uad" };
    },
    createFile: async (_pool, selectedStorage, scope, input) => {
      calls.push([selectedStorage, scope, input.organizationId, input.fileName, input.content.toString()]);
      return { id: "44444444-4444-4444-8444-444444444444", item_type: "file" };
    },
  })));
  context.after(server.close);
  const workfileId = "33333333-3333-4333-8333-333333333333";
  const response = await fetch(`${server.baseUrl}/api/appraisal-workfiles/uad/${workfileId}/items/files`, {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-workfile-file-name": encodeURIComponent("sales.csv"),
      "x-workfile-item-title": encodeURIComponent("Sales export"),
    },
    body: "address,price",
  });
  assert.equal(response.status, 201);
  assert.deepEqual(calls[0], [auth, workfileId, { write: true }]);
  assert.equal(calls[1][0], uadStorage);
  assert.deepEqual(calls[1].slice(1), [{ uadWorkfileId: workfileId }, "org-uad", "sales.csv", "address,price"]);
});

test("workfile links reject requests denied by workflow policy", async context => {
  const server = await start(createAssignmentWorkfileItemRouter(options({
    requireWorkflowAccess: (_req, res) => { res.status(403).json({ error: "application_access_denied" }); return false; },
  })));
  context.after(server.close);
  const response = await fetch(`${server.baseUrl}/api/accounts/42/assignment-files/7/workfile/items/links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Map", external_url: "https://example.test" }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "application_access_denied" });
});

test("large file uploads authorize the exact assignment before buffering and reject compression", async context => {
  const calls = [];
  const server = await start(createAssignmentWorkfileItemRouter(options({
    requireAssignmentAccess: async () => { calls.push("authorized"); return true; },
    createFile: async () => { calls.push("created"); return { id: "unexpected" }; },
  })));
  context.after(server.close);
  const response = await fetch(`${server.baseUrl}/api/accounts/42/assignment-files/7/workfile/items/files`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "content-encoding": "gzip",
      "x-workfile-file-name": "compressed.pdf",
    },
    body: gzipSync(Buffer.from("%PDF-compressed")),
  });
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "unsupported_content_encoding" });
  assert.deepEqual(calls, ["authorized"]);
});

test("unexpected provider failures remain bounded", async context => {
  const logs = [];
  const server = await start(createAssignmentWorkfileItemRouter(options({
    listItems: async () => { throw new Error("postgresql://secret@private-host/workfiles"); },
    logger: { error: (...values) => logs.push(values) },
  })));
  context.after(server.close);
  const response = await fetch(`${server.baseUrl}/api/accounts/42/assignment-files/7/workfile/items`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "workfile_items_lookup_failed" });
  assert.deepEqual(logs, [["assignment workfile items list failed", { code: "workfile_items_lookup_failed" }]]);
});
