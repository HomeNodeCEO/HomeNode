import assert from "node:assert/strict";
import test from "node:test";

import { createUadAssetUpload } from "../src/modules/uad/assets.js";

const WORKFILE_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const UPLOAD_INPUT = Object.freeze({
  asset_kind: "photo",
  content_type: "image/jpeg",
  file_name: "subject-front.jpg",
  byte_size: 1_024,
});

function normalizeSql(sql) {
  return String(sql).trim().replace(/\s+/g, " ");
}

function uploadHarness({
  workfile = {
    id: WORKFILE_ID,
    organization_id: ORGANIZATION_ID,
    status: "draft",
    signed_at: null,
  },
  signatureResult = { rows: [{ has_signatures: false }] },
  signatureError = null,
  uploadError = null,
  insertError = null,
  emptyInsert = false,
  commitError = null,
  rollbackError = null,
} = {}) {
  const statements = [];
  const storageCalls = [];
  const mutationQueries = [];
  let connectCount = 0;
  let releaseCount = 0;

  const query = async (owner, sql, parameters = []) => {
    const statement = normalizeSql(sql);
    statements.push({ owner, statement, parameters });

    if (owner === "pool" && connectCount > 0) {
      throw new Error(`pool_query_after_connect:${statement}`);
    }

    if (statement === "BEGIN" || statement === "BEGIN ISOLATION LEVEL READ COMMITTED") {
      return { rows: [] };
    }
    if (
      /^SELECT id, organization_id, status(?:, signed_at)? FROM appraisal\.uad_workfiles WHERE id = \$1(?: FOR UPDATE)?$/.test(statement)
    ) {
      assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: workfile == null ? [] : [workfile] };
    }
    if (
      /^SELECT EXISTS \( SELECT 1 FROM appraisal\.uad_signatures WHERE workfile_id = \$1 \) AS has_signatures$/.test(statement)
    ) {
      assert.deepEqual(parameters, [WORKFILE_ID]);
      if (signatureError) throw signatureError;
      return signatureResult;
    }
    if (
      statement.startsWith("WITH mutable_workfile AS (")
      && statement.includes("INSERT INTO appraisal.uad_assets")
      && statement.endsWith("SELECT id FROM inserted_asset")
    ) {
      assert.equal(parameters.length, 14);
      assert.equal(parameters[1], WORKFILE_ID);
      assert.equal(parameters[3], UPLOAD_INPUT.asset_kind);
      assert.equal(parameters[10], UPLOAD_INPUT.file_name);
      assert.equal(parameters[11], UPLOAD_INPUT.content_type);
      mutationQueries.push({ statement, parameters });
      if (insertError) throw insertError;
      return { rows: emptyInsert ? [] : [{ id: parameters[0] }] };
    }
    if (statement === "SELECT status FROM appraisal.uad_workfiles WHERE id = $1") {
      assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: workfile == null ? [] : [{ status: workfile.status }] };
    }
    if (statement === "COMMIT") {
      if (commitError) throw commitError;
      return { rows: [] };
    }
    if (statement === "ROLLBACK") {
      if (rollbackError) throw rollbackError;
      return { rows: [] };
    }
    throw new Error(`unexpected_sql:${statement}`);
  };

  const client = {
    query(sql, parameters) {
      return query("client", sql, parameters);
    },
    release() {
      releaseCount += 1;
      statements.push({ owner: "client", statement: "RELEASE", parameters: [] });
    },
  };
  const pool = {
    query(sql, parameters) {
      return query("pool", sql, parameters);
    },
    async connect() {
      connectCount += 1;
      return client;
    },
  };
  const storage = {
    provider: "synthetic",
    bucket: "synthetic-private-bucket",
    createUploadUrl({ objectKey, contentType }) {
      storageCalls.push({ objectKey, contentType });
      if (uploadError) throw uploadError;
      return {
        url: "https://upload.invalid/synthetic",
        method: "PUT",
        headers: { "content-type": contentType },
        expires_in_seconds: 900,
      };
    },
  };

  return {
    pool,
    storage,
    statements,
    storageCalls,
    mutationQueries,
    get connectCount() { return connectCount; },
    get releaseCount() { return releaseCount; },
  };
}

function statementIndex(harness, predicate) {
  return harness.statements.findIndex(({ statement }) => predicate(statement));
}

function assertOnlyClientQueries(harness) {
  assert.equal(
    harness.statements.every(({ owner }) => owner === "client"),
    true,
    "all queries after pool.connect must use the owned client",
  );
}

