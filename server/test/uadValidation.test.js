import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UAD_LOCAL_VALIDATOR_VERSION,
  buildLocalUadValidationFindings,
  buildUadValidationInputDigest,
  runLocalUadValidation,
} from "../src/modules/uad/validation.js";

const WORKFILE_ID = "57f26fb0-0ed7-42dc-a7dd-54a87f2b7ab5";

function editorFixture({ applicable = true, confirmed = false, values } = {}) {
  return {
    workfile: {
      id: WORKFILE_ID,
      current_revision: 4,
      specification_release_key: "uad-3.6-2026-08-13-h1.5",
    },
    sections: [{ key: "assignment", applicable }],
    entities: [],
    values: values || [{
      id: "field-1",
      entity_id: null,
      context_key: "assignment",
      uid: "1000.0034",
      report_field_id: "2.000",
      value: "Purchase",
      source_type: "homenode",
      is_appraiser_confirmed: confirmed,
    }],
  };
}

test("aggregates section failures and blocks visible unconfirmed source data", () => {
  const findings = buildLocalUadValidationFindings(editorFixture());

  assert.ok(findings.some((finding) => finding.metadata.code === "required"));
  const confirmation = findings.find((finding) => finding.metadata.code === "appraiser_confirmation_required");
  assert.equal(confirmation?.severity, "fatal");
  assert.equal(confirmation?.report_field_id, "2.000");
  assert.equal(confirmation?.metadata.validator_version, UAD_LOCAL_VALIDATOR_VERSION);
});

test("does not require confirmation for values in a non-applicable section", () => {
  const findings = buildLocalUadValidationFindings(editorFixture({ applicable: false }));
  assert.deepEqual(findings, []);
});

test("reports saved values that do not exist in the locked UAD catalog", () => {
  const findings = buildLocalUadValidationFindings(editorFixture({
    applicable: false,
    values: [{
      id: "field-unknown",
      entity_id: null,
      context_key: "assignment",
      uid: "9999.9999",
      report_field_id: "unknown",
      value: "Unexpected",
      source_type: "appraiser",
      is_appraiser_confirmed: true,
    }],
  }));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule_id, "uad.local.catalog.unknown_field");
});

test("creates a deterministic digest of the exact validated workfile inputs", () => {
  const editor = editorFixture({ confirmed: true });
  const digest = buildUadValidationInputDigest(editor, [], []);
  const reordered = structuredClone(editor);
  reordered.workfile.status = "ready";

  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(buildUadValidationInputDigest(reordered, [], []), digest);
  reordered.values[0].value = "Refinance";
  assert.notEqual(buildUadValidationInputDigest(reordered, [], []), digest);
});

test("persists revision-specific runs and exposes one GET and one POST route", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const service = fs.readFileSync(path.resolve(directory, "../src/modules/uad/validation.js"), "utf8");
  const router = fs.readFileSync(path.resolve(directory, "../src/modules/uad/router.js"), "utf8");
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  const entities = fs.readFileSync(path.resolve(directory, "../src/modules/uad/entities.js"), "utf8");
  const sketches = fs.readFileSync(path.resolve(directory, "../src/modules/uad/sketches.js"), "utf8");

  assert.match(service, /INSERT INTO appraisal\.uad_validation_runs/);
  assert.match(service, /INSERT INTO appraisal\.uad_validation_findings/);
  assert.match(service, /uad_validation\.completed/);
  assert.match(service, /workfile\.status === "ready"/);
  assert.match(router, /router\.get\("\/workfiles\/:workfileId\/validation"/);
  assert.match(router, /router\.post\("\/workfiles\/:workfileId\/validation"/);
  assert.match(assets, /SET status = 'draft', updated_at = now\(\)/);
  assert.match(entities, /SET status = 'draft', updated_at = now\(\)/);
  assert.match(sketches, /SET status = 'draft', updated_at = now\(\)/);
});

test("validates inside one transaction and leaves an incomplete workfile in draft", async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM appraisal.uad_workfiles") && sql.includes("FOR UPDATE")) {
        return { rows: [{
          id: WORKFILE_ID,
          current_revision: 4,
          specification_release_key: "uad-3.6-2026-08-13-h1.5",
          status: "draft",
        }] };
      }
      if (sql.includes("SELECT id, account_id, file_number")) {
        return { rows: [{
          id: WORKFILE_ID,
          account_id: "26272500060150000",
          file_number: "HN-UAD-TEST",
          specification_release_key: "uad-3.6-2026-08-13-h1.5",
          status: "validating",
          current_revision: 4,
          updated_at: "2026-08-20T12:00:00.000Z",
        }] };
      }
      if (sql.includes("INSERT INTO appraisal.uad_validation_runs")) {
        return { rows: [{
          id: params[0],
          workfile_id: WORKFILE_ID,
          revision_number: 4,
          specification_release_key: "uad-3.6-2026-08-13-h1.5",
          validator_type: "local_compliance",
          status: params[4],
          fatal_count: params[5],
          warning_count: params[6],
          started_at: "2026-08-20T12:00:00.000Z",
          completed_at: "2026-08-20T12:00:01.000Z",
          metadata: JSON.parse(params[7]),
        }] };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  const pool = { connect: async () => client };

  const validation = await runLocalUadValidation(pool, WORKFILE_ID);

  assert.equal(validation.status, "failed");
  assert.equal(validation.workfile_status, "draft");
  assert.equal(validation.ready_for_export, false);
  assert.ok(validation.fatal_count > 0);
  assert.match(validation.metadata.input_digest_sha256, /^[a-f0-9]{64}$/);
  assert.ok(calls.some((call) => call.sql === "COMMIT"));
  assert.ok(calls.some((call) => call.sql.includes("SET status = $2") && call.params[1] === "draft"));
  assert.equal(released, true);
});
