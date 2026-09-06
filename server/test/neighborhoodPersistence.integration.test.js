import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment, canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import { createNeighborhoodAssessmentRepository, neighborhoodMemberSetDigest, neighborhoodMemberContentDigest, prepareNeighborhoodPublication } from "../src/services/neighborhoodAssessment/assessmentRepository.js";
import { neighborhoodMappedManifestDigest, prepareNeighborhoodApplicationGroup, buildNeighborhoodApplicationReceipt } from "../src/services/neighborhoodAssessment/applicationGroup.js";
import { persistNeighborhoodAttachment, getNeighborhoodAttachment, getAcceptedNeighborhoodApplication, getAcceptedNeighborhoodApplicationRecord, recordNeighborhoodApplicationAcceptance } from "../src/services/neighborhoodAssessment/applicationRepository.js";
import { assertNeighborhoodJsonbStorage } from "../src/services/neighborhoodAssessment/jsonbStorage.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "./fixtures/neighborhoodAssessmentFixture.js";
import { checkedNeighborhoodDatabaseUrl as checkedDatabaseUrl, neighborhoodCiDatabasePlan,
  verifyNeighborhoodCiConnection, prepareNeighborhoodCiDatabase, NEIGHBORHOOD_CI_IDENTITY_SQL } from "./helpers/neighborhoodCiDatabase.js";
import { devNull } from "node:os";
import { checkNeighborhoodCohortBlobDatabase } from "./helpers/neighborhoodCohortBlobDatabaseChecks.js";

// Run only against a fresh GitHub CI child database prepared by the ordinary
// UAD/mobile scripts. Never add records to the shared runner database or delete
// fixtures; the ephemeral service teardown owns disposal of this child database.
// Actual canonical tables exercise publication/locks. Private rollback schemas
// below are only absence probes, not substitutes for canonical migration tests.
test("neighborhood PG guard rejects unsafe targets before importing pg or connecting", () => {
  for (const value of ["postgres://example.com/app_test", "postgres://127.0.0.1/app", "postgres://127.0.0.1/app_test?host=remote",
    "postgres://127.0.0.1/a/b_test", "postgres://127.0.0.1/app_test#ignored", "https://127.0.0.1/app_test", "not a URL"]) {
    assert.throws(() => checkedDatabaseUrl(value, "test"));
  }
  assert.throws(() => checkedDatabaseUrl("postgres://127.0.0.1/app_test", "production"));
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.equal(checkedDatabaseUrl(`postgres://${host}/neighborhood_test`, "test").databaseName, "neighborhood_test");
  }
});

test("neighborhood child database is CI-only, uniquely named, and cannot inherit connection overrides", () => {
  const env = { NODE_ENV: "test", GITHUB_ACTIONS: "true", CI: "true",
    DATABASE_URL: "postgres://user:secret@127.0.0.1:5432/parent_test", PATH: "/preserved/path",
    PGHOST: "remote", PGDATABASE: "production", DOTENV_CONFIG_OVERRIDE: "true",
    DOTENV_CONFIG_PATH: "/unexpected/.env", DOTENV_KEY: "secret", NODE_OPTIONS: "--require malicious", NODE_PATH: "/unexpected" };
  const plan = neighborhoodCiDatabasePlan(env, "00000000-0000-4000-8000-000000000001");
  assert.match(plan.child.databaseName, /^neighborhood_[a-f0-9]{32}_test$/);
  assert.ok(Buffer.byteLength(plan.child.databaseName) < 63);
  assert.notEqual(plan.parent.databaseName, plan.child.databaseName);
  assert.equal(new URL(plan.child.connectionString).host, "127.0.0.1:5432");
  assert.equal(plan.env.DATABASE_URL, plan.child.connectionString);
  assert.equal(plan.env.PATH, env.PATH);
  assert.equal(plan.env.DOTENV_CONFIG_PATH, devNull);
  for (const key of ["PGHOST", "PGDATABASE", "DOTENV_CONFIG_OVERRIDE", "DOTENV_KEY", "NODE_OPTIONS", "NODE_PATH"]) {
    assert.equal(Object.hasOwn(plan.env, key), false);
  }
  assert.equal(env.DATABASE_URL, "postgres://user:secret@127.0.0.1:5432/parent_test");
  assert.deepEqual(plan.scripts, ["prepareUadCiDatabase.js", "runUadMigrations.js", "prepareMobileCiDatabase.js", "runMobileMigrations.js"]);
  for (const key of ["NODE_ENV", "GITHUB_ACTIONS", "CI"]) for (const value of [undefined, "false", "TRUE", "production"]) {
    assert.throws(() => neighborhoodCiDatabasePlan({ ...env, [key]: value }), error => !error.message.includes("secret"));
  }
  for (const nonce of ["bad", 'name";DROP DATABASE parent_test;', "a".repeat(80)]) {
    assert.throws(() => neighborhoodCiDatabasePlan(env, nonce));
  }
  assert.throws(() => neighborhoodCiDatabasePlan({ ...env, DATABASE_URL: plan.child.connectionString }, "00000000-0000-4000-8000-000000000001"));
});

test("neighborhood CI bootstrap verifies actual database and loopback socket before CREATE", () => {
  assert.match(NEIGHBORHOOD_CI_IDENTITY_SQL, /host\(inet_server_addr\(\)\)/);
  assert.doesNotMatch(NEIGHBORHOOD_CI_IDENTITY_SQL, /inet_server_addr\(\)::text/);
  const identity = { database_name: "parent_test", server_address: "172.18.0.2" };
  for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.doesNotThrow(() => verifyNeighborhoodCiConnection(identity, remote, "parent_test"));
  }
  for (const remote of [undefined, "172.18.0.2", "8.8.8.8", "127.evil"]) {
    assert.throws(() => verifyNeighborhoodCiConnection(identity, remote, "parent_test"));
  }
  for (const server_address of [null, "8.8.8.8", "172.32.0.1", "unresolved"]) {
    assert.throws(() => verifyNeighborhoodCiConnection({ ...identity, server_address }, "127.0.0.1", "parent_test"));
  }
  assert.throws(() => verifyNeighborhoodCiConnection(identity, "127.0.0.1", "wrong_test"));
});

const prerequisites = ["app_auth.organizations", "app_auth.users", "core.accounts", "app.appraisal_cases",
  "app.appraisal_subject_snapshots", "app.report_files", "app.assignment_files", "appraisal.uad_workfiles",
  "appraisal.uad_revisions", "appraisal.uad_audit_events"];
const date = "2024-06-30";
const json = value => JSON.stringify(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function within(promise, label, milliseconds = 2500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function rollbackFixture(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='8s'");
    return await operation(client);
  } finally { await client.query("ROLLBACK"); client.release(); }
}
async function rejectsSql(client, sql, values, pattern) {
  await client.query("SAVEPOINT invalid_fixture");
  try { await assert.rejects(client.query(sql, values), pattern); }
  finally { await client.query("ROLLBACK TO SAVEPOINT invalid_fixture"); }
}

// Hooks pause between real PostgreSQL statements; they do not fabricate query
// results. This permits deterministic lease-expiry and two-client lock oracles.
function observingPool(pool, { before, after } = {}) {
  return { query: (...args) => pool.query(...args), async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), async query(sql, values) {
      const tag = sql.match(/\/\* neighborhood:([a-z-]+) \*\//)?.[1];
      await before?.(tag, client, values);
      const result = await client.query(sql, values);
      await after?.(tag, client, result);
      return result;
    } };
  } };
}

