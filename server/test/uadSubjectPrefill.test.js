import assert from "node:assert/strict";
import test from "node:test";
import { buildUadSubjectPrefillValues } from "../src/modules/uad/subjectPrefillValues.js";
import { prefillUadSubject } from "../src/modules/uad/subjectPrefill.js";

const FILE = "d51f534a-9447-4c36-8c09-36b530b64c21";
const ACTOR = "d51f534a-9447-4c36-8c09-36b530b64c22";
const entities = [
  { id: "property", entity_type: "property", entity_identifier: "subject", parent_entity_id: null },
  { id: "dwelling", entity_type: "dwelling", entity_identifier: "dwelling-1", parent_entity_id: "property" },
  { id: "unit", entity_type: "unit", entity_identifier: "unit-1", parent_entity_id: "dwelling" },
  { id: "parcel", entity_type: "site_parcel", entity_identifier: "site-parcel-1", parent_entity_id: "property" },
];
const snapshot = () => ({
  account: { account_id: "TEST-1", address: "100 Test Lane", city: "Garland", county: "Dallas", postal_code: "75044", legal_description: "OLD SHORT LEGAL" },
  legal_description: { legal_lines: ["LOT 1 BLOCK A", "TEST ADDITION"] },
  housing_profile: { attachment_type: "detached" },
  primary_improvements: { year_built: 2001, effective_year_built: 2010, number_units: 1, bedroom_count: "3", baths_full: "2", baths_half: "0", bath_count: 2.1, living_area_sqft: 1850, stories: 1.5, building_class: "GOOD", basement: "Y" },
  land_details: [
    { tax_year: 2025, line_number: 1, area_sqft: 99999 },
    { tax_year: 2026, line_number: 1, area_sqft: "7000" },
    { tax_year: 2026, line_number: 2, area_sqft: "500.5" },
  ],
});
const row = (key, value, entity_id = null) => {
  const [field_context, uad_uid] = key.split(":");
  return { field_context, uad_uid, entity_id, value, is_appraiser_confirmed: true, source_type: "appraiser" };
};
const candidates = (source = snapshot(), topology = entities, existing = [], options) =>
  buildUadSubjectPrefillValues(source, topology, existing, options);
const find = (values, key, id = null) => values.find((item) => item.field.key === key && item.entityId === id);

test("maps retained public facts into official root and repeatable fields with exact source references", () => {
  const values = candidates();
  assert.equal(find(values, "subject_address:0100.0007").value, "100 Test Lane");
  assert.equal(find(values, "subject_legal:0100.0067").value, "LOT 1 BLOCK A\nTEST ADDITION");
  assert.equal(find(values, "subject:0100.0020").value, "Detached");
  assert.equal(find(values, "dwelling:0300.0011", "dwelling").value, "2001");
  assert.equal(find(values, "unit:0700.0118", "unit").value, 3);
  assert.equal(find(values, "unit:0700.0119", "unit").value, 2);
  assert.equal(find(values, "unit:0700.0120", "unit").value, 0);
  assert.equal(find(values, "site_parcel:1500.0027", "parcel").value, "TEST-1");
  assert.deepEqual(find(values, "site_parcel:1500.0022", "parcel").value, { amount: 7500.5, unit: "SquareFeet" });
  assert.deepEqual(find(values, "site:1500.0093").value, { amount: 7500.5, unit: "SquareFeet" });
  assert.match(find(values, "site:1500.0093").sourceReference, /tax_year=2026/);
  assert.ok(values.every((value) => value.sourceReference.startsWith("subject_snapshot.")));
});

test("never guesses ANSI areas, condition, quality, occupancy, utilities, or bath-count decimals", () => {
  const source = snapshot();
  delete source.primary_improvements.baths_full;
  delete source.primary_improvements.baths_half;
  const values = candidates(source);
  assert.equal(find(values, "unit:0700.0119", "unit"), undefined);
  assert.equal(find(values, "unit:0700.0120", "unit"), undefined);
  assert.ok(!values.some(({ field }) => /quality|condition|occupancy|utilities|finished area|unfinished area|levels/i.test(field.label)));
});

