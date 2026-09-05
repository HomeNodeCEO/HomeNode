import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment } from "../src/services/neighborhoodAssessment/contract.js";
import { createNeighborhoodAssessmentRepository, neighborhoodMemberSetDigest, neighborhoodMemberContentDigest, prepareNeighborhoodPublication } from "../src/services/neighborhoodAssessment/assessmentRepository.js";
import { neighborhoodMappedManifestDigest, prepareNeighborhoodApplicationGroup, buildNeighborhoodApplicationReceipt } from "../src/services/neighborhoodAssessment/applicationGroup.js";
import { persistNeighborhoodAttachment, getNeighborhoodAttachment, getAcceptedNeighborhoodApplication, recordNeighborhoodApplicationAcceptance } from "../src/services/neighborhoodAssessment/applicationRepository.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "./fixtures/neighborhoodAssessmentFixture.js";

// Run only against the dedicated database prepared by test:uad-migration. Never
// bootstrap canonical identity tables here, load .env, or delete fixture records.
// Actual canonical tables exercise publication/locks. Private rollback schemas
// below are only absence probes, not substitutes for canonical migration tests.
function checkedDatabaseUrl(value, mode) {
  if (mode !== "test") throw new Error("Neighborhood PG tests require NODE_ENV=test");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid neighborhood test DATABASE_URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^\/[a-zA-Z0-9_]+_test$/.test(url.pathname) || url.search || url.hash) {
    throw new Error("Neighborhood PG tests require a loopback *_test URL without query overrides");
  }
  return { connectionString: value, databaseName: url.pathname.slice(1) };
}

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
  const release = (await pool.query("SELECT release_key FROM uad_ref.specification_releases ORDER BY release_key LIMIT 1")).rows[0]?.release_key;
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
  return { workfileId, reportFileId, release, initialRevisionId };
}

function applicationFixture(identity, uad, assessment) {
  const group = assessment.application_group;
  const suggestions = [
    { id: "boundary", target_key: "synthetic:boundary", value: "North Road", dependency_ids: ["source"],
      evidence_refs: ["geographic_neighborhood", "population:stock-a"], application_group_id: group.id },
    { id: "median", target_key: "synthetic:median", value: 330000, dependency_ids: ["boundary", "source"],
      evidence_refs: ["statistic:median-sale-price", "population:sales-a"], application_group_id: group.id },
    { id: "source", target_key: "synthetic:source", value: group.source_refs, dependency_ids: [],
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
async function acceptSyntheticUad(pool, identity, uad, application, { invalidAudit = false } = {}) {
  const client = await pool.connect(), operationId = randomUUID(), revisionId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM app.report_files WHERE id=$1 FOR UPDATE", [uad.reportFileId]);
    const current = (await client.query("SELECT current_revision,status,signed_at FROM appraisal.uad_workfiles WHERE id=$1 FOR UPDATE", [uad.workfileId])).rows[0];
    assert.equal(current.current_revision, 1); assert.equal(current.signed_at, null); assert.equal(current.status, "draft");
    const document = { synthetic: true, values: Object.fromEntries(application.plan.writes.map(item => [item.target_key, item.value])),
      neighborhood_provenance: application.plan.acceptance_manifest.provenance_digest };
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
    await client.query("COMMIT"); return { result, input, document };
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
  return { effective_date: date, data_cutoff: date, input_signature_sha256: data.assessment.input_signature_sha256,
    payload: { synthetic: true, assessment_signature: data.assessment.input_signature_sha256 } };
}
test("PostgreSQL publication fixtures pass the exact pure content contract without a database", () => {
  const identity = { scope: { organization_id: randomUUID(), appraisal_case_id: randomUUID(), subject_snapshot_id: randomUUID(), account_id: "SYNTHETIC-P1" },
    accounts: ["SYNTHETIC-P1", "SYNTHETIC-P2", "SYNTHETIC-P3", "SYNTHETIC-P4"] };
  const data = publicationFixture(identity);
  const prepared = prepareNeighborhoodPublication(data.assessment, data.members, data.sources);
  assert.equal(prepared.members.length, 7); assert.equal(prepared.sources.length, 3);
  assert.notEqual(publicationFixture(identity, "B").assessment.input_signature_sha256, data.assessment.input_signature_sha256);
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
  skip: !process.env.DATABASE_URL, timeout: 120_000,
}, async t => {
  const target = checkedDatabaseUrl(process.env.DATABASE_URL, process.env.NODE_ENV);
  const { default: pg } = await import("pg"); // Must remain AFTER every URL guard.
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 5, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: "neighborhood_persistence_integration" });
  const owned = [];
  const repository = createNeighborhoodAssessmentRepository(pool);
  const enqueue = async (identity, data, extra = {}) => {
    const result = await repository.enqueue(identity.scope, { ...requestFor(data), ...extra });
    owned.push({ scope: identity.scope, id: result.job.id }); return result;
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

    await t.test("scope and captured-date checks reject foreign tuples and do not leave partial heads", async () => {
      const identity = await identityFixture(pool, { case_date: null });
      const foreign = await identityFixture(pool);
      const data = publicationFixture(identity);
      for (const scope of [{ ...identity.scope, organization_id: foreign.scope.organization_id },
        { ...identity.scope, subject_snapshot_id: foreign.scope.subject_snapshot_id }, { ...identity.scope, account_id: foreign.scope.account_id }]) {
        await assert.rejects(repository.enqueue(scope, requestFor(data)), /scope_mismatch/);
      }
      const accepted = await enqueue(identity, data); // Explicit snapshot date with null case date is allowed.
      await repository.cancel(identity.scope, accepted.job.id);
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

    for (const cancellationFirst of [true, false]) {
      await t.test(`cancellation/publication race is atomic when ${cancellationFirst ? "cancellation" : "publication"} locks first`, async () => {
        const identity = await identityFixture(pool), data = publicationFixture(identity);
        const { job } = await enqueue(identity, data), claim = await claimOne(repository, job.id);
        const firstLocked = deferred(), secondAttempted = deferred(), resume = deferred();
        const winnerTag = cancellationFirst ? "head-by-job" : "lock-head";
        const loserTag = cancellationFirst ? "lock-head" : "head-by-job";
        const winner = createNeighborhoodAssessmentRepository(observingPool(pool, { after: async tag => {
          if (tag === winnerTag) { firstLocked.resolve(); await resume.promise; }
        } }));
        const loser = createNeighborhoodAssessmentRepository(observingPool(pool, { before: async tag => {
          if (tag === loserTag) secondAttempted.resolve();
        } }));
        const first = cancellationFirst ? winner.cancel(identity.scope, job.id) : publish(winner, claim, data);
        first.catch(() => {});
        let second;
        try {
          await within(firstLocked.promise, "first operation owns the head");
          second = cancellationFirst ? publish(loser, claim, data) : loser.cancel(identity.scope, job.id);
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
  } finally {
    // Preserve synthetic audit/history rows; cancel only this run's unfinished
    // jobs so later dedicated test runs cannot accidentally consume them.
    for (const job of owned) await repository.cancel(job.scope, job.id).catch(() => {});
    await pool.end();
  }
});
