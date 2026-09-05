import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OFFICIAL_ZONING_SOURCES } from "../src/services/propertyZoningSources.js";
import { canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import {
  GIS_EVIDENCE_READER_VERSION,
  GIS_EVIDENCE_SOURCE_KEYS,
  readGisEvidence,
} from "../src/services/neighborhoodAssessment/gisEvidenceReader.js";
import { ASSESSMENT_SCOPE } from "./fixtures/neighborhoodAssessmentFixture.js";

// Synthetic query results only: this test never constructs a PostgreSQL pool.
const SCOPE = { ...ASSESSMENT_SCOPE };
const BOUNDS = { west: -97.01, south: 32.99, east: -96.99, north: 33.01 };
const NOW = "2026-09-05T00:00:00.000Z";
const PARCEL = "dcad_parcels";
const ROAD = "tiger_roads_primary";
const TRAFFIC = "txdot_aadt";
const ZONE = OFFICIAL_ZONING_SOURCES[0];
// EWKB point, SRID 4326, x=-97, y=33. Geometry predicates are PostgreSQL's job;
// this boundary test verifies faithful transport of its result and binary bytes.
const POINT_EWKB = "0101000020e610000000000000004058c00000000000804040";

function healthyState(key, overrides = {}) {
  return {
    source_key: key, status: "current", source_vintage: "synthetic-2026", row_count: "100",
    source_url_matches_catalog: true, metadata_oversized: false,
    last_run_id: `${key}-latest`, last_success_at: "2026-09-04T00:00:00.000Z",
    last_attempt_at: "2026-09-03T00:00:00.000Z", last_source_update_at: null,
    run_id: `${key}-latest`, run_source_key: key, run_mode: "incremental", run_status: "complete",
    run_started_at: "2026-09-03T00:00:00.000Z", run_completed_at: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

function feature(key, id, overrides = {}) {
  const payload = {
    properties: {
      ...(key === PARCEL ? { account_id: SCOPE.account_id } : {}),
      source_attributes_json: '{"synthetic_precise_identifier":9007199254740993}',
    },
    geometry_ewkb: POINT_EWKB, geometry_valid: true,
    ingest: { source_record_hash: `synthetic-hash-${id}`, sync_run_id: `${key}-older`, synced_at: "2026-09-02T00:00:00.000Z" },
    origin_run: {
      id: `${key}-older`, source_key: key, mode: "full", status: "complete",
      started_at: "2026-09-01T00:00:00.000Z", completed_at: "2026-09-02T00:00:00.000Z",
    },
    ...overrides,
  };
  return { feature_id: String(id), payload_json: JSON.stringify(payload) };
}

function tag(query) {
  return /\/\* neighborhood-gis:([^*]+) \*\//.exec(query.text)?.[1] ?? query.text;
}

function harness({
  sourceKeys = [PARCEL], rows = { [PARCEL]: [feature(PARCEL, "1")] },
  subject = [{ feature_id: "1", covered: true }], states = {}, absentTables = [],
  registry, clock = { captured_at: NOW, postgis_version: "3.5.0" }, onQuery, onRelease,
} = {}) {
  const calls = [];
  const releases = [];
  let connects = 0;
  const client = {
    async query(query) {
      assert.equal(typeof query, "object", "the adapter must provide bounded query options");
      assert.equal(typeof query.text, "string");
      assert.ok(Array.isArray(query.values));
      assert.ok(Number.isSafeInteger(query.query_timeout) && query.query_timeout > 0);
      calls.push(structuredClone(query));
      const name = tag(query);
      if (onQuery) {
        const override = await onQuery(name, query, calls);
        if (override !== undefined) return override;
      }
      if (name === "clock") return { rows: [structuredClone(clock)] };
      if (name === "capabilities") return { rows: query.values[0].map(name => ({ name, relation: absentTables.includes(name) ? null : name })) };
      if (name === "state") return { rows: query.values[0].flatMap(key => states[key] === null ? [] : [healthyState(key, {
        ...(absentTables.includes("gis.source_sync_runs") ? { run_id: null, run_status: null } : {}), ...states[key],
      })]) };
      if (name === "registry") return { rows: registry ?? query.values[0].map(provider_key => ({
        provider_key, provider_type: "official_municipal", status: "current", jurisdiction: "Synthetic jurisdiction", last_success_at: "2026-09-04T00:00:00.000Z",
        service_url_matches_catalog: true, service_layer_matches_catalog: true, metadata_oversized: false,
      })) };
      if (name === "subject") return { rows: subject.slice(0, query.values[5]) };
      if (name.startsWith("page:")) {
        const kind = name.slice(5);
        const partition = query.values[4];
        const key = kind === "parcel" ? PARCEL : kind === "zoning"
          ? OFFICIAL_ZONING_SOURCES.find(source => source.providerKey === partition)?.sourceKey : partition;
        assert.ok(key, "page queries must identify an actual catalog partition");
        const after = query.values[5];
        const sorted = [...(rows[key] ?? [])].sort((a, b) => kind === "zoning"
          ? Buffer.compare(Buffer.from(a.feature_id), Buffer.from(b.feature_id))
          : BigInt(a.feature_id) < BigInt(b.feature_id) ? -1 : BigInt(a.feature_id) > BigInt(b.feature_id) ? 1 : 0);
        const selected = sorted.filter(row => after === null || (kind === "zoning"
          ? Buffer.compare(Buffer.from(row.feature_id), Buffer.from(after)) > 0 : BigInt(row.feature_id) > BigInt(after)));
        const candidates = selected.slice(0, query.values[6]).map(row => absentTables.includes("gis.source_sync_runs") && row.payload_json
          ? { ...row, payload_json: JSON.stringify({ ...JSON.parse(row.payload_json), origin_run: {} }) }
          : { ...row });
        let payloadBytes = 0;
        return { rows: candidates.map(row => {
          const bytes = typeof row.payload_json === "string" ? Buffer.byteLength(row.payload_json) : 0;
          payloadBytes += bytes;
          const page_bytes_exceeded = payloadBytes > query.values[8];
          return { ...row, payload_bytes: bytes, page_bytes_exceeded,
            payload_json: page_bytes_exceeded || bytes > query.values[7] ? null : row.payload_json };
        }) };
      }
      if (name === "settings" || name === "COMMIT" || name === "ROLLBACK" || name.startsWith("BEGIN ")) return { rows: [] };
      assert.fail(`unexpected query tag ${name}`);
    },
    release(discard) { releases.push(discard); onRelease?.(discard); },
  };
  const pool = { async connect() { connects++; return client; } };
  return {
    pool, calls, releases, get connects() { return connects; },
    read(overrides = {}) { return readGisEvidence({ pool, scope: SCOPE, bounds: BOUNDS, sourceKeys, ...overrides }); },
  };
}

const records = result => result.capture.sources.flatMap(source => source.payload.records);
const diagnostic = (result, key = PARCEL) => result.diagnostics.find(item => item.source_key === key);
const tags = fake => fake.calls.map(tag);
function cleanCommit(fake) {
  assert.equal(tags(fake).filter(value => value.startsWith("BEGIN ")).length, 1);
  assert.equal(tags(fake).filter(value => value === "COMMIT").length, 1);
  assert.equal(tags(fake).filter(value => value === "ROLLBACK").length, 0);
  assert.deepEqual(fake.releases, [undefined]);
}
function cleanRollback(fake) {
  assert.equal(tags(fake).filter(value => value === "ROLLBACK").length, 1);
  assert.deepEqual(fake.releases, [true]);
}
async function fails(fake, reason, overrides = {}) {
  await assert.rejects(fake.read(overrides), error => {
    assert.equal(error.code, "NEIGHBORHOOD_GIS_READ_FAILED");
    assert.equal(error.state, "incomplete");
    assert.equal(error.reason, reason);
    return true;
  });
  cleanRollback(fake);
}

test("captures parcels, roads, traffic and official zoning in one assignment-private snapshot", async () => {
  const sourceKeys = [ZONE.sourceKey, TRAFFIC, ROAD, PARCEL];
  const rows = {
    [PARCEL]: [feature(PARCEL, "1")], [ROAD]: [feature(ROAD, "9007199254740993")],
    [TRAFFIC]: [feature(TRAFFIC, "17")], [ZONE.sourceKey]: [feature(ZONE.sourceKey, "Z-1")],
  };
  const fake = harness({ sourceKeys, rows });
  const result = await fake.read();
  assert.equal(result.status, "ready");
  assert.equal(result.reader_version, GIS_EVIDENCE_READER_VERSION);
  assert.equal(result.captured_at, NOW);
  assert.equal(result.totals.rows, 4);
  assert.deepEqual(result.subject.member_record_ids, ["dcad_parcels:1"]);
  assert.equal(result.subject.status, "resolved");
  assert.deepEqual(records(result).map(row => row.record_id).sort(), ["dcad_parcels:1", `${ROAD}:9007199254740993`, `${TRAFFIC}:17`, `${ZONE.sourceKey}:Z-1`].sort());
  for (const row of records(result)) {
    assert.equal(row.data.attributes.source_attributes_json, '{"synthetic_precise_identifier":9007199254740993}');
    assert.equal(row.data.geometry.ewkb, POINT_EWKB);
    assert.equal(row.data.geometry.content_sha256, createHash("sha256").update(Buffer.from(POINT_EWKB, "hex")).digest("hex"));
    assert.equal(row.data.geometry.raw_provider_geometry, "unavailable_in_legacy_mirror");
    assert.ok(Object.isFrozen(row.data.attributes));
  }
  for (const snapshot of result.capture.source_snapshots) {
    assert.equal(snapshot.visibility, "assignment");
    assert.deepEqual(snapshot.scope, SCOPE);
    assert.equal(snapshot.historical_availability, "unknown");
  }
  for (const source of result.capture.sources) {
    assert.equal(source.payload.upstream.visibility, "assignment_private");
    assert.deepEqual(source.payload.projection.definition.bounds, BOUNDS);
    assert.equal(source.payload.projection.definition.scope_of_completeness, "selected_current_mirror_query_only");
  }
  assert.deepEqual(result.applicability, { provider_coverage: "unknown", historical_availability: "unknown", report_eligibility: "not_assessed" });
  assert.ok(Object.isFrozen(result));
  assert.equal(fake.connects, 1);
  assert.match(fake.calls[0].text, /REPEATABLE READ READ ONLY/);
  cleanCommit(fake);
});

test("completed older origins survive a newer incremental run without pretending to be historical coverage", async () => {
  const fake = harness();
  const result = await fake.read();
  const row = records(result)[0];
  assert.equal(result.status, "ready");
  assert.notEqual(row.data.origin_run.id, result.capture.sources[0].payload.projection.definition.raw_source_state.run_id);
  assert.equal(row.data.origin_run.completed_at, "2026-09-02T00:00:00.000Z");
  assert.equal(result.applicability.historical_availability, "unknown");
  cleanCommit(fake);
});

test("bad or missing row origins never become usable evidence", async t => {
  for (const [name, origin] of [
    ["running", { status: "running" }], ["failed", { status: "failed" }],
    ["different source", { source_key: ROAD }], ["future completion", { completed_at: "2026-09-06T00:00:00.000Z" }],
    ["missing left-join origin", { id: null, source_key: null, mode: null, status: null, started_at: null, completed_at: null }],
  ]) await t.test(name, async () => {
    const row = feature(PARCEL, "1");
    const payload = JSON.parse(row.payload_json);
    row.payload_json = JSON.stringify({ ...payload, origin_run: { ...payload.origin_run, ...origin } });
    const fake = harness({ rows: { [PARCEL]: [row] } });
    const result = await fake.read();
    assert.equal(result.status, "incomplete");
    assert.ok(diagnostic(result).reasons.includes("origin_run_unverified"));
    assert.equal(records(result).length, 0, "unverified records must not be exposed as captured sources");
    assert.ok(result.subject.reasons.includes("subject_capture_incomplete"));
    cleanCommit(fake);
  });
});

test("latest source state must be independently verified even when retained rows have completed origins", async t => {
  for (const [name, state] of [
    ["no source state", null], ["running latest", { run_status: "running" }],
    ["failed latest", { run_status: "failed" }], ["missing latest join", { run_id: null, run_status: null }],
    ["different latest source", { run_source_key: ROAD }], ["stale source", { status: "stale" }],
    ["unexpected service origin", { source_url_matches_catalog: false }],
    ["oversized metadata", { metadata_oversized: true }],
    ["success clock older than completed run", { last_success_at: "2026-09-02T00:00:00.000Z" }],
  ]) await t.test(name, async () => {
    const fake = harness({ states: { [PARCEL]: state } });
    const result = await fake.read();
    assert.equal(result.status, "incomplete");
    assert.ok(diagnostic(result).reasons.includes("source_sync_unverified"));
    assert.equal(records(result).length, 0);
    cleanCommit(fake);
  });
});

test("resolves all exact account features, with account and envelope passed as values", async () => {
  const account_id = "synthetic'; SELECT private_data --";
  const fake = harness({ subject: [{ feature_id: "1", covered: true }, { feature_id: "2", covered: true }], rows: { [PARCEL]: [feature(PARCEL, "1"), feature(PARCEL, "2")] } });
  const result = await fake.read({ scope: { ...SCOPE, account_id } });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.subject.member_record_ids, ["dcad_parcels:1", "dcad_parcels:2"]);
  const subjectQuery = fake.calls.find(query => tag(query) === "subject");
  assert.deepEqual(subjectQuery.values.slice(0, 5), [BOUNDS.west, BOUNDS.south, BOUNDS.east, BOUNDS.north, account_id]);
  assert.ok(fake.calls.every(query => !query.text.includes(account_id)));
  cleanCommit(fake);
});

test("subject resolution cannot silently choose one field or fall back to nearby parcels", async t => {
  for (const [name, subject, limits, reason] of [
    ["one of two fields outside", [{ feature_id: "1", covered: true }, { feature_id: "2", covered: false }], {}, "subject_outside_query_envelope"],
    ["account not found", [], {}, "subject_account_not_resolved"],
    ["subject member cap exceeded", [{ feature_id: "1", covered: true }, { feature_id: "2", covered: true }], { subject_members: 1 }, "subject_members_limit"],
    ["resolved feature missing in capture", [{ feature_id: "2", covered: true }], {}, "subject_member_not_captured"],
  ]) await t.test(name, async () => {
    const fake = harness({ subject });
    const result = await fake.read({ limits });
    assert.equal(result.status, "incomplete");
    assert.equal(result.subject.status, "unavailable");
    assert.ok(result.subject.reasons.includes(reason));
    if (limits.subject_members) assert.equal(result.subject.member_record_ids.length, limits.subject_members);
    cleanCommit(fake);
  });
});

test("row cap distinguishes cap minus one, exact cap and a real cap plus one sentinel", async t => {
  for (const count of [2, 3, 4]) await t.test(`${count} rows with cap 3`, async () => {
    const fake = harness({ rows: { [PARCEL]: Array.from({ length: count }, (_, i) => feature(PARCEL, String(i + 1))) } });
    const result = await fake.read({ limits: { total_rows: 3, page_rows: 2 } });
    assert.equal(result.totals.rows, Math.min(count, 3));
    assert.equal(result.status, count <= 3 ? "ready" : "incomplete");
    assert.equal(diagnostic(result).query_exhausted, count <= 3);
    assert.equal(diagnostic(result).reasons.includes("total_rows_limit"), count > 3);
    assert.equal(records(result).length, count <= 3 ? count : 0);
    cleanCommit(fake);
  });
});

test("keyset pages consume their sentinel on the next page once, preserving bigint identities", async () => {
  const ids = ["9007199254740992", "9007199254740993", "9007199254740994", "9007199254740995", "9007199254740996"];
  const fake = harness({ subject: [{ feature_id: ids[0], covered: true }], rows: { [PARCEL]: ids.map(id => feature(PARCEL, id)) } });
  const result = await fake.read({ limits: { total_rows: 6, page_rows: 2 } });
  assert.equal(result.status, "ready");
  assert.deepEqual(records(result).map(row => row.data.feature.object_id), ids);
  assert.deepEqual(fake.calls.filter(query => tag(query) === "page:parcel").map(query => query.values[5]), [null, ids[1], ids[3]]);
  assert.equal(result.totals.rows, 5);
  cleanCommit(fake);
});

test("zoning cursor pagination follows PostgreSQL C byte order across non-ASCII identifiers", async () => {
  // UTF-8/C orders U+E000 before U+1F600; JavaScript UTF-16 string ordering does not.
  const ids = ["Z-1", "\uE000", "\u{1F600}"];
  const fake = harness({ sourceKeys: [PARCEL, ZONE.sourceKey], rows: {
    [PARCEL]: [feature(PARCEL, "1")], [ZONE.sourceKey]: ids.map(id => feature(ZONE.sourceKey, id)),
  } });
  const result = await fake.read({ limits: { page_rows: 1 } });
  assert.equal(result.status, "ready");
  assert.deepEqual(new Set(records(result).filter(row => row.data.feature.source_key === ZONE.sourceKey).map(row => row.data.feature.object_id)), new Set(ids));
  assert.deepEqual(fake.calls.filter(query => tag(query) === "page:zoning").map(query => query.values[5]), [null, ids[0], ids[1]]);
  cleanCommit(fake);
});

test("source identity separates identical IDs in different road layers and is stable under caller source order", async () => {
  const secondary = "tiger_roads_secondary";
  const rows = { [PARCEL]: [feature(PARCEL, "1")], [ROAD]: [feature(ROAD, "7")], [secondary]: [feature(secondary, "7")] };
  const first = await harness({ sourceKeys: [secondary, PARCEL, ROAD], rows }).read();
  const second = await harness({ sourceKeys: [ROAD, secondary, PARCEL], rows }).read();
  assert.equal(first.status, "ready");
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(records(first).map(row => row.record_id)), new Set([`${PARCEL}:1`, `${ROAD}:7`, `${secondary}:7`]));
});

test("a byte-bounded page resumes after the last retained feature without losing suppressed rows", async () => {
  const ids = ["1", "2", "3", "4", "5"];
  const rows = { [PARCEL]: ids.map(id => feature(PARCEL, id, { properties: { account_id: SCOPE.account_id, description: "x".repeat(1000) } })) };
  const seed = await harness({ rows }).read();
  const oneRecordBytes = Buffer.byteLength(canonicalAssessmentJson(records(seed)[0]));
  assert.ok(oneRecordBytes < 2 * Buffer.byteLength(rows[PARCEL][0].payload_json), "one normalized record must fit while two raw rows exceed a page");
  const fake = harness({ rows });
  const result = await fake.read({ limits: { page_rows: 4, record_bytes: oneRecordBytes, page_bytes: oneRecordBytes } });
  assert.equal(result.status, "ready");
  assert.deepEqual(records(result).map(row => row.data.feature.object_id), ids);
  assert.equal(result.totals.rows, 5);
  assert.deepEqual(fake.calls.filter(query => tag(query) === "page:parcel").map(query => query.values[5]), [null, "1", "2", "3", "4"]);
  assert.equal(diagnostic(result).query_exhausted, true);
  cleanCommit(fake);
});

test("wire budget exhaustion aborts even when the retained-record budget would allow all features", async () => {
  const rows = { [PARCEL]: [feature(PARCEL, "1"), feature(PARCEL, "2")] };
  const rawBytes = Buffer.byteLength(rows[PARCEL][0].payload_json);
  // The first response contains one selected row plus its sentinel. Leave only
  // half a raw record for the next page after reserving its bounded metadata.
  const wireBudget = 2 * (rawBytes + 129) + 2 * 512 + Math.floor(rawBytes / 2);
  const fake = harness({ rows });
  await fails(fake, "total_wire_bytes_limit", { limits: { page_rows: 1, total_wire_bytes: wireBudget } });
  assert.equal(fake.calls.filter(query => tag(query) === "page:parcel").length, 2);
});

test("an unexpectedly oversized driver page cannot bypass the bounded response contract", async () => {
  const fake = harness({ onQuery(name) {
    if (name === "page:parcel") return { rows: [{ feature_id: "1", payload_json: "x".repeat(3000), page_bytes_exceeded: false }] };
  } });
  await fails(fake, "total_wire_bytes_limit", { limits: { page_rows: 1, record_bytes: 1024, page_bytes: 1024 } });
});

test("an exhausted global row budget still probes remaining sources for actual emptiness", async t => {
  for (const roadCount of [0, 1]) await t.test(`${roadCount} remaining road rows`, async () => {
    const fake = harness({ sourceKeys: [PARCEL, ROAD], rows: { [PARCEL]: [feature(PARCEL, "1")], [ROAD]: roadCount ? [feature(ROAD, "2")] : [] } });
    const result = await fake.read({ limits: { total_rows: 1 } });
    assert.equal(result.status, roadCount ? "incomplete" : "ready");
    assert.equal(result.totals.rows, 1);
    assert.equal(diagnostic(result, ROAD).query_exhausted, !roadCount);
    assert.equal(fake.calls.find(query => tag(query) === "page:road").values[6], 1);
    assert.equal(records(result).length, 1, "a complete parcel source remains available while roads are incomplete");
    cleanCommit(fake);
  });
});

test("complete empty selection is captured; missing source tables are unavailable, never empty evidence", async () => {
  const complete = harness({ sourceKeys: [PARCEL, ROAD] });
  const emptyResult = await complete.read();
  assert.equal(emptyResult.status, "ready");
  const emptySource = emptyResult.capture.sources.find(source => source.payload.upstream.key === ROAD);
  assert.ok(emptySource);
  assert.deepEqual(emptySource.payload.records, []);
  assert.equal(emptySource.payload.projection.complete, true);
  const missing = harness({ sourceKeys: [PARCEL, ROAD], absentTables: ["gis.road_segments"] });
  const missingResult = await missing.read();
  assert.equal(missingResult.status, "incomplete");
  assert.ok(diagnostic(missingResult, ROAD).reasons.includes("source_schema_absent"));
  assert.equal(missingResult.capture.sources.some(source => source.payload.upstream.key === ROAD), false);
  assert.equal(tags(missing).includes("page:road"), false);
  cleanCommit(complete);
  cleanCommit(missing);
});

test("missing PostGIS or parcel relation cannot certify subject evidence", async t => {
  for (const [name, config] of [
    ["PostGIS absent", { clock: { captured_at: NOW, postgis_version: null } }],
    ["parcel table absent", { absentTables: ["gis.dcad_parcels"] }],
  ]) await t.test(name, async () => {
    const fake = harness(config);
    const result = await fake.read();
    assert.equal(result.status, "incomplete");
    assert.equal(result.subject.status, "unavailable");
    assert.equal(records(result).length, 0);
    assert.equal(tags(fake).includes("page:parcel"), false);
    cleanCommit(fake);
  });
});

test("missing sync-run metadata preserves the distinction between a present mirror and an absent feature source", async () => {
  const fake = harness({ absentTables: ["gis.source_sync_runs"] });
  const result = await fake.read();
  assert.equal(result.status, "incomplete");
  assert.equal(result.subject.status, "unavailable");
  assert.equal(result.capture.capability_diagnostics[0].upstream_state, "populated");
  assert.ok(diagnostic(result).reasons.includes("source_sync_schema_absent"));
  assert.ok(diagnostic(result).reasons.includes("origin_run_unverified"));
  assert.equal(diagnostic(result).reasons.includes("source_schema_absent"), false);
  assert.equal(records(result).length, 0);
  assert.equal(tags(fake).includes("page:parcel"), true);
  cleanCommit(fake);
});

test("official zoning requires a current registry entry even with healthy sync and row origin", async () => {
  const fake = harness({ sourceKeys: [PARCEL, ZONE.sourceKey], registry: [], rows: { [PARCEL]: [feature(PARCEL, "1")], [ZONE.sourceKey]: [feature(ZONE.sourceKey, "Z-1")] } });
  const result = await fake.read();
  assert.equal(result.status, "incomplete");
  assert.ok(diagnostic(result, ZONE.sourceKey).reasons.includes("zoning_registry_unverified"));
  assert.equal(records(result).some(row => row.data.feature.source_key === ZONE.sourceKey), false);
  cleanCommit(fake);
});

test("invalid geometry and contradictory source totals remain explicit omissions", async t => {
  for (const [name, config, reason] of [
    ["invalid geometry", { rows: { [PARCEL]: [feature(PARCEL, "1", { geometry_valid: false })] } }, "invalid_or_empty_geometry"],
    ["reported zero rows but selected one", { states: { [PARCEL]: { row_count: "0" } } }, "source_row_count_contradiction"],
  ]) await t.test(name, async () => {
    const fake = harness(config);
    const result = await fake.read();
    assert.equal(result.status, "incomplete");
    assert.ok(diagnostic(result).reasons.includes(reason));
    assert.equal(records(result).length, 0);
    cleanCommit(fake);
  });
});

test("total record byte budget is inclusive at its exact boundary and aborts one byte below", async () => {
  const seed = await harness().read();
  const bytes = seed.totals.record_bytes;
  assert.equal(bytes, Buffer.byteLength(canonicalAssessmentJson(records(seed)[0])));
  const exact = harness();
  assert.equal((await exact.read({ limits: { total_bytes: bytes } })).status, "ready");
  cleanCommit(exact);
  const over = harness();
  await fails(over, "total_bytes_limit", { limits: { total_bytes: bytes - 1 } });
});

test("record byte cap applies to raw transfer and normalized evidence, including SQL oversize sentinels", async t => {
  const seed = await harness().read();
  const normalizedBytes = seed.totals.record_bytes;
  const rawBytes = Buffer.byteLength(feature(PARCEL, "1").payload_json);
  assert.ok(normalizedBytes > rawBytes, "fixture must exercise normalization overhead");
  const exact = harness();
  assert.equal((await exact.read({ limits: { record_bytes: normalizedBytes } })).status, "ready");
  cleanCommit(exact);
  await t.test("raw transfer exceeds budget", async () => {
    await fails(harness(), "record_bytes_limit", { limits: { record_bytes: rawBytes - 1 } });
  });
  await t.test("normalization exceeds budget although raw payload fits", async () => {
    await fails(harness(), "record_bytes_limit", { limits: { record_bytes: normalizedBytes - 1 } });
  });
  await t.test("database did not materialize an oversized payload", async () => {
    await fails(harness({ rows: { [PARCEL]: [{ feature_id: "1", payload_json: null, payload_bytes: 99999999 }] } }), "record_bytes_limit");
  });
});

test("driver failures roll back and release once, exposing SQLSTATE but no driver details", async t => {
  for (const [code, expectedReason, expectedState] of [
    ["57014", "statement_timeout", "57014"], ["42501", "query_or_capture_failed", "42501"],
    ["ECONNRESET", "query_or_capture_failed", undefined], ["bad secret value", "query_or_capture_failed", undefined],
    ["NEIGHBORHOOD_GIS_READ_FAILED", "query_or_capture_failed", undefined],
  ]) await t.test(code, async () => {
    const fake = harness({ onQuery(name) {
      if (name === "page:parcel") throw Object.assign(new Error("synthetic private SQL, account and credentials"), { code, detail: "synthetic private details", query: "SELECT private_fixture" });
    } });
    await assert.rejects(fake.read(), error => {
      assert.equal(error.reason, expectedReason);
      assert.equal(error.sqlstate, expectedState);
      assert.equal(error.message, `neighborhood_gis_reader:${expectedReason}`);
      assert.equal(error.detail, undefined);
      assert.equal(error.query, undefined);
      assert.equal(error.cause, undefined);
      assert.ok(!JSON.stringify(error).includes("private"));
      return true;
    });
    cleanRollback(fake);
  });
});

test("rollback failure cannot replace the original safe error or prevent release", async () => {
  const fake = harness({ onQuery(name) {
    if (name === "clock") throw Object.assign(new Error("synthetic original detail"), { code: "42501" });
    if (name === "ROLLBACK") throw new Error("synthetic rollback detail");
  } });
  await fails(fake, "query_or_capture_failed");
});

test("client release errors are sanitized after success and preserve an earlier primary failure", async t => {
  await t.test("after successful commit", async () => {
    const fake = harness({ onRelease() { throw new Error("synthetic private release details"); } });
    await assert.rejects(fake.read(), error => {
      assert.equal(error.reason, "client_release_failed");
      assert.equal(error.message, "neighborhood_gis_reader:client_release_failed");
      return true;
    });
    cleanCommit(fake);
  });
  await t.test("after primary failure", async () => {
    const fake = harness({
      onQuery(name) { if (name === "page:parcel") throw Object.assign(new Error("synthetic private query details"), { code: "57014" }); },
      onRelease() { throw new Error("synthetic private release details"); },
    });
    await fails(fake, "statement_timeout");
  });
});

test("failed BEGIN discards the client without inventing an active transaction", async () => {
  const fake = harness({ onQuery(name) { if (name.startsWith("BEGIN ")) throw new Error("synthetic begin error"); } });
  await assert.rejects(fake.read(), { reason: "query_or_capture_failed" });
  assert.equal(tags(fake).includes("ROLLBACK"), false);
  assert.deepEqual(fake.releases, [true]);
});

test("connection failure is sanitized without attempting queries on a missing client", async () => {
  let connects = 0;
  await assert.rejects(readGisEvidence({
    pool: { async connect() { connects++; throw Object.assign(new Error("synthetic password and connection string"), { code: "08006" }); } },
    scope: SCOPE, bounds: BOUNDS, sourceKeys: [PARCEL],
  }), error => {
    assert.equal(error.reason, "query_or_capture_failed");
    assert.equal(error.sqlstate, "08006");
    assert.equal(error.message, "neighborhood_gis_reader:query_or_capture_failed");
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(connects, 1);
});

test("a client arriving after the acquisition deadline is discarded once without starting work", async () => {
  let resolveClient;
  const releases = [];
  const connection = new Promise(resolve => { resolveClient = resolve; });
  await assert.rejects(readGisEvidence({
    pool: { connect() { return connection; } }, scope: SCOPE, bounds: BOUNDS, sourceKeys: [PARCEL], limits: { total_ms: 5 },
  }), { reason: "connection_timeout" });
  resolveClient({ query() { assert.fail("late client must never be queried"); }, release(discard) { releases.push(discard); } });
  // Drain promise continuations; no additional wall-clock sleep is required.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(releases, [true]);
});

test("failed COMMIT does not return a snapshot and still attempts rollback before discard", async () => {
  const fake = harness({ onQuery(name) { if (name === "COMMIT") throw Object.assign(new Error("synthetic commit error"), { code: "40001" }); } });
  await fails(fake, "query_or_capture_failed");
});

test("malformed pages, nonadvancing cursors and malformed payloads abort the whole read", async t => {
  for (const [name, onQuery, reason, limits] of [
    ["too many rows", name => name === "page:parcel" ? { rows: [feature(PARCEL, "1"), feature(PARCEL, "2"), feature(PARCEL, "3")] } : undefined, "invalid_page_size", { page_rows: 1 }],
    ["repeated cursor", name => name === "page:parcel" ? { rows: [feature(PARCEL, "1"), feature(PARCEL, "1")] } : undefined, "nonadvancing_feature_cursor", { page_rows: 2 }],
    ["invalid JSON", name => name === "page:parcel" ? { rows: [{ feature_id: "1", payload_json: "{" }] } : undefined, "invalid_feature_payload", {}],
  ]) await t.test(name, async () => {
    await fails(harness({ onQuery }), reason, { limits });
  });
});

test("a NULL invalid-ID tail cannot be skipped by byte pagination and produce a ready capture", async () => {
  const first = feature(ZONE.sourceKey, "A", { properties: { padding: "x".repeat(1000) } });
  const last = feature(ZONE.sourceKey, "C", { properties: { padding: "x".repeat(1000) } });
  const pageBytes = Buffer.byteLength(first.payload_json) + Buffer.byteLength(last.payload_json) + 1;
  let zoningPages = 0;
  const fake = harness({
    sourceKeys: [PARCEL, ZONE.sourceKey],
    onQuery(name) {
      if (name !== "page:zoning") return undefined;
      zoningPages++;
      if (zoningPages > 1) return { rows: [] };
      // Raw identities were A, B + 140 characters, C. Gating the invalid B to
      // NULL and ordering by that alias used to move it behind C. A byte-full
      // tail then advanced the cursor to C, silently losing B on the next page.
      return { rows: [
        { ...first, invalid_feature_identity: false, page_bytes_exceeded: false },
        { ...last, invalid_feature_identity: false, page_bytes_exceeded: false },
        { feature_id: null, invalid_feature_identity: true, payload_json: null,
          payload_bytes: Buffer.byteLength(first.payload_json), page_bytes_exceeded: true },
      ] };
    },
  });
  await fails(fake, "invalid_feature_identity", { limits: { record_bytes: pageBytes, page_bytes: pageBytes } });
  assert.equal(zoningPages, 1, "reject the invalid candidate before advancing past its original identity");
  assert.equal(tags(fake).includes("COMMIT"), false);
});

test("invalid caller inputs are rejected before acquiring any connection", async t => {
  for (const [name, input] of [
    ["missing organization", { scope: { ...SCOPE, organization_id: undefined } }],
    ["malformed case", { scope: { ...SCOPE, appraisal_case_id: "other-case" } }],
    ["empty subject", { scope: { ...SCOPE, subject_snapshot_id: "" } }],
    ["account whitespace", { scope: { ...SCOPE, account_id: " synthetic " } }],
    ["account control character", { scope: { ...SCOPE, account_id: "synthetic\n" } }],
    ["invalid longitude", { bounds: { ...BOUNDS, west: -181 } }],
    ["inverted bounds", { bounds: { ...BOUNDS, west: BOUNDS.east } }],
    ["NaN coordinate", { bounds: { ...BOUNDS, north: NaN } }],
    ["too large envelope", { bounds: { west: -98, east: -96, south: 33, north: 33.1 } }],
    ["unknown source", { sourceKeys: [PARCEL, "arbitrary_table"] }],
    ["duplicate source", { sourceKeys: [PARCEL, PARCEL] }],
    ["no parcel source", { sourceKeys: [ROAD] }],
    ["zero rows", { limits: { total_rows: 0 } }],
    ["over maximum rows", { limits: { total_rows: 50001 } }],
    ["fractional page", { limits: { page_rows: 1.5 } }],
    ["record cannot fit page budget", { limits: { record_bytes: 1025, page_bytes: 1024 } }],
    ["unbounded wire budget", { limits: { total_wire_bytes: 32000001 } }],
    ["unknown limit", { limits: { radius_meters: 1 } }],
  ]) await t.test(name, async () => {
    const fake = harness();
    await assert.rejects(fake.read(input), error => error instanceof TypeError && error.message.startsWith("invalid_neighborhood_gis_reader:"));
    assert.equal(fake.connects, 0);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(fake.releases, []);
  });
});

test("advertised source catalog includes the fixture's four source kinds and is immutable", () => {
  for (const key of [PARCEL, ROAD, TRAFFIC, ZONE.sourceKey]) assert.ok(GIS_EVIDENCE_SOURCE_KEYS.includes(key));
  assert.ok(Object.isFrozen(GIS_EVIDENCE_SOURCE_KEYS));
});
