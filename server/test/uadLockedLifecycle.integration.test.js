import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prepareNeighborhoodCiDatabase } from "./helpers/neighborhoodCiDatabase.js";

const databaseUrl = process.env.DATABASE_URL;
const LOCKED_ERROR = "uad_workfile_status_locked";
const READ_COMMITTED_BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED";
const COMPLETION_ACCESS_ERROR = "uad_appraiser_confirmation_access_denied";
const COMPLETION_WORKFILE_LOCK = "SELECT id, current_revision, specification_release_key, status, signed_at, organization_id, assigned_appraiser_user_id, supervisory_appraiser_user_id FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE";

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

async function cleanupState(pool, workfileId) {
  const [canonical, signatures, validation, artifacts] = await Promise.all([
    canonicalState(pool, workfileId),
    pool.query("SELECT * FROM appraisal.uad_signatures WHERE workfile_id = $1 ORDER BY id", [workfileId]),
    pool.query("SELECT * FROM appraisal.uad_validation_runs WHERE workfile_id = $1 ORDER BY id", [workfileId]),
    pool.query("SELECT * FROM appraisal.uad_generated_artifacts WHERE workfile_id = $1 ORDER BY id", [workfileId]),
  ]);
  return JSON.parse(JSON.stringify({ canonical, signatures: signatures.rows,
    validation: validation.rows, artifacts: artifacts.rows }));
}

