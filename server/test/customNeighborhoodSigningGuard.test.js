import assert from "node:assert/strict";
import test from "node:test";
import { signCustomAppraisalWorkfile, verifyCustomAppraisalSignedSnapshot } from "../src/services/customAppraisalWorkfiles.js";
import { customAppraisalReportFixture } from "./fixtures/customAppraisalReportFixture.js";
import { customNeighborhoodReportPdfFixture } from "./fixtures/customNeighborhoodReportPdfFixture.js";

const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const SIGNER_ID = "30000000-0000-4000-8000-000000000001";
const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "40000000-0000-4000-8000-000000000001";
const SECRET = "signing-guard-test-secret-32-characters";

// Only the database/artifact boundary is simulated. Signing, the authoritative
// binding helper, report projection/readiness and HMAC use production functions.
// No database, remote image requests or generated artifact is needed here.
function signingHarness({ accepted = false, hasAcceptance = false, hasSection = false,
  bindingRows, mutateSection, signerAssigned = true } = {}) {
  const fixture = accepted ? customNeighborhoodReportPdfFixture() : customAppraisalReportFixture();
  const { snapshot, property } = fixture;
  property.assignment.organization_id ||= ORGANIZATION_ID;
  const assignmentFileId = property.assignment.id;
  const accountId = property.assignment.account_id;
  const reportFiles = snapshot.evidence.report_files || [];
  const sections = Object.entries(snapshot.sections).map(([section_key, section]) => ({
    section_key, section_value: structuredClone(section.value), revision: section.revision,
    updated_by: "Saved appraiser", updated_at: "2026-09-01T12:00:00.000Z",
  }));
  mutateSection?.(sections.find(row => row.section_key === "neighborhood_assessment"));
  const calls = [];
  const state = { hasAcceptance, hasSection, released: 0, signedRow: null };
  const artifact = { canonical_file_name: "stored-report.pdf", content_sha256: "a".repeat(64),
    page_count: 9, byte_size: 20000, generated_at: "2026-09-01T12:00:01.000Z" };
  const result = rows => ({ rows, rowCount: rows.length });
  const client = {
    async query(sql, params = []) {
      const statement = String(sql).trim();
      calls.push({ sql: statement, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)
        || statement.includes("pg_advisory_xact_lock")
        || statement.startsWith("CREATE SCHEMA")
        || statement.startsWith("INSERT INTO app.custom_appraisal_workfiles")) return result([]);
      if (statement.includes("WHERE snapshot.signature_event_id = $1")) {
        return result(state.signedRow ? [state.signedRow] : []);
      }
      if (statement.startsWith("SELECT assignment_file.id, assignment_file.file_number")) {
        return result([property.assignment]);
      }
      if (statement.includes("FOR UPDATE OF workfile")) return result([{
        assignment_file_id: assignmentFileId, file_number: property.assignment.file_number,
        organization_id: property.assignment.organization_id, status: "draft", signed_at: null,
        assigned_appraiser_user_id: signerAssigned ? SIGNER_ID : "different-signer",
        supervisory_appraiser_user_id: null, schema_version: 1,
        canonical_file_name: snapshot.canonical_file_name,
      }]);
      if (statement.includes("ORDER BY section_key FOR SHARE")) return result(sections);
      if (statement.startsWith("/* custom-neighborhood-draft:verify-absent */")) {
        assert.deepEqual(params, [assignmentFileId, accountId, "neighborhood_assessment"]);
        return result([{ assignment_file_id: String(assignmentFileId), account_id: accountId,
          has_section: state.hasSection, has_acceptance: state.hasAcceptance }]);
      }
      if (statement.startsWith("/* custom-neighborhood-draft:exact-report-binding */")) {
        const section = sections.find(row => row.section_key === "neighborhood_assessment");
        assert.deepEqual(params.slice(0, 4), [assignmentFileId, accountId, "neighborhood_assessment", Number(section.revision)]);
        assert.deepEqual(JSON.parse(params[4]), section.section_value);
        return result(bindingRows ?? reportFiles);
      }
      if (statement.startsWith("SELECT jsonb_build_object(")) return result([{ record: property.assignment }]);
      if (statement === "SELECT to_regclass($1) AS table_name") {
        return result([{ table_name: params[0] === "app.report_files" ? params[0] : null }]);
      }
      if (statement === "SELECT to_regclass($1) AS name") return result([{ name: null }]);
      if (statement.startsWith("SELECT to_jsonb(report_file)")) return result(reportFiles.map(record => ({ record })));
      if (statement.startsWith("WITH candidate_source_records AS MATERIALIZED")) return result([]);
      if (statement.includes("FROM core.accounts a")) return result([property.account]);
      if (statement.includes("FROM core.primary_improvements")) return result([property.improvement]);
      if (statement.includes("FROM core.owner_summary summary")) return result([property.owner]);
      if (statement.includes("FROM core.legal_description_current")) return result([property.legal]);
      if (statement.includes("FROM core.land_detail")) return result(property.land);
      if (statement.includes("FROM core.exemptions_summary")) return result(property.exemptions);
      if (statement.includes("FROM core.secondary_improvements")) return result(property.additional_improvements);
      if (statement.startsWith("SELECT id, account_id, file_number, revision, assignment_details")) return result([property.assignment]);
      if (statement.startsWith("INSERT INTO app.custom_appraisal_signed_snapshots")) {
        state.signedRow = { id: SNAPSHOT_ID, assignment_file_id: params[0], account_id: accountId,
          snapshot: JSON.parse(params[3]), checksum_sha256: params[4], signed_by: params[5], signed_at: params[6],
          organization_id: params[7], current_organization_id: params[7], signed_by_user_id: params[8],
          signature_event_id: params[9], signature_hmac_sha256: params[12] };
        return result([{ id: SNAPSHOT_ID }]);
      }
      if (statement.startsWith("UPDATE app.custom_appraisal_workfiles")) return result([]);
      // Keep the artifact consumer as an existing-result boundary; this suite
      // tests the guard and signing protocol, not PDF rendering/storage.
      if (statement.includes("FROM app.custom_appraisal_report_artifacts WHERE")) return result([artifact]);
      assert.fail(`Unexpected signing query: ${statement}`);
    },
    release() { state.released += 1; },
  };
  const pool = {
    async query(sql) {
      // Schema setup is the only permitted pool work. The guard and every
      // signing query must use the connected transaction client instead.
      assert.match(String(sql).trim(), /^(?:CREATE SCHEMA|INSERT INTO app\.custom_appraisal_workfiles)/);
      return result([]);
    },
    async connect() { return client; },
  };
  return { pool, calls, state, fixture, input: { accountId, assignmentFileId, signedBy: "Assigned Appraiser",
    signerUserId: SIGNER_ID, signatureEventId: EVENT_ID, signingSecret: SECRET, acknowledgedWarningCodes: [] } };
}