for (const value of [null, "", 0, false, 9]) {
  test(`preserves existing/cleared field ${JSON.stringify(value)} and does not reconfirm it`, () => {
    assert.equal(find(candidates(snapshot(), entities, [row("unit:0700.0118", value, "unit")]), "unit:0700.0118", "unit"), undefined);
  });
}
for (const value of [null, "", " ", false, {}, [], "three", -1, "3.5", "100", "1e1"]) {
  test(`does not import invalid bedroom count ${JSON.stringify(value)}`, () => {
    const source = snapshot(); source.primary_improvements.bedroom_count = value;
    assert.equal(find(candidates(source), "unit:0700.0118", "unit"), undefined);
  });
}

test("multi-unit, additional dwelling, ADU, or broken entity ancestry cannot receive aggregate room counts", () => {
  const source = snapshot(); source.primary_improvements.number_units = 2;
  assert.equal(find(candidates(source), "unit:0700.0118", "unit"), undefined);
  for (const extra of [entities[1], entities[2]]) {
    assert.equal(find(candidates(snapshot(), [...entities, { ...extra, id: "extra" }]), "unit:0700.0118", "unit"), undefined);
  }
  assert.equal(find(candidates(snapshot(), entities, [row("unit:0700.0089", true, "unit")]), "unit:0700.0118", "unit"), undefined);
  assert.equal(find(candidates(snapshot(), entities, [row("subject:0100.0019", 1)]), "unit:0700.0118", "unit"), undefined);
  const broken = entities.map((entity) => entity.id === "unit" ? { ...entity, parent_entity_id: "wrong" } : entity);
  assert.equal(find(candidates(snapshot(), broken), "unit:0700.0118", "unit"), undefined);
});

test("missing, duplicate, invalid, or partial current land lines do not become a site total", () => {
  for (const land of [[], [{ tax_year: 2026, line_number: 1, area_sqft: null }],
    [{ tax_year: 2026, line_number: 1, area_sqft: "bad" }],
    [{ tax_year: 2026, line_number: 1, area_sqft: 10 }, { tax_year: 2026, line_number: 1, area_sqft: 10 }],
    [{ tax_year: 2026, line_number: 1, area_sqft: 10 }, { tax_year: 2026, line_number: 2, area_sqft: null }],
    [{ tax_year: null, line_number: 1, area_sqft: 10 }]]) {
    const source = snapshot(); source.land_details = land;
    assert.equal(find(candidates(source), "site:1500.0093"), undefined);
  }
});

test("different parcel, additional parcels, or an edited parcel area cannot seed a misleading total", () => {
  assert.equal(find(candidates(snapshot(), [...entities, { ...entities[3], id: "other" }]), "site:1500.0093"), undefined);
  for (const existing of [[row("site_parcel:1500.0027", "OTHER", "parcel")],
    [row("site_parcel:1500.0022", { amount: 1, unit: "Acres" }, "parcel")], [row("site:1500.0094", 2)]]) {
    assert.equal(find(candidates(snapshot(), entities, existing), "site:1500.0093"), undefined);
  }
});

test("initial defaults are creation-only, and invalid source strings are not truncated or coerced", () => {
  assert.equal(find(candidates(), "assignment:1000.0158"), undefined);
  assert.ok(find(candidates(snapshot(), entities, [], { includeDefaults: true }), "assignment:1000.0158"));
  const source = snapshot(); source.account.address = "A".repeat(101); source.account.city = {};
  assert.equal(find(candidates(source), "subject_address:0100.0007"), undefined);
  assert.equal(find(candidates(source), "subject_address:0100.0009"), undefined);
});

