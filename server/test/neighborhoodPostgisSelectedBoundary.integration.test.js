import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { projectMetricTopologyFixture } from './fixtures/neighborhoodPostgisTopologyFixture.js';
import { makeSubjectEvidence, makeSelectedBoundaryInput } from './fixtures/neighborhoodSelectedBoundaryFixture.js';

// SOURCE ONLY until the separately reviewed native-enrollment gate is released.
// No local/shared database fallback, provider data, schema cleanup or production
// table reads. A successful mock is not evidence that these predicates passed.
// TODO(neighborhood-selected-boundary): after exact native acceptance, coordinate
// the ORIGINAL #632 artifact + independently captured synthetic subject replay
// with Algorithms' frozen perimeter consumer. Never add invented parcel evidence
// to the original artifact or equate this mathematical proof with report consent.

const rectangle = (west, south, east, north) => {
  const ring = [[west, south], [east, south], [east, north], [west, north], [west, south]];
  assert.ok(ring.flat().every(value => Number.isFinite(value) && Math.abs(value) <= 2000));
  return `(${ring.map(([x, y]) => `${700000 + x} ${3600000 + y}`).join(',')})`;
};
const polygon = (...bounds) => `POLYGON (${rectangle(...bounds)})`;
const multipolygon = (...boxes) => `MULTIPOLYGON (${boxes.map(bounds => `(${rectangle(...bounds)})`).join(',')})`;
const noGeometry = result => {
  assert.equal(result.status, 'incomplete');
  assert.equal(result.geometry, null); assert.equal(result.selected_boundary, null);
  assert.equal(result.subject_manifest, null); assert.deepEqual(result.boundary_source_occurrences, []);
  assert.ok(result.incomplete_reasons.length > 0);
};