function assertGuardBeforeManifest(calls, tag) {
  const index = calls.findIndex(call => call.sql.includes(tag));
  assert.ok(index > calls.findIndex(call => call.sql.includes("FOR UPDATE OF workfile")));
  assert.ok(index > calls.findIndex(call => call.sql.includes("ORDER BY section_key FOR SHARE")));
  assert.equal(calls[0].sql, "BEGIN");
  const manifestIndex = calls.findIndex(call => call.sql.startsWith("SELECT jsonb_build_object("));
  if (manifestIndex !== -1) assert.ok(index < manifestIndex);
}

function assertRejectedBeforeSigning(harness) {
  assert.equal(harness.calls.at(-1).sql, "ROLLBACK");
  assert.equal(harness.state.released, 1);
  assert.equal(harness.state.signedRow, null);
  assert.ok(!harness.calls.some(call => call.sql === "COMMIT"
    || call.sql.startsWith("SELECT jsonb_build_object(")
    || call.sql.includes("INSERT INTO app.custom_appraisal_signed_snapshots")
    || call.sql.includes("UPDATE app.custom_appraisal_workfiles")
    || call.sql.includes("app.custom_appraisal_report_artifacts")));
}

for (const flags of [{ hasAcceptance: true }, { hasSection: true }, { hasAcceptance: null }]) {
  test(`direct signing rejects unproven neighborhood absence before manifest, snapshot and artifact: ${JSON.stringify(flags)}`, async () => {
    const harness = signingHarness(flags);
    await assert.rejects(signCustomAppraisalWorkfile(harness.pool, harness.input),
      /custom_neighborhood_saved_group_unavailable/);
    assertGuardBeforeManifest(harness.calls, "custom-neighborhood-draft:verify-absent");
    assertRejectedBeforeSigning(harness);
  });
}

