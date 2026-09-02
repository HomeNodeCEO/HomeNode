import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createAssignmentPhotoRouter } from "../src/modules/assignmentFiles/photoRouter.js";

const pool = { query: async () => ({ rows: [] }) };
const objectStorage = { configured: true };

function options(overrides = {}) {
  return {
    pool,
    objectStorage,
    requireWorkflowAccess: () => true,
    requireEditor: () => true,
    requireAssignmentAccess: async () => true,
    resolveAccountId: async (_pool, accountId) => `canonical-${accountId}`,
    normalizeFileId: (value) => value === "invalid" ? null : `file-${value}`,
    listPhotos: async () => ({ photos: [] }),
    getPhotoVersion: async () => ({ version: "photo-version" }),
    getEvidenceVersion: async () => ({ version: "evidence-version" }),
    createPhotoUpload: async () => ({ photo: { id: "photo-1" }, uploads: [] }),
    uploadPhotoObject: async () => ({ object_id: "object-1" }),
    verifyPhoto: async () => ({ id: "photo-1", status: "verified" }),
    updatePhotoMetadata: async () => ({ id: "photo-1", revision: 2 }),
    removePhoto: async () => ({ photo: { id: "photo-1", status: "excluded" } }),
    ...overrides,
  };
}

async function startRouter(router) {
  const app = express();
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

test("photo and evidence reads preserve workflow and assignment scope", async (context) => {
  const calls = [];
  const server = await startRouter(createAssignmentPhotoRouter(options({
    requireWorkflowAccess: (_req, _res, workflow, permission) => {
      calls.push(["workflow", workflow, permission]);
      return true;
    },
    requireAssignmentAccess: async (_req, _res, accountId, fileId, permission) => {
      calls.push(["assignment", accountId, fileId, permission]);
      return true;
    },
    listPhotos: async (receivedPool, storage, input) => {
      calls.push(["photos", receivedPool, storage, input]);
      return { photos: [{ id: "photo-1" }] };
    },
    getPhotoVersion: async (receivedPool, input) => {
      calls.push(["photo-version", receivedPool, input]);
      return { version: "photo-v1" };
    },
    getEvidenceVersion: async (receivedPool, input) => {
      calls.push(["evidence-version", receivedPool, input]);
      return { version: "evidence-v1" };
    },
  })));
  context.after(server.close);

  const prefix = `${server.baseUrl}/api/accounts/%2042%20/assignment-files/7`;
  const photos = await fetch(`${prefix}/photos`);
  assert.equal(photos.status, 200);
  assert.deepEqual(await photos.json(), {
    ok: true,
    account_id: "canonical-42",
    photos: [{ id: "photo-1" }],
  });
  const photoVersion = await fetch(`${prefix}/photos/version`);
  assert.equal(photoVersion.status, 200);
  assert.equal(photoVersion.headers.get("cache-control"), "no-store");
  assert.deepEqual(await photoVersion.json(), {
    ok: true,
    account_id: "canonical-42",
    version: "photo-v1",
  });
  const evidenceVersion = await fetch(`${prefix}/evidence/version`);
  assert.equal(evidenceVersion.status, 200);
  assert.equal(evidenceVersion.headers.get("cache-control"), "no-store");
  assert.deepEqual(await evidenceVersion.json(), {
    ok: true,
    account_id: "canonical-42",
    version: "evidence-v1",
  });

  assert.deepEqual(calls, [
    ["workflow", "custom_appraisal", "read"],
    ["assignment", "canonical-42", "file-7", "read"],
    ["photos", pool, objectStorage, {
      accountId: "canonical-42",
      assignmentFileId: "file-7",
    }],
    ["workflow", "custom_appraisal", "read"],
    ["assignment", "canonical-42", "file-7", "read"],
    ["photo-version", pool, {
      accountId: "canonical-42",
      assignmentFileId: "file-7",
    }],
    ["workflow", "custom_appraisal", "read"],
    ["assignment", "canonical-42", "file-7", "read"],
    ["evidence-version", pool, {
      accountId: "canonical-42",
      assignmentFileId: "file-7",
    }],
  ]);
});

test("read denial and invalid file identifiers stop before photo storage", async (context) => {
  let resolutions = 0;
  let assignmentChecks = 0;
  let serviceCalls = 0;
  const deniedServer = await startRouter(createAssignmentPhotoRouter(options({
    requireWorkflowAccess: (_req, res) => {
      res.status(403).json({ error: "application_access_denied" });
      return false;
    },
    resolveAccountId: async () => { resolutions += 1; },
    listPhotos: async () => { serviceCalls += 1; },
  })));
  context.after(deniedServer.close);

  const denied = await fetch(
    `${deniedServer.baseUrl}/api/accounts/42/assignment-files/7/photos`,
  );
  assert.equal(denied.status, 403);
  assert.equal(resolutions, 0);
  assert.equal(serviceCalls, 0);

  const invalidServer = await startRouter(createAssignmentPhotoRouter(options({
    requireAssignmentAccess: async () => { assignmentChecks += 1; },
    listPhotos: async () => { serviceCalls += 1; },
  })));
  context.after(invalidServer.close);
  const invalid = await fetch(
    `${invalidServer.baseUrl}/api/accounts/42/assignment-files/invalid/photos`,
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_assignment_file_id" });
  assert.equal(assignmentChecks, 0);
  assert.equal(serviceCalls, 0);
});

test("upload requests preserve editor, assignment, and input gates", async (context) => {
  const calls = [];
  const result = { photo: { id: "photo-1" }, uploads: [{ object_id: "object-1" }] };
  const server = await startRouter(createAssignmentPhotoRouter(options({
    requireEditor: () => {
      calls.push("editor");
      return true;
    },
    requireAssignmentAccess: async (_req, _res, accountId, fileId, permission) => {
      calls.push(["assignment", accountId, fileId, permission]);
      return true;
    },
    createPhotoUpload: async (receivedPool, storage, input) => {
      calls.push(["upload", receivedPool, storage, input]);
      return result;
    },
  })));
  context.after(server.close);

  const body = { client_photo_id: "client-photo-1", objects: [{ kind: "original" }] };
  const response = await fetch(
    `${server.baseUrl}/api/accounts/42/assignment-files/7/photos/upload-requests`,
    jsonRequest("POST", body),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, ...result });
  assert.deepEqual(calls, [
    "editor",
    ["assignment", "canonical-42", "file-7", "write"],
    ["upload", pool, objectStorage, {
      accountId: "canonical-42",
      assignmentFileId: "file-7",
      input: body,
    }],
  ]);
});

test("same-application object uploads retain the bounded raw image contract", async (context) => {
  const inputs = [];
  const uploaded = { object_id: "object-1", byte_size: 4 };
  const server = await startRouter(createAssignmentPhotoRouter(options({
    uploadPhotoObject: async (receivedPool, storage, input) => {
      inputs.push([receivedPool, storage, input]);
      return uploaded;
    },
  })));
  context.after(server.close);

  const content = Uint8Array.from([1, 2, 3, 4]);
  const response = await fetch(
    `${server.baseUrl}/api/accounts/42/assignment-files/7/photos/photo-1/objects/object-1/content`,
    {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: content,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, uploaded });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0][0], pool);
  assert.equal(inputs[0][1], objectStorage);
  assert.deepEqual({ ...inputs[0][2], content: undefined }, {
    accountId: "canonical-42",
    assignmentFileId: "file-7",
    photoId: "photo-1",
    objectId: "object-1",
    contentType: "image/jpeg",
    content: undefined,
  });
  assert.deepEqual([...inputs[0][2].content], [...content]);
});