async function identityFixture(pool, options = {}) {
  const organization_id = randomUUID(), actor_user_id = randomUUID(), appraisal_case_id = randomUUID(), subject_snapshot_id = randomUUID();
  const accounts = Array.from({ length: 4 }, () => `neighborhood-pg-${randomUUID()}`);
  const scope = { organization_id, appraisal_case_id, subject_snapshot_id, account_id: accounts[0] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO app_auth.organizations (id,legal_name,display_name) VALUES ($1,'Synthetic neighborhood PG test','Synthetic neighborhood PG test')", [organization_id]);
    await client.query("INSERT INTO app_auth.users (id,email,display_name) VALUES ($1,$2,'Synthetic neighborhood reviewer')", [actor_user_id, `${actor_user_id}@example.test`]);
    for (const id of accounts) await client.query("INSERT INTO core.accounts (account_id,address,city) VALUES ($1,'Synthetic test only','Dallas')", [id]);
    await client.query("INSERT INTO app.appraisal_cases (id,organization_id,account_id,effective_date,created_by_user_id) VALUES ($1,$2,$3,$4,$5)",
      [appraisal_case_id, organization_id, scope.account_id, Object.hasOwn(options, "case_date") ? options.case_date : date, actor_user_id]);
    await client.query(`INSERT INTO app.appraisal_subject_snapshots (id,appraisal_case_id,snapshot_version,effective_date,subject_data,created_by_user_id)
      VALUES ($1,$2,1,$3,'{"synthetic":true}',$4)`, [subject_snapshot_id, appraisal_case_id, Object.hasOwn(options, "snapshot_date") ? options.snapshot_date : date, actor_user_id]);
    const custom = (await client.query(`INSERT INTO app.assignment_files (organization_id,account_id,file_number,created_by_user_id)
      VALUES ($1,$2,$3,$4) RETURNING id`, [organization_id, scope.account_id, `PG-${randomUUID()}`, actor_user_id])).rows[0];
    const customReportId = randomUUID();
    await client.query(`INSERT INTO app.report_files (id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
      VALUES ($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [customReportId, organization_id, scope.account_id, `PG-${randomUUID()}`, custom.id, appraisal_case_id, subject_snapshot_id]);
    await client.query("COMMIT");
    return { scope, accounts, actor_user_id, customId: Number(custom.id), customReportId };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function uadFixture(pool, identity) {
  const workfileId = randomUUID(), reportFileId = randomUUID(), initialRevisionId = randomUUID();
  const release = (await pool.query(`SELECT release_key FROM uad_ref.fields
    WHERE (uid,property_context) IN (('3000.0008','market'),('3000.0029','market_total_sales'),('3000.0051','market_price_trend_source'))
    GROUP BY release_key HAVING count(*)=3 ORDER BY release_key LIMIT 1`)).rows[0]?.release_key;
  assert.ok(release, "Ordinary UAD migrations must provide their pinned specification release");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO appraisal.uad_workfiles
      (id,organization_id,account_id,file_number,specification_release_key,current_revision,created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,1,$6)`, [workfileId, identity.scope.organization_id, identity.scope.account_id, `PG-UAD-${randomUUID()}`, release, identity.actor_user_id]);
    await client.query(`INSERT INTO app.report_files
      (id,organization_id,account_id,workflow_type,file_number,uad_workfile_id,appraisal_case_id,subject_snapshot_id)
      VALUES ($1,$2,$3,'uad_3_6',$4,$5,$6,$7)`, [reportFileId, identity.scope.organization_id, identity.scope.account_id,
      `PG-UAD-${randomUUID()}`, workfileId, identity.scope.appraisal_case_id, identity.scope.subject_snapshot_id]);
    await client.query(`INSERT INTO appraisal.uad_revisions
      (id,workfile_id,revision_number,specification_release_key,document,created_by_user_id)
      VALUES ($1,$2,1,$3,'{"synthetic":true,"values":{}}',$4)`, [initialRevisionId, workfileId, release, identity.actor_user_id]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  return { workfileId, reportFileId, release, initialRevisionId, sourceEntityId: randomUUID() };
}

function applicationFixture(identity, uad, assessment) {
  const group = assessment.application_group;
  const suggestions = [
    { id: "boundary", target_key: "root:3000.0008", value: "North Road", dependency_ids: ["source"],
      evidence_refs: ["geographic_neighborhood", "population:stock-a"], application_group_id: group.id },
    { id: "median", target_key: "root:3000.0029", value: 330000, dependency_ids: ["boundary", "source"],
      evidence_refs: ["statistic:median-sale-price", "population:sales-a"], application_group_id: group.id },
    { id: "source", target_key: `${uad.sourceEntityId}:3000.0051`, value: "Synthetic neighborhood source", dependency_ids: [],
      evidence_refs: group.source_refs.map(id => `source:${id}`), application_group_id: group.id },
  ];
  const attachment = buildNeighborhoodAttachment(assessment, { ...neighborhoodTargetFixture(), scope: identity.scope,
    attachment_id: randomUUID(), report_file_id: uad.reportFileId, uad_workfile_id: uad.workfileId, editor_revision: 1,
    specification_release: uad.release, mapped_manifest_sha256: neighborhoodMappedManifestDigest(suggestions) });
  const preflight = { attachment, group, suggestions, selected_ids: suggestions.map(item => item.id),
    expected_binding_digest: attachment.binding_digest_sha256, current_application_identity_sha256: attachment.application_identity_sha256,
    current_editor_revision: 1, existing_values: suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    // Synthetic mapper/cross-field fixture only; not a UAD catalog/compliance oracle.
    validate_final_group: () => ({ valid: true, issues: [] }) };
  const plan = prepareNeighborhoodApplicationGroup(preflight);
  assert.equal(plan.status, "ready"); assert.equal(plan.writes.length, 3);
  const receipt = buildNeighborhoodApplicationReceipt(plan, 2);
  const lookup = { organizationId: identity.scope.organization_id, reportFileId: uad.reportFileId,
    workflowType: "uad_3_6", workflowTargetId: uad.workfileId, attachmentId: attachment.attachment_id,
    attachmentRevision: attachment.attachment_revision, applicationIdentitySha256: attachment.application_identity_sha256 };
  return { assessment, attachment, suggestions, preflight, plan, receipt, lookup };
}

// Simulates the owning adapter's complete transaction, not product catalog
// generation: all synthetic mapped values, UAD revision/audit and receipt use
// one client. A failure in the final helper must roll ALL owner writes back.
async function acceptSyntheticUad(pool, identity, uad, application, { invalidAudit = false, afterRecord } = {}) {
  const client = await pool.connect(), operationId = randomUUID(), revisionId = randomUUID();
  try {
    await client.query("BEGIN");
    const current = (await client.query("SELECT current_revision,status,signed_at FROM appraisal.uad_workfiles WHERE id=$1 FOR UPDATE", [uad.workfileId])).rows[0];
    await client.query("SELECT id FROM app.report_files WHERE id=$1 AND uad_workfile_id=$2 FOR UPDATE", [uad.reportFileId, uad.workfileId]);
    assert.equal(current.current_revision, 1); assert.equal(current.signed_at, null); assert.equal(current.status, "draft");
    const document = { synthetic: true, values: Object.fromEntries(application.plan.writes.map(item => [item.target_key, item.value])),
      neighborhood_provenance: application.plan.acceptance_manifest.provenance_digest };
    await client.query(`INSERT INTO appraisal.uad_entities (id,workfile_id,entity_type,entity_identifier,label,data)
      VALUES ($1,$2,'market_price_trend_source','synthetic-neighborhood-source','Synthetic neighborhood source','{"synthetic":true}')`, [uad.sourceEntityId, uad.workfileId]);
    for (const field of [
      { id: "boundary", uid: "3000.0008", context: "market", entity: null },
      { id: "median", uid: "3000.0029", context: "market_total_sales", entity: null },
      { id: "source", uid: "3000.0051", context: "market_price_trend_source", entity: uad.sourceEntityId },
    ]) {
      const catalog = (await client.query("SELECT report_field_id FROM uad_ref.fields WHERE release_key=$1 AND uid=$2 AND property_context=$3", [uad.release, field.uid, field.context])).rows[0];
      assert.ok(catalog, `Missing pinned test catalog field ${field.uid}`);
      await client.query(`INSERT INTO appraisal.uad_field_values
        (id,workfile_id,entity_id,uad_uid,report_field_id,value,source_type,source_reference,updated_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,'calculated',$7,$8)`, [randomUUID(), uad.workfileId, field.entity, field.uid, catalog.report_field_id,
        json(application.suggestions.find(item => item.id === field.id).value), `neighborhood:${application.attachment.attachment_id}`, identity.actor_user_id]);
    }
    await client.query("UPDATE appraisal.uad_workfiles SET current_revision=2 WHERE id=$1", [uad.workfileId]);
    await client.query(`INSERT INTO appraisal.uad_revisions
      (id,workfile_id,revision_number,specification_release_key,document,created_by_user_id)
      VALUES ($1,$2,2,$3,$4,$5)`, [revisionId, uad.workfileId, uad.release, json(document), identity.actor_user_id]);
    const attachment = application.attachment, manifest = application.receipt.acceptance_manifest;
    const metadata = { operation_id: operationId, uad_revision_id: revisionId, uad_revision_number: 2,
      application_identity_sha256: attachment.application_identity_sha256, receipt_digest_sha256: application.receipt.receipt_digest_sha256,
      mapped_manifest_sha256: attachment.mapped_manifest_sha256, prepared_values_sha256: manifest.prepared_values_sha256 };
    const after = { attachment_id: attachment.attachment_id, assessment_id: attachment.assessment_id, assessment_revision: attachment.assessment_revision,
      application_group_id: attachment.application_group_id, application_group_revision: attachment.application_group_revision,
      applied_suggestion_ids: manifest.applied.map(item => item.id), reused_suggestion_ids: manifest.reused.map(item => item.id) };
    const audit = (await client.query(`INSERT INTO appraisal.uad_audit_events
      (workfile_id,actor_user_id,event_type,entity_type,entity_id,after_data,metadata)
      VALUES ($1,$2,$3,'uad_neighborhood_application',$4,$5,$6) RETURNING id`, [uad.workfileId, identity.actor_user_id,
      invalidAudit ? "synthetic.incorrect_event" : "uad_neighborhood_assessment.applied", operationId, json(after), json(metadata)])).rows[0];
    const input = { attachmentId: attachment.attachment_id, applicationIdentitySha256: attachment.application_identity_sha256,
      operationId, actorUserId: identity.actor_user_id, uadRevisionId: revisionId, uadRevisionNumber: 2, auditEventId: audit.id, receipt: application.receipt };
    const result = await recordNeighborhoodApplicationAcceptance(client, input);
    // This SAME owner client can read its uncommitted acceptance. A returned
    // verified record is not a COMMIT acknowledgment or a catalog/authority proof.
    const record = await getAcceptedNeighborhoodApplicationRecord(client, application.lookup);
    assert.deepEqual(record, { record_version: 1, application_id: result.application_id,
      operation_id: operationId, actor_user_id: identity.actor_user_id, accepted_editor_revision: 2,
      uad_revision_id: revisionId, uad_audit_event_id: String(audit.id), receipt: application.receipt });
    assert.ok(Object.isFrozen(record)); assert.ok(Object.isFrozen(record.receipt));
    assert.equal(typeof record.uad_audit_event_id, "string");
    const core = await getAcceptedNeighborhoodApplication(client, application.lookup);
    assert.equal(canonicalAssessmentJson(record.receipt), canonicalAssessmentJson(core));
    await afterRecord?.({ result, input, document, record });
    await client.query("COMMIT"); return { result, input, document, record };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

function publicationFixture(identity, label = "initial") {
  const assessment = neighborhoodAssessmentFixture();
  assessment.scope = identity.scope;
  assessment.methodology.configuration.fixture_run = identity.scope.appraisal_case_id;
  assessment.methodology.configuration.fixture_variant = label;
  const sources = [{ id: "fixture-source", payload: { fixture: "neighborhood-v1" } }];
  const row = (population_id, member_unit, member_id, account_ids) => ({ population_id, member_unit, member_id, account_ids,
    member_data: { source_refs: ["fixture-source"], synthetic: true } });
  const members = [...identity.accounts.map(id => row("stock-a", "property", id, [id])),
    row("sales-a", "canonical_transaction", "T1", [identity.accounts[0]]),
    row("sales-a", "canonical_transaction", "T2", [identity.accounts[0]]),
    row("sales-a", "canonical_transaction", "T3", [identity.accounts[1]])];
  for (const population of assessment.populations) {
    const rows = members.filter(member => member.population_id === population.id);
    population.member_set_sha256 = neighborhoodMemberSetDigest(rows.map(member => member.member_id));
    const id = `population-members:${population.id}`;
    const payload = { capture_type: "neighborhood_population_members_v1", population_id: population.id,
      member_unit: population.member_unit, member_content_sha256: neighborhoodMemberContentDigest(rows) };
    sources.push({ id, payload });
    assessment.source_snapshots.push({ ...assessment.source_snapshots[0], id, content_sha256: assessmentEvidenceDigest(payload) });
    population.source_refs.push(id);
  }
  return { assessment: buildNeighborhoodAssessment(assessment), members, sources };
}
function requestFor(data) {
  return { operation_id: randomUUID(), effective_date: date, data_cutoff: date, input_signature_sha256: data.assessment.input_signature_sha256,
    payload: { synthetic: true, assessment_signature: data.assessment.input_signature_sha256 } };
}
test("PostgreSQL publication fixtures pass the exact pure content contract without a database", () => {
  const identity = { scope: { organization_id: randomUUID(), appraisal_case_id: randomUUID(), subject_snapshot_id: randomUUID(), account_id: "SYNTHETIC-P1" },
    accounts: ["SYNTHETIC-P1", "SYNTHETIC-P2", "SYNTHETIC-P3", "SYNTHETIC-P4"] };
  const data = publicationFixture(identity);
  const prepared = prepareNeighborhoodPublication(data.assessment, data.members, data.sources);
  assert.equal(prepared.members.length, 7); assert.equal(prepared.sources.length, 3);
  assert.notEqual(publicationFixture(identity, "B").assessment.input_signature_sha256, data.assessment.input_signature_sha256);
  const application = applicationFixture(identity, { workfileId: randomUUID(), reportFileId: randomUUID(), sourceEntityId: randomUUID(), release: "synthetic-pinned-release" }, prepared.assessment);
  assert.equal(application.receipt.accepted_editor_revision, 2);
  assert.equal(application.receipt.acceptance_manifest.applied.length, 3);
});
async function claimOne(repository, expectedId) {
  const claims = await repository.claim();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, expectedId, "Dedicated test DB must not contain another run's pending neighborhood jobs");
  return claims[0];
}
const publish = (repository, claim, data) => repository.publish(claim, data.assessment, data.members, data.sources);
async function revisionCounts(pool, assessmentId) {
  const tables = ["revisions", "sources", "populations", "members"];
  return Object.fromEntries(await Promise.all(tables.map(async name => [name, Number((await pool.query(
    `SELECT count(*) AS count FROM app.neighborhood_assessment_${name} WHERE assessment_id=$1`, [assessmentId])).rows[0].count)])));
}

async function insertRawAttachment(client, attachment, suggestions = []) {
  return client.query(`INSERT INTO app.neighborhood_assessment_attachments
    (attachment_id,attachment_revision,assessment_id,assessment_revision,report_file_id,organization_id,workflow_type,
     custom_assignment_file_id,uad_workfile_id,application_identity_sha256,binding_digest_sha256,mapped_suggestions,attachment)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [attachment.attachment_id, attachment.attachment_revision,
    attachment.assessment_id, attachment.assessment_revision, attachment.report_file_id, attachment.scope.organization_id,
    attachment.workflow_type, attachment.custom_assignment_file_id, attachment.uad_workfile_id, attachment.application_identity_sha256,
    attachment.binding_digest_sha256, json(suggestions), json(attachment)]);
}

async function privateAbsenceProbes(pool, sql) {
  await rollbackFixture(pool, async client => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemas = Object.fromEntries(["app", "app_auth", "core", "appraisal", "gis"].map(name => [name, `np_${suffix}_${name}`]));
    // Audited substitution is schema qualification only, plus the fixed function
    // search_path. Parent LIKE copies are private and never rename real tables.
    const qualify = statement => statement.replace(/\b(app_auth|appraisal|core|app|gis)(?=\.)/g, name => schemas[name])
      .replaceAll("SET search_path = pg_catalog, app AS", `SET search_path = pg_catalog, ${schemas.app} AS`);
    for (const schema of Object.values(schemas).filter(value => value !== schemas.gis)) await client.query(`CREATE SCHEMA ${schema}`);
    for (const table of prerequisites.filter(name => name !== "app_auth.users")) {
      await client.query(`CREATE TABLE ${qualify(table)} (LIKE ${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    }
    await rejectsSql(client, qualify(sql), [], /neighborhood_identity_prerequisite_missing/);
    assert.equal((await client.query("SELECT to_regclass($1) AS relation", [`${schemas.app}.neighborhood_assessments`])).rows[0].relation, null);
    await client.query(`CREATE TABLE ${schemas.app_auth}.users (LIKE app_auth.users INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    await client.query(qualify(sql)); // Optional GIS namespace entirely absent.
    await client.query(`CREATE SCHEMA ${schemas.gis}`);
    await client.query(`CREATE TABLE ${schemas.gis}.parcel_geometry (source_id text, payload jsonb)`);
    await client.query(`CREATE TABLE ${schemas.gis}.road_segments (source_id text, payload jsonb)`);
    await client.query(qualify(sql)); // Optional GIS relations present, empty.
    await client.query(`INSERT INTO ${schemas.gis}.parcel_geometry VALUES ('synthetic','{}')`);
    await client.query(`INSERT INTO ${schemas.gis}.road_segments VALUES ('synthetic','{}')`);
    await client.query(qualify(sql)); // Optional GIS relations populated.
    assert.equal(Number((await client.query(`SELECT count(*) AS count FROM ${schemas.app}.neighborhood_assessments`)).rows[0].count), 0);
  });
}

test("neighborhood persistence: real PostgreSQL canonical identities, publication and lease fencing", {
  skip: !process.env.DATABASE_URL, timeout: 360_000,
}, async t => {
  const target = await prepareNeighborhoodCiDatabase();
  const { default: pg } = await import("pg"); // Must remain AFTER every URL guard.
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 5, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: "neighborhood_persistence_integration" });
  const owned = [];
  const repository = createNeighborhoodAssessmentRepository(pool);
  const enqueue = async (identity, data, extra = {}) => {
    const result = await repository.enqueue(identity.scope, { ...requestFor(data), ...extra });
    owned.push({ scope: identity.scope, id: result.job.id, generation: result.request_generation }); return result;
  };
  try {
    const actual = (await pool.query("SELECT current_database() AS name")).rows[0].name;
    assert.equal(actual, target.databaseName);
    for (const name of prerequisites) {
      assert.ok((await pool.query("SELECT to_regclass($1) AS relation", [name])).rows[0].relation,
        `Missing ${name}; prepare canonical schemas with the ordinary test:uad-migration runner`);
    }
    const sql = await readFile(new URL("../migrations/20261010_neighborhood_assessment_persistence.sql", import.meta.url), "utf8");
    // The ordinary runner owns migration registration. Re-execution here tests
    // additive rerun safety without deleting existing application/test records.
    await pool.query(sql); await pool.query(sql);
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM app.neighborhood_assessment_jobs WHERE status IN ('queued','running','retry')")).rows[0].count), 0,
      "Use a dedicated, idle *_test database; pending jobs are not cleaned up or claimed from another run");

    await t.test("required prerequisite fails before DDL; optional GIS absent/empty/populated remains independent", () => privateAbsenceProbes(pool, sql));
    await t.test("cohort blobs retain exact tenant-private bytes, reject mutation and honor caller transactions", () => checkNeighborhoodCohortBlobDatabase(pool));

    await t.test("compact canonical bytes and PostgreSQL jsonb text storage have distinct budgets", async () => {
      const payload = { padding: "x".repeat(1_469_990), values: Array(10_000).fill(0) };
      const canonical = canonicalAssessmentJson(payload);
      assert.equal(Buffer.byteLength(canonical), 1_490_015);
      const stored = Number((await pool.query("SELECT octet_length($1::jsonb::text) AS bytes", [canonical])).rows[0].bytes);
      assert.equal(stored, 1_500_017);
      assert.equal(assertNeighborhoodJsonbStorage(payload), stored);
      assert.ok(stored > 1_500_000, "A valid compact document may exceed that same numeric jsonb::text budget");
      // This is an actual PG representation oracle, not a claim that database
      // formatting is the canonical hash/wire serialization used by the service.
      for (const value of [1e308, 5e-324, 1e-7, -1.25e-8, 1e21, 1.2345e22,
        { "Ω\n\t": "Unicode ☃ and controls\b\f\r\t\n", emoji: "📍", slash: "\\\"" }]) {
        const actual = Number((await pool.query("SELECT octet_length($1::jsonb::text) AS bytes", [canonicalAssessmentJson(value)])).rows[0].bytes);
        assert.equal(assertNeighborhoodJsonbStorage(value), actual);
      }
      assert.throws(() => assertNeighborhoodJsonbStorage({ values: Array(10_000).fill(1e308) }), /jsonb_storage_limit/);
    });

    await t.test("scope and captured-date checks reject foreign tuples and do not leave partial heads", async () => {
      const identity = await identityFixture(pool, { case_date: null });
      const foreign = await identityFixture(pool);
      const data = publicationFixture(identity);
      for (const scope of [{ ...identity.scope, organization_id: foreign.scope.organization_id },
        { ...identity.scope, subject_snapshot_id: foreign.scope.subject_snapshot_id }, { ...identity.scope, account_id: foreign.scope.account_id }]) {
        await assert.rejects(repository.enqueue(scope, requestFor(data)), /scope_mismatch/);
      }
      const accepted = await enqueue(identity, data); // Explicit snapshot date with null case date is allowed.
      await repository.cancel(identity.scope, accepted.job.id, { expected_request_generation: accepted.request_generation });
      await rollbackFixture(pool, async client => {
        await rejectsSql(client, `INSERT INTO app.neighborhood_assessments
          (id,organization_id,appraisal_case_id,subject_snapshot_id,account_id) VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), foreign.scope.organization_id, identity.scope.appraisal_case_id, identity.scope.subject_snapshot_id, identity.scope.account_id], /scope_mismatch/);
        await rejectsSql(client, "UPDATE app.neighborhood_assessments SET organization_id=$2 WHERE id=$1", [accepted.job.assessment_id, foreign.scope.organization_id], /scope_immutable/);
      });
      for (const options of [{ case_date: null, snapshot_date: null }, { case_date: date, snapshot_date: "2024-06-29" }]) {
        const invalid = await identityFixture(pool, options);
        await assert.rejects(repository.enqueue(invalid.scope, requestFor(publicationFixture(invalid))), /effective_date_(unresolved|conflict)/);
        assert.equal(Number((await pool.query("SELECT count(*) AS count FROM app.neighborhood_assessments WHERE appraisal_case_id=$1", [invalid.scope.appraisal_case_id])).rows[0].count), 0);
      }
    });

    await t.test("enqueue deduplicates; exact manifests publish once and published rows are append-only", async () => {
      const identity = await identityFixture(pool), data = publicationFixture(identity);
      const first = await enqueue(identity, data), duplicate = await enqueue(identity, data);
      assert.equal(duplicate.reused, true); assert.equal(duplicate.job.id, first.job.id);
      await assert.rejects(repository.enqueue(identity.scope, { ...requestFor(data), payload: { changed: true } }), /request_conflict/);
      const claim = await claimOne(repository, first.job.id);
      const result = await publish(repository, claim, data);
      assert.equal(result.promoted, true);
      assert.deepEqual(await revisionCounts(pool, first.job.assessment_id), { revisions: 1, sources: 3, populations: 2, members: 7 });
      assert.deepEqual(await repository.getCurrent(identity.scope), result.assessment);
      const page = await repository.getMembers(identity.scope, { assessment_id: result.assessment.id, revision: 1, population_id: "stock-a", limit: 2 });
      assert.equal(page.members.length, 2); assert.ok(page.next_cursor);
      await assert.rejects(publish(repository, claim, data), /claim_lost/);
      await rollbackFixture(pool, async client => {
        for (const table of ["revisions", "sources", "populations", "members"]) {
          await rejectsSql(client, `DELETE FROM app.neighborhood_assessment_${table} WHERE assessment_id=$1`, [result.assessment.id], /immutable/);
        }
        await rejectsSql(client, "UPDATE app.neighborhood_assessment_members SET member_data='{}' WHERE assessment_id=$1", [result.assessment.id], /immutable/);
        await rejectsSql(client, "UPDATE app.neighborhood_assessments SET current_revision=999 WHERE id=$1", [result.assessment.id], /not_published/);
        const next = buildNeighborhoodAssessment({ ...publicationFixture(identity, "invalid-staging").assessment, id: result.assessment.id, revision: 2 });
        await client.query(`INSERT INTO app.neighborhood_assessment_revisions (assessment_id,revision,input_signature_sha256,evidence_digest_sha256,assessment)
          VALUES ($1,2,$2,$3,$4)`, [next.id, next.input_signature_sha256, next.evidence_digest_sha256, json(next)]);
        await rejectsSql(client, "UPDATE app.neighborhood_assessment_revisions SET publication_status='published',published_at=clock_timestamp() WHERE assessment_id=$1 AND revision=2", [next.id], /manifest_mismatch/);
        const population = next.populations[0];
        await client.query(`INSERT INTO app.neighborhood_assessment_populations
          (assessment_id,revision,population_id,member_unit,member_count,unique_property_count,property_link_count,completeness,member_set_sha256,population)
          VALUES ($1,2,$2,$3,$4,$5,$6,$7,$8,$9)`, [next.id, population.id, population.member_unit, population.member_count,
          population.unique_property_count, population.property_link_count, population.completeness, population.member_set_sha256, json(population)]);
        await rejectsSql(client, `INSERT INTO app.neighborhood_assessment_members
          (assessment_id,revision,population_id,member_id,member_unit,account_ids,member_data) VALUES ($1,2,$2,'wrong-unit','listing',$3,'{}')`,
        [next.id, population.id, [identity.accounts[0]]], /foreign key/);
        await rejectsSql(client, `INSERT INTO app.neighborhood_assessment_members
          (assessment_id,revision,population_id,member_id,member_unit,account_ids,member_data) VALUES ($1,2,'missing-population','wrong-population','property',$2,'{}')`,
        [next.id, [identity.accounts[0]]], /foreign key/);
        for (const snapshot of next.source_snapshots) {
          await client.query(`INSERT INTO app.neighborhood_assessment_sources
            (assessment_id,revision,source_id,source_revision,content_sha256,source_snapshot,source_payload)
            VALUES ($1,2,$2,$3,$4,$5,$6)`, [next.id, snapshot.id, snapshot.revision, snapshot.content_sha256,
            json(snapshot), json(data.sources.find(source => source.id === snapshot.id).payload)]);
        }
        for (const other of next.populations.slice(1)) {
          await client.query(`INSERT INTO app.neighborhood_assessment_populations
            (assessment_id,revision,population_id,member_unit,member_count,unique_property_count,property_link_count,completeness,member_set_sha256,population)
            VALUES ($1,2,$2,$3,$4,$5,$6,$7,$8,$9)`, [next.id, other.id, other.member_unit, other.member_count,
            other.unique_property_count, other.property_link_count, other.completeness, other.member_set_sha256, json(other)]);
        }
        for (const member of data.members.slice(0, -1)) {
          await client.query(`INSERT INTO app.neighborhood_assessment_members
            (assessment_id,revision,population_id,member_id,member_unit,account_ids,member_data)
            VALUES ($1,2,$2,$3,$4,$5,$6)`, [next.id, member.population_id, member.member_id, member.member_unit, member.account_ids, json(member.member_data)]);
        }
        await rejectsSql(client, "UPDATE app.neighborhood_assessment_revisions SET publication_status='published',published_at=clock_timestamp() WHERE assessment_id=$1 AND revision=2", [next.id], /exact_member_counts_mismatch/);
      });
      const target = { ...neighborhoodTargetFixture("custom_appraisal"), scope: identity.scope, attachment_id: randomUUID(),
        report_file_id: identity.customReportId, custom_assignment_file_id: identity.customId, mapped_manifest_sha256: assessmentEvidenceDigest([]) };
      const attachment = buildNeighborhoodAttachment(result.assessment, target);
      await rollbackFixture(pool, async client => {
        const insert = `INSERT INTO app.neighborhood_assessment_attachments
          (attachment_id,attachment_revision,assessment_id,assessment_revision,report_file_id,organization_id,workflow_type,
           custom_assignment_file_id,uad_workfile_id,application_identity_sha256,binding_digest_sha256,mapped_suggestions,attachment)
          VALUES ($1,1,$2,1,$3,$4,'custom_appraisal',$5,NULL,$6,$7,'[]',$8)`;
        const values = [attachment.attachment_id, result.assessment.id, identity.customReportId, identity.scope.organization_id,
          identity.customId, attachment.application_identity_sha256, attachment.binding_digest_sha256, json(attachment)];
        const foreign = await identityFixture(pool);
        await rejectsSql(client, insert, values.map((value, index) => index === 2 ? foreign.customReportId : value), /target_mismatch/);
        await client.query(insert, values);
        await rejectsSql(client, "UPDATE app.neighborhood_assessment_attachments SET attachment='{}' WHERE attachment_id=$1", [attachment.attachment_id], /immutable/);
      });
    });

    await t.test("losing the final clock-based fence rolls back all inserted data and promotion", async () => {
      const identity = await identityFixture(pool), data = publicationFixture(identity);
      const { job } = await enqueue(identity, data), claim = await claimOne(repository, job.id);
      const fenced = createNeighborhoodAssessmentRepository(observingPool(pool, { before: async (tag, client) => {
        if (tag === "finish") await client.query("UPDATE app.neighborhood_assessment_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
      } }));
      await assert.rejects(publish(fenced, claim, data), /claim_lost/);
      assert.deepEqual(await revisionCounts(pool, job.assessment_id), { revisions: 0, sources: 0, populations: 0, members: 0 });
      const head = (await pool.query("SELECT current_revision,next_revision FROM app.neighborhood_assessments WHERE id=$1", [job.assessment_id])).rows[0];
      assert.deepEqual(head, { current_revision: null, next_revision: 1 });
      await repository.heartbeat(claim); // The expiry injected in the failed transaction also rolled back.
      await publish(repository, claim, data);
    });

    await t.test("expired leases cannot heartbeat/publish; reclaim rotates authority and exhausted work stops", async () => {
      const identity = await identityFixture(pool), data = publicationFixture(identity);
      const { job } = await enqueue(identity, data, { max_attempts: 2 }), old = await claimOne(repository, job.id);
      const expire = () => pool.query("UPDATE app.neighborhood_assessment_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
      await expire();
      await assert.rejects(repository.heartbeat(old), /claim_lost/);
      await assert.rejects(publish(repository, old, data), /claim_lost/);
      const reclaimed = await claimOne(repository, job.id);
      assert.notEqual(reclaimed.claim_token, old.claim_token); assert.equal(reclaimed.attempts, 2);
      await assert.rejects(repository.fail(old, "stale_worker"), /claim_lost/);
      await assert.rejects(publish(repository, old, data), /claim_lost/);
      await expire(); assert.deepEqual(await repository.claim(), []);
      assert.equal((await repository.getJob(identity.scope, job.id)).status, "failed");
      assert.deepEqual(await revisionCounts(pool, job.assessment_id), { revisions: 0, sources: 0, populations: 0, members: 0 });
    });

    await t.test("two clients heartbeat while publication owns head, without job-to-head inversion", async () => {
      const identity = await identityFixture(pool), data = publicationFixture(identity);
      const { job } = await enqueue(identity, data), claim = await claimOne(repository, job.id);
      const headLocked = deferred(), resumePublish = deferred(), heartbeatUpdated = deferred(), resumeHeartbeat = deferred(), atFence = deferred();
      const publisher = createNeighborhoodAssessmentRepository(observingPool(pool, {
        before: async tag => { if (tag === "publication-fence") atFence.resolve(); },
        after: async tag => { if (tag === "lock-head") { headLocked.resolve(); await resumePublish.promise; } },
      }));
      const heartbeater = createNeighborhoodAssessmentRepository(observingPool(pool, { after: async tag => {
        if (tag === "heartbeat") { heartbeatUpdated.resolve(); await resumeHeartbeat.promise; }
      } }));
      const publication = publish(publisher, claim, data); publication.catch(() => {});
      let heartbeat;
      try {
        await within(headLocked.promise, "publication head lock");
        heartbeat = heartbeater.heartbeat(claim); heartbeat.catch(() => {});
        await within(heartbeatUpdated.promise, "heartbeat must not wait for the immutable head");
        resumePublish.resolve(); await within(atFence.promise, "publication waits for heartbeat's job row");
        resumeHeartbeat.resolve(); await within(heartbeat, "heartbeat commit");
        assert.equal((await within(publication, "publication commit", 5000)).promoted, true);
      } finally {
        resumePublish.resolve(); resumeHeartbeat.resolve();
        await Promise.allSettled([publication, heartbeat].filter(Boolean));
      }
    });

    await t.test("reclaim can complete while a stale publisher owns head and old token cannot publish", async () => {
      const identity = await identityFixture(pool), data = publicationFixture(identity);
      const { job } = await enqueue(identity, data), old = await claimOne(repository, job.id);
      await pool.query("UPDATE app.neighborhood_assessment_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
      const headLocked = deferred(), resume = deferred();
      const publisher = createNeighborhoodAssessmentRepository(observingPool(pool, { after: async tag => {
        if (tag === "lock-head") { headLocked.resolve(); await resume.promise; }
      } }));
      const stale = publish(publisher, old, data); stale.catch(() => {});
      let fresh;
      try {
        await within(headLocked.promise, "stale publisher head lock");
        fresh = await within(claimOne(repository, job.id), "reclaim must not lock head");
      } finally { resume.resolve(); }
      await assert.rejects(stale, /claim_lost/);
      assert.notEqual(fresh.claim_token, old.claim_token);
      await publish(repository, fresh, data);
    });

    await t.test("old requested generation preserves newer intent; newest job alone promotes current", async () => {
      const identity = await identityFixture(pool), a = publicationFixture(identity, "A"), b = publicationFixture(identity, "B");
      const first = await enqueue(identity, a), claimA = await claimOne(repository, first.job.id);
      const second = await enqueue(identity, b), claimB = await claimOne(repository, second.job.id);
      assert.equal(second.job.request_generation, first.job.request_generation + 1);
      assert.equal((await publish(repository, claimA, a)).promoted, false);
      assert.equal(await repository.getCurrent(identity.scope), null);
      const newest = await publish(repository, claimB, b);
      assert.equal(newest.promoted, true); assert.equal(newest.assessment.revision, 2);
      assert.equal((await repository.getCurrent(identity.scope)).input_signature_sha256, b.assessment.input_signature_sha256);
    });

    for (const aAlreadySucceeded of [false, true]) {
      await t.test(`A → B → A restores the exact ${aAlreadySucceeded ? "succeeded" : "running"} job and B cannot promote`, async () => {
        const identity = await identityFixture(pool), a = publicationFixture(identity, "A"), b = publicationFixture(identity, "B");
        const first = await enqueue(identity, a), claimA = await claimOne(repository, first.job.id);
        if (aAlreadySucceeded) assert.equal((await publish(repository, claimA, a)).promoted, true);
        const second = await enqueue(identity, b), claimB = await claimOne(repository, second.job.id);
        const restored = await enqueue(identity, a);
        assert.equal(restored.reused, true); assert.equal(restored.job.id, first.job.id);
        assert.equal(restored.job.request_generation, 1, "An immutable job retains its original creation generation");
        const head = (await pool.query("SELECT requested_job_id,request_generation,current_revision FROM app.neighborhood_assessments WHERE id=$1", [first.job.assessment_id])).rows[0];
        assert.equal(head.requested_job_id, first.job.id); assert.equal(head.request_generation, 3);
        assert.equal(head.current_revision, aAlreadySucceeded ? 1 : null);
        assert.equal((await publish(repository, claimB, b)).promoted, false);
        if (aAlreadySucceeded) {
          await assert.rejects(publish(repository, claimA, a), /claim_lost/);
        } else {
          assert.equal(await repository.getCurrent(identity.scope), null);
          assert.equal((await publish(repository, claimA, a)).promoted, true);
        }
        const current = await repository.getCurrent(identity.scope);
        assert.equal(current.input_signature_sha256, a.assessment.input_signature_sha256);
        assert.equal(current.revision, aAlreadySucceeded ? 1 : 2);
        assert.equal(Number((await pool.query("SELECT count(*) AS count FROM app.neighborhood_assessment_jobs WHERE assessment_id=$1", [first.job.assessment_id])).rows[0].count), 2);
      });
    }

    await t.test("old operation retries cannot restore obsolete intent or cancel a newly reselected job", async () => {
      const identity = await identityFixture(pool), a = publicationFixture(identity, "A"), b = publicationFixture(identity, "B"), operationA = randomUUID();
      const first = await enqueue(identity, a, { operation_id: operationA }), claimA = await claimOne(repository, first.job.id);
      const second = await enqueue(identity, b), claimB = await claimOne(repository, second.job.id);
      const replay = await enqueue(identity, a, { operation_id: operationA });
      assert.equal(replay.replayed, true); assert.equal(replay.reused, false); assert.equal(replay.request_generation, 1);
      let head = (await pool.query("SELECT requested_job_id,request_generation FROM app.neighborhood_assessments WHERE id=$1", [first.job.assessment_id])).rows[0];
      assert.deepEqual(head, { requested_job_id: second.job.id, request_generation: 2 });
      await assert.rejects(repository.enqueue(identity.scope, { ...requestFor(a), operation_id: operationA, payload: { changed: true } }), /request_conflict/);
      const selectedAgain = await enqueue(identity, a);
      assert.equal(selectedAgain.replayed, false); assert.equal(selectedAgain.reused, true); assert.equal(selectedAgain.request_generation, 3);
      await assert.rejects(repository.cancel(identity.scope, first.job.id, { expected_request_generation: 1 }), /intent_conflict/);
      await enqueue(identity, a, { operation_id: operationA });
      head = (await pool.query("SELECT requested_job_id,request_generation FROM app.neighborhood_assessments WHERE id=$1", [first.job.assessment_id])).rows[0];
      assert.deepEqual(head, { requested_job_id: first.job.id, request_generation: 3 });
      await rollbackFixture(pool, async client => {
        await rejectsSql(client, "DELETE FROM app.neighborhood_assessment_requests WHERE assessment_id=$1", [first.job.assessment_id], /request_immutable/);
        await rejectsSql(client, "UPDATE app.neighborhood_assessment_requests SET job_reused=true WHERE assessment_id=$1", [first.job.assessment_id], /request_immutable/);
        await rejectsSql(client, `INSERT INTO app.neighborhood_assessment_requests
          (assessment_id,operation_id,request_digest_sha256,job_id,request_generation,job_reused)
          VALUES ($1,$2,$3,$4,3,true)`, [first.job.assessment_id, randomUUID(), "0".repeat(64), first.job.id], /request_intent_mismatch/);
      });
      assert.equal((await publish(repository, claimB, b)).promoted, false);
      assert.equal((await publish(repository, claimA, a)).promoted, true);
    });

    await t.test("stable attachment UUID keeps one scope through evidence revisions and competing first inserts", async () => {
      const identity = await identityFixture(pool), uad = await uadFixture(pool, identity), otherUad = await uadFixture(pool, identity);
      const versions = [];
      for (const label of ["A", "B"]) {
        const data = publicationFixture(identity, label), { job } = await enqueue(identity, data);
        versions.push((await publish(repository, await claimOne(repository, job.id), data)).assessment);
      }
      const stableId = randomUUID();
      const proposal = (assessment, target, revision, id = stableId) => {
        const value = applicationFixture(identity, target, assessment);
        const attachment = buildNeighborhoodAttachment(assessment, { ...value.attachment, attachment_id: id, attachment_revision: revision });
        return { assessment, attachment, mappedSuggestions: value.suggestions };
      };
      const first = proposal(versions[0], uad, 1), next = proposal(versions[1], uad, 2), changed = proposal(versions[1], otherUad, 3);
      const foreignIdentity = await identityFixture(pool), foreignUad = await uadFixture(pool, foreignIdentity), foreignData = publicationFixture(foreignIdentity);
      const foreignJob = await enqueue(foreignIdentity, foreignData);
      const foreignAssessment = (await publish(repository, await claimOne(repository, foreignJob.job.id), foreignData)).assessment;
      const foreignApplication = applicationFixture(foreignIdentity, foreignUad, foreignAssessment);
      const foreignProposal = { assessment: foreignAssessment, mappedSuggestions: foreignApplication.suggestions,
        attachment: buildNeighborhoodAttachment(foreignAssessment, { ...foreignApplication.attachment, attachment_id: stableId, attachment_revision: 4 }) };
      await rollbackFixture(pool, async client => {
        await persistNeighborhoodAttachment(client, first); await persistNeighborhoodAttachment(client, next);
        assert.equal(Number((await client.query("SELECT count(*) AS count FROM app.neighborhood_assessment_attachments WHERE attachment_id=$1", [stableId])).rows[0].count), 2);
        await client.query("SAVEPOINT wrong_target");
        await assert.rejects(persistNeighborhoodAttachment(client, changed), /stable_identity_mismatch/);
        await client.query("ROLLBACK TO SAVEPOINT wrong_target");
        await assert.rejects(persistNeighborhoodAttachment(client, foreignProposal), /stable_identity_mismatch/);
        await client.query("ROLLBACK TO SAVEPOINT wrong_target");
        await rejectsSql(client, "UPDATE app.neighborhood_assessment_attachment_anchors SET report_file_id=$2 WHERE attachment_id=$1", [stableId, otherUad.reportFileId], /anchor_immutable/);
        await rejectsSql(client, "DELETE FROM app.neighborhood_assessment_attachment_anchors WHERE attachment_id=$1", [stableId], /anchor_immutable/);
      });
      const racingId = randomUUID(), winner = proposal(versions[0], uad, 1, racingId), loser = proposal(versions[1], otherUad, 2, racingId);
      const left = await pool.connect(), right = await pool.connect();
      let competing;
      try {
        await left.query("BEGIN"); await right.query("BEGIN");
        await insertRawAttachment(left, winner.attachment, winner.mappedSuggestions);
        competing = insertRawAttachment(right, loser.attachment, loser.mappedSuggestions); competing.catch(() => {});
        await left.query("COMMIT");
        await assert.rejects(competing, /stable_identity_mismatch/);
        await right.query("ROLLBACK");
        const anchors = (await pool.query("SELECT report_file_id FROM app.neighborhood_assessment_attachment_anchors WHERE attachment_id=$1", [racingId])).rows;
        assert.deepEqual(anchors, [{ report_file_id: uad.reportFileId }]);
        assert.equal(Number((await pool.query("SELECT count(*) AS count FROM app.neighborhood_assessment_attachments WHERE attachment_id=$1", [racingId])).rows[0].count), 1);
      } finally {
        await left.query("ROLLBACK"); await right.query("ROLLBACK");
        await Promise.allSettled([competing].filter(Boolean)); left.release(); right.release();
      }
    });

    for (const cancellationFirst of [true, false]) {
      await t.test(`cancellation/publication race is atomic when ${cancellationFirst ? "cancellation" : "publication"} locks first`, async () => {
        const identity = await identityFixture(pool), data = publicationFixture(identity);
        const { job, request_generation } = await enqueue(identity, data), claim = await claimOne(repository, job.id);
        const firstLocked = deferred(), secondAttempted = deferred(), resume = deferred();
        const winnerTag = cancellationFirst ? "head-by-job" : "lock-head";
        const loserTag = cancellationFirst ? "lock-head" : "head-by-job";
        const winner = createNeighborhoodAssessmentRepository(observingPool(pool, { after: async tag => {
          if (tag === winnerTag) { firstLocked.resolve(); await resume.promise; }
        } }));
        const loser = createNeighborhoodAssessmentRepository(observingPool(pool, { before: async tag => {
          if (tag === loserTag) secondAttempted.resolve();
        } }));
        const first = cancellationFirst ? winner.cancel(identity.scope, job.id, { expected_request_generation: request_generation }) : publish(winner, claim, data);
        first.catch(() => {});
        let second;
        try {
          await within(firstLocked.promise, "first operation owns the head");
          second = cancellationFirst ? publish(loser, claim, data) : loser.cancel(identity.scope, job.id, { expected_request_generation: request_generation });
          second.catch(() => {});
          await within(secondAttempted.promise, "second operation attempts the same head");
          resume.resolve();
          if (cancellationFirst) {
            assert.deepEqual(await first, { cancelled: true });
            await assert.rejects(second, /claim_lost/);
            assert.equal((await repository.getJob(identity.scope, job.id)).status, "cancelled");
            assert.equal(await repository.getCurrent(identity.scope), null);
            assert.deepEqual(await revisionCounts(pool, job.assessment_id), { revisions: 0, sources: 0, populations: 0, members: 0 });
          } else {
            assert.equal((await first).promoted, true);
            assert.deepEqual(await second, { cancelled: false }, "Later cancellation cannot unpublish an accepted result");
            assert.equal((await repository.getJob(identity.scope, job.id)).status, "succeeded");
            assert.equal((await repository.getCurrent(identity.scope)).input_signature_sha256, data.assessment.input_signature_sha256);
          }
        } finally {
          resume.resolve(); await Promise.allSettled([first, second].filter(Boolean));
        }
      });
    }

    await t.test("full mapped UAD proposal, revision, audit and receipt are atomic and exact-target replayable", async () => {
      const identity = await identityFixture(pool), uad = await uadFixture(pool, identity), data = publicationFixture(identity);
      const { job } = await enqueue(identity, data), claim = await claimOne(repository, job.id);
      const { assessment } = await publish(repository, claim, data);
      const application = applicationFixture(identity, uad, assessment);
      const proposalClient = await pool.connect();
      try {
        await proposalClient.query("BEGIN");
        const input = { assessment, attachment: application.attachment, mappedSuggestions: application.suggestions };
        assert.equal((await persistNeighborhoodAttachment(proposalClient, input)).reused, false);
        assert.equal((await persistNeighborhoodAttachment(proposalClient, input)).reused, true);
        const stored = await getNeighborhoodAttachment(proposalClient, application.lookup);
        assert.deepEqual(stored.attachment, application.attachment);
        assert.equal(stored.mappedSuggestions.length, application.suggestions.length);
        assert.equal(neighborhoodMappedManifestDigest(stored.mappedSuggestions), application.attachment.mapped_manifest_sha256);
        assert.equal(await getNeighborhoodAttachment(proposalClient, { ...application.lookup, workflowTargetId: randomUUID() }), null);
        assert.equal(await getNeighborhoodAttachment(proposalClient, { ...application.lookup, organizationId: randomUUID() }), null);
        assert.equal(await getNeighborhoodAttachment(proposalClient, { ...application.lookup, attachmentRevision: 2 }), null);
        await proposalClient.query("COMMIT");
      } catch (error) { await proposalClient.query("ROLLBACK"); throw error; }
      finally { proposalClient.release(); }

      let rolledBackRecord = null;
      for (const { options, expected } of [
        { options: { invalidAudit: true }, expected: /uad_link_mismatch/ },
        { options: { afterRecord: async value => {
          rolledBackRecord = value.record;
          assert.equal(rolledBackRecord.application_id, value.result.application_id);
          // A separate client cannot observe the owner's uncommitted row.
          await rollbackFixture(pool, async observer => {
            assert.equal(await getAcceptedNeighborhoodApplication(observer, application.lookup), null);
            assert.equal(await getAcceptedNeighborhoodApplicationRecord(observer, application.lookup), null);
          });
          throw new Error("synthetic_owner_abort_after_verified_metadata_read");
        } }, expected: /synthetic_owner_abort_after_verified_metadata_read/ },
      ]) {
        await assert.rejects(acceptSyntheticUad(pool, identity, uad, application, options), expected);
        assert.equal((await pool.query("SELECT current_revision FROM appraisal.uad_workfiles WHERE id=$1", [uad.workfileId])).rows[0].current_revision, 1);
        assert.equal(Number((await pool.query("SELECT count(*) AS count FROM appraisal.uad_revisions WHERE workfile_id=$1", [uad.workfileId])).rows[0].count), 1);
        assert.equal(Number((await pool.query("SELECT count(*) AS count FROM appraisal.uad_audit_events WHERE workfile_id=$1", [uad.workfileId])).rows[0].count), 0);
        assert.equal(Number((await pool.query("SELECT count(*) AS count FROM app.neighborhood_assessment_applications WHERE report_file_id=$1", [uad.reportFileId])).rows[0].count), 0);
        for (const table of ["uad_entities", "uad_field_values"]) {
          assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM appraisal.${table} WHERE workfile_id=$1`, [uad.workfileId])).rows[0].count), 0);
        }
        await rollbackFixture(pool, async client => {
          assert.equal(await getAcceptedNeighborhoodApplication(client, application.lookup), null);
          assert.equal(await getAcceptedNeighborhoodApplicationRecord(client, application.lookup), null);
        });
      }
      assert.ok(rolledBackRecord, "The owner read a complete record before deliberately rolling back");

      const recorded = deferred(), resumeCommit = deferred(), replayStarted = deferred();
      let staged, accepted, concurrentReplay;
      const acceptance = acceptSyntheticUad(pool, identity, uad, application, { afterRecord: async value => {
        staged = value; recorded.resolve(); await resumeCommit.promise;
      } }); acceptance.catch(() => {});
      try {
        await within(Promise.race([recorded.promise, acceptance]), "owner staged field/entity/revision/audit/receipt");
        concurrentReplay = (async () => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const lock = client.query("SELECT id FROM appraisal.uad_workfiles WHERE id=$1 FOR UPDATE", [uad.workfileId]);
            replayStarted.resolve(); await lock;
            await client.query("SELECT id FROM app.report_files WHERE id=$1 AND uad_workfile_id=$2 FOR UPDATE", [uad.reportFileId, uad.workfileId]);
            const replay = await recordNeighborhoodApplicationAcceptance(client, staged.input);
            await client.query("COMMIT"); return replay;
          } catch (error) { await client.query("ROLLBACK"); throw error; }
          finally { client.release(); }
        })(); concurrentReplay.catch(() => {});
        await within(replayStarted.promise, "concurrent exact retry attempts owner workfile lock");
        resumeCommit.resolve();
        accepted = await acceptance;
        const replay = await concurrentReplay;
        assert.equal(replay.reused, true); assert.equal(replay.application_id, accepted.result.application_id);
      } finally {
        resumeCommit.resolve(); await Promise.allSettled([acceptance, concurrentReplay].filter(Boolean));
      }
      assert.equal(accepted.result.reused, false);
      assert.deepEqual(accepted.result.receipt, application.receipt);
      assert.notEqual(accepted.record.application_id, rolledBackRecord.application_id);
      assert.notEqual(accepted.record.operation_id, rolledBackRecord.operation_id);
      const persistedDocument = (await pool.query("SELECT document FROM appraisal.uad_revisions WHERE id=$1", [accepted.input.uadRevisionId])).rows[0].document;
      assert.deepEqual(persistedDocument, accepted.document);
      assert.equal(Object.keys(persistedDocument.values).length, 3, "One UAD revision contains the entire mapped group");
      const fields = (await pool.query("SELECT uad_uid,value,entity_id FROM appraisal.uad_field_values WHERE workfile_id=$1 ORDER BY uad_uid", [uad.workfileId])).rows;
      assert.deepEqual(fields, [
        { uad_uid: "3000.0008", value: "North Road", entity_id: null },
        { uad_uid: "3000.0029", value: 330000, entity_id: null },
        { uad_uid: "3000.0051", value: "Synthetic neighborhood source", entity_id: uad.sourceEntityId },
      ]);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM appraisal.uad_entities WHERE workfile_id=$1", [uad.workfileId])).rows[0].count), 1);
      const currentAttachment = buildNeighborhoodAttachment(assessment, { ...application.attachment, attachment_revision: 2, editor_revision: 2 });
      const replayInput = { ...application.preflight, expected_binding_digest: currentAttachment.binding_digest_sha256,
        current_application_identity_sha256: currentAttachment.application_identity_sha256, current_editor_revision: 2,
        existing_values: application.suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: true,
          value: persistedDocument.values[item.target_key], provenance_digest: persistedDocument.neighborhood_provenance })) };
      let savedReceipt, savedRecord;
      await rollbackFixture(pool, async client => {
        const replay = await recordNeighborhoodApplicationAcceptance(client, accepted.input);
        assert.equal(replay.reused, true); assert.equal(replay.application_id, accepted.result.application_id);
        savedReceipt = await getAcceptedNeighborhoodApplication(client, application.lookup);
        assert.deepEqual(savedReceipt, application.receipt);
        savedRecord = await getAcceptedNeighborhoodApplicationRecord(client, application.lookup);
        assert.deepEqual(savedRecord, accepted.record);
        assert.equal(canonicalAssessmentJson(savedRecord.receipt), canonicalAssessmentJson(savedReceipt));
        assert.equal(await getAcceptedNeighborhoodApplication(client, { ...application.lookup, reportFileId: randomUUID() }), null);
        assert.equal(await getAcceptedNeighborhoodApplication(client, { ...application.lookup, workflowTargetId: randomUUID() }), null);
        for (const changed of [{ organizationId: randomUUID() }, { reportFileId: randomUUID() },
          { workflowTargetId: randomUUID() }, { applicationIdentitySha256: "0".repeat(64) }]) {
          assert.equal(await getAcceptedNeighborhoodApplicationRecord(client, { ...application.lookup, ...changed }), null);
        }
        await assert.rejects(recordNeighborhoodApplicationAcceptance(client, { ...accepted.input, operationId: randomUUID() }), /uad_link_mismatch/);
        const altered = structuredClone(application.suggestions); altered[1].value = 1;
        await assert.rejects(persistNeighborhoodAttachment(client, { assessment, attachment: application.attachment, mappedSuggestions: altered }), /mapped_manifest_mismatch/);
        for (const statement of ["DELETE FROM app.neighborhood_assessment_applications WHERE id=$1",
          "UPDATE app.neighborhood_assessment_applications SET receipt='{}' WHERE id=$1"]) {
          await rejectsSql(client, statement, [accepted.result.application_id], /application_immutable/);
        }
        const otherActor = randomUUID();
        await client.query("INSERT INTO app_auth.users (id,email,display_name) VALUES ($1,$2,'Other synthetic reviewer')", [otherActor, `${otherActor}@example.test`]);
        await rejectsSql(client, `INSERT INTO app.neighborhood_assessment_applications
          (id,attachment_id,attachment_revision,report_file_id,application_identity_sha256,operation_id,actor_user_id,
           request_digest_sha256,accepted_editor_revision,uad_revision_id,uad_audit_event_id,receipt)
          VALUES ($1,$2,1,$3,$4,$5,$6,$7,2,$8,$9,$10)`, [randomUUID(), application.attachment.attachment_id,
          uad.reportFileId, application.attachment.application_identity_sha256, accepted.input.operationId, otherActor, "0".repeat(64),
          accepted.input.uadRevisionId, accepted.input.auditEventId, json(application.receipt)], /uad_acceptance_identity_mismatch/);
        const originalAudit = (await client.query("SELECT event_type,entity_type,entity_id,metadata,after_data FROM appraisal.uad_audit_events WHERE id=$1", [accepted.input.auditEventId])).rows[0];
        const mutations = [
          { change: audit => { audit.event_type = "synthetic.unrelated_event"; }, code: /uad_acceptance_identity_mismatch/ },
          { change: audit => { audit.entity_type = "synthetic_unrelated_entity"; }, code: /uad_acceptance_identity_mismatch/ },
          { change: audit => { audit.entity_id = randomUUID(); }, code: /uad_acceptance_identity_mismatch/ },
          { change: audit => { delete audit.metadata.operation_id; }, code: /uad_acceptance_audit_metadata_mismatch/ },
          { change: audit => { audit.metadata.uad_revision_number = "2"; }, code: /uad_acceptance_audit_metadata_mismatch/ },
          { change: audit => { audit.metadata.mapped_manifest_sha256 = "0".repeat(64); }, code: /uad_acceptance_audit_metadata_mismatch/ },
          { change: audit => { audit.after_data.assessment_id = randomUUID(); }, code: /uad_acceptance_audit_after_mismatch/ },
          { change: audit => { audit.after_data.application_group_revision = "1"; }, code: /uad_acceptance_audit_after_mismatch/ },
          { change: audit => { audit.after_data.applied_suggestion_ids.pop(); }, code: /uad_acceptance_partition_mismatch/ },
          { change: audit => { audit.after_data.applied_suggestion_ids.push(audit.after_data.applied_suggestion_ids[0]); }, code: /uad_acceptance_partition_mismatch/ },
          { change: audit => { audit.after_data.reused_suggestion_ids = null; }, code: /uad_acceptance_partition_mismatch/ },
        ];
        for (const mutation of mutations) {
          const audit = structuredClone(originalAudit); mutation.change(audit);
          const row = (await client.query(`INSERT INTO appraisal.uad_audit_events
            (workfile_id,actor_user_id,event_type,entity_type,entity_id,metadata,after_data)
            VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [uad.workfileId, identity.actor_user_id, audit.event_type,
            audit.entity_type, audit.entity_id, json(audit.metadata), json(audit.after_data)])).rows[0];
          await rejectsSql(client, `INSERT INTO app.neighborhood_assessment_applications
            (id,attachment_id,attachment_revision,report_file_id,application_identity_sha256,operation_id,actor_user_id,
             request_digest_sha256,accepted_editor_revision,uad_revision_id,uad_audit_event_id,receipt)
            VALUES ($1,$2,1,$3,$4,$5,$6,$7,2,$8,$9,$10)`, [randomUUID(), application.attachment.attachment_id,
            uad.reportFileId, application.attachment.application_identity_sha256, accepted.input.operationId, identity.actor_user_id,
            "0".repeat(64), accepted.input.uadRevisionId, row.id, json(application.receipt)], mutation.code);
        }

        // A2: base1/new3 is individually plausible, but cannot claim the bound
        // attachment whose editor base is2. Rehashing does not excuse that mismatch.
        await insertRawAttachment(client, currentAttachment, application.suggestions);
        const revision3 = randomUUID(), changedOperation = randomUUID();
        await client.query(`INSERT INTO appraisal.uad_revisions
          (id,workfile_id,revision_number,specification_release_key,document,created_by_user_id)
          VALUES ($1,$2,3,$3,$4,$5)`, [revision3, uad.workfileId, uad.release, json(persistedDocument), identity.actor_user_id]);
        const { receipt_digest_sha256: ignoredDigest, ...changedReceipt } = structuredClone(application.receipt);
        changedReceipt.accepted_editor_revision = 3;
        changedReceipt.acceptance_manifest.attachment_revision = 2;
        changedReceipt.acceptance_manifest.binding_digest_sha256 = currentAttachment.binding_digest_sha256;
        const forgedReceipt = { ...changedReceipt, receipt_digest_sha256: assessmentEvidenceDigest(changedReceipt) };
        const changedAudit = (await client.query(`INSERT INTO appraisal.uad_audit_events
          (workfile_id,actor_user_id,event_type,entity_type,entity_id,metadata,after_data)
          SELECT workfile_id,actor_user_id,event_type,entity_type,$2,
            metadata || jsonb_build_object('operation_id',$2::text,'uad_revision_id',$3::text,'uad_revision_number',3,'receipt_digest_sha256',$4::text),after_data
          FROM appraisal.uad_audit_events WHERE id=$1 RETURNING id`, [accepted.input.auditEventId, changedOperation, revision3, forgedReceipt.receipt_digest_sha256])).rows[0];
        await rejectsSql(client, `INSERT INTO app.neighborhood_assessment_applications
          (id,attachment_id,attachment_revision,report_file_id,application_identity_sha256,operation_id,actor_user_id,
           request_digest_sha256,accepted_editor_revision,uad_revision_id,uad_audit_event_id,receipt)
          VALUES ($1,$2,2,$3,$4,$5,$6,$7,3,$8,$9,$10)`, [randomUUID(), currentAttachment.attachment_id, uad.reportFileId,
          currentAttachment.application_identity_sha256, changedOperation, identity.actor_user_id, "0".repeat(64), revision3, changedAudit.id, json(forgedReceipt)], /application_receipt_mismatch/);

        const custom = buildNeighborhoodAttachment(assessment, { ...neighborhoodTargetFixture("custom_appraisal"),
          attachment_id: randomUUID(), scope: identity.scope, report_file_id: identity.customReportId,
          custom_assignment_file_id: identity.customId, editor_revision: 0, mapped_manifest_sha256: assessmentEvidenceDigest([]) });
        await client.query(`INSERT INTO app.neighborhood_assessment_attachments
          (attachment_id,attachment_revision,assessment_id,assessment_revision,report_file_id,organization_id,workflow_type,
           custom_assignment_file_id,uad_workfile_id,application_identity_sha256,binding_digest_sha256,mapped_suggestions,attachment)
          VALUES ($1,1,$2,$3,$4,$5,'custom_appraisal',$6,NULL,$7,$8,'[]',$9)`, [custom.attachment_id, assessment.id,
          assessment.revision, identity.customReportId, identity.scope.organization_id, identity.customId,
          custom.application_identity_sha256, custom.binding_digest_sha256, json(custom)]);
        await rejectsSql(client, `INSERT INTO app.neighborhood_assessment_applications
          (id,attachment_id,attachment_revision,report_file_id,application_identity_sha256,operation_id,actor_user_id,
           request_digest_sha256,accepted_editor_revision,receipt)
          VALUES ($1,$2,1,$3,$4,$5,$6,$7,1,'{}')`, [randomUUID(), custom.attachment_id, identity.customReportId,
          custom.application_identity_sha256, randomUUID(), identity.actor_user_id, "0".repeat(64)], /custom_acceptance_not_supported/);
      });
      const replayPlan = prepareNeighborhoodApplicationGroup({ ...replayInput, accepted_application: savedReceipt });
      assert.equal(replayPlan.status, "already_applied"); assert.deepEqual(replayPlan.writes, []);
      assert.equal(prepareNeighborhoodApplicationGroup({ ...replayInput, accepted_application: null }).status, "conflict");
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM app.neighborhood_assessment_applications WHERE report_file_id=$1", [uad.reportFileId])).rows[0].count), 1);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM appraisal.uad_revisions WHERE workfile_id=$1", [uad.workfileId])).rows[0].count), 2);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM appraisal.uad_audit_events WHERE workfile_id=$1", [uad.workfileId])).rows[0].count), 1);

      await rollbackFixture(pool, async client => {
        await client.query("SELECT id FROM appraisal.uad_workfiles WHERE id=$1 FOR UPDATE", [uad.workfileId]);
        await client.query("UPDATE appraisal.uad_workfiles SET current_revision=3 WHERE id=$1", [uad.workfileId]);
        await client.query(`INSERT INTO appraisal.uad_revisions
          (id,workfile_id,revision_number,specification_release_key,document,created_by_user_id)
          VALUES ($1,$2,3,$3,$4,$5)`, [randomUUID(), uad.workfileId, uad.release,
          json({ ...persistedDocument, unrelated_edit: true }), identity.actor_user_id]);
        const historical = await getAcceptedNeighborhoodApplication(client, application.lookup);
        assert.deepEqual(historical, savedReceipt, "Historical evidence remains readable, not newly applicable");
        const historicalRecord = await getAcceptedNeighborhoodApplicationRecord(client, application.lookup);
        assert.deepEqual(historicalRecord, savedRecord, "Later editor revision does not replace original acceptance metadata");
        assert.equal(historicalRecord.accepted_editor_revision, 2);
        assert.equal(historicalRecord.uad_revision_id, accepted.input.uadRevisionId);
        assert.equal(historicalRecord.operation_id, accepted.input.operationId);
        assert.equal(historicalRecord.actor_user_id, accepted.input.actorUserId);
        assert.equal(historicalRecord.uad_audit_event_id, String(accepted.input.auditEventId));
        const later = buildNeighborhoodAttachment(assessment, { ...application.attachment, attachment_revision: 3, editor_revision: 3 });
        const plan = prepareNeighborhoodApplicationGroup({ ...replayInput, expected_binding_digest: later.binding_digest_sha256,
          current_application_identity_sha256: later.application_identity_sha256, current_editor_revision: 3, accepted_application: historical });
        assert.equal(plan.status, "conflict"); assert.deepEqual(plan.writes, []);
        assert.ok(plan.conflicts.some(item => item.code === "stale_accepted_application"));
        await assert.rejects(recordNeighborhoodApplicationAcceptance(client, accepted.input), /uad_target_not_editable/);
      });
    });
  } finally {
    // Preserve synthetic audit/history rows; cancel only this run's unfinished
    // jobs so later dedicated test runs cannot accidentally consume them.
    for (const job of owned) await repository.cancel(job.scope, job.id, { expected_request_generation: job.generation }).catch(() => {});
    await pool.end();
  }
});