test("verified legacy absence preserves ordinary signing, snapshot shape and HMAC", async () => {
  const harness = signingHarness();
  const signed = await signCustomAppraisalWorkfile(harness.pool, harness.input);
  assertGuardBeforeManifest(harness.calls, "custom-neighborhood-draft:verify-absent");
  assert.equal(signed.status, "signed");
  assert.equal(signed.signature.signer_user_id, SIGNER_ID);
  assert.equal(signed.signature.event_id, EVENT_ID);
  assert.deepEqual(signed.assignment.assignment_details, harness.fixture.property.assignment.assignment_details);
  assert.equal(Object.hasOwn(signed.sections, "neighborhood_assessment"), false);
  assert.deepEqual(Object.keys(signed.evidence).sort(), ["documents", "inspection_photo_objects", "inspection_photos",
    "inspection_sketches", "neighborhood_boundary", "neighborhood_relevance", "property_context",
    "property_report_data", "report_files"].sort());
  assert.equal(verifyCustomAppraisalSignedSnapshot(harness.state.signedRow, SECRET), true);
  assert.equal(harness.calls.at(-1).sql, "COMMIT");
  assert.equal(harness.state.released, 1);
});

test("present accepted section must match the locked exact group before signing", async () => {
  const harness = signingHarness({ accepted: true, bindingRows: [] });
  await assert.rejects(signCustomAppraisalWorkfile(harness.pool, harness.input),
    /custom_neighborhood_saved_group_unavailable/);
  assertGuardBeforeManifest(harness.calls, "custom-neighborhood-draft:exact-report-binding");
  assertRejectedBeforeSigning(harness);
});

test("an exact accepted group signs without rewriting its section or signed manifest", async () => {
  const harness = signingHarness({ accepted: true });
  const signed = await signCustomAppraisalWorkfile(harness.pool, harness.input);
  assertGuardBeforeManifest(harness.calls, "custom-neighborhood-draft:exact-report-binding");
  assert.deepEqual(signed.sections.neighborhood_assessment.value, harness.fixture.section);
  assert.deepEqual(signed.evidence.report_files, harness.fixture.snapshot.evidence.report_files);
  assert.equal(verifyCustomAppraisalSignedSnapshot(harness.state.signedRow, SECRET), true);
  assert.equal(harness.calls.at(-1).sql, "COMMIT");
  assert.equal(harness.state.released, 1);
});

test("explicitly null reserved section is not normalized into legacy absence", async () => {
  const harness = signingHarness({ accepted: true, mutateSection: section => { section.section_value = null; } });
  await assert.rejects(signCustomAppraisalWorkfile(harness.pool, harness.input),
    /custom_neighborhood_saved_group_unavailable/);
  assert.ok(!harness.calls.some(call => call.sql.includes("custom-neighborhood-draft:")));
  assertRejectedBeforeSigning(harness);
});

test("signer authorization still rejects before the neighborhood check", async () => {
  const harness = signingHarness({ signerAssigned: false });
  await assert.rejects(signCustomAppraisalWorkfile(harness.pool, harness.input), /custom_appraisal_signer_not_assigned/);
  assert.ok(!harness.calls.some(call => call.sql.includes("custom-neighborhood-draft:")));
  assertRejectedBeforeSigning(harness);
});

test("idempotent signed replay remains independent of live neighborhood absence", async () => {
  const harness = signingHarness();
  const first = await signCustomAppraisalWorkfile(harness.pool, harness.input);
  harness.calls.length = 0;
  // A live absence read would now reject; the authenticated stored snapshot
  // and existing artifact must still replay without that live-state read.
  harness.state.hasAcceptance = true;
  const replay = await signCustomAppraisalWorkfile(harness.pool, harness.input);
  assert.deepEqual(replay, JSON.parse(JSON.stringify(first)));
  assert.ok(!harness.calls.some(call => call.sql.includes("custom-neighborhood-draft:")
    || call.sql.includes("FOR UPDATE OF workfile")
    || call.sql.includes("INSERT INTO app.custom_appraisal_signed_snapshots")));
  assert.equal(harness.calls.at(-1).sql, "COMMIT");
  assert.equal(harness.state.released, 2);
});