function assertLockedTransaction(harness, { signatureChecked }) {
  assert.equal(harness.connectCount, 1);
  assertOnlyClientQueries(harness);
  assert.equal(harness.statements[0]?.statement, "BEGIN ISOLATION LEVEL READ COMMITTED");
  const workfileLock = statementIndex(
    harness,
    (statement) => /^SELECT id, organization_id, status, signed_at [\s\S]+ FOR UPDATE$/.test(statement),
  );
  assert.ok(workfileLock > 0, "creation must lock fresh lifecycle metadata");
  const signatureCheck = statementIndex(harness, (statement) => statement.includes("AS has_signatures"));
  if (signatureChecked) {
    assert.ok(signatureCheck > workfileLock, "signature state must be read after the workfile lock");
  } else {
    assert.equal(signatureCheck, -1);
  }
  assert.ok(
    harness.statements.some(({ statement }) => statement === "ROLLBACK"),
    "a refused creation must roll back",
  );
  const rollback = statementIndex(harness, (statement) => statement === "ROLLBACK");
  const release = statementIndex(harness, (statement) => statement === "RELEASE");
  assert.ok(release > rollback, "the owned client must be released after rollback");
  assert.equal(harness.releaseCount, 1);
}

async function assertUploadRefused(
  options,
  expectedError = /uad_workfile_status_locked/,
  { signatureChecked = false } = {},
) {
  const harness = uploadHarness(options);
  await assert.rejects(
    () => createUadAssetUpload(
      harness.pool,
      harness.storage,
      WORKFILE_ID,
      UPLOAD_INPUT,
    ),
    expectedError,
  );
  assert.deepEqual(harness.storageCalls, []);
  assert.deepEqual(harness.mutationQueries, []);
  assertLockedTransaction(harness, { signatureChecked });
  return harness;
}

async function captureUpload(harness) {
  let result;
  let error;
  try {
    result = await createUadAssetUpload(
      harness.pool,
      harness.storage,
      WORKFILE_ID,
      UPLOAD_INPUT,
    );
  } catch (caught) {
    error = caught;
  }
  return { result, error };
}

test("asset upload creation preserves every explicitly unsigned mutable workflow", async () => {
  for (const status of ["draft", "validating", "ready", "revised"]) {
    const harness = uploadHarness({
      workfile: {
        id: WORKFILE_ID,
        organization_id: ORGANIZATION_ID,
        status,
        signed_at: null,
      },
    });
    const result = await createUadAssetUpload(
      harness.pool,
      harness.storage,
      WORKFILE_ID,
      UPLOAD_INPUT,
    );

    assert.match(result.asset_id, /^[0-9a-f-]{36}$/);
    assert.equal(result.asset_id, harness.mutationQueries[0]?.parameters[0]);
    assert.equal(harness.storageCalls.length, 1);
    assert.equal(harness.storageCalls[0].contentType, UPLOAD_INPUT.content_type);
    assert.match(harness.storageCalls[0].objectKey, new RegExp(`/${WORKFILE_ID}/assets/${result.asset_id}/subject-front\\.jpg$`));
    assert.equal(harness.mutationQueries.length, 1);

    assert.equal(harness.connectCount, 1);
    assertOnlyClientQueries(harness);
    assert.equal(harness.statements[0]?.statement, "BEGIN ISOLATION LEVEL READ COMMITTED");
    const workfileLock = statementIndex(
      harness,
      (statement) => /^SELECT id, organization_id, status, signed_at [\s\S]+ FOR UPDATE$/.test(statement),
    );
    const signatureCheck = statementIndex(harness, (statement) => statement.includes("AS has_signatures"));
    const insertion = statementIndex(harness, (statement) => statement.includes("INSERT INTO appraisal.uad_assets"));
    const commit = statementIndex(harness, (statement) => statement === "COMMIT");
    const release = statementIndex(harness, (statement) => statement === "RELEASE");
    assert.ok(workfileLock > 0);
    assert.ok(signatureCheck > workfileLock);
    assert.ok(insertion > signatureCheck);
    assert.ok(commit > insertion);
    assert.ok(release > commit);
    assert.equal(harness.statements.some(({ statement }) => statement === "ROLLBACK"), false);
    assert.equal(harness.releaseCount, 1);
    assert.equal(harness.statements.at(-1)?.statement, "RELEASE");
  }
});