test('PostGIS selected boundary: exact union, holes, full subject and strict shared anchor', {
  skip: !process.env.DATABASE_URL, timeout: 360000,
}, async t => {
  // All CI/loopback/unique child identity guards precede pg import and pool use.
  const target = await prepareNeighborhoodCiDatabase();
  const { default: pg } = await import('pg');
  const { createNeighborhoodPostgisTopology, neighborhoodTopologyRevision } = await import('../src/services/neighborhoodAssessment/postgisTopology.js');
  const { createNeighborhoodSelectedBoundary } = await import('../src/services/neighborhoodAssessment/postgisSelectedBoundary.js');
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 3,
    connectionTimeoutMillis: 3000, statement_timeout: 8000, application_name: 'neighborhood_selected_boundary_integration' });
  const built = new Map();
  const topology = async name => {
    if (!built.has(name)) {
      const source = await projectMetricTopologyFixture(pool, name);
      const value = await createNeighborhoodPostgisTopology(pool).build(source);
      assert.equal(value.status, 'ready', `native topology ${name} must be ready before selection tests`);
      built.set(name, { source, topology: value });
    }
    return built.get(name);
  };
  const subject = async (...wkts) => {
    const { rows } = await pool.query({ text: `/* selected-boundary-fixture:subject-projection */
      SELECT item.ordinal, encode(ST_AsEWKB(ST_Transform(ST_GeomFromText(item.wkt,26914),4326),'NDR'),'hex') AS ewkb
      FROM jsonb_to_recordset($1::jsonb) AS item(ordinal integer,wkt text) ORDER BY ordinal`,
    values: [JSON.stringify(wkts.map((wkt, ordinal) => ({ ordinal, wkt })))] });
    assert.equal(rows.length, wkts.length);
    return makeSubjectEvidence({ geometries: rows.map(row => row.ewkb) });
  };
  const validate = async (value, subjectEvidence, selectedCellIds = value.cells.map(cell => cell.id), limits) => {
    const input = makeSelectedBoundaryInput({ topology: value, subjectEvidence, selectedCellIds });
    const original = structuredClone(input);
    const result = await createNeighborhoodSelectedBoundary(pool, limits === undefined ? {} : { limits }).validate(input);
    assert.deepEqual(input, original, 'native validation must not rewrite source/selection evidence');
    return { input, result };
  };
  const audit = async ({ input, result }, expectedHoles = 0) => {
    assert.equal(result.status, 'ready');
    const boundary = result.selected_boundary;
    assert.equal(boundary.validation.valid, true); assert.equal(boundary.validation.connected, true);
    assert.equal(boundary.validation.contains_subject, true);
    assert.equal(boundary.label_anchor.basis, 'validated_subject_interior_point');
    assert.equal(boundary.label_anchor.validation_revision, boundary.validation.revision);
    assert.equal(boundary.interiors.length, expectedHoles);
    const selected = new Set(input.selection.selected_cell_ids);
    const expectedEdges = input.topology.edges.filter(edge => edge.cell_ids.filter(id => selected.has(id)).length === 1);
    const expectedById = new Map(expectedEdges.map(edge => [edge.id, edge]));
    const rings = [boundary.exterior, ...boundary.interiors];
    const segments = rings.flatMap((ring, ringIndex) => ring.segments.map((segment, order) => {
      const edge = expectedById.get(segment.edge_id);
      assert.ok(edge, 'only actual one-selected-incident edges may enter the perimeter');
      assert.equal(segment.from_node_id, segment.reversed ? edge.to_node_id : edge.from_node_id);
      assert.equal(segment.to_node_id, segment.reversed ? edge.from_node_id : edge.to_node_id);
      return { ring_index: ringIndex, ordinal: order, reversed: segment.reversed, ewkb: edge.geometry_ewkb };
    }));
    const usedIds = rings.flatMap(ring => ring.segments.map(segment => segment.edge_id));
    assert.equal(new Set(usedIds).size, usedIds.length);
    assert.deepEqual([...usedIds].sort(), expectedEdges.map(edge => edge.id).sort());
    assert.deepEqual(result.boundary_source_occurrences.map(item => ({
      edge_id: item.edge_id, source_parts: item.source_parts,
    })).sort((a, b) => a.edge_id.localeCompare(b.edge_id)), expectedEdges.map(edge => ({
      edge_id: edge.id, source_parts: edge.source_parts,
    })).sort((a, b) => a.edge_id.localeCompare(b.edge_id)), 'retain every original source-part occurrence');

    const subjectIds = new Set(input.subject_evidence.subject.member_record_ids);
    const members = input.subject_evidence.capture.sources.flatMap(source => source.payload.records)
      .filter(record => subjectIds.has(record.record_id));
    const { rows: [checked] } = await pool.query({ text: `/* selected-boundary-fixture:independent-native-audit */
      WITH cells AS (SELECT ST_GeomFromEWKB(decode(value,'hex')) AS geom FROM jsonb_array_elements_text($1::jsonb)),
      expected AS (SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom FROM cells),
      actual AS (SELECT ST_GeomFromEWKB(decode($2,'hex')) AS geom),
      subject_parts AS (SELECT ST_Transform(ST_GeomFromEWKB(decode(value,'hex')),26914) AS geom
        FROM jsonb_array_elements_text($3::jsonb)),
      subject_whole AS (SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom FROM subject_parts),
      anchor AS (SELECT ST_SetSRID(ST_MakePoint($4::double precision,$5::double precision),26914) AS geom),
      segments AS (SELECT s.ring_index,s.ordinal,CASE WHEN s.reversed THEN ST_Reverse(ST_GeomFromEWKB(decode(s.ewkb,'hex')))
        ELSE ST_GeomFromEWKB(decode(s.ewkb,'hex')) END AS geom
        FROM jsonb_to_recordset($6::jsonb) AS s(ring_index integer,ordinal integer,reversed boolean,ewkb text)),
      rings AS (SELECT ring_index,ST_MakeLine(array_agg(geom ORDER BY ordinal)) AS geom FROM segments GROUP BY ring_index),
      cycle_polygon AS (SELECT ST_MakePolygon((SELECT geom FROM rings WHERE ring_index=0),
        ARRAY(SELECT geom FROM rings WHERE ring_index>0 ORDER BY ring_index)) AS geom)
      SELECT ST_Equals(a.geom,e.geom) AS exact_union,ST_IsValid(a.geom) AS valid,
        GeometryType(a.geom) AS kind,ST_NumInteriorRings(a.geom) AS holes,
        ST_Equals(ST_Boundary(a.geom),(SELECT ST_UnaryUnion(ST_Collect(geom)) FROM segments)) AS exact_perimeter,
        ST_Equals(a.geom,c.geom) AS exact_cycles,
        (SELECT bool_and(ST_IsClosed(geom) AND ST_IsSimple(geom)
          AND ST_IsPolygonCCW(ST_MakePolygon(geom))=(ring_index=0)) FROM rings) AS ring_roles,
        ST_Covers(a.geom,s.geom) AS whole_subject_covered,
        (SELECT bool_and(ST_Covers(a.geom,geom)) FROM subject_parts) AS all_members_covered,
        ST_Contains(a.geom,p.geom) AS anchor_strictly_in_union,
        ST_Contains(s.geom,p.geom) AS anchor_strictly_in_subject
      FROM actual a CROSS JOIN expected e CROSS JOIN subject_whole s CROSS JOIN anchor p CROSS JOIN cycle_polygon c`,
    values: [JSON.stringify(input.topology.cells.filter(cell => selected.has(cell.id)).map(cell => cell.geometry_ewkb)),
      result.geometry.geometry_ewkb, JSON.stringify(members.map(record => record.data.geometry.ewkb)),
      ...boundary.label_anchor.coordinates, JSON.stringify(segments)] });
    assert.deepEqual(checked, { exact_union: true, valid: true, kind: 'POLYGON', holes: expectedHoles,
      exact_perimeter: true, exact_cycles: true, ring_roles: true, whole_subject_covered: true,
      all_members_covered: true, anchor_strictly_in_union: true, anchor_strictly_in_subject: true });
  };

  try {
    await t.test('single enclosure covers an independent interior subject and retains every source occurrence', async () => {
      const value = (await topology('closedRing')).topology;
      await audit(await validate(value, await subject(polygon(10, 10, 20, 20))));
    });
    await t.test('boundary coincidence uses Covers but anchor remains strictly interior', async () => {
      const { source, topology: value } = await topology('closedRing');
      // Use identical ORIGINAL4326 source coordinates. Projecting a returned
      // metric boundary back and forth could introduce ULP differences and would
      // not be an honest exact boundary-coincidence fixture.
      const same = makeSubjectEvidence({ geometries: [{ type: 'Polygon', coordinates: [source.features[0].geometry.coordinates] }] });
      await audit(await validate(value, same));
    });
    await t.test('all four adjacent cells dissolve without retaining shared interior edges', async () => {
      const value = (await topology('crossing')).topology;
      assert.equal(value.cells.length, 4);
      const checked = await validate(value, await subject(polygon(10, 10, 90, 90)));
      await audit(checked);
      assert.ok(value.edges.some(edge => edge.cell_ids.length === 2
        && !checked.result.boundary_source_occurrences.some(ref => ref.edge_id === edge.id)));
    });
    await t.test('rehashed selected-cell interiors that overlap reject during actual native admission', async () => {
      const value = structuredClone((await topology('crossing')).topology);
      // Deliberately forge ONE synthetic cell's position while keeping caller
      // ready flags and combinatorial incidence consistent. This is not a real
      // producer result and never modifies the original #632 artifact. Positive
      // source-line overlap tests below do not exercise this rejection branch.
      const { rows: [shifted] } = await pool.query({ text: `/* selected-boundary-fixture:overlapping-cell */
        WITH cells AS MATERIALIZED (
          SELECT item.id,ST_GeomFromEWKB(decode(item.ewkb,'hex')) AS geom
          FROM jsonb_to_recordset($1::jsonb) AS item(id text,ewkb text)
        ), target AS MATERIALIZED (
          SELECT id,ST_Translate(geom,10,0) AS moved FROM cells
          ORDER BY ST_XMin(Box2D(geom)),ST_YMin(Box2D(geom)),id COLLATE "C" LIMIT 1
        ) SELECT t.id,encode(ST_AsEWKB(t.moved,'NDR'),'hex') AS geometry_ewkb,
          ST_AsGeoJSON(ST_Transform(t.moved,4326),15)::jsonb AS geometry,
          ST_Area(t.moved) AS area_m2,
          (SELECT bool_or(ST_Relate(t.moved,c.geom,'2********')) FROM cells c WHERE c.id<>t.id) AS overlaps
        FROM target t`, values: [JSON.stringify(value.cells.map(cell => ({ id: cell.id, ewkb: cell.geometry_ewkb })))] });
      assert.equal(shifted.overlaps, true, 'the adversarial fixture must actually overlap another selected interior');
      const oldId = shifted.id;
      const newId = `cell:${createHash('sha256').update(Buffer.from(shifted.geometry_ewkb, 'hex')).digest('hex')}`;
      assert.equal(value.cells.some(cell => cell.id === newId), false);
      const cell = value.cells.find(item => item.id === oldId);
      Object.assign(cell, { id: newId, geometry_ewkb: shifted.geometry_ewkb, geometry: shifted.geometry, area_m2: shifted.area_m2 });
      for (const edge of value.edges) edge.cell_ids = edge.cell_ids.map(id => id === oldId ? newId : id);
      value.topology_revision = neighborhoodTopologyRevision(value);
      const checked = await validate(value, await subject(polygon(10, 10, 20, 20)));
      noGeometry(checked.result);
      assert.deepEqual(checked.result.incomplete_reasons, ['selected_interiors_overlap']);
    });
    await t.test('holes survive and a subject in the hole cannot pass', async () => {
      const value = (await topology('nested')).topology;
      const annulus = value.cells.find(cell => cell.interior_ring_count === 1);
      assert.ok(annulus);
      await audit(await validate(value, await subject(polygon(5, 5, 15, 15)), [annulus.id]), 1);
      noGeometry((await validate(value, await subject(polygon(45, 45, 55, 55)), [annulus.id])).result);
    });
    await t.test('an uncovered small multipart component or second account member cannot be discarded', async () => {
      const value = (await topology('closedRing')).topology;
      noGeometry((await validate(value, await subject(multipolygon([10, 10, 40, 40], [150, 10, 152, 12])))).result);
      noGeometry((await validate(value, await subject(polygon(10, 10, 40, 40), polygon(150, 10, 152, 12)))).result);
      await audit(await validate(value, await subject(multipolygon([10, 10, 20, 20], [70, 70, 80, 80]))));
    });
    await t.test('actual nonpolygonal, empty, self-intersecting and three-dimensional subject geometry fails', async () => {
      const value = (await topology('closedRing')).topology;
      for (const wkt of [
        'POINT (700010 3600010)', 'POLYGON EMPTY',
        'POLYGON ((700010 3600010,700020 3600020,700010 3600020,700020 3600010,700010 3600010))',
        'POLYGON Z ((700010 3600010 1,700020 3600010 1,700020 3600020 1,700010 3600020 1,700010 3600010 1))',
      ]) {
        const evidence = await subject(wkt);
        try { noGeometry((await validate(value, evidence)).result); }
        catch (error) {
          // A strict EWKB/type preflight may reject before native admission;
          // neither path may pass or return a partially validated boundary.
          assert.ok(error instanceof TypeError && /^invalid_neighborhood_selected_boundary:/.test(error.message));
        }
      }
    });
    for (const name of ['corner', 'disconnectedPockets']) await t.test(`${name}: no connector or hull may manufacture one neighborhood`, async () => {
      noGeometry((await validate((await topology(name)).topology, await subject(polygon(10, 10, 20, 20)))).result);
    });
    for (const name of ['curved', 'overlap', 'retraced']) await t.test(`${name}: native perimeter retains exact original split/source occurrences`, async () => {
      await audit(await validate((await topology(name)).topology, await subject(polygon(10, 10, 20, 20))));
    });
    await t.test('lower configured caps never expose a partial boundary', async () => {
      const value = (await topology('crossing')).topology;
      noGeometry((await validate(value, await subject(polygon(10, 10, 20, 20)), undefined, { selected_cells: 1 })).result);
      noGeometry((await validate(value, await subject(polygon(10, 10, 20, 20)), undefined, { output_bytes: 1 })).result);
    });
  } finally { await pool.end(); }
});