function fakePool({ status = "draft", signedAt = null, signatures = false, failInsert = false, source = snapshot() } = {}) {
  const calls = []; const fields = []; let revision = 7; let releaseCount = 0;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM appraisal.uad_workfiles")) return { rows: [{ id: FILE, account_id: "TEST-1", status, signed_at: signedAt, current_revision: revision, specification_release_key: "test-release" }] };
      if (sql.includes("AS has_signatures")) return { rows: [{ has_signatures: signatures }] };
      if (sql.includes("FROM appraisal.uad_subject_snapshots")) return { rows: [{ id: "snapshot", subject_data: source, created_at: "2026-09-01T00:00:00Z" }] };
      if (sql.includes("FROM appraisal.uad_entities")) return { rows: entities };
      if (sql.includes("SELECT * FROM appraisal.uad_field_values")) return { rows: fields };
      if (sql.includes("INSERT INTO appraisal.uad_field_values")) {
        if (failInsert) throw new Error("synthetic_write_failure");
        fields.push({ id: params[0], entity_id: params[2], field_context: params[3], uad_uid: params[4], report_field_id: params[5], value: JSON.parse(params[6]), source_type: params[7], source_reference: params[8], is_appraiser_confirmed: false });
      }
      if (sql.includes("UPDATE appraisal.uad_workfiles")) revision = params[1];
      return { rows: [] };
    },
    release() { releaseCount++; },
  };
  return { pool: { connect: async () => client }, calls, fields, released: () => releaseCount };
}

test("prefill holds the workfile lock before signature/snapshot reads, audits one revision, and is idempotent", async () => {
  const fake = fakePool();
  const result = await prefillUadSubject(fake.pool, FILE, ACTOR);
  assert.ok(result.changed_field_count > 5); assert.equal(result.current_revision, 8);
  assert.match(fake.calls[0].sql, /READ COMMITTED/);
  assert.match(fake.calls[1].sql, /FOR UPDATE/);
  assert.match(fake.calls[2].sql, /has_signatures/);
  const inserts = fake.calls.filter(({ sql }) => sql.includes("INSERT INTO appraisal.uad_field_values"));
  assert.ok(inserts.every(({ sql, params }) => /false/.test(sql) && params[9] === "2026-09-01T00:00:00Z" && params[10] === ACTOR));
  assert.equal(fake.calls.filter(({ sql }) => sql.includes("INSERT INTO appraisal.uad_revisions")).length, 1);
  assert.equal(fake.calls.filter(({ sql }) => sql.includes("INSERT INTO appraisal.uad_audit_events")).length, 1);
  assert.ok(!fake.calls.some(({ sql }) => /UPDATE appraisal.uad_field_values|FROM core\./.test(sql)));
  const again = await prefillUadSubject(fake.pool, FILE, ACTOR);
  assert.deepEqual(again, { changed_field_count: 0, current_revision: 8 });
  assert.equal(fake.calls.filter(({ sql }) => sql.includes("INSERT INTO appraisal.uad_revisions")).length, 1);
  assert.equal(fake.released(), 2);
});

for (const options of [{ status: "signed" }, { signedAt: "2026-09-01" }, { signatures: true }]) {
  test(`signed/locked files are rejected before source reads: ${JSON.stringify(options)}`, async () => {
    const fake = fakePool(options);
    await assert.rejects(prefillUadSubject(fake.pool, FILE, ACTOR), /uad_workfile_status_locked/);
    assert.ok(!fake.calls.some(({ sql }) => sql.includes("subject_snapshots") || sql.includes("INSERT INTO")));
    assert.equal(fake.calls.at(-1).sql, "ROLLBACK"); assert.equal(fake.released(), 1);
  });
}

test("snapshot identity mismatch and write failures roll back without touching live source records", async () => {
  const source = snapshot(); source.account.account_id = "FOREIGN";
  for (const [options, error] of [[{ source }, /uad_subject_snapshot_conflict/], [{ failInsert: true }, /synthetic_write_failure/]]) {
    const fake = fakePool(options);
    await assert.rejects(prefillUadSubject(fake.pool, FILE, ACTOR), error);
    assert.equal(fake.calls.at(-1).sql, "ROLLBACK"); assert.equal(fake.released(), 1);
    assert.ok(!fake.calls.some(({ sql }) => sql.includes("COMMIT") && !sql.includes("READ COMMITTED")));
  }
});
