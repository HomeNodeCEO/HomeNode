import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createAssignmentWorkfileFile,
  createAssignmentWorkfileLink,
  deleteAssignmentWorkfileItem,
  getAssignmentWorkfileScopeState,
  getAssignmentWorkfileFile,
} from "../src/services/assignmentWorkfileItems.js";

const organizationId = "11111111-1111-4111-8111-111111111111";

test("general workfile files are checksummed, scope-partitioned, and retained outside evidence extraction", async () => {
  const uploaded = [];
  const content = Buffer.from("parcel spreadsheet bytes");
  const checksum = createHash("sha256").update(content).digest("hex");
  const pool = {
    async query(sql, values) {
      if (/FROM app\.custom_appraisal_workfiles/.test(sql)) {
        assert.deepEqual(values, [41]);
        return { rows: [{ assignment_file_id: 41, status: "draft" }] };
      }
      assert.match(sql, /INSERT INTO app\.assignment_workfile_items/);
      assert.equal(values[1], organizationId);
      assert.equal(values[2], 41);
      assert.equal(values[3], null);
      assert.equal(values[6], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      assert.equal(values[8], checksum);
      return { rows: [{
        id: values[0], item_type: "file", title: values[4], original_file_name: values[5],
        content_type: values[6], file_size_bytes: values[7], checksum_sha256: values[8],
        external_url: null, created_by_user_id: values[10], created_at: "2026-09-22T00:00:00Z",
      }] };
    },
  };
  const storage = {
    configured: true,
    async putObject(input) { uploaded.push(input); },
    async deleteObject() {},
  };
  const result = await createAssignmentWorkfileFile(pool, storage, { assignmentFileId: 41 }, {
    organizationId,
    title: "Market support",
    fileName: "market.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content,
    createdByUserId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(result.title, "Market support");
  assert.equal(result.checksum_sha256, checksum);
  assert.equal(uploaded.length, 1);
  assert.match(uploaded[0].objectKey, new RegExp(`/workfiles/custom/41/items/.+/${checksum}/market.xlsx$`));
  assert.deepEqual(uploaded[0].body, content);
});

test("workfile file allowlist rejects executable content", async () => {
  await assert.rejects(
    createAssignmentWorkfileFile({ query: async () => ({ rows: [] }) }, { configured: true, putObject: async () => {} }, { assignmentFileId: 4 }, {
      organizationId,
      fileName: "payload.exe",
      contentType: "application/octet-stream",
      content: Buffer.from("MZ"),
    }),
    /unsupported_workfile_file_type/,
  );
});

test("workfile files reject non-buffer bodies before inspecting their length", async () => {
  for (const content of ["not raw bytes", ["not", "raw", "bytes"], { length: 12 }]) {
    await assert.rejects(
      createAssignmentWorkfileFile(
        { query: async () => ({ rows: [] }) },
        { configured: true, putObject: async () => assert.fail("invalid content must not be stored") },
        { assignmentFileId: 4 },
        { organizationId, fileName: "evidence.pdf", contentType: "application/pdf", content },
      ),
      /workfile_file_content_required/,
    );
  }
});

test("workfile links accept only credential-free http or https URLs", async () => {
  await assert.rejects(
    createAssignmentWorkfileLink({ query: async () => ({ rows: [] }) }, { uadWorkfileId: "33333333-3333-4333-8333-333333333333" }, {
      organizationId,
      title: "Unsafe",
      externalUrl: "javascript:alert(1)",
    }),
    /invalid_workfile_link/,
  );
});

test("signed Custom workfiles reject new files and clean the staged object", async () => {
  let removed = 0;
  const storage = {
    configured: true,
    async putObject() {},
    async deleteObject() { removed += 1; },
  };
  await assert.rejects(
    createAssignmentWorkfileFile({ query: async sql => {
      assert.match(sql, /FROM app\.custom_appraisal_workfiles/);
      return { rows: [{ assignment_file_id: 4, status: "signed" }] };
    } }, storage, { assignmentFileId: 4 }, {
      organizationId,
      fileName: "signed.pdf",
      contentType: "application/pdf",
      content: Buffer.from("%PDF-signed"),
    }),
    /assignment_workfile_status_locked/,
  );
  assert.equal(removed, 1);
});

test("scope state uses the effective UAD signature guard even while status remains ready", async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push([sql, values]);
      if (/FROM appraisal\.uad_workfiles/.test(sql)) {
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333", status: "ready", signed_at: null }] };
      }
      if (/FROM appraisal\.uad_signatures/.test(sql)) return { rows: [{ has_signatures: true }] };
      throw new Error("unexpected query");
    },
  };
  const result = await getAssignmentWorkfileScopeState(pool, {
    uadWorkfileId: "33333333-3333-4333-8333-333333333333",
  });
  assert.deepEqual(result, { mutable: false });
  assert.equal(queries.length, 2);
});

