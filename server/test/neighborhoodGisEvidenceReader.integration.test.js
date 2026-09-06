import assert from "node:assert/strict";
import test from "node:test";
import { canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import { readGisEvidence } from "../src/services/neighborhoodAssessment/gisEvidenceReader.js";
import { ensurePropertyContextSchema } from "../src/services/propertyContextStore.js";
import { seedNeighborhoodGisPostgisFixture } from "./fixtures/neighborhoodGisPostgisFixture.js";
import {
  prepareNeighborhoodCiDatabase, verifyNeighborhoodCiConnection, NEIGHBORHOOD_CI_IDENTITY_SQL,
} from "./helpers/neighborhoodCiDatabase.js";

// Ordinary local runs explicitly skip native database work, even if a developer
// has DATABASE_URL set. The accepted helper validates NODE_ENV, exact loopback
// parent/child identities and a unique *_test child before canonical preparation.
// No fixtures enter the parent, no provider is contacted, and no database/table
// is deleted. The GitHub ephemeral PostgreSQL service owns eventual disposal.
const nativeCi = process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true" && Boolean(process.env.DATABASE_URL);
const skipReason = "native PostGIS integration requires the guarded GitHub CI ephemeral database; local DB execution is disabled";
const records = result => result.capture.sources.flatMap(source => source.payload.records);
const sourceRecords = (result, key) => records(result).filter(row => row.data.feature.source_key === key);
const diagnostic = (result, key) => result.diagnostics.find(item => item.source_key === key);
const queryTag = input => /\/\* neighborhood-gis:([^*]+) \*\//.exec(input.text)?.[1];

function observingPool(pool, after) {
  return { async connect() {
    const client = await pool.connect();
    return {
      release(discard) { client.release(discard); },
      async query(input) {
        const result = await client.query(input);
        await after?.(queryTag(input), input, result, client);
        return result;
      },
    };
  } };
}

test("native PostGIS GIS evidence reader uses canonical tables, real geometry and repeatable-read pages", {
  skip: nativeCi ? false : skipReason, timeout: 360_000,
}, async t => {
  const target = await prepareNeighborhoodCiDatabase(); // Guards precede pg import in this helper too.
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: target.connectionString, max: 3, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, query_timeout: 9000, idleTimeoutMillis: 1000,
    application_name: "neighborhood_gis_native_ci", allowExitOnIdle: true,
  });
  let writer;
  // Every new physical connection is checked before it can read or modify even
  // the isolated fixture. No unverified pool.query path is exposed below.
  const verifiedPool = { async connect() {
    const client = await pool.connect();
    try {
      const identity = (await client.query({ text: NEIGHBORHOOD_CI_IDENTITY_SQL, values: [], query_timeout: 3000 })).rows[0];
      verifyNeighborhoodCiConnection(identity, client.connection?.stream?.remoteAddress, target.databaseName);
      return client;
    } catch (error) { client.release(true); throw error; }
  } };
  try {
    writer = await verifiedPool.connect();
    const query = (text, values = []) => writer.query({ text, values, query_timeout: 9000 });
    const extension = (await query("SELECT extversion FROM pg_extension WHERE extname='postgis'")).rows[0];
    assert.ok(extension?.extversion, "canonical CI preparation must provide native PostGIS");
    // Reviewed propertyContextStore.js: this call performs local schema/index/
    // trigger creation and static registry upserts, never ingestion or network.
    // Its core.accounts FK resolves against the canonically prepared child.
    await ensurePropertyContextSchema({ query });
    const fixture = await seedNeighborhoodGisPostgisFixture(query);
    const read = overrides => readGisEvidence({ pool: verifiedPool, scope: fixture.scope,
      bounds: fixture.bounds, sourceKeys: fixture.sourceKeys, ...overrides });
    const parcelKey = "dcad_parcels";
    const zoneKey = fixture.zone.sourceKey;
    const subtest = (name, fn) => t.test(name, { timeout: 25_000 }, fn);

    await subtest("all four kinds preserve exact geometry, bigint identifiers and older completed origins", async () => {
      const result = await read();
      assert.equal(result.status, "ready");
      assert.equal(result.totals.rows, 8);
      assert.deepEqual(new Set(sourceRecords(result, parcelKey).map(row => row.data.feature.object_id)), new Set(fixture.insideParcelIds));
      assert.deepEqual(sourceRecords(result, "tiger_roads_primary").map(row => row.data.feature.object_id), ["9007199254741000"]);
      assert.deepEqual(sourceRecords(result, "txdot_aadt").map(row => row.data.feature.object_id), ["33"]);
      assert.deepEqual(new Set(sourceRecords(result, zoneKey).map(row => row.data.feature.object_id)), new Set(fixture.zoningIds));
      assert.deepEqual(result.subject.member_record_ids, fixture.subjectIds.map(id => `${parcelKey}:${id}`));
      for (const row of records(result)) {
        assert.equal(row.data.origin_run.id, fixture.runIds[row.data.feature.source_key].older);
        assert.notEqual(row.data.origin_run.id, fixture.runIds[row.data.feature.source_key].latest);
        assert.equal(row.data.origin_run.status, "complete");
        assert.equal(row.data.geometry.srid, 4326);
      }
      for (const row of sourceRecords(result, parcelKey)) {
        assert.match(row.data.attributes.source_attributes_json, /"precise":\s*9007199254740993/);
      }
      const geometry = (await query(`SELECT encode(ST_AsEWKB(geom,'NDR'),'hex') AS ewkb,
        ST_XMax(Box3D(geom)) AS east FROM gis.dcad_parcels WHERE object_id=$1::bigint`, [fixture.parcelIds[2]])).rows[0];
      assert.ok(geometry.east > fixture.bounds.east, "fixture really crosses the query boundary");
      assert.equal(sourceRecords(result, parcelKey).find(row => row.data.feature.object_id === fixture.parcelIds[2]).data.geometry.ewkb, geometry.ewkb,
        "capture must retain source geometry rather than clipping it to the query");
      assert.equal(result.applicability.provider_coverage, "unknown");
      assert.equal(result.applicability.historical_availability, "unknown");
      assert.equal(result.applicability.report_eligibility, "not_assessed");
    });

    await subtest("spatial inclusion uses intersection after bbox filtering and resolves every subject part", async () => {
      const { west, south, east, north } = fixture.bounds;
      const spatial = (await query(`SELECT object_id::text,
        geom && ST_MakeEnvelope($1,$2,$3,$4,4326) AS bbox,
        ST_Intersects(geom,ST_MakeEnvelope($1,$2,$3,$4,4326)) AS intersects,
        ST_NumGeometries(geom) AS parts
        FROM gis.dcad_parcels ORDER BY object_id`, [west, south, east, north])).rows;
      assert.equal(spatial.find(row => row.object_id === fixture.parcelIds[4]).bbox, true);
      assert.equal(spatial.find(row => row.object_id === fixture.parcelIds[4]).intersects, false);
      assert.equal(spatial.find(row => row.object_id === fixture.parcelIds[3]).bbox, false);
      assert.equal(spatial.find(row => row.object_id === fixture.parcelIds[1]).parts, 2);
      const result = await read({ sourceKeys: [parcelKey] });
      assert.equal(result.status, "ready");
      assert.deepEqual(new Set(sourceRecords(result, parcelKey).map(row => row.data.feature.object_id)), new Set(fixture.insideParcelIds));
      assert.deepEqual(result.subject.member_record_ids, fixture.subjectIds.map(id => `${parcelKey}:${id}`));
      const outside = await read({ scope: { ...fixture.scope, account_id: fixture.outsideAccount }, sourceKeys: [parcelKey] });
      assert.equal(outside.status, "incomplete");
      assert.ok(outside.subject.reasons.includes("subject_outside_query_envelope"));
      assert.ok(outside.subject.reasons.includes("subject_member_not_captured"));
      const missing = await read({ scope: { ...fixture.scope, account_id: "SYNTHETIC-GIS-NOT-FOUND" }, sourceKeys: [parcelKey] });
      assert.ok(missing.subject.reasons.includes("subject_account_not_resolved"));
    });

    await subtest("numeric and C text cursors preserve every cap+1 sentinel exactly once", async () => {
      const cursors = { "page:parcel": [], "page:zoning": [] };
      const observed = observingPool(verifiedPool, (tag, input) => { if (cursors[tag]) cursors[tag].push(input.values[5]); });
      const result = await read({ pool: observed, limits: { page_rows: 1 } });
      assert.equal(result.status, "ready");
      assert.equal(result.totals.rows, 8);
      assert.deepEqual(cursors["page:parcel"], [null, ...fixture.insideParcelIds.slice(0, 2)]);
      assert.deepEqual(cursors["page:zoning"], [null, ...fixture.zoningIds.slice(0, 2)]);
      assert.deepEqual(new Set(sourceRecords(result, zoneKey).map(row => row.data.feature.object_id)), new Set(fixture.zoningIds));
      assert.equal(new Set(records(result).map(row => row.record_id)).size, 8);
    });

    await subtest("real SQL byte windows resume suppressed payloads without dropping features", async () => {
      const rawSizes = [];
      const baseline = await read({ sourceKeys: [parcelKey], pool: observingPool(verifiedPool, (tag, _input, result) => {
        if (tag === "page:parcel") rawSizes.push(...result.rows.map(row => row.payload_bytes));
      }) });
      const normalizedMax = Math.max(...records(baseline).map(row => Buffer.byteLength(canonicalAssessmentJson(row))));
      const pageBytes = Math.max(normalizedMax, ...rawSizes) + 100;
      assert.ok(pageBytes < 2 * Math.min(...rawSizes), "fixture forces one payload per byte-limited page");
      const pages = [];
      const result = await read({ sourceKeys: [parcelKey], limits: { page_rows: 4, record_bytes: pageBytes, page_bytes: pageBytes },
        pool: observingPool(verifiedPool, (tag, input, response) => { if (tag === "page:parcel") pages.push({ after: input.values[5], rows: response.rows }); }) });
      assert.equal(result.status, "ready");
      assert.ok(pages[0].rows.some(row => row.page_bytes_exceeded === true && row.payload_json === null));
      assert.deepEqual(pages.map(page => page.after), [null, ...fixture.insideParcelIds.slice(0, 2)]);
      assert.deepEqual(new Set(records(result).map(row => row.record_id)), new Set(fixture.insideParcelIds.map(id => `${parcelKey}:${id}`)));
      assert.equal(result.totals.rows, 3);
    });

    await subtest("row cap distinguishes an exhausted three-row query from truncation at two", async () => {
      const exact = await read({ sourceKeys: [parcelKey], limits: { total_rows: 3, page_rows: 2 } });
      assert.equal(exact.status, "ready");
      assert.equal(diagnostic(exact, parcelKey).query_exhausted, true);
      const capped = await read({ sourceKeys: [parcelKey], limits: { total_rows: 2, page_rows: 2 } });
      assert.equal(capped.status, "incomplete");
      assert.ok(diagnostic(capped, parcelKey).reasons.includes("total_rows_limit"));
      assert.equal(sourceRecords(capped, parcelKey).length, 0);
    });

    await subtest("malformed early-sorting zoning IDs cannot disappear behind valid cursors", async () => {
      for (const id of fixture.malformedZoningIds) {
        try {
          await query(`UPDATE gis.zoning_districts SET geom=ST_Multi(ST_GeomFromText($3,4326))
            WHERE provider_key=$1 AND source_record_id=$2`, [fixture.zone.providerKey, id, fixture.insideWkt]);
          await assert.rejects(read({ sourceKeys: [parcelKey, zoneKey], limits: { page_rows: 1 } }), {
            code: "NEIGHBORHOOD_GIS_READ_FAILED", state: "incomplete", reason: "invalid_feature_identity",
          });
        } finally {
          await query(`UPDATE gis.zoning_districts SET geom=ST_Multi(ST_GeomFromText($3,4326))
            WHERE provider_key=$1 AND source_record_id=$2`, [fixture.zone.providerKey, id, fixture.outsideWkt]);
        }
      }
      assert.equal((await read()).status, "ready", "restored outside malformed features must not contaminate the selected query");
    });

    await subtest("healthy empty source, missing state and an absent table have different evidence status", async () => {
      const empty = await read({ sourceKeys: [parcelKey, fixture.emptySourceKey] });
      assert.equal(empty.status, "ready");
      const emptySource = empty.capture.sources.find(source => source.payload.upstream.key === fixture.emptySourceKey);
      assert.deepEqual(emptySource.payload.records, []);
      assert.equal(emptySource.payload.projection.complete, true);
      const missingState = await read({ sourceKeys: [parcelKey, fixture.missingStateSourceKey] });
      assert.equal(missingState.status, "incomplete");
      assert.ok(diagnostic(missingState, fixture.missingStateSourceKey).reasons.includes("source_sync_unverified"));
      assert.equal(missingState.capture.capability_diagnostics.find(item => item.upstream_source_id === `gis-cache:${fixture.missingStateSourceKey}`).upstream_state, "present_empty");
      // Reversible fixed-name rename in this unique child only. No DROP/DELETE.
      await query("ALTER TABLE gis.traffic_volume_segments RENAME TO neighborhood_gis_fixture_traffic_hidden");
      try {
        const absent = await read();
        assert.equal(absent.status, "incomplete");
        assert.ok(diagnostic(absent, "txdot_aadt").reasons.includes("source_schema_absent"));
        assert.equal(sourceRecords(absent, "txdot_aadt").length, 0);
        assert.equal(sourceRecords(absent, parcelKey).length, 3);
      } finally {
        await query("ALTER TABLE gis.neighborhood_gis_fixture_traffic_hidden RENAME TO traffic_volume_segments");
      }
      await query("ALTER TABLE gis.source_sync_runs RENAME TO neighborhood_gis_fixture_runs_hidden");
      try {
        const absentRuns = await read({ sourceKeys: [parcelKey] });
        assert.equal(absentRuns.status, "incomplete");
        assert.ok(diagnostic(absentRuns, parcelKey).reasons.includes("source_sync_schema_absent"));
        assert.ok(diagnostic(absentRuns, parcelKey).reasons.includes("origin_run_unverified"));
        assert.equal(absentRuns.capture.capability_diagnostics[0].upstream_state, "populated");
        assert.equal(diagnostic(absentRuns, parcelKey).reasons.includes("source_schema_absent"), false);
      } finally {
        await query("ALTER TABLE gis.neighborhood_gis_fixture_runs_hidden RENAME TO source_sync_runs");
      }
    });

    await subtest("running, failed and missing latest runs do not reuse healthy older rows as complete evidence", async () => {
      for (const status of ["running", "failed"]) {
        try {
          await query("UPDATE gis.source_sync_state SET status=$2 WHERE source_key=$1", [parcelKey, status]);
          const result = await read({ sourceKeys: [parcelKey] });
          assert.equal(result.status, "incomplete");
          assert.ok(diagnostic(result, parcelKey).reasons.includes("source_sync_unverified"));
        } finally {
          await query("UPDATE gis.source_sync_state SET status='current' WHERE source_key=$1", [parcelKey]);
        }
      }
      for (const status of ["running", "failed"]) {
        try {
          await query("UPDATE gis.source_sync_runs SET status=$2 WHERE id=$1::uuid", [fixture.runIds[parcelKey].latest, status]);
          const result = await read({ sourceKeys: [parcelKey] });
          assert.equal(result.status, "incomplete");
          assert.ok(diagnostic(result, parcelKey).reasons.includes("source_sync_unverified"));
          assert.equal(records(result).length, 0);
        } finally {
          await query("UPDATE gis.source_sync_runs SET status='complete' WHERE id=$1::uuid", [fixture.runIds[parcelKey].latest]);
        }
      }
      try {
        await query("UPDATE gis.source_sync_state SET last_run_id=NULL WHERE source_key=$1", [parcelKey]);
        const result = await read({ sourceKeys: [parcelKey] });
        assert.equal(result.status, "incomplete");
        assert.ok(diagnostic(result, parcelKey).reasons.includes("source_sync_unverified"));
      } finally {
        await query("UPDATE gis.source_sync_state SET last_run_id=$2::uuid WHERE source_key=$1", [parcelKey, fixture.runIds[parcelKey].latest]);
      }
      try {
        await query("UPDATE gis.dcad_parcels SET sync_run_id=NULL WHERE object_id=$1::bigint", [fixture.parcelIds[2]]);
        const result = await read({ sourceKeys: [parcelKey] });
        assert.equal(result.status, "incomplete");
        assert.ok(diagnostic(result, parcelKey).reasons.includes("origin_run_unverified"));
      } finally {
        await query("UPDATE gis.dcad_parcels SET sync_run_id=$2::uuid WHERE object_id=$1::bigint", [fixture.parcelIds[2], fixture.runIds[parcelKey].older]);
      }
    });

    await subtest("a second client can commit between pages while one capture retains its original snapshot", async () => {
      const writerPid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      let committed = false;
      let readerPid;
      const observed = observingPool(verifiedPool, async (tag, _input, _response, client) => {
        if (tag !== "page:parcel" || committed) return;
        readerPid = (await client.query({ text: "SELECT pg_backend_pid() AS pid", values: [], query_timeout: 3000 })).rows[0].pid;
        assert.notEqual(readerPid, writerPid, "snapshot oracle requires two real backend connections");
        // The third row is beyond both the selected first row and its sentinel.
        // This autocommit completes before the reader issues its next page.
        await query("UPDATE gis.dcad_parcels SET site_address='Synthetic after' WHERE object_id=$1::bigint", [fixture.parcelIds[2]]);
        committed = true;
      });
      try {
        const first = await read({ pool: observed, sourceKeys: [parcelKey], limits: { page_rows: 1 } });
        assert.equal(committed, true);
        assert.notEqual(readerPid, writerPid);
        assert.equal(first.status, "ready");
        const original = records(first).find(row => row.data.feature.object_id === fixture.parcelIds[2]);
        assert.equal(original.data.attributes.site_address, "Synthetic before");
        assert.equal((await query("SELECT site_address FROM gis.dcad_parcels WHERE object_id=$1::bigint", [fixture.parcelIds[2]])).rows[0].site_address, "Synthetic after");
        const second = await read({ sourceKeys: [parcelKey], limits: { page_rows: 1 } });
        const updated = records(second).find(row => row.data.feature.object_id === fixture.parcelIds[2]);
        assert.equal(second.status, "ready");
        assert.equal(updated.data.attributes.site_address, "Synthetic after");
        assert.notEqual(updated.data.normalized_content_sha256, original.data.normalized_content_sha256);
        assert.equal(original.data.attributes.site_address, "Synthetic before", "the already captured immutable evidence must not change");
      } finally {
        await query("UPDATE gis.dcad_parcels SET site_address='Synthetic before' WHERE object_id=$1::bigint", [fixture.parcelIds[2]]);
      }
    });

    // GR-S1 source additions: the ordinary real-clock controls above are kept
    // intact. The clock below is stipulated only where testing a precise native
    // predicate boundary; no state/page/registry result or boolean is fabricated.
    const exact = "2024-03-01T12:00:00.500500Z";
    const observed = "2024-03-01T12:00:00.500Z";
    const withClock = () => observingPool(verifiedPool, (tag, input, response) => {
      if (tag === "clock") {
        assert.equal(response.rows.length, 1);
        assert.match(response.rows[0].captured_at_exact, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        response.rows[0] = { ...response.rows[0], captured_at: observed, captured_at_exact: exact };
      } else if (tag === "state" || tag === "registry" || tag?.startsWith("page:")) {
        assert.equal(input.values.at(-1), exact, "every native predicate gets the same unrounded stipulated clock");
      }
    });
    const temporalRead = key => read({ pool: withClock(), sourceKeys: key === parcelKey ? [parcelKey] : [parcelKey, key] });
    const unverified = async (key, reason) => {
      const result = await temporalRead(key);
      assert.equal(result.status, "incomplete");
      assert.ok(diagnostic(result, key).reasons.includes(reason));
      assert.equal(sourceRecords(result, key).length, 0);
      if (key !== parcelKey) assert.equal(sourceRecords(result, parcelKey).length, 3);
    };
    const withTimeline = async (key, mutate, check) => {
      // PostgreSQL text preserves all timestamp microseconds, including infinity;
      // pg's ordinary Date decoding would lose precision during restoration.
      const ids = [fixture.runIds[key].older, fixture.runIds[key].latest];
      const runs = (await query(`SELECT id::text, started_at::text, completed_at::text
        FROM gis.source_sync_runs WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids])).rows;
      const state = (await query(`SELECT last_attempt_at::text, last_success_at::text
        FROM gis.source_sync_state WHERE source_key=$1`, [key])).rows[0];
      const registry = key === zoneKey ? (await query(`SELECT last_success_at::text
        FROM gis.zoning_source_registry WHERE provider_key=$1`, [fixture.zone.providerKey])).rows[0] : null;
      assert.equal(runs.length, 2);
      assert.ok(state);
      try { await mutate(); await check(); }
      finally {
        for (const run of runs) await query(`UPDATE gis.source_sync_runs SET started_at=$2::timestamptz,
          completed_at=$3::timestamptz WHERE id=$1::uuid`, [run.id, run.started_at, run.completed_at]);
        await query(`UPDATE gis.source_sync_state SET last_attempt_at=$2::timestamptz,
          last_success_at=$3::timestamptz WHERE source_key=$1`, [key, state.last_attempt_at, state.last_success_at]);
        if (registry) await query(`UPDATE gis.zoning_source_registry SET last_success_at=$2::timestamptz
          WHERE provider_key=$1`, [fixture.zone.providerKey, registry.last_success_at]);
      }
    };
    const setLatest = async (key, start, attempt, end, success) => {
      await query(`UPDATE gis.source_sync_runs SET started_at=$2::timestamptz, completed_at=$3::timestamptz
        WHERE id=$1::uuid`, [fixture.runIds[key].latest, start, end]);
      await query(`UPDATE gis.source_sync_state SET last_attempt_at=$2::timestamptz, last_success_at=$3::timestamptz
        WHERE source_key=$1`, [key, attempt, success]);
    };

    await subtest("native chronology rejects reversed microseconds in latest and older origin runs", async () => {
      const start = "2024-02-01T00:00:00.000900Z", end = "2024-02-01T00:00:00.000100Z";
      await withTimeline(parcelKey, () => setLatest(parcelKey, start, start, end, start),
        () => unverified(parcelKey, "source_sync_unverified"));
      await withTimeline(parcelKey, () => query(`UPDATE gis.source_sync_runs SET started_at=$2::timestamptz,
        completed_at=$3::timestamptz WHERE id=$1::uuid`, [fixture.runIds[parcelKey].older, start, end]),
      () => unverified(parcelKey, "origin_run_unverified"));
      assert.equal((await temporalRead(parcelKey)).status, "ready");
    });

    await subtest("native ordered microseconds and real-writer equal times remain usable without retained private fields", async () => {
      for (const values of [
        ["000100", "000200", "000700", "000900"], ["000100", "000100", "000900", "000900"],
      ]) await withTimeline(parcelKey, () => setLatest(parcelKey, ...values.map(value => `2024-02-01T00:00:00.${value}Z`)), async () => {
        const result = await temporalRead(parcelKey);
        assert.equal(result.status, "ready");
        const definition = result.capture.sources[0].payload.projection.definition;
        assert.equal(Object.keys(definition.raw_source_state).length, 16);
        assert.equal(Object.keys(records(result)[0].data.origin_run).length, 6);
        assert.equal(JSON.stringify(result).includes('"captured_at_exact"'), false);
        assert.equal(JSON.stringify(result).includes('"chronology_valid"'), false);
        assert.equal(records(result)[0].data.origin_run.id, fixture.runIds[parcelKey].older);
      });
      const result = await temporalRead(zoneKey);
      assert.equal(result.status, "ready");
      const zone = result.capture.sources.find(source => source.payload.upstream.key === zoneKey);
      assert.equal(Object.keys(zone.payload.projection.definition.zoning_registry).length, 8);
    });

    await subtest("native attempt chronology refuses null, before-start, after-completion and post-clock timestamps", async () => {
      for (const attempt of [null, "2024-01-31T23:59:59.999999Z", "2024-02-02T00:00:00.000001Z", "2024-03-01T12:00:00.500501Z"]) {
        await withTimeline(parcelKey, () => query(`UPDATE gis.source_sync_state SET last_attempt_at=$2::timestamptz
          WHERE source_key=$1`, [parcelKey, attempt]), () => unverified(parcelKey, "source_sync_unverified"));
      }
      assert.equal((await temporalRead(parcelKey)).status, "ready");
    });

    await subtest("native predicates enforce one-microsecond capture bounds with an explicitly stipulated clock", async () => {
      const before = "2024-03-01T12:00:00.500100Z", after = "2024-03-01T12:00:00.500501Z";
      for (const values of [[after, after, after, after], [before, before, after, after], [before, before, before, after]]) {
        await withTimeline(parcelKey, () => setLatest(parcelKey, ...values), () => unverified(parcelKey, "source_sync_unverified"));
      }
      await withTimeline(parcelKey, () => query(`UPDATE gis.source_sync_runs SET started_at=$2::timestamptz,
        completed_at=$3::timestamptz WHERE id=$1::uuid`, [fixture.runIds[parcelKey].older, before, after]),
      () => unverified(parcelKey, "origin_run_unverified"));
      await withTimeline(zoneKey, () => query(`UPDATE gis.zoning_source_registry SET last_success_at=$2::timestamptz
        WHERE provider_key=$1`, [fixture.zone.providerKey, after]), () => unverified(zoneKey, "zoning_registry_unverified"));
      assert.equal((await temporalRead(zoneKey)).status, "ready");
    });

    await subtest("native registry comparisons retain microsecond order and equality with the exact source state", async () => {
      for (const [registryTime, ready] of [["500399", false], ["500400", true], ["500500", true]]) {
        await withTimeline(zoneKey, async () => {
          await setLatest(zoneKey, "2024-03-01T12:00:00.500100Z", "2024-03-01T12:00:00.500200Z",
            "2024-03-01T12:00:00.500300Z", "2024-03-01T12:00:00.500400Z");
          await query(`UPDATE gis.zoning_source_registry SET last_success_at=$2::timestamptz WHERE provider_key=$1`,
            [fixture.zone.providerKey, `2024-03-01T12:00:00.${registryTime}Z`]);
        }, async () => {
          if (ready) assert.equal((await temporalRead(zoneKey)).status, "ready");
          else await unverified(zoneKey, "zoning_registry_unverified");
        });
      }
    });

    await subtest("native nullable and nonfinite chronology operands cannot become a true admission flag", async () => {
      for (const value of [null, "infinity", "-infinity"]) {
        for (const column of ["last_attempt_at", "last_success_at"]) await withTimeline(parcelKey,
          () => query(`UPDATE gis.source_sync_state SET ${column}=$2::timestamptz WHERE source_key=$1`, [parcelKey, value]),
          () => unverified(parcelKey, "source_sync_unverified"));
        for (const [which, reason] of [["latest", "source_sync_unverified"], ["older", "origin_run_unverified"]]) {
          await withTimeline(parcelKey, () => query(`UPDATE gis.source_sync_runs SET completed_at=$2::timestamptz
            WHERE id=$1::uuid`, [fixture.runIds[parcelKey][which], value]), () => unverified(parcelKey, reason));
        }
        await withTimeline(zoneKey, () => query(`UPDATE gis.zoning_source_registry SET last_success_at=$2::timestamptz
          WHERE provider_key=$1`, [fixture.zone.providerKey, value]), () => unverified(zoneKey, "zoning_registry_unverified"));
      }
      // started_at is NOT NULL: exercise infinities without weakening that constraint.
      for (const value of ["infinity", "-infinity"]) for (const which of ["latest", "older"]) {
        await withTimeline(parcelKey, () => query(`UPDATE gis.source_sync_runs SET started_at=$2::timestamptz
          WHERE id=$1::uuid`, [fixture.runIds[parcelKey][which], value]),
        () => unverified(parcelKey, which === "latest" ? "source_sync_unverified" : "origin_run_unverified"));
      }
      assert.equal((await temporalRead(zoneKey)).status, "ready");
    });

    await subtest("native optional run and sync-state schemas keep chronology parameter arity and source distinctions", async () => {
      await query("ALTER TABLE gis.source_sync_runs RENAME TO neighborhood_gis_fixture_runs_hidden");
      try {
        const result = await temporalRead(zoneKey);
        assert.equal(result.status, "incomplete");
        assert.ok(diagnostic(result, parcelKey).reasons.includes("source_sync_schema_absent"));
        assert.ok(diagnostic(result, zoneKey).reasons.includes("origin_run_unverified"));
      } finally { await query("ALTER TABLE gis.neighborhood_gis_fixture_runs_hidden RENAME TO source_sync_runs"); }
      await query("ALTER TABLE gis.source_sync_state RENAME TO neighborhood_gis_fixture_state_hidden");
      try {
        const result = await temporalRead(zoneKey);
        assert.equal(result.status, "incomplete");
        assert.ok(diagnostic(result, zoneKey).reasons.includes("zoning_registry_unverified"));
        assert.ok(diagnostic(result, parcelKey).reasons.includes("source_sync_schema_absent"));
        assert.equal(sourceRecords(result, zoneKey).length, 0);
      } finally { await query("ALTER TABLE gis.neighborhood_gis_fixture_state_hidden RENAME TO source_sync_state"); }
      assert.equal((await temporalRead(zoneKey)).status, "ready");
    });
  } finally {
    try { writer?.release(); } finally { await pool.end(); }
  }
});
