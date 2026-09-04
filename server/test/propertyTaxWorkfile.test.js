import assert from "node:assert/strict";
import test from "node:test";

import { saveDesktopPropertyTaxFile } from "../src/modules/mobile/desktopPropertyTax.js";
import { mergePropertyTaxWorkfileUpdate } from "../src/modules/mobile/propertyTaxWorkfile.js";

const FILE_ID = "00000000-0000-4000-8000-000000000711";
const REPORT_ID = "00000000-0000-4000-8000-000000000712";
const ACTOR_ID = "00000000-0000-4000-8000-000000000713";

function comparable(overrides = {}) {
  return {
    id: "district:41:1",
    source: "district_evidence",
    sourceLabel: "District evidence",
    sourceReference: "document:41:candidate:1",
    documentId: 41,
    documentPage: 2,
    saleId: "SALE-1",
    accountId: "ACCOUNT-1",
    address: "123 Main St",
    saleDate: "2026-01-15",
    salePrice: 300000,
    districtAdjustedValue: 295000,
    concessions: 0,
    adjustmentAmount: -5000,
    propertyUse: "single_family_residential",
    neighborhoodCode: "N-1",
    buildingClass: "17",
    livingAreaSqft: 1800,
    siteSizeSqft: 7500,
    yearBuilt: 1998,
    bedroomCount: 3,
    bathCount: 2,
    garageSpaces: 2,
    pool: false,
    reviewStatus: "verified",
    armsLength: true,
    ...overrides,
  };
}

test("desktop Property Tax updates change only reviewed fields and preserve stored extensions", () => {
  const stored = {
    legacy_extension: { retained: true },
    subject: {
      condition_rating: "C4",
      server_owned_future_state: { locked: true },
    },
    analysis: { server_packet_digest: "immutable" },
  };
  const submitted = {
    legacy_extension: { retained: true },
    protest_case: {
      district_code: "tx-dallas-cad",
      property_use: "single_family_residential",
      market_value_ground: "yes",
      unequal_appraisal_ground: "no",
      protest_status: "prepared",
    },
    subject: {
      condition_rating: "C3",
      living_area_sqft: "1850",
      server_owned_future_state: { locked: true },
    },
    analysis: {
      sales_comparison_notes: "Reviewed against district evidence.",
      server_packet_digest: "immutable",
      comparable_grid: {
        version: 1,
        rows: [comparable()],
        updated_at: "2026-09-02T12:00:00.000Z",
        recommendation_policy: "dcad-residential-comparables-2026.1",
      },
    },
  };

  const result = mergePropertyTaxWorkfileUpdate(stored, submitted);
  assert.equal(result.subject.condition_rating, "C3");
  assert.equal(result.subject.living_area_sqft, 1850);
  assert.deepEqual(result.legacy_extension, { retained: true });
  assert.deepEqual(result.subject.server_owned_future_state, { locked: true });
  assert.equal(result.analysis.server_packet_digest, "immutable");
  assert.equal(result.analysis.comparable_grid.rows[0].adjustmentAmount, -5000);
});

test("desktop Property Tax updates cannot create, alter, or delete unknown server-owned fields", () => {
  const stored = {
    subject: { condition_rating: "C4", server_state: { filing_status: "locked" } },
    immutable_packet: { checksum: "abc" },
  };

  assert.throws(
    () => mergePropertyTaxWorkfileUpdate(stored, {
      subject: { condition_rating: "C3", server_state: { filing_status: "open" } },
    }),
    /invalid_property_tax_protest_workfile/,
  );
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate(stored, { new_server_switch: true }),
    /invalid_property_tax_protest_workfile/,
  );

  const omitted = mergePropertyTaxWorkfileUpdate(stored, { subject: { condition_rating: "C3" } });
  assert.deepEqual(omitted.immutable_packet, { checksum: "abc" });
  assert.deepEqual(omitted.subject.server_state, { filing_status: "locked" });
});

test("Property Tax comparable-grid input has exact bounded rows", () => {
  const grid = (rows) => ({
    analysis: {
      comparable_grid: {
        version: 1,
        rows,
        updated_at: null,
        recommendation_policy: "policy-1",
      },
    },
  });
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate({}, grid([comparable({ privileged: true })])),
    /invalid_property_tax_protest_workfile/,
  );
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate({}, grid([comparable(), comparable()])),
    /invalid_property_tax_protest_workfile/,
  );
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate({}, grid(Array.from({ length: 41 }, (_, index) => comparable({ id: `sale-${index}`, saleId: `sale-${index}` })))),
    /invalid_property_tax_protest_workfile/,
  );
});