test("download verifies both retained byte length and SHA-256", async () => {
  const body = Buffer.from("verified workfile evidence");
  const pool = { query: async () => ({ rows: [{
    id: "44444444-4444-4444-8444-444444444444",
    title: "Evidence",
    original_file_name: "evidence.pdf",
    content_type: "application/pdf",
    file_size_bytes: body.length,
    checksum_sha256: createHash("sha256").update(body).digest("hex"),
    object_key: "private/evidence",
  }] }) };
  const storage = { configured: true, getObject: async () => ({ body }) };
  const result = await getAssignmentWorkfileFile(pool, storage, { assignmentFileId: 4 }, "44444444-4444-4444-8444-444444444444");
  assert.deepEqual(result.body, body);
  await assert.rejects(
    getAssignmentWorkfileFile(pool, { configured: true, getObject: async () => ({ body: Buffer.from("tampered") }) }, { assignmentFileId: 4 }, "44444444-4444-4444-8444-444444444444"),
    /workfile_file_integrity_failed/,
  );
});

const itemId = "44444444-4444-4444-8444-444444444444";
const uadWorkfileId = "33333333-3333-4333-8333-333333333333";
const transactionStages = ["BEGIN", "lock", "write", "COMMIT"];

function itemTransactionFixture({
  failureStage, primaryError = new Error("private primary database detail"), primaryThrows = false,
  rollbackMode = "resolve", beforeRollback = () => undefined, releaseError,
  ownership = "owned", uad = false, locked = false, missingScope = false, missingItem = false,
  storageDeleteMode = "resolve", putError,
} = {}) {
  const events = [], statements = [], releases = [], uploaded = [], deleted = [];
  const rollbackError = new Error("private rollback connection detail");
  const storageError = new Error("private object cleanup detail");
  const scope = uad ? { uadWorkfileId } : { assignmentFileId: 41 };
  let connections = 0;
  const client = {
    query(sql, params) {
      const stage = ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ? sql
        : sql.includes("FROM appraisal.uad_signatures") ? "signatures"
          : sql.includes("FROM app.custom_appraisal_workfiles") || sql.includes("FROM appraisal.uad_workfiles") ? "lock"
            : sql.includes("INSERT INTO app.assignment_workfile_items") ? "write"
              : sql.includes("DELETE FROM app.assignment_workfile_items") ? "delete" : null;
      assert.ok(stage, `unexpected workfile item SQL: ${sql}`);
      statements.push({ stage, sql, params });
      events.push(stage);
      if (stage === "ROLLBACK") {
        if (rollbackMode === "throw") throw rollbackError;
        return Promise.resolve(beforeRollback()).then(() => {
          if (rollbackMode === "reject") throw rollbackError;
          return { rows: [] };
        });
      }
      if (stage === failureStage) {
        if (primaryThrows) throw primaryError;
        return Promise.reject(primaryError);
      }
      if (stage === "lock") return Promise.resolve({ rows: missingScope ? [] : uad
        ? [{ id: uadWorkfileId, status: "ready", signed_at: null }]
        : [{ assignment_file_id: 41, status: locked ? "signed" : "draft" }] });
      if (stage === "signatures") return Promise.resolve({ rows: [{ has_signatures: locked }] });
      if (stage === "delete") return Promise.resolve({ rows: missingItem ? [] : [{ id: itemId, item_type: "file", object_key: "private/retained-item" }] });
      if (stage === "write") {
        const file = sql.includes("'file'");
        return Promise.resolve({ rows: [{
          id: params[0], item_type: file ? "file" : "link", title: params[4],
          original_file_name: file ? params[5] : null, content_type: file ? params[6] : null,
          file_size_bytes: file ? params[7] : null, checksum_sha256: file ? params[8] : null,
          external_url: file ? null : params[5], created_by_user_id: file ? params[10] : params[6],
        }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release(reason) {
      events.push("release"); releases.push(reason);
      if (releaseError !== undefined) throw releaseError;
    },
  };
  const connect = async () => {
    connections += 1; events.push("connect");
    if (failureStage === "connect") throw primaryError;
    return client;
  };
  const pool = ownership === "owned" ? { connect } : client;
  if (ownership === "self") client.connect = connect;
  const storage = {
    configured: true,
    async putObject(input) {
      events.push("put"); uploaded.push(input);
      if (putError !== undefined) throw putError;
    },
    deleteObject(input) {
      events.push("storage delete"); deleted.push(input);
      if (storageDeleteMode === "throw") throw storageError;
      return storageDeleteMode === "reject" ? Promise.reject(storageError) : Promise.resolve();
    },
  };
  const input = { organizationId, title: "Evidence", createdByUserId: "22222222-2222-4222-8222-222222222222" };
  return {
    events, statements, releases, uploaded, deleted, primaryError, rollbackError, storageError,
    get connections() { return connections; },
    run(operation = "link") {
      if (operation === "state") return getAssignmentWorkfileScopeState(pool, scope);
      if (operation === "delete") return deleteAssignmentWorkfileItem(pool, storage, scope, itemId);
      if (operation === "file") return createAssignmentWorkfileFile(pool, storage, scope, {
        ...input, fileName: "evidence.txt", contentType: "text/plain", content: Buffer.from("synthetic workfile evidence"),
      });
      return createAssignmentWorkfileLink(pool, scope, { ...input, externalUrl: "https://example.test/evidence" });
    },
  };
}

function assertItemRelease(fixture, discarded) {
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.releases.length, 1);
  const [reason] = fixture.releases;
  if (!discarded) return assert.equal(reason, undefined);
  assert.ok(reason instanceof Error);
  assert.equal(reason.message, "assignment_workfile_item_rollback_failed");
  assert.equal(Object.hasOwn(reason, "cause"), false);
  assert.deepEqual(Object.keys(reason), []);
  assert.equal(reason.stack.includes("private"), false);
  assert.notEqual(reason, fixture.primaryError);
  assert.notEqual(reason, fixture.rollbackError);
}

for (const failureStage of transactionStages) {
  for (const rollbackMode of ["resolve", "reject", "throw"]) {
    test(`workfile item ${failureStage} failure preserves its primary error when rollback ${rollbackMode}s`, async () => {
      const fixture = itemTransactionFixture({ failureStage, rollbackMode });
      await assert.rejects(fixture.run(), error => error === fixture.primaryError);
      assert.deepEqual(fixture.events, ["connect", ...transactionStages.slice(0, transactionStages.indexOf(failureStage) + 1), "ROLLBACK", "release"]);
      assertItemRelease(fixture, rollbackMode !== "resolve");
    });
  }
}

for (const operation of ["state", "link", "file", "delete"]) {
  test(`owned workfile ${operation} success commits and releases once with its original result`, async () => {
    const fixture = itemTransactionFixture();
    const result = await fixture.run(operation);
    assert.deepEqual(fixture.events, [
      ...(operation === "file" ? ["put"] : []), "connect", "BEGIN", "lock",
      ...(operation === "state" ? [] : [operation === "delete" ? "delete" : "write"]), "COMMIT", "release",
      ...(operation === "delete" ? ["storage delete"] : []),
    ]);
    if (operation === "state") assert.deepEqual(result, { mutable: true });
    else if (operation === "delete") {
      assert.deepEqual(result, { id: itemId });
      assert.deepEqual(fixture.deleted, [{ objectKey: "private/retained-item" }]);
    } else {
      const write = fixture.statements.find(statement => statement.stage === "write");
      assert.equal(result.id, write.params[0]);
      assert.equal(result.item_type, operation);
      assert.equal(result.created_by_user_id, "22222222-2222-4222-8222-222222222222");
      assert.deepEqual(write.params.slice(1, 4), [organizationId, 41, null]);
      if (operation === "file") {
        assert.equal(write.params[9], fixture.uploaded[0].objectKey);
        assert.equal(result.checksum_sha256, createHash("sha256").update(fixture.uploaded[0].body).digest("hex"));
        assert.deepEqual(fixture.deleted, []);
      } else assert.equal(result.external_url, "https://example.test/evidence");
    }
    assertItemRelease(fixture, false);
  });

  test(`workfile ${operation} acquisition failure never cleans up an unowned client`, async () => {
    const fixture = itemTransactionFixture({ failureStage: "connect" });
    await assert.rejects(fixture.run(operation), error => error === fixture.primaryError);
    assert.deepEqual(fixture.events, operation === "file" ? ["put", "connect", "storage delete"] : ["connect"]);
    assert.deepEqual(fixture.statements, []);
    assert.deepEqual(fixture.releases, []);
    if (operation === "file") assert.deepEqual(fixture.deleted, [{ objectKey: fixture.uploaded[0].objectKey }]);
  });
}

for (const ownership of ["borrowed", "self"]) {
  test(`workfile operations leave ${ownership === "self" ? "connect-returning-itself" : "borrowed"} queryable transactions and release ownership unchanged`, async () => {
    for (const operation of ["state", "link", "file", "delete"]) {
      for (const fails of [false, true]) {
        const failureStage = fails ? operation === "state" ? "lock" : operation === "delete" ? "delete" : "write" : undefined;
        const fixture = itemTransactionFixture({ ownership, failureStage });
        if (fails) await assert.rejects(fixture.run(operation), error => error === fixture.primaryError);
        else await fixture.run(operation);
        assert.equal(fixture.connections, ownership === "self" ? 1 : 0);
        assert.deepEqual(fixture.releases, []);
        assert.deepEqual(fixture.statements.map(statement => statement.stage), ["lock", ...(operation === "state" ? [] : [operation === "delete" ? "delete" : "write"])]);
      }
    }
  });
}

test("workfile synchronous non-Error operation failures retain exact identity after cleanup", async () => {
  for (const primaryError of [Symbol("primary failure"), Object.freeze({ private: "primary detail" }), null]) {
    for (const rollbackMode of ["resolve", "reject"]) {
      const fixture = itemTransactionFixture({ failureStage: "write", primaryError, primaryThrows: true, rollbackMode });
      await assert.rejects(fixture.run(), error => error === primaryError);
      assert.deepEqual(fixture.events, ["connect", "BEGIN", "lock", "write", "ROLLBACK", "release"]);
      assertItemRelease(fixture, rollbackMode !== "resolve");
    }
  }
});

for (const outcome of [
  { label: "COMMIT" },
  { label: "successful rollback", failureStage: "write" },
  { label: "failed rollback", failureStage: "write", rollbackMode: "reject" },
]) {
  test(`workfile release exceptions retain exact precedence after ${outcome.label}`, async () => {
    for (const releaseError of [new Error("release failed"), Symbol("release failed"), Object.freeze({ release: "failed" })]) {
      const fixture = itemTransactionFixture({ ...outcome, releaseError });
      await assert.rejects(fixture.run(), error => error === releaseError);
      assert.deepEqual(fixture.events, ["connect", "BEGIN", "lock", "write", outcome.failureStage ? "ROLLBACK" : "COMMIT", "release"]);
      assertItemRelease(fixture, outcome.rollbackMode === "reject");
    }
  });
}

for (const rollbackMode of ["resolve", "reject"]) {
  test(`file cleanup waits for rollback to ${rollbackMode} and client release before storage compensation`, async () => {
    let finishRollback;
    const gate = new Promise(resolve => { finishRollback = resolve; });
    const fixture = itemTransactionFixture({ failureStage: "write", rollbackMode, beforeRollback: () => gate });
    let settled = false;
    const pending = fixture.run("file").then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(fixture.events, ["put", "connect", "BEGIN", "lock", "write", "ROLLBACK"]);
      assert.deepEqual(fixture.releases, []);
      assert.deepEqual(fixture.deleted, []);
      assert.equal(settled, false);
      finishRollback();
      assert.equal((await pending).error, fixture.primaryError);
      assert.deepEqual(fixture.events, ["put", "connect", "BEGIN", "lock", "write", "ROLLBACK", "release", "storage delete"]);
      assert.deepEqual(fixture.deleted, [{ objectKey: fixture.uploaded[0].objectKey }]);
      assertItemRelease(fixture, rollbackMode === "reject");
    } finally {
      finishRollback();
      await pending;
    }
  });
}

test("file COMMIT failures compensate only the staged object after final cleanup", async () => {
  for (const rollbackMode of ["resolve", "reject"]) {
    const fixture = itemTransactionFixture({ failureStage: "COMMIT", rollbackMode });
    await assert.rejects(fixture.run("file"), error => error === fixture.primaryError);
    assert.deepEqual(fixture.events, ["put", "connect", "BEGIN", "lock", "write", "COMMIT", "ROLLBACK", "release", "storage delete"]);
    assert.deepEqual(fixture.deleted, [{ objectKey: fixture.uploaded[0].objectKey }]);
    assertItemRelease(fixture, rollbackMode === "reject");
  }
});

test("a file storage PUT failure neither acquires a client nor attempts compensation", async () => {
  const putError = new Error("put failed");
  const fixture = itemTransactionFixture({ putError });
  await assert.rejects(fixture.run("file"), error => error === putError);
  assert.deepEqual(fixture.events, ["put"]);
  assert.equal(fixture.connections, 0);
  assert.deepEqual(fixture.deleted, []);
});

test("file compensation preserves existing rejection and synchronous storage-error precedence", async () => {
  for (const storageDeleteMode of ["reject", "throw"]) {
    const fixture = itemTransactionFixture({ failureStage: "write", rollbackMode: "reject", storageDeleteMode });
    await assert.rejects(fixture.run("file"), error => error === (storageDeleteMode === "throw" ? fixture.storageError : fixture.primaryError));
    assert.deepEqual(fixture.events.slice(-3), ["ROLLBACK", "release", "storage delete"]);
    assert.deepEqual(fixture.deleted, [{ objectKey: fixture.uploaded[0].objectKey }]);
    assertItemRelease(fixture, true);
  }
  const releaseError = new Error("release failed after commit");
  const fixture = itemTransactionFixture({ releaseError, storageDeleteMode: "reject" });
  await assert.rejects(fixture.run("file"), error => error === releaseError);
  assert.deepEqual(fixture.events, ["put", "connect", "BEGIN", "lock", "write", "COMMIT", "release", "storage delete"]);
  assert.deepEqual(fixture.deleted, [{ objectKey: fixture.uploaded[0].objectKey }]);
  assertItemRelease(fixture, false);
});

test("failed database deletion or COMMIT never deletes stored workfile bytes", async () => {
  for (const failureStage of ["delete", "COMMIT"]) {
    for (const rollbackMode of ["resolve", "reject"]) {
      const fixture = itemTransactionFixture({ failureStage, rollbackMode });
      await assert.rejects(fixture.run("delete"), error => error === fixture.primaryError);
      assert.deepEqual(fixture.events, ["connect", "BEGIN", "lock", "delete", ...(failureStage === "COMMIT" ? ["COMMIT"] : []), "ROLLBACK", "release"]);
      assert.deepEqual(fixture.deleted, []);
      assertItemRelease(fixture, rollbackMode === "reject");
    }
  }
});

test("successful deletion keeps storage cleanup after release and preserves cleanup-error precedence", async () => {
  for (const storageDeleteMode of ["reject", "throw"]) {
    const fixture = itemTransactionFixture({ storageDeleteMode });
    if (storageDeleteMode === "throw") await assert.rejects(fixture.run("delete"), error => error === fixture.storageError);
    else assert.deepEqual(await fixture.run("delete"), { id: itemId });
    assert.deepEqual(fixture.events, ["connect", "BEGIN", "lock", "delete", "COMMIT", "release", "storage delete"]);
    assertItemRelease(fixture, false);
  }
  const releaseError = new Error("release failed after deletion");
  const fixture = itemTransactionFixture({ releaseError });
  await assert.rejects(fixture.run("delete"), error => error === releaseError);
  assert.deepEqual(fixture.events, ["connect", "BEGIN", "lock", "delete", "COMMIT", "release"]);
  assert.deepEqual(fixture.deleted, []);
  assertItemRelease(fixture, false);
});

for (const uad of [false, true]) {
  test(`${uad ? "UAD effective signature" : "Custom signed"} guards preserve scope state and prevent writes even if cleanup fails`, async () => {
    for (const rollbackMode of ["resolve", "reject"]) {
      const state = itemTransactionFixture({ uad, locked: true, rollbackMode });
      assert.deepEqual(await state.run("state"), { mutable: false });
      assert.deepEqual(state.events, ["connect", "BEGIN", "lock", ...(uad ? ["signatures"] : []), "ROLLBACK", "release"]);
      assertItemRelease(state, rollbackMode === "reject");
      const file = itemTransactionFixture({ uad, locked: true, rollbackMode });
      await assert.rejects(file.run("file"), { message: uad ? "uad_workfile_status_locked" : "assignment_workfile_status_locked" });
      assert.deepEqual(file.events, ["put", "connect", "BEGIN", "lock", ...(uad ? ["signatures"] : []), "ROLLBACK", "release", "storage delete"]);
      assert.deepEqual(file.deleted, [{ objectKey: file.uploaded[0].objectKey }]);
      assertItemRelease(file, rollbackMode === "reject");
    }
  });
}

test("missing scopes and items preserve domain errors through failed rollback", async () => {
  for (const [options, operation, message] of [
    [{ missingScope: true }, "link", "assignment_workfile_not_found"],
    [{ missingScope: true, uad: true }, "link", "uad_workfile_not_found"],
    [{ missingItem: true }, "delete", "workfile_item_not_found"],
  ]) {
    const fixture = itemTransactionFixture({ ...options, rollbackMode: "reject" });
    await assert.rejects(fixture.run(operation), { message });
    assert.deepEqual(fixture.events.slice(-2), ["ROLLBACK", "release"]);
    assert.deepEqual(fixture.deleted, []);
    assertItemRelease(fixture, true);
  }
});
