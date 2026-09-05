import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prepareNeighborhoodCiDatabase } from "./helpers/neighborhoodCiDatabase.js";

const databaseUrl = process.env.DATABASE_URL;
const LOCKED_ERROR = "uad_workfile_status_locked";
const READ_COMMITTED_BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function within(promise, label, milliseconds = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function statementOf(config) {
  return String(typeof config === "string" ? config : config?.text || "").replace(/\s+/g, " ").trim();
}

function fixedObservedPool(client, { before, after } = {}) {
  let connected = false;
  let released = false;
  const trace = [];
  return {
    trace,
    pool: {
      async connect() {
        assert.equal(connected, false, "the writer must acquire its one dedicated test client once");
        connected = true;
        return {
          async query(config, values) {
            const statement = statementOf(config);
            trace.push(statement);
            await before?.(statement, client, values);
            const result = await client.query(config, values);
            await after?.(statement, client, result);
            return result;
          },
          release() {
            if (!released) {
              released = true;
              // The test deliberately changes this session's default isolation.
              // Destroy it instead of returning contaminated state to the pool.
              client.release(true);
            }
          },
        };
      },
    },
    forceRelease() {
      if (!released) {
        released = true;
        client.release(true);
      }
    },
  };
}

async function assertBlockedBy(pool, blockedPid, blockerPid, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      "SELECT pg_blocking_pids($1::integer) AS blocking_pids",
      [blockedPid],
    );
    if (rows[0]?.blocking_pids?.includes(blockerPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${label} did not acquire a real PostgreSQL lock wait`);
}

async function canonicalState(pool, workfileId) {
  const [workfile, values, entities, assets, revisions, audit, sketches, sketchHistory] = await Promise.all([
    pool.query(
      `SELECT current_revision, status, signed_at, updated_at
         FROM appraisal.uad_workfiles WHERE id = $1`,
      [workfileId],
    ),
    pool.query(
      `SELECT id, entity_id, field_context, uad_uid, report_field_id, value,
              source_type, source_reference, is_appraiser_confirmed, is_override,
              override_reason, updated_by_user_id, created_at, updated_at
         FROM appraisal.uad_field_values WHERE workfile_id = $1 ORDER BY id`,
      [workfileId],
    ),
    pool.query(
      `SELECT id, parent_entity_id, entity_type, entity_identifier, ordinal, label, data,
              created_at, updated_at
         FROM appraisal.uad_entities WHERE workfile_id = $1 ORDER BY id`,
      [workfileId],
    ),
    pool.query(
      `SELECT id, asset_kind, storage_provider, storage_bucket, object_key, status,
              checksum_sha256, byte_size, capture_metadata, created_at, updated_at
         FROM appraisal.uad_assets WHERE workfile_id = $1 ORDER BY id`,
      [workfileId],
    ),
    pool.query(
      `SELECT id, revision_number, specification_release_key, document, change_summary,
              created_by_user_id, created_at
         FROM appraisal.uad_revisions WHERE workfile_id = $1 ORDER BY revision_number, id`,
      [workfileId],
    ),
    pool.query(
      `SELECT id, actor_user_id, event_type, entity_type, entity_id,
              before_data, after_data, request_id, occurred_at, metadata
         FROM appraisal.uad_audit_events WHERE workfile_id = $1 ORDER BY id`,
      [workfileId],
    ),
    pool.query(
      `SELECT id, entity_id, schema_version, geometry, measurements, calculated_areas,
              area_overrides, rendered_asset_id, source, created_by_user_id,
              updated_by_user_id, revision, created_at, updated_at
         FROM appraisal.uad_sketches WHERE workfile_id = $1 ORDER BY id`,
      [workfileId],
    ),
    pool.query(
      `SELECT id, sketch_id, workfile_id, revision, geometry, measurements,
              calculated_areas, area_overrides, rendered_asset_id, source,
              changed_by_user_id, change_source, changed_at
         FROM appraisal.uad_sketch_history WHERE workfile_id = $1 ORDER BY id`,
      [workfileId],
    ),
  ]);
  return JSON.parse(JSON.stringify({
    workfile: workfile.rows,
    values: values.rows,
    entities: entities.rows,
    assets: assets.rows,
    revisions: revisions.rows,
    audit: audit.rows,
    sketches: sketches.rows,
    sketchHistory: sketchHistory.rows,
  }));
}

async function createIdentityFixture(pool, customAppraisalReportFixture) {
  const actorUserId = randomUUID();
  const accountId = `L${randomUUID().replaceAll("-", "").slice(0, 31)}`;
  const appraisalCaseId = randomUUID();
  const subjectSnapshotId = randomUUID();
  const customReportId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO app_auth.users (id, email, display_name) VALUES ($1, $2, 'Synthetic lifecycle signer')",
      [actorUserId, `${actorUserId}@example.test`],
    );
    await client.query(
      `INSERT INTO core.accounts (
         account_id, county, address, city, postal_code, neighborhood_code,
         subdivision, legal_description
       ) VALUES ($1, 'Synthetic County', '100 Lifecycle Way', 'Dallas', '75201',
         'SYNTHETIC', 'Synthetic Addition', 'SYNTHETIC TEST ONLY')`,
      [accountId],
    );
    await client.query(
      `INSERT INTO core.primary_improvements (
         account_id, year_built, living_area_sqft, bedroom_count, bath_count, number_units
       ) VALUES ($1, 2001, 1800, 3, 2, 1)`,
      [accountId],
    );
    await client.query(
      `INSERT INTO app.appraisal_cases (
         id, account_id, effective_date, inspection_date, created_by_user_id
       ) VALUES ($1, $2, DATE '2026-09-05', DATE '2026-09-04', $3)`,
      [appraisalCaseId, accountId, actorUserId],
    );
    await client.query(
      `INSERT INTO app.appraisal_subject_snapshots (
         id, appraisal_case_id, snapshot_version, effective_date, subject_data, created_by_user_id
       ) VALUES ($1, $2, 1, DATE '2026-09-05', '{"synthetic":true}'::jsonb, $3)`,
      [subjectSnapshotId, appraisalCaseId, actorUserId],
    );
    const assignment = await client.query(
      `INSERT INTO app.assignment_files (
         account_id, file_number, assignment_details, created_by_user_id
       ) VALUES ($1, $2, '{"assignment_types":["purchase_transaction"]}'::jsonb, $3)
       RETURNING id`,
      [accountId, `CUSTOM-LOCK-${randomUUID()}`, actorUserId],
    );
    const assignmentId = assignment.rows[0].id;
    await client.query(
      `INSERT INTO app.custom_appraisal_workfiles (assignment_file_id, canonical_file_name)
       VALUES ($1, $2)`,
      [assignmentId, `synthetic-${assignmentId}.homenode-appraisal.json`],
    );
    await client.query(
      `INSERT INTO app.report_files (
         id, account_id, workflow_type, file_number, custom_assignment_file_id,
         is_current, registry_revision, appraisal_case_id, subject_snapshot_id,
         created_by_user_id
       ) VALUES ($1, $2, 'custom_appraisal', $3, $4, true, 1, $5, $6, $7)`,
      [customReportId, accountId, `CUSTOM-LOCK-${randomUUID()}`, assignmentId,
        appraisalCaseId, subjectSnapshotId, actorUserId],
    );
    const report = customAppraisalReportFixture();
    for (const [sectionKey, section] of Object.entries(report.snapshot.sections)) {
      await client.query(
        `INSERT INTO app.custom_appraisal_workfile_sections (
           assignment_file_id, section_key, section_value, revision
         ) VALUES ($1, $2, $3::jsonb, $4)`,
        [assignmentId, sectionKey, JSON.stringify(section.value), section.revision],
      );
    }
    await client.query("COMMIT");
    return { actorUserId, accountId, appraisalCaseId, subjectSnapshotId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function createWorkfileFixture(pool, identity, { status = "draft", revision = 1 } = {}) {
  const workfileId = randomUUID();
  const reportFileId = randomUUID();
  const release = await pool.query(
    `SELECT release_key FROM uad_ref.specification_releases
      WHERE status = 'current' ORDER BY released_on DESC, release_key LIMIT 1`,
  );
  const releaseKey = release.rows[0]?.release_key;
  assert.ok(releaseKey, "ordinary UAD migrations must seed the current release");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO appraisal.uad_workfiles (
         id, account_id, file_number, specification_release_key, status,
         current_revision, created_by_user_id, updated_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [workfileId, identity.accountId, `UAD-LOCK-${randomUUID()}`, releaseKey,
        status, revision, identity.actorUserId],
    );
    await client.query(
      `INSERT INTO app.report_files (
         id, account_id, workflow_type, file_number, uad_workfile_id,
         is_current, registry_revision, appraisal_case_id, subject_snapshot_id,
         created_by_user_id
       ) VALUES ($1, $2, 'uad_3_6', $3, $4, false, 1, $5, $6, $7)`,
      [reportFileId, identity.accountId, `UAD-LOCK-${randomUUID()}`, workfileId,
        identity.appraisalCaseId, identity.subjectSnapshotId, identity.actorUserId],
    );
    for (let revisionNumber = 1; revisionNumber <= revision; revisionNumber += 1) {
      await client.query(
        `INSERT INTO appraisal.uad_revisions (
           id, workfile_id, revision_number, specification_release_key,
           document, change_summary, created_by_user_id
         ) VALUES ($1, $2, $3, $4, $5::jsonb, 'Synthetic lifecycle baseline', $6)`,
        [randomUUID(), workfileId, revisionNumber, releaseKey,
          JSON.stringify({ synthetic: true, revision: revisionNumber }), identity.actorUserId],
      );
    }
    await client.query("COMMIT");
    return { workfileId, reportFileId, releaseKey, revision };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function insertSyntheticSignature(client, identity, workfile, revisionNumber = workfile.revision) {
  // This is deliberately only a signature-state transition under the exact
  // workfile lock used by production signing. It is not end-to-end coverage of
  // signUadWorkfile, credential validation, quorum, artifacts, or attestations.
  await client.query(
    `INSERT INTO appraisal.uad_signatures (
       id, workfile_id, revision_number, signer_user_id, signer_role,
       credential_snapshot, authentication_method
     ) VALUES ($1, $2, $3, $4, 'appraiser', '{"synthetic":true}'::jsonb, 'session')`,
    [randomUUID(), workfile.workfileId, revisionNumber, identity.actorUserId],
  );
}

function assertGuardFirst(trace) {
  assert.equal(trace[0], READ_COMMITTED_BEGIN);
  assert.match(trace[1], /^SELECT id, (current_revision, specification_release_key, )?status, signed_at FROM appraisal\.uad_workfiles/);
  assert.match(trace[1], /FOR UPDATE$/);
  const signatureIndex = trace.findIndex((statement) => statement.includes("FROM appraisal.uad_signatures"));
  const rollbackIndex = trace.indexOf("ROLLBACK");
  assert.ok(rollbackIndex > 1);
  if (signatureIndex >= 0) assert.ok(signatureIndex < rollbackIndex);
  const forbidden = trace.filter((statement) => (
    /appraisal\.(uad_field_values|uad_entities|uad_assets|uad_revisions|uad_audit_events|uad_sketches|uad_sketch_history)/.test(statement)
    || /app\.(report_files|custom_appraisal_workfile_sections)/.test(statement)
  ));
  assert.deepEqual(forbidden, [], "locked writers must reject before canonical/source reads or writes");
  assert.equal(trace.some((statement) => /^(INSERT|UPDATE|DELETE)\b/.test(statement)), false);
  assert.equal(trace.at(-1), "ROLLBACK");
}

test("UAD canonical writers honor immutable lifecycle and signature state in a disposable PostgreSQL database", {
  skip: !databaseUrl,
  timeout: 360_000,
}, async (t) => {
  // This guard creates a unique GitHub-CI-only loopback *_test child and runs
  // ordinary migrations before pg is imported. No shared/local database,
  // schema cleanup, DROP, provider, or production data is permitted.
  const target = await prepareNeighborhoodCiDatabase();
  const [
    { default: pg },
    { saveUadSection },
    { applyUadCompletionSuggestions },
    { loadUadCompletionSuggestions },
    { saveUadSketch },
    { customAppraisalReportFixture },
  ] = await Promise.all([
    import("pg"),
    import("../src/modules/uad/editor.js"),
    import("../src/modules/uad/completionApply.js"),
    import("../src/modules/uad/completionSuggestions.js"),
    import("../src/modules/uad/sketches.js"),
    import("./fixtures/customAppraisalReportFixture.js"),
  ]);
  const pool = new pg.Pool({
    connectionString: target.connectionString,
    max: 8,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 8_000,
    application_name: "uad_locked_lifecycle_integration",
  });

  try {
    const identity = await createIdentityFixture(pool, customAppraisalReportFixture);
    const sectionWrite = (writerPool, workfile) => saveUadSection(
      writerPool,
      workfile.workfileId,
      "assignment",
      {
        expected_revision: workfile.revision,
        save_reason: "autosave",
        values: [{ context_key: "assignment", uid: "1000.0158", value: "TraditionalAppraisal" }],
      },
      identity.actorUserId,
    );
    const completionWrite = (writerPool, workfile) => applyUadCompletionSuggestions(
      writerPool,
      workfile.workfileId,
      {
        expected_revision: workfile.revision,
        expected_source_digest_sha256: "a".repeat(64),
        expected_adapter_version: "synthetic-guard-must-run-first",
        selected_suggestion_ids: ["synthetic-guard-must-run-first"],
        preserve_existing: true,
        confirmed: true,
      },
      identity.actorUserId,
    );
    const sketchInput = {
      schema_version: "1.0",
      geometry: { rooms: [{ id: "synthetic-room", points: [[0, 0], [10, 0], [10, 12], [0, 12]] }] },
      measurements: { width: 10, length: 12 },
      calculated_areas: { gross_living_area: 120 },
      area_overrides: { reason: "Synthetic measured sketch" },
      source: "mobile",
      change_source: "synthetic_lifecycle_test",
    };
    const sketchWrite = (writerPool, workfile) => saveUadSketch(
      writerPool, workfile.workfileId,
      { ...sketchInput, expected_revision: 1 }, identity.actorUserId,
    );
    // Seed an actual sketch/history before exercising update refusal and races.
    // This does not involve storage publication or native mobile capture.
    const createWriterFixture = async (writerName, options = {}) => {
      const workfile = await createWorkfileFixture(pool, identity, {
        ...options, ...(writerName === "saveUadSketch" ? { status: "draft" } : {}),
      });
      if (writerName === "saveUadSketch") {
        await saveUadSketch(pool, workfile.workfileId, sketchInput, identity.actorUserId);
        await pool.query("UPDATE appraisal.uad_workfiles SET status = $2 WHERE id = $1",
          [workfile.workfileId, options.status || "draft"]);
      }
      return workfile;
    };
    const assertDenied = async (write, workfile) => {
      const before = await canonicalState(pool, workfile.workfileId);
      const observed = fixedObservedPool(await pool.connect());
      try {
        await assert.rejects(() => write(observed.pool, workfile), { message: LOCKED_ERROR });
        assertGuardFirst(observed.trace);
        assert.deepEqual(await canonicalState(pool, workfile.workfileId), before);
      } finally {
        observed.forceRelease();
      }
    };
    const writers = [
      ["saveUadSection", sectionWrite],
      ["applyUadCompletionSuggestions", completionWrite],
      ["saveUadSketch", sketchWrite],
    ];

    for (const [writerName, write] of writers) {
      for (const status of ["signed", "exported", "submitted", "cancelled"]) {
        await t.test(`${writerName} rejects ${status} before canonical reads and rolls back`, async () => {
          const workfile = await createWriterFixture(writerName, { status });
          await assertDenied(write, workfile);
        });
      }

      await t.test(`${writerName} rejects signed_at even while status is mutable`, async () => {
        const workfile = await createWriterFixture(writerName, { status: "ready" });
        await pool.query(
          "UPDATE appraisal.uad_workfiles SET signed_at = now() WHERE id = $1",
          [workfile.workfileId],
        );
        await assertDenied(write, workfile);
      });

      for (const [caseName, revision] of [["partial current-revision", 1], ["historical", 1]]) {
        await t.test(`${writerName} rejects any ${caseName} signature under a mutable status`, async () => {
          const currentRevision = caseName === "historical" ? 2 : 1;
          const workfile = await createWriterFixture(writerName, {
            status: caseName === "historical" ? "revised" : "ready",
            revision: currentRevision,
          });
          await insertSyntheticSignature(pool, identity, workfile, revision);
          await assertDenied(write, workfile);
        });
      }
    }

    await t.test("locked workfiles also reject creation of their first canonical sketch", async () => {
      const workfile = await createWorkfileFixture(pool, identity, { status: "signed" });
      await assertDenied(sketchWrite, workfile);
    });

    for (const status of ["draft", "validating", "ready", "revised"]) {
      await t.test(`unsigned ${status} sketch insert/update preserves independent revision and history`, async () => {
        const workfile = await createWorkfileFixture(pool, identity, { status, revision: 3 });
        const inserted = await saveUadSketch(pool, workfile.workfileId, sketchInput, identity.actorUserId);
        assert.equal(inserted.revision, 1);
        const updateInput = { ...sketchInput, geometry: { rooms: [{ id: "edited-room" }] }, expected_revision: 1 };
        const updated = await saveUadSketch(pool, workfile.workfileId, updateInput, identity.actorUserId);
        assert.equal(updated.id, inserted.id);
        assert.equal(updated.revision, 2);
        assert.deepEqual(updated.geometry, updateInput.geometry);
        assert.deepEqual(updated.measurements, sketchInput.measurements);
        assert.deepEqual(updated.calculated_areas, sketchInput.calculated_areas);
        assert.deepEqual(updated.area_overrides, sketchInput.area_overrides);
        assert.equal(updated.source, "mobile");
        const state = await canonicalState(pool, workfile.workfileId);
        assert.equal(state.workfile[0].current_revision, 3, "sketch saves must not advance the workfile revision");
        assert.equal(state.workfile[0].status, "draft");
        assert.equal(state.workfile[0].signed_at, null);
        assert.equal(state.revisions.length, 3);
        assert.deepEqual(state.sketches.map((row) => row.revision), [2]);
        assert.equal(state.sketches[0].created_by_user_id, identity.actorUserId);
        assert.equal(state.sketches[0].updated_by_user_id, identity.actorUserId);
        assert.deepEqual(state.sketchHistory.map((row) => row.revision), [1, 2]);
        assert.deepEqual(state.sketchHistory.map((row) => row.geometry), [sketchInput.geometry, updateInput.geometry]);
        assert.ok(state.sketchHistory.every((row) => row.changed_by_user_id === identity.actorUserId
          && row.change_source === sketchInput.change_source && row.source === "mobile"));
        assert.deepEqual(state.audit.map((row) => row.event_type), ["uad_sketch.saved", "uad_sketch.saved"]);
        assert.ok(state.audit.every((row) => row.actor_user_id === identity.actorUserId));
        const signatures = await pool.query("SELECT id FROM appraisal.uad_signatures WHERE workfile_id = $1", [workfile.workfileId]);
        assert.deepEqual(signatures.rows, []);
        await assert.rejects(() => saveUadSketch(pool, workfile.workfileId, updateInput, identity.actorUserId),
          { message: "uad_sketch_revision_conflict", currentRevision: 2 });
        assert.deepEqual(await canonicalState(pool, workfile.workfileId), state, "stale retries preserve history and audit");
      });
    }

    await t.test("unsigned mutable workfiles still accept real section and completion writes", async () => {
      const sectionWorkfile = await createWorkfileFixture(pool, identity, { status: "draft" });
      const sectionResult = await sectionWrite(pool, sectionWorkfile);
      assert.equal(sectionResult.current_revision, 2);
      assert.equal(sectionResult.changed_field_count, 1);
      const savedSection = await pool.query(
        `SELECT value, source_type, is_appraiser_confirmed
           FROM appraisal.uad_field_values
          WHERE workfile_id = $1 AND field_context = 'assignment' AND uad_uid = '1000.0158'`,
        [sectionWorkfile.workfileId],
      );
      assert.deepEqual(savedSection.rows[0], {
        value: "TraditionalAppraisal",
        source_type: "appraiser",
        is_appraiser_confirmed: true,
      });

      const completionWorkfile = await createWorkfileFixture(pool, identity, { status: "ready" });
      const suggestions = await loadUadCompletionSuggestions(pool, completionWorkfile.workfileId);
      const selected = suggestions.suggestions.sales_comparison_fields.find((item) => (
        item.field_key === "sales_comparison_summary:1300.0006"
      ));
      assert.ok(selected, "the real custom-appraisal adapter must supply the tested suggestion");
      const completionResult = await applyUadCompletionSuggestions(pool, completionWorkfile.workfileId, {
        selected_suggestion_ids: [selected.suggestion_id],
        expected_source_digest_sha256: suggestions.source_completion.source_digest_sha256,
        expected_adapter_version: suggestions.adapter_version,
        expected_revision: 1,
        preserve_existing: true,
        confirmed: true,
      }, identity.actorUserId);
      assert.equal(completionResult.current_revision, 2);
      assert.equal(completionResult.applied_suggestion_count, 1);
      const applied = await pool.query(
        `SELECT value, source_type, is_appraiser_confirmed
           FROM appraisal.uad_field_values
          WHERE workfile_id = $1
            AND field_context = 'sales_comparison_summary' AND uad_uid = '1300.0006'`,
        [completionWorkfile.workfileId],
      );
      assert.deepEqual(applied.rows[0], {
        value: 302000,
        source_type: "homenode",
        is_appraiser_confirmed: true,
      });
    });

    for (const [writerName, write, nextWorkfileRevision] of [
      ["saveUadSection", sectionWrite, 2], ["saveUadSketch", sketchWrite, 1],
    ]) {
      await t.test(`${writerName} waits for an in-flight signature and then rejects it at unchanged revision`, async () => {
        const workfile = await createWriterFixture(writerName, { status: "ready" });
        const before = await canonicalState(pool, workfile.workfileId);
        const signer = await pool.connect();
        const writerClient = await pool.connect();
        let signerTransaction = false;
        const lockIssued = deferred();
        const observed = fixedObservedPool(writerClient, {
          before(statement) {
            if (statement.includes("FROM appraisal.uad_workfiles") && statement.endsWith("FOR UPDATE")) lockIssued.resolve();
          },
        });
        let saving;
        try {
          // Prove the writer explicitly overrides a hostile session default. With
          // inherited REPEATABLE READ, the post-wait signature SELECT could use a
          // snapshot taken before the signer committed its signature row.
          await writerClient.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          await signer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          signerTransaction = true;
          const locked = await signer.query(
            `SELECT id, current_revision FROM appraisal.uad_workfiles
              WHERE id = $1 FOR UPDATE`,
            [workfile.workfileId],
          );
          assert.equal(Number(locked.rows[0].current_revision), 1);
          saving = write(observed.pool, workfile);
          void saving.catch(() => {});
          await within(lockIssued.promise, `${writerName} issued its workfile lock`);
          await assertBlockedBy(pool, writerClient.processID, signer.processID, writerName);
          await insertSyntheticSignature(signer, identity, workfile, 1);
          await signer.query("COMMIT");
          signerTransaction = false;
          await assert.rejects(() => within(saving, `${writerName} observed committed signature`), { message: LOCKED_ERROR });
          assertGuardFirst(observed.trace);
          assert.deepEqual(await canonicalState(pool, workfile.workfileId), before,
            "denial must preserve canonical values/revision/audit even though expected_revision stayed current");
          const signatures = await pool.query(
            "SELECT revision_number FROM appraisal.uad_signatures WHERE workfile_id = $1",
            [workfile.workfileId],
          );
          assert.deepEqual(signatures.rows.map((row) => row.revision_number), [1]);
        } finally {
          if (signerTransaction) await signer.query("ROLLBACK").catch(() => {});
          signer.release();
          if (saving) await within(saving.catch(() => {}), `${writerName} cleanup`).catch(() => {});
          observed.forceRelease();
        }
      });

      await t.test(`a sign-like decision observes the committed draft and revision after waiting for ${writerName}`, async () => {
        const workfile = await createWriterFixture(writerName, { status: "ready" });
        const writerClient = await pool.connect();
        const signer = await pool.connect();
        let signerTransaction = false;
        let abortSigner = false;
        let signing;
        const writerLocked = deferred();
        const continueWriter = deferred();
        const observed = fixedObservedPool(writerClient, {
          async after(statement) {
            if (statement.includes("FROM appraisal.uad_workfiles") && statement.endsWith("FOR UPDATE")) {
              writerLocked.resolve();
              await continueWriter.promise;
            }
          },
        });
        let saving;
        try {
          await writerClient.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          saving = write(observed.pool, workfile);
          void saving.catch(() => {});
          await within(writerLocked.promise, `${writerName} acquired its workfile lock`);
          signing = (async () => {
            await signer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            signerTransaction = true;
            const locked = await signer.query(
              `SELECT id, current_revision, status FROM appraisal.uad_workfiles
                WHERE id = $1 FOR UPDATE`,
              [workfile.workfileId],
            );
            if (abortSigner) {
              await signer.query("ROLLBACK");
              signerTransaction = false;
              return null;
            }
            const decision = {
              revision: Number(locked.rows[0].current_revision),
              status: locked.rows[0].status,
            };
            assert.deepEqual(decision, { revision: nextWorkfileRevision, status: "draft" },
              "a real signer must refuse the post-save draft instead of inserting a signature");
            await signer.query("COMMIT");
            signerTransaction = false;
            return decision;
          })();
          void signing.catch(() => {});
          await assertBlockedBy(pool, signer.processID, writerClient.processID, "sign-like transition");
          continueWriter.resolve();
          const result = await within(saving, `${writerName} committed before signer`);
          const signDecision = await within(signing, "sign-like decision completed after save");
          if (writerName === "saveUadSection") {
            assert.equal(result.current_revision, 2);
            assert.equal(result.changed_field_count, 1);
          } else {
            assert.equal(result.revision, 2);
            const canonical = await canonicalState(pool, workfile.workfileId);
            assert.deepEqual(canonical.sketches.map((row) => row.revision), [2]);
            assert.deepEqual(canonical.sketchHistory.map((row) => row.revision), [1, 2]);
            assert.equal(canonical.audit.filter((row) => row.event_type === "uad_sketch.saved").length, 2);
          }
          assert.deepEqual(signDecision, { revision: nextWorkfileRevision, status: "draft" });
          assert.equal(observed.trace[0], READ_COMMITTED_BEGIN);
          const state = await pool.query(
            `SELECT w.current_revision, w.status, w.signed_at,
                    (SELECT array_agg(s.revision_number ORDER BY s.revision_number)
                       FROM appraisal.uad_signatures s WHERE s.workfile_id = w.id) AS signature_revisions
               FROM appraisal.uad_workfiles w WHERE w.id = $1`,
            [workfile.workfileId],
          );
          assert.deepEqual(state.rows[0], {
            current_revision: nextWorkfileRevision,
            status: "draft",
            signed_at: null,
            signature_revisions: null,
          });
        } finally {
          abortSigner = true;
          continueWriter.resolve();
          if (saving) await within(saving.catch(() => {}), `${writerName} cleanup`).catch(() => {});
          observed.forceRelease();
          if (signing) await within(signing.catch(() => {}), "sign-like cleanup").catch(() => {});
          if (signerTransaction) await signer.query("ROLLBACK").catch(() => {});
          signer.release();
        }
      });
    }
  } finally {
    await pool.end();
  }
});