test("authenticated desktop saves record the server identity on every audit record", async () => {
  const calls = [];
  const row = {
    report_file_id: REPORT_ID,
    registry_revision: 1,
    is_current: true,
    organization_id: "00000000-0000-4000-8000-000000000714",
    tax_protest_file_id: FILE_ID,
    account_id: "ACCOUNT-1",
    file_number: "PT-2026-1",
    previous_file_id: null,
    workfile_data: { subject: { condition_rating: "C4" } },
    assigned_appraiser_user_id: ACTOR_ID,
    status: "draft",
    revision: 1,
    completed_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("SELECT report_file.id")) return { rows: [row] };
      if (sql.includes("FROM app_auth.users app_user")) {
        return { rows: [{ role_code: "appraiser" }] };
      }
      if (sql.includes("UPDATE app.tax_protest_files")) {
        return { rows: [{ ...row, revision: 2, status: "in_progress", workfile_data: JSON.parse(values[1]) }] };
      }
      if (sql.includes("UPDATE app.report_files")) return { rows: [{ registry_revision: 2 }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };

  await saveDesktopPropertyTaxFile(
    pool,
    "ACCOUNT-1",
    FILE_ID,
    {
      expected_revision: 1,
      workfile_data: { subject: { condition_rating: "C3" } },
      reviewer: "Browser supplied identity",
    },
    {
      actorUserId: ACTOR_ID,
      actorLabel: "Taylor Appraiser",
      actorAuth: { userId: ACTOR_ID },
      authorizationRequired: true,
    },
  );

  const authorization = calls.find(({ sql }) => sql.includes("FROM app_auth.users app_user"));
  assert.match(authorization.sql, /membership\.status = 'active'/);
  assert.match(authorization.sql, /FOR SHARE OF app_user, membership, membership_role/);
  assert.deepEqual(authorization.values, [ACTOR_ID, row.organization_id]);
  const update = calls.find(({ sql }) => sql.includes("UPDATE app.tax_protest_files"));
  assert.ok(calls.indexOf(authorization) < calls.indexOf(update));
  assert.match(update.sql, /updated_by_user_id = \$4/);
  assert.equal(update.values[3], ACTOR_ID);
  const history = calls.find(({ sql }) => sql.includes("INSERT INTO app.tax_protest_file_history"));
  assert.match(history.sql, /changed_by_user_id/);
  assert.equal(history.values[4], ACTOR_ID);
  assert.match(history.values[5], /Taylor Appraiser/);
  assert.doesNotMatch(history.values[5], /Browser supplied identity/);
  const event = calls.find(({ sql }) => sql.includes("INSERT INTO app.report_file_events"));
  assert.match(event.sql, /actor_user_id/);
  assert.equal(event.values[1], ACTOR_ID);
  assert.deepEqual(JSON.parse(event.values[5]), {
    tax_protest_revision: 2,
    reviewer: "Taylor Appraiser",
    authentication_mode: "authenticated",
  });
});

test("non-signers can stage draft comparables but cannot create or alter attestations", () => {
  const grid = (rows) => ({
    analysis: {
      comparable_grid: {
        version: 1,
        rows,
        updated_at: "2026-09-04T12:00:00.000Z",
        recommendation_policy: "policy-1",
      },
    },
  });
  const verified = comparable();
  const draft = comparable({
    id: "district:41:draft",
    saleId: "SALE-DRAFT",
    reviewStatus: "needs_review",
    armsLength: false,
    adjustmentAmount: 0,
  });
  const stored = grid([verified]);

  const staged = mergePropertyTaxWorkfileUpdate(
    stored,
    grid([verified, draft]),
    { canAttestComparables: false },
  );
  assert.equal(staged.analysis.comparable_grid.rows.length, 2);
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate(stored, grid([
      { ...verified, address: "Forged address" },
    ]), { canAttestComparables: false }),
    /property_tax_comparable_attestation_required/,
  );
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate(stored, grid([]), { canAttestComparables: false }),
    /property_tax_comparable_attestation_required/,
  );
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate({}, grid([verified]), { canAttestComparables: false }),
    /property_tax_comparable_attestation_required/,
  );
  assert.doesNotThrow(() => mergePropertyTaxWorkfileUpdate(
    stored,
    grid([{ ...verified, address: "Appraiser-corrected address" }]),
    { canAttestComparables: true },
  ));
});

test("desktop Property Tax saves deny revoked membership or reassignment inside the transaction", async () => {
  const baseRow = {
    report_file_id: REPORT_ID,
    registry_revision: 1,
    is_current: true,
    organization_id: "00000000-0000-4000-8000-000000000714",
    tax_protest_file_id: FILE_ID,
    account_id: "ACCOUNT-1",
    file_number: "PT-2026-1",
    previous_file_id: null,
    workfile_data: {},
    assigned_appraiser_user_id: ACTOR_ID,
    status: "draft",
    revision: 1,
    completed_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };

  for (const scenario of [
    { name: "revoked membership", row: baseRow, roles: [] },
    {
      name: "reassigned file",
      row: { ...baseRow, assigned_appraiser_user_id: "00000000-0000-4000-8000-000000000799" },
      roles: [{ role_code: "appraiser" }],
    },
  ]) {
    const calls = [];
    const client = {
      async query(sql) {
        calls.push(sql);
        if (sql.includes("SELECT report_file.id")) return { rows: [scenario.row] };
        if (sql.includes("FROM app_auth.users app_user")) return { rows: scenario.roles };
        return { rows: [] };
      },
      release() {},
    };
    await assert.rejects(
      saveDesktopPropertyTaxFile(
        { connect: async () => client },
        "ACCOUNT-1",
        FILE_ID,
        { expected_revision: 1, workfile_data: {} },
        {
          actorUserId: ACTOR_ID,
          actorAuth: { userId: ACTOR_ID },
          authorizationRequired: true,
        },
      ),
      /property_tax_protest_access_denied/,
      scenario.name,
    );
    assert.ok(calls.some((sql) => sql === "ROLLBACK"), scenario.name);
    assert.equal(calls.some((sql) => sql.includes("UPDATE app.tax_protest_files")), false);
  }
});