test("verify, metadata, and removal routes preserve exact mutation inputs", async (context) => {
  const calls = [];
  const server = await startRouter(createAssignmentPhotoRouter(options({
    verifyPhoto: async (receivedPool, storage, input) => {
      calls.push(["verify", receivedPool, storage, input]);
      return { id: "photo-1", status: "verified" };
    },
    updatePhotoMetadata: async (receivedPool, storage, input) => {
      calls.push(["update", receivedPool, storage, input]);
      return { id: "photo-1", revision: 4 };
    },
    removePhoto: async (receivedPool, input) => {
      calls.push(["remove", receivedPool, input]);
      return { photo: { id: "photo-1", status: "excluded" } };
    },
  })));
  context.after(server.close);
  const prefix = `${server.baseUrl}/api/accounts/42/assignment-files/7/photos/photo-1`;

  const verified = await fetch(`${prefix}/verify`, jsonRequest("POST"));
  assert.equal(verified.status, 200);
  assert.deepEqual((await verified.json()).photo, { id: "photo-1", status: "verified" });
  const metadata = { category: "Kitchen", caption: "Updated", base_revision: 3 };
  const updated = await fetch(prefix, jsonRequest("PATCH", metadata));
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).photo, { id: "photo-1", revision: 4 });
  const removed = await fetch(prefix, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).photo, { id: "photo-1", status: "excluded" });

  const assignment = { accountId: "canonical-42", assignmentFileId: "file-7" };
  assert.deepEqual(calls, [
    ["verify", pool, objectStorage, { ...assignment, photoId: "photo-1" }],
    ["update", pool, objectStorage, {
      ...assignment,
      photoId: "photo-1",
      input: metadata,
    }],
    ["remove", pool, { ...assignment, photoId: "photo-1" }],
  ]);
});