function assertOnlyCandidateRetired(before, after, assetId) {
  const prior = before.canonical.assets.find((row) => row.id === assetId);
  const retired = after.canonical.assets.find((row) => row.id === assetId);
  assert.ok(prior && retired);
  assert.equal(retired.status, "deleted");
  assert.deepEqual(retired.capture_metadata, { ...prior.capture_metadata, orphaned_editor_render: true });
  assert.ok(Date.parse(retired.updated_at) >= Date.parse(prior.updated_at));
  const comparable = structuredClone(after);
  Object.assign(comparable.canonical.assets.find((row) => row.id === assetId), {
    status: prior.status, capture_metadata: prior.capture_metadata, updated_at: prior.updated_at,
  });
  assert.deepEqual(comparable, before, "cleanup must preserve keys, canonical content, history, audit and observer records");
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
  if (trace[1] !== COMPLETION_WORKFILE_LOCK) {
    assert.match(trace[1], /^SELECT id, (current_revision, specification_release_key, )?status, signed_at FROM appraisal\.uad_workfiles/);
  }
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
    { cleanupFailedUadSketchRender },
    { deleteUadAsset },
    { signUadWorkfile },
    { authorizeUadWorkfileAccess, authorizeUadAppraiserConfirmation },
    { customAppraisalReportFixture },
  ] = await Promise.all([
    import("pg"),
    import("../src/modules/uad/editor.js"),
    import("../src/modules/uad/completionApply.js"),
    import("../src/modules/uad/completionSuggestions.js"),
    import("../src/modules/uad/sketches.js"),
    import("../src/modules/uad/sketchExhibitCleanup.js"),
    import("../src/modules/uad/assets.js"),
    import("../src/modules/uad/certifications.js"),
    import("../src/modules/uad/access.js"),
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
    // Completion authorization fixtures have their own account, identities and
    // organization. Never bind the baseline's deliberately org-less asset rows.
    const createCompletionFixture = async (signerRole = "appraiser") => {
      const completionIdentity = await createIdentityFixture(pool, customAppraisalReportFixture);
      const workfile = await createWorkfileFixture(pool, completionIdentity, { status: "ready" });
      const organizationId = randomUUID(), otherOrganizationId = randomUUID(), otherUserId = randomUUID();
      const actorUserId = completionIdentity.actorUserId;
      await pool.query(
        "INSERT INTO app_auth.users (id, email, display_name) VALUES ($1, $2, 'Synthetic alternate completion appraiser')",
        [otherUserId, `${otherUserId}@example.test`],
      );
      for (const id of [organizationId, otherOrganizationId]) {
        await pool.query(
          `INSERT INTO app_auth.organizations (id, legal_name, display_name)
           VALUES ($1, 'Synthetic completion target organization', 'Synthetic completion target organization')`, [id],
        );
        for (const userId of [actorUserId, otherUserId]) {
          await pool.query(
            "INSERT INTO app_auth.organization_memberships (organization_id, user_id, status) VALUES ($1, $2, 'active')",
            [id, userId],
          );
          await pool.query(
            `INSERT INTO app_auth.membership_roles (organization_id, user_id, role_code)
             VALUES ($1, $2, 'appraiser'), ($1, $2, 'supervisory_appraiser')`, [id, userId],
          );
        }
      }
      await pool.query(
        `UPDATE appraisal.uad_workfiles
            SET organization_id = $2, assigned_appraiser_user_id = $3, supervisory_appraiser_user_id = $4
          WHERE id = $1`,
        [workfile.workfileId, organizationId, signerRole === "appraiser" ? actorUserId : otherUserId, actorUserId],
      );
      await pool.query("UPDATE app.report_files SET organization_id = $2 WHERE account_id = $1",
        [completionIdentity.accountId, organizationId]);
      await pool.query("UPDATE app.appraisal_cases SET organization_id = $2 WHERE id = $1",
        [completionIdentity.appraisalCaseId, organizationId]);
      await pool.query(
        "UPDATE app.assignment_files SET organization_id = $2, assigned_appraiser_user_id = $3 WHERE account_id = $1",
        [completionIdentity.accountId, organizationId, actorUserId],
      );
      const membershipRows = (await pool.query(
        `SELECT membership.organization_id, role.role_code
           FROM app_auth.organization_memberships membership
           JOIN app_auth.membership_roles role USING (organization_id, user_id)
          WHERE membership.user_id = $1 AND membership.status = 'active'
          ORDER BY membership.organization_id, role.role_code`, [actorUserId],
      )).rows;
      const auth = { userId: actorUserId, organizations: [organizationId, otherOrganizationId].map((id) => ({
        organizationId: id, roles: membershipRows.filter((row) => row.organization_id === id).map((row) => row.role_code),
      })) };
      const authorized = await authorizeUadWorkfileAccess(pool, auth, workfile.workfileId, { write: true });
      const confirmation = authorizeUadAppraiserConfirmation(auth, authorized);
      assert.equal(confirmation.signerRole, signerRole);
      const receipt = Object.freeze({ workfileId: authorized.id, organizationId: authorized.organization_id,
        actorUserId: confirmation.actorUserId, signerRole: confirmation.signerRole });
      const suggestions = await loadUadCompletionSuggestions(pool, workfile.workfileId);
      const selected = suggestions.suggestions.sales_comparison_fields.find((item) => (
        item.field_key === "sales_comparison_summary:1300.0006"
      ));
      assert.ok(selected, "the scoped fixture must use a real adapter suggestion, not a validation-error stand-in");
      return { ...workfile, identity: completionIdentity, actorUserId, organizationId, otherOrganizationId,
        otherUserId, auth, receipt, request: {
          selected_suggestion_ids: [selected.suggestion_id],
          expected_source_digest_sha256: suggestions.source_completion.source_digest_sha256,
          expected_adapter_version: suggestions.adapter_version,
          expected_revision: workfile.revision, preserve_existing: true, confirmed: true,
        } };
    };
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

      const completionWorkfile = await createCompletionFixture();
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
      }, completionWorkfile.actorUserId, completionWorkfile.receipt);
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
    // These assets are synthetic metadata rows in the same disposable child.
    // No object is uploaded, read, replaced or deleted from any storage service.
    const createCleanupFixture = async () => {
      const workfile = await createWorkfileFixture(pool, identity, { revision: 2 });
      const sketch = await saveUadSketch(pool, workfile.workfileId, sketchInput, identity.actorUserId);
      const assetId = randomUUID();
      await pool.query(
        `INSERT INTO appraisal.uad_assets (
           id, workfile_id, asset_kind, section_number, caption_type, storage_provider,
           object_key, content_type, byte_size, checksum_sha256, status, verified_at,
           capture_metadata, created_by_user_id
         ) VALUES ($1, $2, 'sketch', 7, 'SubjectPropertyImprovementSketch', 'postgres',
           $3, 'image/png', 8, $4, 'verified', now(), $5::jsonb, $6)`,
        [assetId, workfile.workfileId, `synthetic-cleanup/${assetId}.png`, "a".repeat(64),
          JSON.stringify({ source: "homenode_web_sketch_editor", source_uad_sketch_id: sketch.id,
            source_uad_sketch_revision: 1, uad_sketch_editor_revision: `${sketch.id}:2`,
            retained_source_asset_id: null }), identity.actorUserId],
      );
      return { ...workfile, sketchId: sketch.id, assetId, expectedRevision: 1 };
    };
    const cleanup = (writerPool, fixture) => cleanupFailedUadSketchRender(writerPool, {
      workfileId: fixture.workfileId, assetId: fixture.assetId,
      sketchId: fixture.sketchId, expectedRevision: fixture.expectedRevision,
    });
    const publishCandidate = (writerPool, fixture) => saveUadSketch(writerPool, fixture.workfileId,
      { ...sketchInput, rendered_asset_id: fixture.assetId, expected_revision: 1 }, identity.actorUserId);
    const assertCleanupAbstains = async (fixture) => {
      const before = await cleanupState(pool, fixture.workfileId);
      const observed = fixedObservedPool(await pool.connect());
      try {
        assert.equal(await cleanup(observed.pool, fixture), false);
        assert.equal(observed.trace[0], READ_COMMITTED_BEGIN);
        assert.equal(observed.trace.at(-1), "ROLLBACK");
        assert.equal(observed.trace.some((statement) => /^(INSERT|UPDATE|DELETE)\b/.test(statement)), false);
        assert.deepEqual(await cleanupState(pool, fixture.workfileId), before);
      } finally {
        observed.forceRelease();
      }
    };

    await t.test("failed-render cleanup only soft-deletes its unreferenced draft candidate", async () => {
      const fixture = await createCleanupFixture();
      const before = await cleanupState(pool, fixture.workfileId);
      const observed = fixedObservedPool(await pool.connect());
      try {
        assert.equal(await cleanup(observed.pool, fixture), true);
        assert.equal(observed.trace[0], READ_COMMITTED_BEGIN);
        assert.equal(observed.trace.at(-1), "COMMIT");
        const workfileLock = observed.trace.findIndex((sql) => sql.includes("FROM appraisal.uad_workfiles") && sql.endsWith("FOR UPDATE"));
        const signatureCheck = observed.trace.findIndex((sql) => sql.includes("AS has_signatures"));
        const assetLock = observed.trace.findIndex((sql) => sql.includes("FROM appraisal.uad_assets") && sql.endsWith("FOR UPDATE"));
        assert.ok(workfileLock > 0 && signatureCheck > workfileLock && assetLock > signatureCheck);
        assertOnlyCandidateRetired(before, await cleanupState(pool, fixture.workfileId), fixture.assetId);
      } finally {
        observed.forceRelease();
      }
      await assertCleanupAbstains(fixture);
    });

    for (const reference of ["current sketch", "historical sketch"]) {
      await t.test(`failed-render cleanup retains a ${reference} exhibit reference`, async () => {
        const fixture = await createCleanupFixture();
        await publishCandidate(pool, fixture);
        if (reference === "historical sketch") {
          await saveUadSketch(pool, fixture.workfileId, { ...sketchInput, expected_revision: 2 }, identity.actorUserId);
          const current = await pool.query("SELECT rendered_asset_id FROM appraisal.uad_sketches WHERE id = $1", [fixture.sketchId]);
          assert.equal(current.rows[0].rendered_asset_id, null);
          const history = await pool.query("SELECT revision FROM appraisal.uad_sketch_history WHERE rendered_asset_id = $1", [fixture.assetId]);
          assert.deepEqual(history.rows.map((row) => row.revision), [2]);
        }
        await assertCleanupAbstains(fixture);
      });
    }

    for (const status of ["validating", "ready", "revised", "signed", "exported", "submitted", "cancelled"]) {
      await t.test(`failed-render cleanup abstains when the workfile has advanced to ${status}`, async () => {
        const fixture = await createCleanupFixture();
        await pool.query("UPDATE appraisal.uad_workfiles SET status = $2 WHERE id = $1", [fixture.workfileId, status]);
        await assertCleanupAbstains(fixture);
      });
    }

    await t.test("failed-render cleanup retains signed_at evidence even under draft status", async () => {
      const fixture = await createCleanupFixture();
      await pool.query("UPDATE appraisal.uad_workfiles SET signed_at = now() WHERE id = $1", [fixture.workfileId]);
      await assertCleanupAbstains(fixture);
    });
    for (const revision of [1, 2]) {
      await t.test(`failed-render cleanup retains signature evidence from revision ${revision}`, async () => {
        const fixture = await createCleanupFixture();
        await insertSyntheticSignature(pool, identity, fixture, revision);
        await assertCleanupAbstains(fixture);
      });
    }

    await t.test("failed-render cleanup retains an inconsistent other-workfile signature reference", async () => {
      const fixture = await createCleanupFixture();
      const other = await createWorkfileFixture(pool, identity);
      await insertSyntheticSignature(pool, identity, other);
      await pool.query("UPDATE appraisal.uad_signatures SET signature_asset_id = $2 WHERE workfile_id = $1",
        [other.workfileId, fixture.assetId]);
      const otherBefore = await cleanupState(pool, other.workfileId);
      await assertCleanupAbstains(fixture);
      assert.deepEqual(await cleanupState(pool, other.workfileId), otherBefore);
    });

    for (const status of ["running", "passed", "failed", "error"]) {
      await t.test(`failed-render cleanup retains any historical ${status} validation run`, async () => {
        const fixture = await createCleanupFixture();
        await pool.query(
          `INSERT INTO appraisal.uad_validation_runs (
             id, workfile_id, revision_number, specification_release_key, validator_type, status
           ) VALUES ($1, $2, 1, $3, 'local_schema', $4)`,
          [randomUUID(), fixture.workfileId, fixture.releaseKey, status],
        );
        await assertCleanupAbstains(fixture);
      });
    }
    for (const status of ["pending", "generating", "ready", "failed", "superseded"]) {
      await t.test(`failed-render cleanup retains any historical ${status} generated artifact`, async () => {
        const fixture = await createCleanupFixture();
        const artifactId = randomUUID();
        await pool.query(
          `INSERT INTO appraisal.uad_generated_artifacts (
             id, workfile_id, revision_number, artifact_type, storage_provider,
             object_key, content_type, generation_status
           ) VALUES ($1, $2, 1, 'pdf', 'postgres', $3, 'application/pdf', $4)`,
          [artifactId, fixture.workfileId, `synthetic-cleanup/${artifactId}.pdf`, status],
        );
        await assertCleanupAbstains(fixture);
      });
    }

    await t.test("failed-render cleanup rolls back its real asset update if commit cannot execute", async () => {
      const fixture = await createCleanupFixture();
      const before = await cleanupState(pool, fixture.workfileId);
      const observed = fixedObservedPool(await pool.connect(), {
        before(statement) {
          if (statement === "COMMIT") throw new Error("synthetic_cleanup_commit_failure");
        },
      });
      try {
        assert.equal(await cleanup(observed.pool, fixture), false);
        assert.ok(observed.trace.some((sql) => sql.startsWith("UPDATE appraisal.uad_assets")));
        assert.equal(observed.trace.at(-1), "ROLLBACK");
        assert.deepEqual(await cleanupState(pool, fixture.workfileId), before,
          "the real database must roll back the status and orphan metadata together");
      } finally {
        observed.forceRelease();
      }
    });

    await t.test("failed-render cleanup abandons a real workfile lock timeout without changing state", async () => {
      const fixture = await createCleanupFixture();
      const before = await cleanupState(pool, fixture.workfileId);
      const blocker = await pool.connect();
      const cleanupClient = await pool.connect();
      const observed = fixedObservedPool(cleanupClient);
      let blockerTransaction = false;
      let retiring;
      try {
        await blocker.query(READ_COMMITTED_BEGIN);
        blockerTransaction = true;
        await blocker.query("SELECT id FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE", [fixture.workfileId]);
        retiring = cleanup(observed.pool, fixture);
        void retiring.catch(() => {});
        await assertBlockedBy(pool, cleanupClient.processID, blocker.processID, "bounded failed-render cleanup");
        assert.equal(await within(retiring, "cleanup's bounded lock timeout"), false);
        assert.ok(observed.trace.includes("SET LOCAL lock_timeout = '500ms'"));
        assert.equal(observed.trace.at(-1), "ROLLBACK");
        assert.equal(observed.trace.some((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
        await blocker.query("ROLLBACK");
        blockerTransaction = false;
        assert.deepEqual(await cleanupState(pool, fixture.workfileId), before);
      } finally {
        if (blockerTransaction) await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        if (retiring) await within(retiring.catch(() => {}), "timed-out cleanup completion").catch(() => {});
        observed.forceRelease();
      }
    });

    await t.test("a canonical sketch writer wins the real lock race and cleanup preserves its exhibit", async () => {
      const fixture = await createCleanupFixture();
      const writerClient = await pool.connect();
      const cleanupClient = await pool.connect();
      const writerLocked = deferred();
      const continueWriter = deferred();
      const cleanupLockIssued = deferred();
      const writerObserved = fixedObservedPool(writerClient, {
        async after(statement) {
          if (statement.includes("FROM appraisal.uad_workfiles") && statement.endsWith("FOR UPDATE")) {
            writerLocked.resolve();
            await continueWriter.promise;
          }
        },
      });
      const cleanupObserved = fixedObservedPool(cleanupClient, {
        before(statement) {
          if (statement.includes("FROM appraisal.uad_workfiles") && statement.endsWith("FOR UPDATE")) cleanupLockIssued.resolve();
        },
      });
      let writing;
      let retiring;
      try {
        await cleanupClient.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        writing = publishCandidate(writerObserved.pool, fixture);
        void writing.catch(() => {});
        await within(writerLocked.promise, "canonical writer owns the workfile lock");
        retiring = cleanup(cleanupObserved.pool, fixture);
        void retiring.catch(() => {});
        await within(cleanupLockIssued.promise, "cleanup issues its workfile lock");
        await assertBlockedBy(pool, cleanupClient.processID, writerClient.processID, "failed-render cleanup");
        continueWriter.resolve();
        assert.equal((await within(writing, "canonical exhibit publication")).rendered_asset_id, fixture.assetId);
        const published = await cleanupState(pool, fixture.workfileId);
        assert.equal(await within(retiring, "cleanup sees the committed exhibit"), false);
        assert.equal(cleanupObserved.trace[0], READ_COMMITTED_BEGIN);
        assert.ok(cleanupObserved.trace.some((sql) => sql.includes("AS has_observers")),
          "cleanup must observe the committed reference, not merely time out");
        assert.equal(cleanupObserved.trace.some((sql) => sql.startsWith("UPDATE appraisal.uad_assets")), false);
        assert.equal(published.canonical.assets.find((row) => row.id === fixture.assetId).status, "verified");
        assert.deepEqual(await cleanupState(pool, fixture.workfileId), published);
      } finally {
        continueWriter.resolve();
        if (writing) await within(writing.catch(() => {}), "canonical writer cleanup").catch(() => {});
        if (retiring) await within(retiring.catch(() => {}), "failed-render cleanup completion").catch(() => {});
        writerObserved.forceRelease();
        cleanupObserved.forceRelease();
      }
    });

    await t.test("cleanup wins the real lock race and a later writer refuses the retired exhibit", async () => {
      const fixture = await createCleanupFixture();
      const before = await cleanupState(pool, fixture.workfileId);
      const cleanupClient = await pool.connect();
      const writerClient = await pool.connect();
      const candidateUpdated = deferred();
      const continueCleanup = deferred();
      const cleanupObserved = fixedObservedPool(cleanupClient, {
        async after(statement) {
          if (statement.startsWith("UPDATE appraisal.uad_assets")) {
            candidateUpdated.resolve();
            await continueCleanup.promise;
          }
        },
      });
      const writerObserved = fixedObservedPool(writerClient);
      let retiring;
      let writing;
      try {
        retiring = cleanup(cleanupObserved.pool, fixture);
        void retiring.catch(() => {});
        await within(candidateUpdated.promise, "cleanup owns the workfile and updated asset locks");
        writing = publishCandidate(writerObserved.pool, fixture);
        void writing.catch(() => {});
        await assertBlockedBy(pool, writerClient.processID, cleanupClient.processID, "canonical sketch publication");
        continueCleanup.resolve();
        assert.equal(await within(retiring, "cleanup committed retirement"), true);
        await assert.rejects(() => within(writing, "writer sees the retired exhibit"),
          { message: "uad_sketch_rendered_asset_not_found" });
        assert.equal(writerObserved.trace.at(-1), "ROLLBACK");
        assert.equal(writerObserved.trace.some((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
        assertOnlyCandidateRetired(before, await cleanupState(pool, fixture.workfileId), fixture.assetId);
      } finally {
        continueCleanup.resolve();
        if (retiring) await within(retiring.catch(() => {}), "failed-render cleanup completion").catch(() => {});
        if (writing) await within(writing.catch(() => {}), "canonical writer cleanup").catch(() => {});
        cleanupObserved.forceRelease();
        writerObserved.forceRelease();
      }
    });
    // Direct deletion uses a memory-only storage stand-in. This does not test
    // R2 behavior or make storage deletion atomic with a later database commit.
    const deletionSupervisorId = randomUUID();
    await pool.query("INSERT INTO app_auth.users (id, email, display_name) VALUES ($1, $2, 'Synthetic deletion supervisor')",
      [deletionSupervisorId, `${deletionSupervisorId}@example.test`]);
    const createDeletionFixture = async ({ status = "draft", supervised = false } = {}) => {
      const workfile = await createWorkfileFixture(pool, identity, { status, revision: 2 });
      await pool.query(
        "UPDATE appraisal.uad_workfiles SET assigned_appraiser_user_id = $2, supervisory_appraiser_user_id = $3 WHERE id = $1",
        [workfile.workfileId, identity.actorUserId, supervised ? deletionSupervisorId : null],
      );
      const assetId = randomUUID();
      const objectKey = `synthetic-direct-deletion/${assetId}.png`;
      await pool.query(
        `INSERT INTO appraisal.uad_assets (
           id, workfile_id, asset_kind, section_number, caption_type, storage_provider,
           object_key, content_type, byte_size, checksum_sha256, status, verified_at,
           capture_metadata, created_by_user_id
         ) VALUES ($1, $2, 'sketch', 7, 'SubjectPropertyImprovementSketch', 'postgres',
           $3, 'image/png', 16, $4, 'verified', now(), '{"synthetic":true}'::jsonb, $5)`,
        [assetId, workfile.workfileId, objectKey, "b".repeat(64), identity.actorUserId],
      );
      return { ...workfile, assetId, objectKey };
    };
    const deletionStorage = (objectKey, { failure, onDelete } = {}) => {
      const calls = [];
      const objects = new Map([[objectKey, Buffer.from("synthetic object")]]);
      return { calls, objects, storage: {
        async deleteObject(request) {
          assert.deepEqual(request, { objectKey });
          calls.push({ ...request });
          await onDelete?.();
          if (failure) throw failure;
          assert.equal(objects.delete(objectKey), true, "the synthetic object is deleted exactly once");
        },
      } };
    };
    const assertDirectDeletionState = (before, after, assetId) => {
      const priorAsset = before.canonical.assets.find((row) => row.id === assetId);
      const afterAsset = after.canonical.assets.find((row) => row.id === assetId);
      const priorWorkfile = before.canonical.workfile[0];
      const afterWorkfile = after.canonical.workfile[0];
      assert.equal(afterAsset.status, "deleted");
      assert.equal(afterWorkfile.status, "draft");
      assert.ok(Date.parse(afterAsset.updated_at) >= Date.parse(priorAsset.updated_at));
      assert.ok(Date.parse(afterWorkfile.updated_at) >= Date.parse(priorWorkfile.updated_at));
      const comparable = structuredClone(after);
      Object.assign(comparable.canonical.assets.find((row) => row.id === assetId),
        { status: priorAsset.status, updated_at: priorAsset.updated_at });
      Object.assign(comparable.canonical.workfile[0],
        { status: priorWorkfile.status, updated_at: priorWorkfile.updated_at });
      assert.deepEqual(comparable, before, "ordinary deletion only retires the asset and marks its workfile draft");
    };
    const assertDirectDeletionDenied = async (fixture) => {
      const before = await cleanupState(pool, fixture.workfileId);
      const memory = deletionStorage(fixture.objectKey);
      const observed = fixedObservedPool(await pool.connect());
      try {
        await assert.rejects(() => deleteUadAsset(observed.pool, memory.storage, fixture.workfileId, fixture.assetId),
          { message: LOCKED_ERROR });
        assertGuardFirst(observed.trace);
        assert.deepEqual(memory.calls, []);
        assert.equal(memory.objects.has(fixture.objectKey), true);
        assert.deepEqual(await cleanupState(pool, fixture.workfileId), before);
      } finally {
        observed.forceRelease();
      }
    };

    for (const status of ["signed", "exported", "submitted", "cancelled"]) {
      await t.test(`deleteUadAsset rejects ${status} before asset or storage access`, async () => {
        await assertDirectDeletionDenied(await createDeletionFixture({ status }));
      });
    }

    await t.test("the native workfile CHECK separately rejects unknown lifecycle status without schema weakening", async () => {
      const fixture = await createDeletionFixture();
      const before = await cleanupState(pool, fixture.workfileId);
      // Unknown stored status cannot be manufactured under the ordinary schema.
      // This is a schema assertion, not a claim to exercise the deletion guard
      // with an impossible stored row; decoded-row negatives belong in units.
      await assert.rejects(() => pool.query("UPDATE appraisal.uad_workfiles SET status = $2 WHERE id = $1",
        [fixture.workfileId, "synthetic_unknown_status"]), error => error.code === "23514");
      assert.deepEqual(await cleanupState(pool, fixture.workfileId), before);
    });

    for (const status of ["draft", "validating", "ready", "revised"]) {
      await t.test(`deleteUadAsset rejects signed_at under ${status} before asset or storage access`, async () => {
        const fixture = await createDeletionFixture({ status });
        await pool.query("UPDATE appraisal.uad_workfiles SET signed_at = now() WHERE id = $1", [fixture.workfileId]);
        await assertDirectDeletionDenied(fixture);
      });
      for (const [name, revision, supervised] of [
        ["current-revision", 2, false], ["partial current-revision", 2, true], ["historical", 1, false],
      ]) {
        await t.test(`deleteUadAsset rejects ${name} signature under ${status} before asset or storage access`, async () => {
          const fixture = await createDeletionFixture({ status, supervised });
          await insertSyntheticSignature(pool, identity, fixture, revision);
          if (supervised) {
            const quorum = await pool.query(
              `SELECT w.supervisory_appraiser_user_id,
                      (SELECT count(*)::integer FROM appraisal.uad_signatures s WHERE s.workfile_id = w.id) AS signature_count
                 FROM appraisal.uad_workfiles w WHERE w.id = $1`, [fixture.workfileId]);
            assert.equal(quorum.rows[0].supervisory_appraiser_user_id, deletionSupervisorId);
            assert.equal(quorum.rows[0].signature_count, 1, "one appraiser signature leaves the required supervisor unsigned");
          }
          await assertDirectDeletionDenied(fixture);
        });
      }

      await t.test(`unsigned ${status} direct asset deletion preserves storage-first semantics and revisions`, async () => {
        const fixture = await createDeletionFixture({ status });
        const before = await cleanupState(pool, fixture.workfileId);
        const observed = fixedObservedPool(await pool.connect());
        const memory = deletionStorage(fixture.objectKey, { onDelete() {
          assert.match(observed.trace.at(-1), /^SELECT id, object_key FROM appraisal\.uad_assets.*FOR UPDATE$/);
          assert.ok(observed.trace.some((sql) => sql.includes("AS has_signatures")));
          assert.equal(observed.trace.some((sql) => sql.startsWith("WITH deleted_asset")), false);
        } });
        try {
          assert.equal(await deleteUadAsset(observed.pool, memory.storage, fixture.workfileId, fixture.assetId), undefined);
          assert.equal(observed.trace[0], READ_COMMITTED_BEGIN);
          assert.equal(observed.trace.at(-1), "COMMIT");
          assert.deepEqual(memory.calls, [{ objectKey: fixture.objectKey }]);
          assert.equal(memory.objects.size, 0);
          assertDirectDeletionState(before, await cleanupState(pool, fixture.workfileId), fixture.assetId);
        } finally {
          observed.forceRelease();
        }
      });

      await t.test(`unsigned ${status} storage failure preserves all database state and the original error`, async () => {
        const fixture = await createDeletionFixture({ status });
        const before = await cleanupState(pool, fixture.workfileId);
        const failure = new Error("synthetic_storage_delete_failed_before_removal");
        const memory = deletionStorage(fixture.objectKey, { failure });
        const observed = fixedObservedPool(await pool.connect());
        try {
          await assert.rejects(() => deleteUadAsset(observed.pool, memory.storage, fixture.workfileId, fixture.assetId),
            error => error === failure);
          assert.equal(observed.trace[0], READ_COMMITTED_BEGIN);
          assert.equal(observed.trace.at(-1), "ROLLBACK");
          assert.equal(observed.trace.some((sql) => sql.startsWith("WITH deleted_asset")), false);
          assert.deepEqual(memory.calls, [{ objectKey: fixture.objectKey }]);
          assert.equal(memory.objects.has(fixture.objectKey), true);
          assert.deepEqual(await cleanupState(pool, fixture.workfileId), before);
        } finally {
          observed.forceRelease();
        }
      });
    }

    await t.test("deleteUadAsset waits for a synthetic partial-signature commit and reads fresh signature state", async () => {
      const fixture = await createDeletionFixture({ status: "ready", supervised: true });
      const before = await cleanupState(pool, fixture.workfileId);
      const signer = await pool.connect();
      let deleterClient;
      try { deleterClient = await pool.connect(); }
      catch (error) { signer.release(true); throw error; }
      const lockIssued = deferred();
      const observed = fixedObservedPool(deleterClient, { before(statement) {
        if (statement.includes("FROM appraisal.uad_workfiles") && statement.endsWith("FOR UPDATE")) lockIssued.resolve();
      } });
      const memory = deletionStorage(fixture.objectKey);
      let signerTransaction = false;
      let deleting;
      try {
        await deleterClient.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await signer.query(READ_COMMITTED_BEGIN);
        signerTransaction = true;
        await signer.query("SELECT id FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE", [fixture.workfileId]);
        deleting = deleteUadAsset(observed.pool, memory.storage, fixture.workfileId, fixture.assetId);
        void deleting.catch(() => {});
        await within(lockIssued.promise, "direct deleter issued its workfile lock");
        await assertBlockedBy(pool, deleterClient.processID, signer.processID, "direct asset deletion");
        assert.deepEqual(memory.calls, []);
        // This intentionally inserts synthetic signature state under the real
        // signing lock. It is not a successful signUadWorkfile ceremony.
        await insertSyntheticSignature(signer, identity, fixture, 2);
        const committedSignatures = JSON.parse(JSON.stringify((await signer.query(
          "SELECT * FROM appraisal.uad_signatures WHERE workfile_id = $1 ORDER BY id", [fixture.workfileId],
        )).rows));
        await signer.query("COMMIT");
        signerTransaction = false;
        await assert.rejects(() => within(deleting, "direct deleter observed committed partial signature"), { message: LOCKED_ERROR });
        assertGuardFirst(observed.trace);
        assert.ok(observed.trace.some((sql) => sql.includes("AS has_signatures")));
        assert.deepEqual(memory.calls, []);
        assert.equal(memory.objects.has(fixture.objectKey), true);
        const after = await cleanupState(pool, fixture.workfileId);
        assert.deepEqual(after.canonical, before.canonical);
        assert.deepEqual(after.validation, before.validation);
        assert.deepEqual(after.artifacts, before.artifacts);
        assert.deepEqual(after.signatures, committedSignatures);
        assert.deepEqual(after.signatures.map((row) => [row.revision_number, row.signer_role]), [[2, "appraiser"]]);
        assert.equal(after.canonical.workfile[0].status, "ready");
        assert.equal(after.canonical.workfile[0].current_revision, 2);
        assert.equal(after.canonical.workfile[0].signed_at, null);
      } finally {
        if (signerTransaction) await signer.query("ROLLBACK").catch(() => {});
        signer.release(true);
        if (deleting) await within(deleting.catch(() => {}), "direct deletion cleanup").catch(() => {});
        observed.forceRelease();
      }
    });

    await t.test("real signUadWorkfile waits for direct deletion then refuses its committed draft", async () => {
      const fixture = await createDeletionFixture({ status: "ready" });
      const before = await cleanupState(pool, fixture.workfileId);
      const deleterClient = await pool.connect();
      let signerClient;
      try { signerClient = await pool.connect(); }
      catch (error) { deleterClient.release(true); throw error; }
      const deleterLocked = deferred();
      const continueDeletion = deferred();
      const deleterObserved = fixedObservedPool(deleterClient, { async after(statement) {
        if (statement.includes("FROM appraisal.uad_workfiles") && statement.endsWith("FOR UPDATE")) {
          deleterLocked.resolve();
          await continueDeletion.promise;
        }
      } });
      let signerLockedState;
      const signerObserved = fixedObservedPool(signerClient, { after(statement, _client, result) {
        if (statement.includes("FROM appraisal.uad_workfiles") && statement.endsWith("FOR UPDATE")) {
          signerLockedState = { status: result.rows[0]?.status, revision: result.rows[0]?.current_revision };
        }
      } });
      const memory = deletionStorage(fixture.objectKey);
      let deleting;
      let signing;
      try {
        deleting = deleteUadAsset(deleterObserved.pool, memory.storage, fixture.workfileId, fixture.assetId);
        void deleting.catch(() => {});
        await within(deleterLocked.promise, "direct deleter owns the workfile lock");
        // Invoke the real service, but cover only its post-lock lifecycle
        // refusal. This does not claim provider, credential, quorum or artifact
        // success; those checks must not run once the workfile became draft.
        signing = signUadWorkfile(signerObserved.pool, fixture.workfileId, { userId: identity.actorUserId },
          { execution_date: "2026-09-05" }, { now: new Date("2026-09-05T12:00:00.000Z") });
        void signing.catch(() => {});
        await assertBlockedBy(pool, signerClient.processID, deleterClient.processID, "real UAD signing service");
        assert.deepEqual(memory.calls, []);
        continueDeletion.resolve();
        assert.equal(await within(deleting, "direct deletion committed before signing"), undefined);
        await assert.rejects(() => within(signing, "real signer observed the post-deletion draft"),
          { message: "uad_signature_local_validation_required" });
        assert.deepEqual(signerLockedState, { status: "draft", revision: 2 });
        assert.equal(signerObserved.trace.length, 3);
        assert.equal(signerObserved.trace[0], "BEGIN");
        assert.equal(signerObserved.trace.at(-1), "ROLLBACK");
        assert.deepEqual(memory.calls, [{ objectKey: fixture.objectKey }]);
        assert.equal(memory.objects.size, 0);
        const after = await cleanupState(pool, fixture.workfileId);
        assertDirectDeletionState(before, after, fixture.assetId);
        assert.deepEqual(after.signatures, []);
      } finally {
        continueDeletion.resolve();
        if (deleting) await within(deleting.catch(() => {}), "direct deletion cleanup").catch(() => {});
        if (signing) await within(signing.catch(() => {}), "real signer cleanup").catch(() => {});
        deleterObserved.forceRelease();
        signerObserved.forceRelease();
      }
    });

    // Reuse the existing synthetic workfile/signature fixture, including its
    // unrelated verified asset. Only createUploadUrl exists here: it issues a
    // local fake capability synchronously and cannot upload/read/delete bytes.
    const { createUadAssetUpload } = await import("../src/modules/uad/assets.js");
    const uploadInput = Object.freeze({ asset_kind: "photo", content_type: "image/jpeg",
      file_name: "synthetic-upload.jpg", byte_size: 16,
      capture_metadata: Object.freeze({ synthetic_upload_request: true }) });
    const localUploadStorage = (onIssue) => {
      const calls = [];
      const capabilities = [];
      return { calls, capabilities, storage: {
        provider: "postgres", bucket: "synthetic-local-only",
        createUploadUrl(request) {
          assert.equal(request.contentType, uploadInput.content_type);
          calls.push({ ...request });
          onIssue?.(request);
          const capability = { url: `https://synthetic-upload.invalid/${request.objectKey}`,
            method: "PUT", headers: { "Content-Type": request.contentType }, expires_in_seconds: 900 };
          capabilities.push(capability);
          return capability;
        },
      } };
    };
    const assertUploadGuardFirst = (trace) => {
      assert.equal(trace[0], READ_COMMITTED_BEGIN);
      assert.equal(trace[1], "SELECT id, organization_id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE");
      const signatureRead = trace[2]?.includes("AS has_signatures");
      assert.equal(trace.length, signatureRead ? 4 : 3);
      if (signatureRead) assert.equal(trace[2], "SELECT EXISTS ( SELECT 1 FROM appraisal.uad_signatures WHERE workfile_id = $1 ) AS has_signatures");
      assert.equal(trace.at(-1), "ROLLBACK");
    };
    const assertUploadDenied = async (fixture) => {
      const before = await cleanupState(pool, fixture.workfileId);
      const local = localUploadStorage();
      const observed = fixedObservedPool(await pool.connect());
      try {
        await assert.rejects(() => createUadAssetUpload(observed.pool, local.storage, fixture.workfileId, uploadInput),
          { message: LOCKED_ERROR });
        assertUploadGuardFirst(observed.trace);
        assert.deepEqual(local.calls, []);
        assert.deepEqual(local.capabilities, []);
        assert.deepEqual(await cleanupState(pool, fixture.workfileId), before);
      } finally {
        observed.forceRelease();
      }
    };
    const assertUploadCreated = async (fixture, before, result, local) => {
      assert.deepEqual(Object.keys(result).sort(), ["asset_id", "expires_at", "object_key", "upload"]);
      assert.equal(result.object_key, `organizations/unassigned/uad/${fixture.workfileId}/assets/${result.asset_id}/synthetic-upload.jpg`);
      assert.deepEqual(local.calls, [{ objectKey: result.object_key, contentType: uploadInput.content_type }]);
      assert.equal(local.capabilities.length, 1);
      assert.equal(result.upload, local.capabilities[0], "the same locally issued capability is returned after commit");
      assert.equal(result.upload.method, "PUT");
      assert.equal(result.upload.expires_in_seconds, 900);
      assert.equal(result.upload.url, `https://synthetic-upload.invalid/${result.object_key}`);
      const after = await cleanupState(pool, fixture.workfileId);
      assert.equal(after.canonical.assets.length, before.canonical.assets.length + 1);
      const asset = after.canonical.assets.find(row => row.id === result.asset_id);
      assert.ok(asset);
      assert.equal(asset.status, "pending_upload");
      assert.equal(asset.asset_kind, "photo");
      assert.equal(asset.object_key, result.object_key);
      assert.equal(asset.storage_provider, "postgres");
      assert.equal(asset.storage_bucket, "synthetic-local-only");
      assert.equal(asset.byte_size, null);
      assert.equal(asset.checksum_sha256, null);
      assert.deepEqual(asset.capture_metadata, { synthetic_upload_request: true, expected_byte_size: 16 });
      const { rows: [details] } = await pool.query(
        `SELECT workfile_id, entity_id, section_number, caption_type, content_type,
                original_file_name, upload_expires_at, verified_at
           FROM appraisal.uad_assets WHERE id = $1`, [result.asset_id]);
      assert.deepEqual(JSON.parse(JSON.stringify(details)), { workfile_id: fixture.workfileId,
        entity_id: null, section_number: null, caption_type: null, content_type: "image/jpeg",
        original_file_name: "synthetic-upload.jpg", upload_expires_at: result.expires_at, verified_at: null });
      assert.equal(after.canonical.workfile[0].status, "draft");
      assert.equal(after.canonical.workfile[0].current_revision, 2);
      assert.ok(Date.parse(after.canonical.workfile[0].updated_at) >= Date.parse(before.canonical.workfile[0].updated_at));
      const comparable = structuredClone(after);
      comparable.canonical.assets = comparable.canonical.assets.filter(row => row.id !== result.asset_id);
      Object.assign(comparable.canonical.workfile[0], { status: before.canonical.workfile[0].status,
        updated_at: before.canonical.workfile[0].updated_at });
      assert.deepEqual(comparable, before, "creation changes only pending metadata and draft/timestamp, never revision or signed evidence");
    };

    for (const status of ["signed", "exported", "submitted", "cancelled"]) {
      await t.test(`createUadAssetUpload rejects ${status} before capability or asset access`, async () => {
        await assertUploadDenied(await createDeletionFixture({ status }));
      });
    }
    for (const status of ["draft", "validating", "ready", "revised"]) {
      await t.test(`createUadAssetUpload rejects signed_at under ${status} without issuing a capability`, async () => {
        const fixture = await createDeletionFixture({ status });
        await pool.query("UPDATE appraisal.uad_workfiles SET signed_at = now() WHERE id = $1", [fixture.workfileId]);
        await assertUploadDenied(fixture);
      });
      for (const [name, revision, supervised] of [
        ["current-revision", 2, false], ["partial current-revision", 2, true], ["historical", 1, false],
      ]) {
        await t.test(`createUadAssetUpload rejects ${name} signature under ${status} without issuing a capability`, async () => {
          const fixture = await createDeletionFixture({ status, supervised });
          await insertSyntheticSignature(pool, identity, fixture, revision);
          if (supervised) {
            const { rows: [quorum] } = await pool.query(
              `SELECT supervisory_appraiser_user_id,
                      (SELECT count(*)::integer FROM appraisal.uad_signatures WHERE workfile_id = $1) AS signature_count
                 FROM appraisal.uad_workfiles WHERE id = $1`, [fixture.workfileId]);
            assert.equal(quorum.supervisory_appraiser_user_id, deletionSupervisorId);
            assert.equal(quorum.signature_count, 1, "the required supervisor remains unsigned");
          }
          await assertUploadDenied(fixture);
        });
      }
      await t.test(`unsigned ${status} upload creation commits pending metadata before returning its local capability`, async () => {
        const fixture = await createDeletionFixture({ status });
        const before = await cleanupState(pool, fixture.workfileId);
        let returned = false;
        let local;
        const observed = fixedObservedPool(await pool.connect(), { async before(statement) {
          if (statement === "COMMIT") {
            assert.equal(returned, false);
            assert.equal(local.calls.length, 1);
            const { rows } = await pool.query("SELECT id FROM appraisal.uad_assets WHERE object_key = $1", [local.calls[0].objectKey]);
            assert.deepEqual(rows, [], "another client must not see the pending asset before commit");
          }
        } });
        local = localUploadStorage(() => {
          assert.equal(observed.trace[0], READ_COMMITTED_BEGIN);
          assert.ok(observed.trace.at(-1).includes("AS has_signatures"));
          assert.equal(observed.trace.some(sql => sql.includes("INSERT INTO appraisal.uad_assets")), false);
        });
        try {
          const result = await createUadAssetUpload(observed.pool, local.storage, fixture.workfileId, uploadInput)
            .then(value => { returned = true; return value; });
          assert.equal(returned, true);
          assert.equal(observed.trace.at(-1), "COMMIT");
          await assertUploadCreated(fixture, before, result, local);
        } finally {
          observed.forceRelease();
        }
      });
    }

    await t.test("upload creation waits for a synthetic partial-signature commit before issuing any local capability", async () => {
      const fixture = await createDeletionFixture({ status: "ready", supervised: true });
      const before = await cleanupState(pool, fixture.workfileId);
      const signer = await pool.connect();
      let creatorClient;
      try { creatorClient = await pool.connect(); }
      catch (error) { signer.release(true); throw error; }
      const lockIssued = deferred();
      const observed = fixedObservedPool(creatorClient, { before(statement) {
        if (statement.includes("FROM appraisal.uad_workfiles") && statement.endsWith("FOR UPDATE")) lockIssued.resolve();
      } });
      const local = localUploadStorage();
      let signerTransaction = false;
      let creating;
      try {
        await creatorClient.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await signer.query(READ_COMMITTED_BEGIN);
        signerTransaction = true;
        await signer.query("SELECT id FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE", [fixture.workfileId]);
        creating = createUadAssetUpload(observed.pool, local.storage, fixture.workfileId, uploadInput);
        void creating.catch(() => {});
        await within(lockIssued.promise, "upload creator issued its workfile lock");
        await assertBlockedBy(pool, creatorClient.processID, signer.processID, "upload creation");
        assert.deepEqual(local.calls, []);
        // Synthetic signature state under the real lock; no successful signing
        // ceremony, provider authentication, quorum or artifact claim is made.
        await insertSyntheticSignature(signer, identity, fixture, 2);
        const committedSignatures = JSON.parse(JSON.stringify((await signer.query(
          "SELECT * FROM appraisal.uad_signatures WHERE workfile_id = $1 ORDER BY id", [fixture.workfileId],
        )).rows));
        await signer.query("COMMIT");
        signerTransaction = false;
        await assert.rejects(() => within(creating, "upload creator observed fresh partial signature"), { message: LOCKED_ERROR });
        assertUploadGuardFirst(observed.trace);
        assert.ok(observed.trace.some(sql => sql.includes("AS has_signatures")));
        assert.deepEqual(local.calls, []);
        assert.deepEqual(local.capabilities, []);
        const after = await cleanupState(pool, fixture.workfileId);
        assert.deepEqual(after, { ...before, signatures: committedSignatures });
        assert.deepEqual(after.signatures.map(row => [row.revision_number, row.signer_role]), [[2, "appraiser"]]);
        assert.equal(after.canonical.workfile[0].status, "ready");
        assert.equal(after.canonical.workfile[0].signed_at, null);
      } finally {
        if (signerTransaction) await signer.query("ROLLBACK").catch(() => {});
        signer.release(true);
        if (creating) await within(creating.catch(() => {}), "upload creator cleanup").catch(() => {});
        observed.forceRelease();
      }
    });

    await t.test("real signUadWorkfile waits for upload creation then refuses the committed draft", async () => {
      const fixture = await createDeletionFixture({ status: "ready" });
      const before = await cleanupState(pool, fixture.workfileId);
      const creatorClient = await pool.connect();
      let signerClient;
      try { signerClient = await pool.connect(); }
      catch (error) { creatorClient.release(true); throw error; }
      const creatorLocked = deferred();
      const continueCreation = deferred();
      const creatorObserved = fixedObservedPool(creatorClient, { async after(statement) {
        if (statement.includes("FROM appraisal.uad_workfiles") && statement.endsWith("FOR UPDATE")) {
          creatorLocked.resolve();
          await continueCreation.promise;
        }
      } });
      let signerLockedState;
      const signerObserved = fixedObservedPool(signerClient, { after(statement, _client, result) {
        if (statement.includes("FROM appraisal.uad_workfiles") && statement.endsWith("FOR UPDATE")) {
          signerLockedState = { status: result.rows[0]?.status, revision: result.rows[0]?.current_revision };
        }
      } });
      const local = localUploadStorage();
      let creating;
      let signing;
      try {
        creating = createUadAssetUpload(creatorObserved.pool, local.storage, fixture.workfileId, uploadInput);
        void creating.catch(() => {});
        await within(creatorLocked.promise, "upload creator owns the workfile lock");
        // The actual signing service must stop at its lifecycle check after
        // waking; successful credentials/provider/signature artifacts are out
        // of scope, and no such downstream checks should be reached here.
        signing = signUadWorkfile(signerObserved.pool, fixture.workfileId, { userId: identity.actorUserId },
          { execution_date: "2026-09-05" }, { now: new Date("2026-09-05T12:00:00.000Z") });
        void signing.catch(() => {});
        await assertBlockedBy(pool, signerClient.processID, creatorClient.processID, "real signer versus upload creation");
        assert.deepEqual(local.calls, []);
        continueCreation.resolve();
        const result = await within(creating, "upload creation committed before signing");
        await assert.rejects(() => within(signing, "real signer observed the upload-created draft"),
          { message: "uad_signature_local_validation_required" });
        assert.deepEqual(signerLockedState, { status: "draft", revision: 2 });
        assert.equal(signerObserved.trace.length, 3);
        assert.equal(signerObserved.trace[0], "BEGIN");
        assert.equal(signerObserved.trace.at(-1), "ROLLBACK");
        assert.equal(creatorObserved.trace[0], READ_COMMITTED_BEGIN);
        assert.equal(creatorObserved.trace.at(-1), "COMMIT");
        await assertUploadCreated(fixture, before, result, local);
      } finally {
        continueCreation.resolve();
        if (creating) await within(creating.catch(() => {}), "upload creation cleanup").catch(() => {});
        if (signing) await within(signing.catch(() => {}), "real signer cleanup").catch(() => {});
        creatorObserved.forceRelease();
        signerObserved.forceRelease();
      }
    });
    // Verification has separate preflight/final transactions. These additions
    // use the same guarded disposable database and memory-only PNG storage.
    const { verifyUadAssetUpload } = await import("../src/modules/uad/assets.js");
    const { buildUadObjectKey, buildUadVerifiedAssetObjectKey } = await import("../src/modules/uad/r2Storage.js");
    const { createHash } = await import("node:crypto");
    const verificationPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const verificationChecksum = createHash("sha256").update(verificationPng).digest("hex");
    const verificationWorkfileLock = "SELECT id, organization_id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE";
    const verificationState = async (workfileId) => JSON.parse(JSON.stringify({
      state: await cleanupState(pool, workfileId),
      assets: (await pool.query("SELECT * FROM appraisal.uad_assets WHERE workfile_id = $1 ORDER BY id", [workfileId])).rows,
      workfile: (await pool.query("SELECT * FROM appraisal.uad_workfiles WHERE id = $1", [workfileId])).rows,
    }));
    const createVerificationFixture = async ({ status = "draft", supervised = false,
      assetStatus = "pending_upload", owned = true } = {}) => {
      const workfile = await createDeletionFixture({ status, supervised });
      const assetId = randomUUID(), fileName = "native-verification.png";
      const sourceKey = owned ? buildUadObjectKey({ organizationId: null, workfileId: workfile.workfileId, assetId, fileName })
        : `synthetic-legacy-verification/${assetId}.png`;
      const verifiedKey = buildUadVerifiedAssetObjectKey({ organizationId: null, workfileId: workfile.workfileId,
        assetId, fileName, checksumSha256: verificationChecksum });
      await pool.query(
        `INSERT INTO appraisal.uad_assets (id, workfile_id, asset_kind, storage_provider, storage_bucket,
          object_key, original_file_name, content_type, status, capture_metadata, created_by_user_id)
         VALUES ($1, $2, 'photo', 'postgres', 'synthetic-verification-only', $3, $4, 'image/png', $5, $6::jsonb, $7)`,
        [assetId, workfile.workfileId, sourceKey, fileName, assetStatus,
          JSON.stringify({ expected_byte_size: verificationPng.length, synthetic_verification: true }), identity.actorUserId]);
      return { ...workfile, assetId, sourceKey, verifiedKey };
    };
    const verificationObserver = ({ before, after } = {}) => {
      const phases = [], active = new Set(), releases = new Set();
      const result = { phases, active, pool: {
        query: (...args) => pool.query(...args),
        async connect() {
          const client = await pool.connect();
          try { await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ"); }
          catch (error) { client.release(true); throw error; }
          const phase = { number: phases.length + 1, pid: client.processID, trace: [] };
          phases.push(phase);
          let released = false;
          const release = () => { if (!released) { released = true; active.delete(client.processID); client.release(true); } };
          releases.add(release);
          return { async query(config, values) {
            const statement = statementOf(config); phase.trace.push(statement);
            await before?.(statement, client, phase, values);
            const rows = await client.query(config, values);
            if (statement.startsWith("BEGIN")) {
              active.add(client.processID);
              const isolation = await client.query("SHOW transaction_isolation");
              assert.equal(isolation.rows[0].transaction_isolation, "read committed", "verification overrides the hostile session default");
            }
            if (statement === "COMMIT" || statement === "ROLLBACK") active.delete(client.processID);
            await after?.(statement, client, phase, rows);
            return rows;
          }, release };
        },
      }, forceRelease() { for (const release of releases) release(); } };
      return result;
    };
    const memoryVerificationStorage = (fixture, observers, { inspectMismatch = false, invalidPayload = false,
      copyMismatchOnce = false, onStorage, existingVerified = false } = {}) => {
      const objects = new Map([[fixture.sourceKey, Buffer.from(verificationPng)]]), calls = [], storageFailures = [];
      if (existingVerified) objects.set(fixture.verifiedKey, Buffer.from(verificationPng));
      let copies = 0;
      const outsideTransaction = async (method, objectKey) => {
        const pids = observers.flatMap(observer => observer.phases.map(phase => phase.pid));
        for (const observer of observers) assert.equal(observer.active.size, 0, `${method} cannot run inside a verifier transaction`);
        const { rows } = await pool.query(
          "SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::integer[]) AND xact_start IS NOT NULL", [pids]);
        assert.deepEqual(rows, [], `${method} must observe actual verifier transaction release`);
        calls.push({ method, objectKey });
      };
      const storage = {
        async inspectObject({ objectKey }) {
          await outsideTransaction("inspect", objectKey); await onStorage?.("inspect", objectKey);
          assert.ok(objects.has(objectKey));
          return { byte_size: verificationPng.length + (inspectMismatch ? 1 : 0), content_type: "image/png", etag: "synthetic-inspected" };
        },
        async getObject({ objectKey }) {
          await outsideTransaction("get", objectKey); await onStorage?.("get", objectKey);
          assert.ok(objects.has(objectKey));
          return { body: invalidPayload ? Buffer.alloc(verificationPng.length, 0x41) : Buffer.from(objects.get(objectKey)),
            byte_size: verificationPng.length, content_type: "image/png" };
        },
        async putObject({ objectKey, contentType, body }) {
          await outsideTransaction("put", objectKey); assert.equal(objectKey, fixture.verifiedKey);
          assert.equal(contentType, "image/png"); assert.deepEqual(body, verificationPng);
          objects.set(objectKey, Buffer.from(body)); const copyNumber = ++copies;
          await onStorage?.("put", objectKey);
          return { byte_size: body.length + (copyMismatchOnce && copyNumber === 1 ? 1 : 0), etag: "synthetic-copied" };
        },
        async deleteObject({ objectKey }) {
          await outsideTransaction("delete", objectKey); await onStorage?.("delete", objectKey);
          assert.equal(objectKey, fixture.sourceKey, "verification must never delete a checksum-addressed object");
          assert.equal(objects.delete(objectKey), true);
        },
      };
      // GET rejection and best-effort DELETE handling may catch storage errors.
      // Keep an independent oracle so no contract failure can masquerade as an
      // invalid payload or disappear during cleanup. These fakes never inject
      // intentional storage exceptions; invalid outcomes use returned data.
      for (const [method, operation] of Object.entries(storage)) {
        storage[method] = async (...args) => {
          try { return await operation(...args); }
          catch (error) { storageFailures.push({ method, error }); throw error; }
        };
      }
      return { objects, calls, storage, storageFailures };
    };
    const verify = async (observer, memory, fixture) => {
      try { return await verifyUadAssetUpload(observer.pool, memory.storage, fixture.workfileId, fixture.assetId); }
      finally { assert.deepEqual(memory.storageFailures, [], "storage contract failures must not be swallowed by verification"); }
    };
    const assertVerificationPhase = (phase, ending, { assetRead = true } = {}) => {
      assert.equal(phase.trace[0], READ_COMMITTED_BEGIN);
      assert.equal(phase.trace[1], verificationWorkfileLock);
      assert.ok(phase.trace[2]?.includes("AS has_signatures"));
      if (assetRead) assert.match(phase.trace[3], /^SELECT id, workfile_id, .* FROM appraisal\.uad_assets .* FOR UPDATE$/);
      else assert.equal(phase.trace.some(sql => sql.includes("FROM appraisal.uad_assets")), false);
      assert.equal(phase.trace.at(-1), ending);
    };
    const mutateUnderWorkfileLock = async (fixture, action) => {
      const client = await pool.connect();
      try {
        await client.query(READ_COMMITTED_BEGIN);
        await client.query("SELECT id FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE", [fixture.workfileId]);
        await action(client); await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(true); }
    };
    const assertVerificationOnlyAssetChanged = (before, after, fixture, status) => {
      const asset = after.assets.find(row => row.id === fixture.assetId);
      const originalAsset = before.assets.find(row => row.id === fixture.assetId);
      assert.equal(asset.status, status); assert.equal(after.workfile[0].status, "draft");
      assert.equal(after.workfile[0].current_revision, 2);
      assert.ok(Date.parse(asset.updated_at) >= Date.parse(originalAsset.updated_at));
      const immutableAsset = structuredClone(asset), originalImmutableAsset = structuredClone(originalAsset);
      const changedColumns = status === "verified"
        ? ["status", "byte_size", "checksum_sha256", "object_key", "uploaded_at", "verified_at", "updated_at", "capture_metadata"]
        : ["status", "updated_at", "capture_metadata"];
      for (const column of changedColumns) { delete immutableAsset[column]; delete originalImmutableAsset[column]; }
      assert.deepEqual(immutableAsset, originalImmutableAsset, "identity, applicability, ownership and all other asset columns remain unchanged");
      const comparable = structuredClone(after);
      comparable.assets = comparable.assets.map(row => row.id === fixture.assetId ? before.assets.find(old => old.id === row.id) : row);
      comparable.state.canonical.assets = comparable.state.canonical.assets.map(row => row.id === fixture.assetId
        ? before.state.canonical.assets.find(old => old.id === row.id) : row);
      for (const [rows, prior] of [[comparable.workfile, before.workfile],
        [comparable.state.canonical.workfile, before.state.canonical.workfile]]) {
        Object.assign(rows[0], { status: prior[0].status, updated_at: prior[0].updated_at });
      }
      assert.deepEqual(comparable, before, "verification cannot change canonical values, revision, signatures, history, audit or artifacts");
      return asset;
    };
    for (const status of ["signed", "exported", "submitted", "cancelled"]) {
      await t.test(`verifyUadAssetUpload rejects ${status} before storage inspection`, async () => {
        const fixture = await createVerificationFixture({ status }), before = await verificationState(fixture.workfileId);
        const observer = verificationObserver(), memory = memoryVerificationStorage(fixture, [observer]);
        try {
          await assert.rejects(() => verify(observer, memory, fixture), { message: LOCKED_ERROR });
          assert.deepEqual(memory.calls, []); assert.deepEqual(observer.phases, []);
          assert.deepEqual(await verificationState(fixture.workfileId), before);
        } finally { observer.forceRelease(); }
      });
    }
    for (const status of ["draft", "validating", "ready", "revised"]) {
      for (const evidence of ["signed_at", "current signature", "partial signature", "historical signature"]) {
        await t.test(`verification preflight refuses ${evidence} under ${status} without storage or metadata changes`, async () => {
          const fixture = await createVerificationFixture({ status, supervised: evidence === "partial signature" });
          if (evidence === "signed_at") await pool.query("UPDATE appraisal.uad_workfiles SET signed_at = now() WHERE id = $1", [fixture.workfileId]);
          else await insertSyntheticSignature(pool, identity, fixture, evidence === "historical signature" ? 1 : 2);
          const before = await verificationState(fixture.workfileId), observer = verificationObserver();
          const memory = memoryVerificationStorage(fixture, [observer]);
          try {
            await assert.rejects(() => verify(observer, memory, fixture), { message: LOCKED_ERROR });
            assert.equal(observer.phases.length, 1); const phase = observer.phases[0];
            if (evidence === "signed_at") assert.deepEqual(phase.trace, [READ_COMMITTED_BEGIN, verificationWorkfileLock, "ROLLBACK"]);
            else assertVerificationPhase(phase, "ROLLBACK", { assetRead: false });
            assert.deepEqual(memory.calls, []); assert.deepEqual(await verificationState(fixture.workfileId), before);
          } finally { observer.forceRelease(); }
        });
      }
    }
    for (const [status, assetStatus] of [["draft", "pending_upload"], ["validating", "pending_upload"],
      ["ready", "pending_upload"], ["revised", "pending_upload"], ["draft", "uploaded"]]) {
      await t.test(`unsigned ${status}/${assetStatus} verification commits only verified metadata with storage outside transactions`, async () => {
        const fixture = await createVerificationFixture({ status, assetStatus }), before = await verificationState(fixture.workfileId);
        const observer = verificationObserver(), memory = memoryVerificationStorage(fixture, [observer]);
        try {
          const result = await verify(observer, memory, fixture), after = await verificationState(fixture.workfileId);
          assert.equal(result.id, fixture.assetId); assert.equal(result.status, "verified");
          assert.equal(result.byte_size, verificationPng.length); assert.equal(result.original_file_name, "native-verification.png");
          assert.equal(observer.phases.length, 2); observer.phases.forEach(phase => assertVerificationPhase(phase, "COMMIT"));
          const asset = assertVerificationOnlyAssetChanged(before, after, fixture, "verified");
          assert.equal(asset.object_key, fixture.verifiedKey); assert.equal(asset.checksum_sha256, verificationChecksum);
          assert.equal(Number(asset.byte_size), verificationPng.length); assert.ok(asset.uploaded_at && asset.verified_at);
          assert.deepEqual(asset.capture_metadata, { expected_byte_size: verificationPng.length, synthetic_verification: true,
            storage_etag: "synthetic-copied", verified_dimensions: { width: 1, height: 1, pixels: 1 }, verified_object_immutable: true });
          assert.deepEqual(memory.calls.map(call => call.method), ["inspect", "get", "put", "delete"]);
          assert.equal(memory.objects.has(fixture.sourceKey), false); assert.deepEqual(memory.objects.get(fixture.verifiedKey), verificationPng);
        } finally { observer.forceRelease(); }
      });
    }
    for (const invalid of ["inspection", "payload"]) for (const owned of [true, false]) {
      await t.test(`invalid ${invalid} verification commits rejection and cleans only an exact owned source (${owned})`, async () => {
        const fixture = await createVerificationFixture({ status: "ready", owned }), before = await verificationState(fixture.workfileId);
        const observer = verificationObserver(), memory = memoryVerificationStorage(fixture, [observer], {
          inspectMismatch: invalid === "inspection", invalidPayload: invalid === "payload", existingVerified: true });
        try {
          await assert.rejects(() => verify(observer, memory, fixture), { message: "invalid_uad_uploaded_asset" });
          assert.equal(observer.phases.length, 2); observer.phases.forEach(phase => assertVerificationPhase(phase, "COMMIT"));
          const asset = assertVerificationOnlyAssetChanged(before, await verificationState(fixture.workfileId), fixture, "rejected");
          assert.equal(asset.object_key, fixture.sourceKey); assert.equal(asset.checksum_sha256, null); assert.equal(asset.verified_at, null);
          assert.deepEqual(asset.capture_metadata, invalid === "inspection"
            ? { expected_byte_size: verificationPng.length, synthetic_verification: true,
              verification_error: "uploaded_object_does_not_match_request",
              inspected: { byte_size: verificationPng.length + 1, content_type: "image/png", etag: "synthetic-inspected" } }
            : { expected_byte_size: verificationPng.length, synthetic_verification: true,
              verification_error: "invalid_uad_asset_content_type_mismatch" });
          assert.equal(memory.objects.has(fixture.sourceKey), !owned);
          assert.equal(memory.calls.filter(call => call.method === "delete").length, owned ? 1 : 0);
          assert.equal(memory.calls.some(call => call.method === "put"), false);
          assert.deepEqual(memory.objects.get(fixture.verifiedKey), verificationPng);
        } finally { observer.forceRelease(); }
      });
    }
    for (const field of ["object_key", "capture_metadata", "caption"]) {
      await t.test(`verification refuses changed pending ${field} after copy without overwriting or deleting evidence`, async () => {
        const fixture = await createVerificationFixture(), observer = verificationObserver(); let changed;
        const memory = memoryVerificationStorage(fixture, [observer], { async onStorage(method) {
          if (method !== "put") return;
          await mutateUnderWorkfileLock(fixture, async client => {
            const value = field === "object_key" ? `synthetic-replacement/${fixture.assetId}.png`
              : field === "caption" ? "Concurrent owner caption" : JSON.stringify({ expected_byte_size: verificationPng.length, new_owner: true });
            // field comes only from this fixed test matrix, never a request.
            await client.query(`UPDATE appraisal.uad_assets SET ${field} = $2${field === "capture_metadata" ? "::jsonb" : ""} WHERE id = $1`, [fixture.assetId, value]);
          });
          changed = await verificationState(fixture.workfileId);
        } });
        try {
          await assert.rejects(() => verify(observer, memory, fixture), { message: "uad_asset_not_found" });
          assertVerificationPhase(observer.phases[1], "ROLLBACK"); assert.deepEqual(await verificationState(fixture.workfileId), changed);
          assert.equal(memory.calls.some(call => call.method === "delete"), false);
          assert.deepEqual(memory.objects.get(fixture.sourceKey), verificationPng); assert.deepEqual(memory.objects.get(fixture.verifiedKey), verificationPng);
        } finally { observer.forceRelease(); }
      });
    }
    for (const [stage, invalid] of [["inspect", false], ["put", false], ["inspect", true]]) {
      await t.test(`synthetic signing during ${stage} storage causes fresh ${invalid ? "rejection" : "promotion"} refusal`, async () => {
        const fixture = await createVerificationFixture({ status: "ready", supervised: true }), observer = verificationObserver(); let signed;
        const memory = memoryVerificationStorage(fixture, [observer], { inspectMismatch: invalid, async onStorage(method) {
          if (method !== stage) return;
          await mutateUnderWorkfileLock(fixture, client => insertSyntheticSignature(client, identity, fixture, 2));
          signed = await verificationState(fixture.workfileId);
        } });
        try {
          await assert.rejects(() => verify(observer, memory, fixture), { message: LOCKED_ERROR });
          assertVerificationPhase(observer.phases[0], "COMMIT"); assertVerificationPhase(observer.phases[1], "ROLLBACK", { assetRead: false });
          assert.equal(signed.state.signatures.length, 1); assert.equal(signed.workfile[0].status, "ready");
          assert.deepEqual(await verificationState(fixture.workfileId), signed);
          assert.equal(memory.calls.some(call => call.method === "delete"), false); assert.deepEqual(memory.objects.get(fixture.sourceKey), verificationPng);
          if (!invalid) assert.deepEqual(memory.objects.get(fixture.verifiedKey), verificationPng);
        } finally { observer.forceRelease(); }
      });
    }
    await t.test("verification preflight waits for a real partial-signature lock then reads fresh state despite repeatable-read default", async () => {
      const fixture = await createVerificationFixture({ status: "ready", supervised: true }), signer = await pool.connect();
      const lockIssued = deferred(); let signerTransaction = false, checking;
      const observer = verificationObserver({ before(statement) { if (statement === verificationWorkfileLock) lockIssued.resolve(); } });
      const memory = memoryVerificationStorage(fixture, [observer]);
      try {
        await signer.query(READ_COMMITTED_BEGIN); signerTransaction = true;
        await signer.query("SELECT id FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE", [fixture.workfileId]);
        checking = verify(observer, memory, fixture); void checking.catch(() => {});
        await within(lockIssued.promise, "verification preflight requested the workfile lock");
        await assertBlockedBy(pool, observer.phases[0].pid, signer.processID, "verification preflight");
        assert.deepEqual(memory.calls, []);
        await insertSyntheticSignature(signer, identity, fixture, 2);
        const signatures = JSON.parse(JSON.stringify((await signer.query("SELECT * FROM appraisal.uad_signatures WHERE workfile_id = $1 ORDER BY id", [fixture.workfileId])).rows));
        await signer.query("COMMIT"); signerTransaction = false;
        const committed = await verificationState(fixture.workfileId);
        await assert.rejects(() => within(checking, "verification sees the committed partial signature"), { message: LOCKED_ERROR });
        assertVerificationPhase(observer.phases[0], "ROLLBACK", { assetRead: false });
        assert.deepEqual(committed.state.signatures, signatures); assert.deepEqual(await verificationState(fixture.workfileId), committed);
        assert.deepEqual(memory.calls, []);
      } finally {
        if (signerTransaction) await signer.query("ROLLBACK").catch(() => {}); signer.release(true);
        if (checking) await within(checking.catch(() => {}), "verification preflight cleanup").catch(() => {});
        observer.forceRelease();
      }
    });
    await t.test("final verification waits for an in-flight partial signature after copying then refuses fresh state", async () => {
      const fixture = await createVerificationFixture({ status: "ready", supervised: true });
      const signer = await pool.connect(), finalIssued = deferred(); let checking, signerTransaction = false;
      const observer = verificationObserver({ before(statement, _client, phase) {
        if (phase.number === 2 && statement === verificationWorkfileLock) finalIssued.resolve();
      } });
      const memory = memoryVerificationStorage(fixture, [observer], { async onStorage(method) {
        if (method !== "put") return;
        // A separate synthetic signer owns the real lock while the verifier's
        // storage call completes. The verifier itself owns no transaction here.
        await signer.query(READ_COMMITTED_BEGIN); signerTransaction = true;
        await signer.query("SELECT id FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE", [fixture.workfileId]);
        await insertSyntheticSignature(signer, identity, fixture, 2);
      } });
      try {
        checking = verify(observer, memory, fixture); void checking.catch(() => {});
        await within(finalIssued.promise, "verification final outcome requested the workfile lock");
        await assertBlockedBy(pool, observer.phases[1].pid, signer.processID, "verification final outcome");
        const signatures = JSON.parse(JSON.stringify((await signer.query("SELECT * FROM appraisal.uad_signatures WHERE workfile_id = $1 ORDER BY id", [fixture.workfileId])).rows));
        await signer.query("COMMIT"); signerTransaction = false;
        const committed = await verificationState(fixture.workfileId);
        await assert.rejects(() => within(checking, "verification final outcome reads fresh signature state"), { message: LOCKED_ERROR });
        assertVerificationPhase(observer.phases[0], "COMMIT"); assertVerificationPhase(observer.phases[1], "ROLLBACK", { assetRead: false });
        assert.deepEqual(committed.state.signatures, signatures); assert.deepEqual(await verificationState(fixture.workfileId), committed);
        assert.equal(committed.assets.find(row => row.id === fixture.assetId).status, "pending_upload");
        assert.equal(memory.calls.some(call => call.method === "delete"), false);
        assert.deepEqual(memory.objects.get(fixture.sourceKey), verificationPng); assert.deepEqual(memory.objects.get(fixture.verifiedKey), verificationPng);
      } finally {
        if (signerTransaction) await signer.query("ROLLBACK").catch(() => {}); signer.release(true);
        if (checking) await within(checking.catch(() => {}), "verification final wait cleanup").catch(() => {});
        observer.forceRelease();
      }
    });
    await t.test("real signUadWorkfile waits for final verification metadata then refuses the committed draft", async () => {
      const fixture = await createVerificationFixture({ status: "ready" }), before = await verificationState(fixture.workfileId);
      const finalLocked = deferred(), continueFinal = deferred(); let checking, signing;
      const observer = verificationObserver({ async after(statement, _client, phase) {
        if (phase.number === 2 && statement === verificationWorkfileLock) { finalLocked.resolve(); await continueFinal.promise; }
      } });
      const signerClient = await pool.connect(), signer = fixedObservedPool(signerClient);
      const memory = memoryVerificationStorage(fixture, [observer]);
      try {
        checking = verify(observer, memory, fixture); void checking.catch(() => {});
        await within(finalLocked.promise, "verification owns the final workfile lock");
        signing = signUadWorkfile(signer.pool, fixture.workfileId, { userId: identity.actorUserId },
          { execution_date: "2026-09-05" }, { now: new Date("2026-09-05T12:00:00.000Z") });
        void signing.catch(() => {});
        await assertBlockedBy(pool, signerClient.processID, observer.phases[1].pid, "real signer versus verification publication");
        continueFinal.resolve(); assert.equal((await within(checking, "verification publication committed")).status, "verified");
        await assert.rejects(() => within(signing, "real signer sees verification-created draft"), { message: "uad_signature_local_validation_required" });
        assert.equal(signer.trace.length, 3); assert.equal(signer.trace[0], "BEGIN"); assert.equal(signer.trace.at(-1), "ROLLBACK");
        assertVerificationOnlyAssetChanged(before, await verificationState(fixture.workfileId), fixture, "verified");
        assert.deepEqual(memory.objects.get(fixture.verifiedKey), verificationPng);
      } finally {
        continueFinal.resolve();
        if (checking) await within(checking.catch(() => {}), "verification publication cleanup").catch(() => {});
        if (signing) await within(signing.catch(() => {}), "real signer cleanup").catch(() => {});
        observer.forceRelease(); signer.forceRelease();
      }
    });
    for (const copyMismatchOnce of [false, true]) {
      await t.test(`a competing real verifier preserves its committed row and shared checksum bytes when the loser resumes (${copyMismatchOnce})`, async () => {
        const fixture = await createVerificationFixture(), loser = verificationObserver(), winner = verificationObserver();
        const copied = deferred(), continueLoser = deferred(); let firstCopy = true, checking;
        const memory = memoryVerificationStorage(fixture, [loser, winner], { copyMismatchOnce, async onStorage(method) {
          if (method === "put" && firstCopy) { firstCopy = false; copied.resolve(); await continueLoser.promise; }
        } });
        try {
          checking = verify(loser, memory, fixture); void checking.catch(() => {});
          await within(copied.promise, "loser copied checksum bytes outside a transaction");
          const result = await within(verify(winner, memory, fixture), "competing verifier committed publication");
          assert.equal(result.status, "verified"); const committed = await verificationState(fixture.workfileId);
          continueLoser.resolve();
          await assert.rejects(() => within(checking, "late verifier refuses to replace winner"),
            { message: copyMismatchOnce ? "invalid_uad_uploaded_asset" : "uad_asset_not_found" });
          assert.deepEqual(await verificationState(fixture.workfileId), committed);
          assert.deepEqual(memory.objects.get(fixture.verifiedKey), verificationPng); assert.equal(memory.objects.has(fixture.sourceKey), false);
          assert.deepEqual(memory.calls.filter(call => call.method === "delete"), [{ method: "delete", objectKey: fixture.sourceKey }]);
          if (!copyMismatchOnce) assertVerificationPhase(loser.phases[1], "ROLLBACK");
        } finally {
          continueLoser.resolve(); if (checking) await within(checking.catch(() => {}), "late verifier cleanup").catch(() => {});
          loser.forceRelease(); winner.forceRelease();
        }
      });
    }
    for (const invalid of [false, true]) {
      await t.test(`final verification ${invalid ? "rejection" : "promotion"} rolls back real metadata on commit failure without storage deletion`, async () => {
        const fixture = await createVerificationFixture({ status: "ready" }), before = await verificationState(fixture.workfileId);
        const failure = new Error("synthetic_verification_commit_failure");
        const observer = verificationObserver({ before(statement, _client, phase) {
          if (phase.number === 2 && statement === "COMMIT") throw failure;
        } });
        const memory = memoryVerificationStorage(fixture, [observer], { inspectMismatch: invalid });
        try {
          await assert.rejects(() => verify(observer, memory, fixture), error => error === failure);
          assertVerificationPhase(observer.phases[1], "ROLLBACK");
          assert.ok(observer.phases[1].trace.some(sql => sql.startsWith("WITH mutable_workfile AS")));
          assert.deepEqual(await verificationState(fixture.workfileId), before);
          assert.equal(memory.calls.some(call => call.method === "delete"), false); assert.deepEqual(memory.objects.get(fixture.sourceKey), verificationPng);
          if (!invalid) assert.deepEqual(memory.objects.get(fixture.verifiedKey), verificationPng);
        } finally { observer.forceRelease(); }
      });
    }
    for (const invalid of [false, true]) {
      await t.test(`lost final ${invalid ? "rejection" : "promotion"} COMMIT acknowledgment retains the committed outcome and every storage object`, async () => {
        const fixture = await createVerificationFixture({ status: "ready" }), before = await verificationState(fixture.workfileId);
        const failure = new Error("synthetic_verification_commit_acknowledgment_lost");
        let commitCompleted = false;
        const observer = verificationObserver({ after(statement, _client, phase) {
          if (phase.number === 2 && statement === "COMMIT") {
            // The actual PostgreSQL COMMIT has completed before this transport-
            // acknowledgment stand-in throws. A subsequent ROLLBACK cannot undo it.
            commitCompleted = true; throw failure;
          }
        } });
        const memory = memoryVerificationStorage(fixture, [observer], { inspectMismatch: invalid, existingVerified: true });
        try {
          await assert.rejects(() => verify(observer, memory, fixture), error => error === failure);
          assert.equal(commitCompleted, true); assertVerificationPhase(observer.phases[1], "ROLLBACK");
          assert.deepEqual(observer.phases[1].trace.slice(-2), ["COMMIT", "ROLLBACK"]);
          const after = await verificationState(fixture.workfileId);
          const asset = assertVerificationOnlyAssetChanged(before, after, fixture, invalid ? "rejected" : "verified");
          assert.equal(asset.capture_metadata.synthetic_verification, true);
          assert.equal(asset.capture_metadata.expected_byte_size, verificationPng.length);
          if (invalid) {
            assert.equal(asset.object_key, fixture.sourceKey); assert.equal(asset.checksum_sha256, null);
            assert.equal(asset.verified_at, null);
            assert.deepEqual(asset.capture_metadata, { expected_byte_size: verificationPng.length, synthetic_verification: true,
              verification_error: "uploaded_object_does_not_match_request",
              inspected: { byte_size: verificationPng.length + 1, content_type: "image/png", etag: "synthetic-inspected" } });
          } else {
            assert.equal(asset.object_key, fixture.verifiedKey); assert.equal(asset.checksum_sha256, verificationChecksum);
            assert.equal(Number(asset.byte_size), verificationPng.length); assert.ok(asset.verified_at && asset.uploaded_at);
            assert.deepEqual(asset.capture_metadata, { expected_byte_size: verificationPng.length, synthetic_verification: true,
              storage_etag: "synthetic-copied", verified_dimensions: { width: 1, height: 1, pixels: 1 }, verified_object_immutable: true });
          }
          assert.equal(memory.calls.some(call => call.method === "delete"), false);
          assert.deepEqual(memory.objects.get(fixture.sourceKey), verificationPng);
          assert.deepEqual(memory.objects.get(fixture.verifiedKey), verificationPng);
        } finally { observer.forceRelease(); }
      });
    }
    const completionState = async (workfileId) => {
      const state = await cleanupState(pool, workfileId);
      const workfile = (await pool.query("SELECT * FROM appraisal.uad_workfiles WHERE id = $1", [workfileId])).rows;
      return JSON.parse(JSON.stringify({ state, workfile }));
    };
    const withCompletionWorkfile = (before, row) => {
      const expected = structuredClone(before);
      expected.workfile = JSON.parse(JSON.stringify([row]));
      expected.state.canonical.workfile = expected.workfile.map(({ current_revision, status, signed_at, updated_at }) => ({
        current_revision, status, signed_at, updated_at,
      }));
      return expected;
    };
    const assertCompletionTargetDenied = (trace) => {
      assertGuardFirst(trace);
      assert.equal(trace[1], COMPLETION_WORKFILE_LOCK);
      assert.equal(trace.length, 4, "target refusal must follow only BEGIN, locked workfile, signature check and ROLLBACK");
      assert.match(trace[2], /^SELECT EXISTS \( SELECT 1 FROM appraisal\.uad_signatures WHERE workfile_id = \$1 \) AS has_signatures$/);
    };
    const assertCompletionApplied = async (fixture, before, result) => {
      assert.equal(result.current_revision, 2);
      assert.equal(result.applied_suggestion_count, 1);
      assert.equal(result.applied_field_count, 1);
      assert.equal(result.applied_entity_count, 0);
      assert.deepEqual(result.created_entities, []);
      const after = await completionState(fixture.workfileId);
      const canonical = after.state.canonical;
      assert.equal(before.state.canonical.values.length, 0);
      assert.equal(canonical.values.length, 1);
      const saved = canonical.values[0];
      assert.equal(saved.field_context, "sales_comparison_summary");
      assert.equal(saved.uad_uid, "1300.0006");
      assert.equal(saved.value, 302000);
      assert.equal(saved.source_type, "homenode");
      assert.equal(saved.is_appraiser_confirmed, true);
      assert.equal(canonical.revisions.length, before.state.canonical.revisions.length + 1);
      const revision = canonical.revisions.at(-1);
      assert.equal(revision.revision_number, 2);
      assert.equal(revision.document.field_values.length, 1);
      assert.deepEqual(revision.document.field_values[0], {
        entity_id: null, uid: saved.uad_uid, context_key: saved.field_context,
        report_field_id: saved.report_field_id, value: saved.value,
        source_type: "homenode", is_appraiser_confirmed: true,
      });
      assert.equal(canonical.audit.length, before.state.canonical.audit.length + 1);
      const audit = canonical.audit.find((row) => row.event_type === "uad_completion_suggestions.applied");
      assert.ok(audit);
      assert.equal(audit.actor_user_id, fixture.actorUserId);
      assert.deepEqual(audit.after_data, { applied_suggestion_ids: fixture.request.selected_suggestion_ids, created_entities: [] });
      assert.equal(audit.metadata.revision_number, 2);
      assert.equal(audit.metadata.source_digest_sha256, fixture.request.expected_source_digest_sha256);
      assert.equal(after.workfile[0].current_revision, 2);
      assert.equal(after.workfile[0].status, "draft");
      assert.ok(Date.parse(after.workfile[0].updated_at) >= Date.parse(before.workfile[0].updated_at));
      const comparable = withCompletionWorkfile(after, before.workfile[0]);
      comparable.state.canonical.values = [];
      comparable.state.canonical.revisions = canonical.revisions.slice(0, -1);
      comparable.state.canonical.audit = canonical.audit.filter((row) => row.id !== audit.id);
      assert.deepEqual(comparable, before,
        "one authorized suggestion must preserve previous snapshots, assets, entities, signatures, history and audit");
      const currentIdentity = { ...after.workfile[0], current_revision: before.workfile[0].current_revision,
        status: before.workfile[0].status, updated_at: before.workfile[0].updated_at };
      assert.deepEqual(currentIdentity, before.workfile[0], "completion may not rewrite organization or signer slots");
      return after;
    };

    await t.test("unsigned completion without an internal confirmation receipt refuses before source reads", async () => {
      const fixture = await createCompletionFixture(), before = await completionState(fixture.workfileId);
      const observed = fixedObservedPool(await pool.connect());
      try {
        await assert.rejects(() => applyUadCompletionSuggestions(
          observed.pool, fixture.workfileId, fixture.request, fixture.actorUserId,
        ), { message: COMPLETION_ACCESS_ERROR });
        assertCompletionTargetDenied(observed.trace);
        assert.deepEqual(await completionState(fixture.workfileId), before);
      } finally { observed.forceRelease(); }
    });
    for (const signerRole of ["appraiser", "supervisory_appraiser"]) {
      await t.test(`matching ${signerRole} completion receipt preserves real apply and audit attribution`, async () => {
        const fixture = await createCompletionFixture(signerRole), before = await completionState(fixture.workfileId);
        const lockedParameters = [];
        const observed = fixedObservedPool(await pool.connect(), { before(statement, _client, values) {
          if (statement === COMPLETION_WORKFILE_LOCK) lockedParameters.push(values);
        } });
        try {
          const result = await applyUadCompletionSuggestions(
            observed.pool, signerRole === "appraiser" ? fixture.workfileId.toUpperCase() : fixture.workfileId,
            fixture.request, fixture.actorUserId, fixture.receipt,
          );
          assert.equal(observed.trace[0], READ_COMMITTED_BEGIN);
          assert.equal(observed.trace[1], COMPLETION_WORKFILE_LOCK);
          assert.equal(observed.trace.at(-1), "COMMIT");
          assert.deepEqual(lockedParameters, [[fixture.workfileId]], "UUID URL casing must resolve to the canonical locked receipt target");
          await assertCompletionApplied(fixture, before, result);
        } finally { observed.forceRelease(); }
      });
    }

    for (const drift of ["organization", "assigned appraiser", "supervisory slot"]) {
      await t.test(`completion waits for administrator-first ${drift} drift and refuses the stale exact target`, async () => {
        const fixture = await createCompletionFixture(drift === "supervisory slot" ? "supervisory_appraiser" : "appraiser");
        const before = await completionState(fixture.workfileId);
        // Both real access and confirmation have already succeeded. The DML is
        // an administrative state change, not a simulated provider/auth result.
        const administrator = await pool.connect(), lockIssued = deferred();
        let administratorTransaction = false, writerClient, observed, saving;
        const isolations = [];
        try {
          writerClient = await pool.connect();
          await writerClient.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          observed = fixedObservedPool(writerClient, {
            before(statement) { if (statement === COMPLETION_WORKFILE_LOCK) lockIssued.resolve(); },
            async after(statement, client) {
              if (statement === READ_COMMITTED_BEGIN) {
                isolations.push((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation);
              }
            },
          });
          await administrator.query(READ_COMMITTED_BEGIN); administratorTransaction = true;
          const changed = drift === "organization"
            ? await administrator.query(
              "UPDATE appraisal.uad_workfiles SET organization_id = $2, updated_at = now() WHERE id = $1 RETURNING *",
              [fixture.workfileId, fixture.otherOrganizationId],
            )
            : drift === "assigned appraiser"
              ? await administrator.query(
                "UPDATE appraisal.uad_workfiles SET assigned_appraiser_user_id = $2, updated_at = now() WHERE id = $1 RETURNING *",
                [fixture.workfileId, fixture.otherUserId],
              )
              : await administrator.query(
                `UPDATE appraisal.uad_workfiles
                    SET supervisory_appraiser_user_id = $2, assigned_appraiser_user_id = $3, updated_at = now()
                  WHERE id = $1 RETURNING *`, [fixture.workfileId, fixture.otherUserId, fixture.actorUserId],
              );
          assert.equal(changed.rowCount, 1);
          const expected = withCompletionWorkfile(before, changed.rows[0]);
          saving = applyUadCompletionSuggestions(observed.pool, fixture.workfileId, fixture.request, fixture.actorUserId, fixture.receipt);
          void saving.catch(() => {});
          await within(lockIssued.promise, "completion requested the administrator-held target lock");
          await assertBlockedBy(pool, writerClient.processID, administrator.processID, `completion ${drift}`);
          assert.deepEqual(observed.trace, [READ_COMMITTED_BEGIN, COMPLETION_WORKFILE_LOCK]);
          await administrator.query("COMMIT"); administratorTransaction = false;
          await assert.rejects(() => within(saving, "completion observes the committed target drift"), { message: COMPLETION_ACCESS_ERROR });
          assert.deepEqual(isolations, ["read committed"]);
          assertCompletionTargetDenied(observed.trace);
          assert.deepEqual(await completionState(fixture.workfileId), expected,
            "denial must preserve the administrator's exact row and every canonical, revision and audit record");
          const newlyAuthorized = await authorizeUadWorkfileAccess(pool, fixture.auth, fixture.workfileId, { write: true });
          const newConfirmation = authorizeUadAppraiserConfirmation(fixture.auth, newlyAuthorized);
          assert.equal(newConfirmation.signerRole, drift === "assigned appraiser" ? "supervisory_appraiser" : "appraiser",
            "broad access or eligibility in the other slot cannot rescue the earlier exact receipt");
        } finally {
          if (administratorTransaction) await administrator.query("ROLLBACK").catch(() => {});
          administrator.release(true);
          if (saving) await within(saving.catch(() => {}), "completion target-drift cleanup").catch(() => {});
          observed?.forceRelease();
          if (writerClient && !observed) writerClient.release(true);
        }
      });
    }

    await t.test("administrator reassignment waits for authorized completion and observes its committed revision", async () => {
      const fixture = await createCompletionFixture(), before = await completionState(fixture.workfileId);
      const writerLocked = deferred(), continueWriter = deferred(), administratorUpdated = deferred(), continueAdministrator = deferred();
      const administrator = await pool.connect();
      let writerClient, observed, saving, reassigning, administratorTransaction = false, abortAdministrator = false;
      let changedRow;
      try {
        writerClient = await pool.connect();
        observed = fixedObservedPool(writerClient, { async after(statement) {
          if (statement === COMPLETION_WORKFILE_LOCK) {
            writerLocked.resolve(); await continueWriter.promise;
          }
        } });
        saving = applyUadCompletionSuggestions(observed.pool, fixture.workfileId, fixture.request, fixture.actorUserId, fixture.receipt);
        void saving.catch(() => {});
        await within(writerLocked.promise, "authorized completion owns its target lock");
        reassigning = (async () => {
          await administrator.query(READ_COMMITTED_BEGIN); administratorTransaction = true;
          const changed = await administrator.query(
            `UPDATE appraisal.uad_workfiles
                SET organization_id = $2, assigned_appraiser_user_id = $3,
                    supervisory_appraiser_user_id = $3, updated_at = now()
              WHERE id = $1 RETURNING *`, [fixture.workfileId, fixture.otherOrganizationId, fixture.otherUserId],
          );
          assert.equal(changed.rowCount, 1);
          changedRow = changed.rows[0]; administratorUpdated.resolve();
          await continueAdministrator.promise;
          if (abortAdministrator) await administrator.query("ROLLBACK");
          else await administrator.query("COMMIT");
          administratorTransaction = false;
        })();
        void reassigning.catch(() => {});
        await assertBlockedBy(pool, administrator.processID, writerClient.processID, "administrator versus authorized completion");
        assert.deepEqual(await completionState(fixture.workfileId), before);
        continueWriter.resolve();
        const result = await within(saving, "authorized completion commits before reassignment");
        await within(administratorUpdated.promise, "administrator sees the committed completion row");
        assert.equal(changedRow.current_revision, 2); assert.equal(changedRow.status, "draft");
        assert.equal(observed.trace[0], READ_COMMITTED_BEGIN);
        assert.equal(observed.trace[1], COMPLETION_WORKFILE_LOCK);
        assert.equal(observed.trace.at(-1), "COMMIT");
        const applied = await assertCompletionApplied(fixture, before, result);
        continueAdministrator.resolve();
        await within(reassigning, "administrator commits after the authorized apply");
        assert.deepEqual(await completionState(fixture.workfileId), withCompletionWorkfile(applied, changedRow));
      } finally {
        abortAdministrator = true; continueWriter.resolve(); continueAdministrator.resolve();
        if (saving) await within(saving.catch(() => {}), "apply-first writer cleanup").catch(() => {});
        observed?.forceRelease();
        if (writerClient && !observed) writerClient.release(true);
        if (reassigning) await within(reassigning.catch(() => {}), "apply-first administrator cleanup").catch(() => {});
        if (administratorTransaction) await administrator.query("ROLLBACK").catch(() => {});
        administrator.release(true);
      }
    });

    await t.test("signed completion with a mismatched receipt retains lifecycle-error precedence", async () => {
      const fixture = await createCompletionFixture();
      await pool.query(
        "UPDATE appraisal.uad_workfiles SET status = 'signed', signed_at = now(), organization_id = $2 WHERE id = $1",
        [fixture.workfileId, fixture.otherOrganizationId],
      );
      await insertSyntheticSignature(pool, fixture.identity, fixture);
      const before = await completionState(fixture.workfileId), observed = fixedObservedPool(await pool.connect());
      try {
        await assert.rejects(() => applyUadCompletionSuggestions(
          observed.pool, fixture.workfileId, fixture.request, fixture.actorUserId, fixture.receipt,
        ), { message: LOCKED_ERROR });
        assertGuardFirst(observed.trace);
        assert.equal(observed.trace[1], COMPLETION_WORKFILE_LOCK);
        assert.deepEqual(await completionState(fixture.workfileId), before);
      } finally { observed.forceRelease(); }
    });
  } finally {
    await pool.end();
  }
});