test("organization writers cannot self-attest a comparable inside the save transaction", async () => {
  const row = {
    report_file_id: REPORT_ID,
    registry_revision: 1,
    is_current: true,
    organization_id: "00000000-0000-4000-8000-000000000714",
    tax_protest_file_id: FILE_ID,
    account_id: "ACCOUNT-1",
    file_number: "PT-2026-1",
    previous_file_id: null,
    workfile_data: {},
    assigned_appraiser_user_id: "00000000-0000-4000-8000-000000000799",
    status: "draft",
    revision: 1,
    completed_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT report_file.id")) return { rows: [row] };
      if (sql.includes("FROM app_auth.users app_user")) {
        return { rows: [{ role_code: "office_assistant" }] };
      }
      return { rows: [] };
    },
    release() {},
  };

  await assert.rejects(
    saveDesktopPropertyTaxFile(
      { connect: async () => client },
      "ACCOUNT-1",
      FILE_ID,
      {
        expected_revision: 1,
        workfile_data: {
          analysis: {
            comparable_grid: {
              version: 1,
              rows: [comparable()],
              updated_at: null,
              recommendation_policy: "policy-1",
            },
          },
        },
      },
      {
        actorUserId: ACTOR_ID,
        actorAuth: { userId: ACTOR_ID },
        authorizationRequired: true,
      },
    ),
    /property_tax_comparable_attestation_required/,
  );
  assert.ok(calls.some((sql) => sql === "ROLLBACK"));
  assert.equal(calls.some((sql) => sql.includes("UPDATE app.tax_protest_files")), false);
});

test("desktop Property Tax save retries do not create a second revision", async () => {
  const operationId = "00000000-0000-4000-8000-000000000715";
  const row = {
    report_file_id: REPORT_ID,
    registry_revision: 1,
    is_current: true,
    organization_id: "00000000-0000-4000-8000-000000000714",
    tax_protest_file_id: FILE_ID,
    account_id: "ACCOUNT-1",
    file_number: "PT-2026-1",
    previous_file_id: null,
    workfile_data: { subject: { condition_rating: "C4" } },
    assigned_appraiser_user_id: ACTOR_ID,
    status: "draft",
    revision: 1,
    completed_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };
  let current = { ...row };
  let operation = null;
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("SELECT report_file.id")) return { rows: [current] };
      if (sql.includes("FROM app.tax_protest_save_operations")) {
        return { rows: operation ? [operation] : [] };
      }
      if (sql.includes("UPDATE app.tax_protest_files")) {
        current = {
          ...current,
          revision: 2,
          status: "in_progress",
          workfile_data: JSON.parse(values[1]),
        };
        return { rows: [current] };
      }
      if (sql.includes("UPDATE app.report_files")) {
        current = { ...current, registry_revision: 2 };
        return { rows: [{ registry_revision: 2 }] };
      }
      if (sql.includes("INSERT INTO app.tax_protest_save_operations")) {
        operation = {
          request_sha256: values[2],
          base_revision: values[3],
          applied_revision: values[4],
          result: JSON.parse(values[5]),
          actor_user_id: values[6],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };
  const input = {
    client_operation_id: operationId,
    expected_revision: 1,
    workfile_data: { subject: { condition_rating: "C3" } },
  };

  const first = await saveDesktopPropertyTaxFile(
    pool, "ACCOUNT-1", FILE_ID, input, { actorUserId: ACTOR_ID },
  );
  const replay = await saveDesktopPropertyTaxFile(
    pool, "ACCOUNT-1", FILE_ID, input, { actorUserId: ACTOR_ID },
  );

  assert.equal(first.revision, 2);
  assert.equal(replay.revision, 2);
  assert.equal(calls.filter(({ sql }) => sql.includes("UPDATE app.tax_protest_files")).length, 1);
  assert.equal(calls.filter(({ sql }) => sql.includes("INSERT INTO app.tax_protest_file_history")).length, 1);
  assert.equal(calls.filter(({ sql }) => sql.includes("INSERT INTO app.tax_protest_save_operations")).length, 1);
  await assert.rejects(
    saveDesktopPropertyTaxFile(
      pool,
      "ACCOUNT-1",
      FILE_ID,
      { ...input, workfile_data: { subject: { condition_rating: "C2" } } },
      { actorUserId: ACTOR_ID },
    ),
    /property_tax_protest_save_operation_conflict/,
  );
});