test("write denials stop before photo mutation services", async (context) => {
  let resolutions = 0;
  let mutations = 0;
  const editorDenied = await startRouter(createAssignmentPhotoRouter(options({
    requireEditor: (_req, res) => {
      res.status(401).json({ error: "authentication_required" });
      return false;
    },
    resolveAccountId: async () => { resolutions += 1; },
    verifyPhoto: async () => { mutations += 1; },
  })));
  context.after(editorDenied.close);
  const denied = await fetch(
    `${editorDenied.baseUrl}/api/accounts/42/assignment-files/7/photos/photo-1/verify`,
    jsonRequest("POST"),
  );
  assert.equal(denied.status, 401);
  assert.equal(resolutions, 0);
  assert.equal(mutations, 0);

  const assignmentDenied = await startRouter(createAssignmentPhotoRouter(options({
    requireAssignmentAccess: async (_req, res) => {
      res.status(403).json({ error: "assignment_file_access_denied" });
      return false;
    },
    verifyPhoto: async () => { mutations += 1; },
  })));
  context.after(assignmentDenied.close);
  const scoped = await fetch(
    `${assignmentDenied.baseUrl}/api/accounts/42/assignment-files/7/photos/photo-1/verify`,
    jsonRequest("POST"),
  );
  assert.equal(scoped.status, 403);
  assert.equal(mutations, 0);
});

test("assignment photo routes retain stable error status mappings", async (context) => {
  const server = await startRouter(createAssignmentPhotoRouter(options({
    listPhotos: async () => { throw new Error("assignment_photo_file_not_found"); },
    getPhotoVersion: async () => { throw new Error("database_failure"); },
    createPhotoUpload: async () => { throw new Error("assignment_photo_limit_conflict"); },
    uploadPhotoObject: async () => {
      throw new Error("assignment_photo_storage_not_configured");
    },
    verifyPhoto: async () => { throw new Error("invalid_assignment_photo_checksum"); },
  })));
  context.after(server.close);
  const prefix = `${server.baseUrl}/api/accounts/42/assignment-files/7`;
  const requests = [
    [fetch(`${prefix}/photos`), 404, "assignment_photo_file_not_found"],
    [fetch(`${prefix}/photos/version`), 500, "database_failure"],
    [fetch(`${prefix}/photos/upload-requests`, jsonRequest("POST")), 409,
      "assignment_photo_limit_conflict"],
    [fetch(`${prefix}/photos/photo-1/objects/object-1/content`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: Uint8Array.from([1]),
    }), 503, "assignment_photo_storage_not_configured"],
    [fetch(`${prefix}/photos/photo-1/verify`, jsonRequest("POST")), 400,
      "invalid_assignment_photo_checksum"],
  ];
  for (const [responsePromise, status, error] of requests) {
    const response = await responsePromise;
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
});

test("assignment photo router validates composition and replaces inline routes", () => {
  assert.throws(() => createAssignmentPhotoRouter(), /assignment_photo_router_pool_required/);
  assert.throws(
    () => createAssignmentPhotoRouter(options({ objectStorage: null })),
    /assignment_photo_router_storage_required/,
  );
  assert.throws(
    () => createAssignmentPhotoRouter(options({ requireEditor: null })),
    /assignment_photo_router_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const guards = source.indexOf("createApplicationAccessGuards({");
  const photoRouter = source.indexOf("app.use(createAssignmentPhotoRouter(");
  const documents = source.indexOf("app.use(createAssignmentDocumentRouter(");
  assert.ok(guards > 0);
  assert.ok(photoRouter > guards);
  assert.ok(documents > photoRouter);
  assert.equal(
    source.includes('app.get("/api/accounts/:id/assignment-files/:assignmentFileId/photos"'),
    false,
  );
  assert.equal(
    source.includes('app.post("/api/accounts/:id/assignment-files/:assignmentFileId/photos/'),
    false,
  );
  assert.equal(
    source.includes('app.patch("/api/accounts/:id/assignment-files/:assignmentFileId/photos/'),
    false,
  );
});