test("asset upload creation preserves terminal-status refusals before storage or mutation", async () => {
  for (const status of ["signed", "exported", "submitted", "cancelled", "", null, undefined, 0, false, {}, "unknown"]) {
    await assertUploadRefused({
      workfile: {
        id: WORKFILE_ID,
        organization_id: ORGANIZATION_ID,
        status,
        signed_at: null,
      },
    });
  }
});

test("asset upload creation rejects a missing workfile inside the owned transaction", async () => {
  await assertUploadRefused(
    { workfile: null },
    /uad_workfile_not_found/,
  );
});

test("asset upload creation refuses signed_at or missing timestamp evidence before signing a URL", async () => {
  for (const workfile of [
    { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "ready", signed_at: "2026-09-05T12:00:00.000Z" },
    { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "revised", signed_at: "2026-09-04T12:00:00.000Z" },
    { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "draft" },
    { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "validating", signed_at: undefined },
    { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "draft", signed_at: false },
    { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "draft", signed_at: 0 },
    { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "draft", signed_at: "" },
  ]) {
    await assertUploadRefused({ workfile });
  }
});

test("asset upload creation refuses partial and historical signatures before signing a URL", async () => {
  for (const status of ["ready", "revised"]) {
    await assertUploadRefused({
      workfile: {
        id: WORKFILE_ID,
        organization_id: ORGANIZATION_ID,
        status,
        signed_at: null,
      },
      signatureResult: { rows: [{ has_signatures: true }] },
    }, /uad_workfile_status_locked/, { signatureChecked: true });
  }
});

test("asset upload creation fails closed on malformed signature query results", async () => {
  const malformedResults = [
    null,
    {},
    { rows: [] },
    { rows: [{}] },
    { rows: [{ has_signatures: false }, { has_signatures: false }] },
    { rows: { 0: { has_signatures: false }, length: 1 } },
    { rows: [{ has_signatures: "false" }] },
    { rows: [{ has_signatures: null }] },
  ];
  for (const signatureResult of malformedResults) {
    await assertUploadRefused(
      { signatureResult },
      /uad_workfile_status_locked/,
      { signatureChecked: true },
    );
  }
});

test("asset upload creation rolls back a signature-query failure before storage access", async () => {
  const signatureError = new Error("uad_signature_query_failed");
  await assertUploadRefused(
    { signatureError },
    signatureError,
    { signatureChecked: true },
  );
});

test("asset upload creation preserves local failure identities and never returns an upload capability", async () => {
  const cases = [
    {
      label: "URL signing",
      options: { uploadError: new Error("uad_upload_url_signing_failed") },
      expectedStorageCalls: 1,
      expectedMutationQueries: 0,
    },
    {
      label: "asset insertion",
      options: { insertError: new Error("uad_asset_insert_failed") },
      expectedStorageCalls: 1,
      expectedMutationQueries: 1,
    },
    {
      label: "transaction commit",
      options: { commitError: new Error("uad_asset_commit_failed") },
      expectedStorageCalls: 1,
      expectedMutationQueries: 1,
    },
  ];

  for (const scenario of cases) {
    const harness = uploadHarness(scenario.options);
    const outcome = await captureUpload(harness);
    assert.equal(outcome.result, undefined, `${scenario.label} failure returned a capability`);
    assert.equal(outcome.error, Object.values(scenario.options)[0]);
    assert.equal(harness.storageCalls.length, scenario.expectedStorageCalls);
    assert.equal(harness.mutationQueries.length, scenario.expectedMutationQueries);
    assertLockedTransaction(harness, { signatureChecked: true });
  }
});

test("asset upload creation treats an empty insertion as failure and returns no capability", async () => {
  const harness = uploadHarness({ emptyInsert: true });
  const outcome = await captureUpload(harness);
  assert.equal(outcome.result, undefined);
  assert.match(outcome.error?.message || "", /uad_asset_not_found/);
  assert.equal(harness.storageCalls.length, 1);
  assert.equal(harness.mutationQueries.length, 1);
  assertLockedTransaction(harness, { signatureChecked: true });
});

test("asset upload creation preserves the original error when rollback also fails", async () => {
  const signatureError = new Error("uad_signature_query_failed");
  const rollbackError = new Error("uad_asset_upload_rollback_failed");
  const harness = uploadHarness({ signatureError, rollbackError });
  const outcome = await captureUpload(harness);

  assert.equal(outcome.result, undefined);
  assert.equal(outcome.error, signatureError);
  assert.deepEqual(harness.storageCalls, []);
  assert.deepEqual(harness.mutationQueries, []);
  assertLockedTransaction(harness, { signatureChecked: true });
});
