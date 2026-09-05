import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNeighborhoodCiDatabase, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './helpers/neighborhoodCiDatabase.js';
import { buildNeighborhoodPostgisLandUseFixture, LAND_USE_FIXTURE_VARIANTS, LAND_USE_FIXTURE_COORDINATES,
  rehashLandUseFixtureSnapshot, rebindLandUseFixtureFeature } from './fixtures/neighborhoodPostgisLandUseFixture.js';

const near = (actual, expected, label) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= LAND_USE_FIXTURE_COORDINATES.area_tolerance_m2,
  `${label}: expected ${expected}, received ${actual}`);

// Enrollment in the existing isolated CI command is a separate owner-coordinated
// change. This file creates no source rows, schema, provider traffic or persisted
// geometry. The accepted helper must prepare a unique ephemeral child first.
test('PostGIS land-use partition: supplied evidence conserves exclusive full-boundary area', {
  skip: !process.env.DATABASE_URL, timeout: 240000,
}, async t => {
  const target = await prepareNeighborhoodCiDatabase();
  const { default: pg } = await import('pg');
  const { createNeighborhoodPostgisLandUsePartition, LAND_USE_KNOWN_CATEGORIES } = await import('../src/services/neighborhoodAssessment/postgisLandUsePartition.js');
  const rawPool = new pg.Pool({ connectionString: target.connectionString, max: 3,
    connectionTimeoutMillis: 3000, statement_timeout: 8000, application_name: 'neighborhood_land_use_integration' });
  const checked = new WeakSet();
  let lastPartition = null;
  const queryTrace = [];
  const pool = {
    async connect() {
      const client = await rawPool.connect();
      try {
        if (!checked.has(client)) {
          const identity = (await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0];
          verifyNeighborhoodCiConnection(identity, client.connection?.stream?.remoteAddress, target.databaseName);
          checked.add(client);
        }
        return {
          async query(input, values) {
            const result = await client.query(input, values);
            const sql = typeof input === 'string' ? input : input.text;
            const stage = /neighborhood-land-use:([a-z]+)/.exec(sql)?.[1];
            if (stage) {
              queryTrace.push({ stage, result_shape: Array.isArray(result) ? 'multiple_results' : 'single_result',
                row_count: result.rows?.length ?? null });
              if (queryTrace.length > 16) queryTrace.shift();
            }
            if (stage === 'partition') lastPartition = { row_count: result.rows?.length ?? null,
              payload_bytes: result.rows?.[0]?.payload_bytes ?? null, payload: result.rows?.[0]?.payload ?? null };
            return result;
          },
          release(error) { return client.release(error); },
        };
      } catch (error) { client.release(error); throw error; }
    },
    async query(text, values) {
      const client = await this.connect();
      try { return await client.query(text, values); } finally { client.release(); }
    },
  };
  const engine = createNeighborhoodPostgisLandUsePartition(pool);
  const expectedKeys = [...LAND_USE_KNOWN_CATEGORIES, 'unknown_uncovered', 'unknown_classification', 'unknown_conflict'];
  const verify = (result, expected) => {
    if (result.computation_status !== 'ready') {
      // Only this invented fixture's area/count/reference payload is eligible
      // for diagnostics; no SQL text, connection identity or source data logs.
      const diagnostic = JSON.stringify({ query_trace: queryTrace, partition: lastPartition });
      t.diagnostic(Buffer.byteLength(diagnostic) <= 16000 ? diagnostic
        : JSON.stringify({ query_trace: queryTrace, diagnostic: 'synthetic_payload_exceeds_diagnostic_limit' }));
    }
    assert.equal(result.computation_status, 'ready', JSON.stringify(result.incomplete_reasons));
    assert.equal(result.report_eligibility, 'not_assessed');
    assert.ok(result.partition_revision); assert.ok(result.engine_versions); assert.equal(Object.isFrozen(result), true);
    near(result.boundary_area_m2, expected.boundary_area_m2, 'boundary denominator');
    assert.deepEqual(result.buckets.map(row => row.category).sort(), [...expectedKeys].sort());
    const byCategory = new Map(result.buckets.map(row => [row.category, row]));
    for (const category of expectedKeys) {
      const bucket = byCategory.get(category);
      const expectedArea = expected.areas_m2[category] ?? 0;
      near(bucket.area_m2, expectedArea, category);
      near(bucket.percent_of_boundary, expectedArea / expected.boundary_area_m2 * 100, `${category} percent`);
      assert.equal(new Set(bucket.source_feature_ids).size, bucket.source_feature_ids.length);
      for (const absent of expected.zero_area_feature_ids) assert.equal(bucket.source_feature_ids.includes(absent), false);
    }
    near(result.buckets.reduce((sum, row) => sum + row.area_m2, 0), expected.boundary_area_m2, 'exclusive area conservation');
    near(result.buckets.reduce((sum, row) => sum + row.percent_of_boundary, 0), 100, 'full-boundary percentages');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= result.limits.output_bytes);
  };
  try {
    await t.test('exact synthetic difference operands return a native polygon result', async () => {
      // These are invented EPSG:26914 operands captured from the extending-tract
      // oracle. The experimental WASM runtime returned no typed SQL row for this
      // valid-operand difference; retain the exact bytes for native verification.
      // No snap, repair, simplification or replacement geometry is applied.
      const boundary = '0103000020226900000100000005000000feffffffbf5c2541feffffff3f774b4100000000885d2541ffffffff3f774b41fdffffff875d25410100000072774b41feffffffbf5c25410100000072774b41feffffffbf5c2541feffffff3f774b41';
      const observed = '010300002022690000010000000d00000002000000385d2541feffffff71774b41feffffff555d25410100000072774b41020000006a5d2541ffffffff71774b4103000000745d2541feffffff71774b41f4ffffff735d2541ffffffff3f774b41feffffff695d2541ffffffff3f774b41fcffffff555d25410100000040774b413594d7503e5d2541ffffffff3f774b4100000000385d2541ffffffff3f774b4129afa1bc1e5d2541feffffff3f774b41feffffffbf5c25410000000040774b41feffffffbf5c2541ffffffff71774b4102000000385d2541feffffff71774b41';
      const operands = `WITH operands AS (SELECT ST_GeomFromEWKB(decode($1,'hex')) AS boundary,
        ST_GeomFromEWKB(decode($2,'hex')) AS observed)`;
      const validity = await pool.query(`${operands} SELECT ST_SRID(boundary) AS srid,
        ST_IsValid(boundary) AS boundary_valid, ST_IsValid(observed) AS observed_valid FROM operands`, [boundary, observed]);
      assert.deepEqual(validity.rows, [{ srid: 26914, boundary_valid: true, observed_valid: true }]);
      const difference = await pool.query(`${operands} SELECT
        ST_Area(ST_CollectionExtract(ST_Difference(boundary,observed),3)) AS uncovered_area_m2 FROM operands`, [boundary, observed]);
      assert.equal(difference.rows.length, 1, 'a scalar geometry query must return one native SQL row');
      near(difference.rows[0].uncovered_area_m2, 1000, 'exact-operand uncovered area');
    });
    for (const variant of LAND_USE_FIXTURE_VARIANTS) await t.test(`independent metric oracle: ${variant}`, async () => {
      const fixture = await buildNeighborhoodPostgisLandUseFixture(pool, variant);
      lastPartition = null; queryTrace.length = 0;
      const before = JSON.stringify(fixture.input);
      const result = await engine.build(fixture.input);
      verify(result, fixture.expected);
      assert.equal(JSON.stringify(fixture.input), before, 'kernel does not mutate supplied evidence');
      const ids = new Set(fixture.input.features.map(row => row.id));
      assert.ok(result.buckets.every(bucket => bucket.source_feature_ids.every(id => ids.has(id))));
    });
    await t.test('independent input ordering is stable and changed interpretation revises identity', async () => {
      const { input, expected } = await buildNeighborhoodPostgisLandUseFixture(pool);
      const first = await engine.build(input); verify(first, expected);
      input.features.reverse(); input.source_snapshots.reverse(); input.source_snapshots.forEach(source => source.records.reverse());
      const reordered = await engine.build(input); verify(reordered, expected);
      assert.equal(reordered.input_sha256, first.input_sha256);
      assert.equal(reordered.partition_revision, first.partition_revision);
      input.features[0].classification.policy_version = 'synthetic-explicit-current-use-v2';
      rebindLandUseFixtureFeature(input, input.features[0].id);
      const changed = await engine.build(input); verify(changed, expected);
      assert.notEqual(changed.input_sha256, first.input_sha256);
      assert.notEqual(changed.partition_revision, first.partition_revision);
    });
    await t.test('unknown historical use remains unclassified and cannot become report-ready', async () => {
      const { input, expected } = await buildNeighborhoodPostgisLandUseFixture(pool);
      for (const feature of input.features.filter(row => row.classification.category === 'one_unit')) {
        feature.historical_availability = { status: 'unknown', available_at: null };
        rebindLandUseFixtureFeature(input, feature.id);
      }
      const result = await engine.build(input);
      verify(result, { ...expected, areas_m2: { ...expected.areas_m2, one_unit: 0, unknown_classification: 6000 } });
      assert.notEqual(result.effective_date_support, 'supported');
    });
    await t.test('incomplete capture cannot expose a ready partition or denominator', async () => {
      const { input } = await buildNeighborhoodPostgisLandUseFixture(pool);
      input.source_snapshots[0].state = 'incomplete'; rehashLandUseFixtureSnapshot(input.source_snapshots[0]);
      const result = await engine.build(input);
      assert.equal(result.computation_status, 'incomplete');
      assert.equal(result.partition_revision, null); assert.equal(result.boundary_area_m2, null); assert.deepEqual(result.buckets, []);
      assert.equal(result.report_eligibility, 'not_assessed');
    });
  } finally { await rawPool.end(); }
});
