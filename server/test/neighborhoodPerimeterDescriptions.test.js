import test from "node:test";
import assert from "node:assert/strict";
import { assessmentEvidenceDigest } from "../src/services/neighborhoodAssessment/contract.js";
import {
  describeNeighborhoodPerimeter, perimeterDescriptionDigest,
  PERIMETER_DESCRIPTION_VERSION, PERIMETER_DESCRIPTION_LIMITS,
} from "../src/services/neighborhoodAssessment/perimeterDescriptions.js";
import {
  neighborhoodPerimeterDescriptionFixture, rehashPerimeterFixture,
  rehashPerimeterFixtureRecord, perimeterFixtureTopologyRevision,
  FROZEN_TOPOLOGY_COMPATIBILITY_COMMIT,
} from "./fixtures/neighborhoodPerimeterDescriptionFixture.js";

// These are presentation/evidence-closure tests over invented metric geometry.
// Neither the supplied synthetic validation record nor its matching hashes
// establish spatial, source, authorization, or report-application authority.
const fixture = variant => neighborhoodPerimeterDescriptionFixture(variant).input;
const run = (input = fixture(), limits) => describeNeighborhoodPerimeter(input, limits ? { limits } : {});
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
const north = result => result.exterior_pieces.filter(piece => piece.candidate_sides.includes("north"));
const invalid = operation => assert.throws(operation, error => error instanceof TypeError && /^invalid_perimeter_description:[a-z0-9_]+$/.test(error.message));
function noAuthority(result) {
  assert.equal(result.report_eligibility, "not_assessed");
  assert.equal(result.source_authority, "not_established");
  assert.equal(result.geometry_authority, "upstream_validation_required");
}
function incomplete(result) {
  assert.equal(result.computation_status, "incomplete");
  assert.equal(result.description_revision, null);
  assert.deepEqual(result.exterior_pieces, []);
  assert.deepEqual(result.interior_pieces, []);
  assert.deepEqual(result.cardinal_summaries, { north: null, east: null, south: null, west: null });
  assert.ok(result.incomplete_reasons.length > 0);
  assert.ok(bytes(result) <= 16384, "fixed bounded failure control envelope");
  noAuthority(result);
}
function rename(input, oldName, newName) {
  for (const feature of input.topology.source_features) {
    if (feature.name === oldName) { feature.name = newName; feature.base_name = newName; }
  }
  for (const label of input.label_records) {
    if (label.literal_name === oldName) {
      label.literal_name = newName;
      label.record_ref.record_sha256 = assessmentEvidenceDigest({ name: newName, kind: label.kind });
    }
  }
  return rehashPerimeterFixture(input);
}

function admittedBudgets(input) {
  const a=input.topology.noding_admission;
  return {points:2*a.primitive_segments+4*a.candidate_pairs,chains:a.primitive_segments+4*a.candidate_pairs};
}

test("synthetic topology bytes match the provisionally checked frozen v3 digest", () => {
  assert.equal(FROZEN_TOPOLOGY_COMPATIBILITY_COMMIT, "2f603b426256926096f6d90f38fd2431d9174a12");
  // Independently verified by neighborhoodTopologyRevision from that exact
  // commit in scratch; production code must not import the unmerged service.
  // The producer checkpoint remains subject to separate security/native review.
  assert.equal(perimeterFixtureTopologyRevision(fixture().topology),
    "topology:b37e9e7aa02b39ff749ec809988fac80316ba87c4dc36daa5f11613599f16f8d");
});

test("v3 output retains the ordering-coordinate interpretation without distance authority", () => {
  const result=run();
  assert.equal(result.computation_status,"complete");
  assert.equal(result.performed_policy.source_fraction_basis,"source_segment");
  assert.equal(result.performed_policy.source_fraction_interpretation,"dominant_axis_signed_order_coordinate_v1");
  assert.equal(result.performed_policy.geometry_operations,"none");
  noAuthority(result);
});

for (const field of ["source_attribution","source_fraction_basis","source_fraction_interpretation","source_occurrence_coverage","source_witness_budgets"]) {
  test(`v3 requires the exact ${field} method, even with newly bound manifest bytes`, () => {
    for (const replacement of [undefined,"unreviewed_different_method_v1"]) {
      const input=fixture();
      if (replacement===undefined) delete input.topology.performed_policy[field];
      else input.topology.performed_policy[field]=replacement;
      rehashPerimeterFixture(input); incomplete(run(input));
    }
  });
}

test("a fully rehashed v2 policy cannot masquerade as the accepted v3 method", () => {
  const input=fixture();
  input.topology.topology_version="postgis-planar-v2";
  input.topology.performed_policy.version="postgis-planar-v2";
  rehashPerimeterFixture(input); incomplete(run(input));
});

test("synthetic raw point counts retain repeated pair witnesses before distinct points", () => {
  // Rectangle: eight original endpoint rows plus four point-contact pairs,
  // each repeated for both source occurrences. Duplicate north: ten original
  // endpoints, six point-contact pairs and one overlap with two endpoints.
  const rectangle=fixture().topology, duplicate=fixture("duplicate_source").topology;
  assert.equal(rectangle.noding_admission.primitive_segments,4);
  assert.equal(rectangle.noding_admission.candidate_pairs,4);
  assert.equal(rectangle.diagnostics.source_point_incidence_count,16);
  assert.equal(rectangle.diagnostics.source_chain_count,4);
  assert.equal(duplicate.noding_admission.primitive_segments,5);
  assert.equal(duplicate.noding_admission.candidate_pairs,7);
  assert.equal(duplicate.diagnostics.source_point_incidence_count,26);
  assert.equal(duplicate.diagnostics.source_chain_count,5);
  assert.equal(run({ ...fixture(), topology:rectangle }).computation_status,"complete");
  assert.equal(run(fixture("duplicate_source")).computation_status,"complete");
});

for (const field of ["source_point_incidence_count","source_chain_count","invalid_source_witness_count","ambiguous_source_order_count"]) {
  test(`v3 requires an explicit ${field} diagnostic`, () => {
    const input=fixture(); delete input.topology.diagnostics[field];
    rehashPerimeterFixture(input); incomplete(run(input));
  });
}

test("point witness counters stop at the actual admitted S/P budget, not a high configured cap", () => {
  // Deliberately altered counter envelopes test scalar admission only; these
  // changes do not claim that the fixture actually has more geometric witnesses.
  const upper=admittedBudgets(fixture()).points;
  for (const count of [upper-1,upper,upper+1]) {
    const input=fixture(); input.topology.diagnostics.source_point_incidence_count=count;
    rehashPerimeterFixture(input);
    if (count<=upper) { assert.equal(run(input).computation_status,"complete"); noAuthority(run(input)); }
    else incomplete(run(input));
  }
});

test("source counter fields require safe nonnegative integral values", () => {
  for (const field of ["source_point_incidence_count","source_chain_count"]) for (const value of [-1,0.5,"16",Number.MAX_SAFE_INTEGER+1]) {
    const input=fixture(); input.topology.diagnostics[field]=value;
    rehashPerimeterFixture(input); incomplete(run(input));
  }
});

test("source chain counts must match retained occurrence cardinality as well as the budget", () => {
  for (const delta of [-1,1]) {
    const input=fixture(); input.topology.diagnostics.source_chain_count+=delta;
    rehashPerimeterFixture(input); incomplete(run(input));
    input.topology.diagnostics.source_reference_count+=delta;
    rehashPerimeterFixture(input); incomplete(run(input));
  }
  const over=fixture(); over.topology.diagnostics.source_chain_count=admittedBudgets(over).chains+1;
  rehashPerimeterFixture(over); incomplete(run(over));
  assert.equal(run(fixture()).computation_status,"complete");
});

for (const field of ["invalid_source_witness_count","ambiguous_source_order_count"]) {
  test(`ready flags cannot override a nonzero ${field}`, () => {
    const input=fixture(); input.topology.diagnostics[field]=1;
    rehashPerimeterFixture(input); incomplete(run(input));
  });
}

test("declared split budget must exactly equal S plus four P, even with roomy caps", () => {
  for (const delta of [-1,1]) {
    const input=fixture(); input.topology.noding_admission.split_pieces_upper_bound+=delta;
    rehashPerimeterFixture(input); incomplete(run(input));
  }
});

test("full admitted chain budget must fit each declared edge and reference cap", () => {
  const required=admittedBudgets(fixture()).chains;
  for (const field of ["edges","source_references"]) for (const delta of [-1,0,1]) {
    const input=fixture(); input.topology.limits[field]=required+delta;
    rehashPerimeterFixture(input);
    if (delta<0) incomplete(run(input));
    else assert.equal(run(input).computation_status,"complete",`${field} at cap ${required+delta}`);
  }
});

test("impossible pair cardinality cannot be admitted by increasing every declared upper bound", () => {
  const input=fixture(), a=input.topology.noding_admission;
  a.candidate_pairs=a.primitive_segments*(a.primitive_segments-1)/2+1;
  a.split_pieces_upper_bound=a.primitive_segments+4*a.candidate_pairs;
  a.noded_coordinates_upper_bound=a.original_coordinates+8*a.candidate_pairs;
  rehashPerimeterFixture(input); incomplete(run(input));
});

test("original coordinate admission must be present, integral and within the source cap", () => {
  for (const value of [undefined,-1,0.5,"8",8193]) {
    const input=fixture(), a=input.topology.noding_admission;
    if (value===undefined) delete a.original_coordinates; else a.original_coordinates=value;
    if (typeof value==="number") a.noded_coordinates_upper_bound=value+8*a.candidate_pairs;
    rehashPerimeterFixture(input); incomplete(run(input));
  }
});

test("noded coordinate admission cannot omit or understate its exact original-plus-eight-P bound", () => {
  for (const delta of [undefined,-1,1]) {
    const input=fixture();
    if (delta===undefined) delete input.topology.noding_admission.noded_coordinates_upper_bound;
    else input.topology.noding_admission.noded_coordinates_upper_bound+=delta;
    rehashPerimeterFixture(input); incomplete(run(input));
  }
});

test("an arithmetically consistent noded bound must still fit the declared coordinate capacity", () => {
  const input=fixture(), a=input.topology.noding_admission;
  input.topology.limits.edges=admittedBudgets(input).chains;
  // A deliberately contradictory admission envelope: its chain budget fits,
  // original count fits input capacity and C+8P is exact, but the resulting
  // coordinate allocation would exceed four times the admitted edge cap.
  a.original_coordinates=4*input.topology.limits.edges-8*a.candidate_pairs+1;
  a.noded_coordinates_upper_bound=a.original_coordinates+8*a.candidate_pairs;
  rehashPerimeterFixture(input); incomplete(run(input));
});

test("interior signed-order intervals preserve reversal and lengths from exact metric edges", () => {
  const input=fixture("split_north"), result=run(input), pieces=north(result);
  assert.equal(result.computation_status,"complete");
  assert.equal(pieces.length,3);
  const intervals=pieces.map(piece => {
    assert.equal(piece.source_occurrences.length,1);
    assert.equal(piece.reversed,true);
    const source=piece.source_occurrences[0];
    assert.equal(source.source_part_index,1); assert.equal(source.source_segment_index,1);
    assert.equal(source.start_fraction,source.traversal_end_fraction);
    assert.equal(source.end_fraction,source.traversal_start_fraction);
    return [source.traversal_start_fraction,source.traversal_end_fraction,piece.length_m];
  }).sort((a,b)=>a[0]-b[0]);
  assert.deepEqual(intervals,[[0.25,0.375,25],[0.375,0.625,50],[0.625,0.75,25]]);
  assert.equal(pieces.reduce((sum,piece)=>sum+piece.length_m,0),100);
  assert.equal(result.coverage.perimeter_length_m,400);
  const northFeature=input.topology.source_features.find(row=>row.name==="North Road").feature_id;
  assert.equal(input.topology.edges.flatMap(row=>row.source_parts).filter(row=>row.feature_id===northFeature).length,5,
    "full original source chains include the two outside intervals");
  assert.ok(result.provenance.feature_ids.every(id=>!input.topology.source_features.find(row=>row.feature_id===id).name.startsWith("External Witness")));
  noAuthority(result);
});

test("one continuous source run coalesces text across the stable cyclic seam without merging pieces", () => {
  const input=fixture("split_north"), result=run(input);
  assert.equal(result.computation_status,"complete");
  assert.equal(result.cardinal_summaries.north,"North Road");
  assert.equal(north(result).length,3);
  assert.equal(result.exterior_pieces[0].side_assignment,"north");
  assert.equal(result.exterior_pieces.at(-1).side_assignment,"north");
  assert.equal(result.exterior_pieces.at(-1).to_node_id,result.exterior_pieces[0].from_node_id);
  const rows=input.selected_boundary.exterior.segments;
  rows.push(rows.shift()); rows.push(rows.shift()); rehashPerimeterFixture(input);
  const rotated=run(input);
  assert.deepEqual(rotated.exterior_pieces,result.exterior_pieces);
  assert.deepEqual(rotated.cardinal_summaries,result.cardinal_summaries);
  assert.notEqual(rotated.input_sha256,result.input_sha256);
  assert.notEqual(rotated.description_revision,result.description_revision);
});

test("identical north literals from distinct source features remain distinct at the cyclic seam", () => {
  const result=run(fixture("split_north_distinct_sources"));
  assert.equal(result.computation_status,"complete");
  assert.equal(result.cardinal_summaries.north,"North Road; North Road; North Road");
  assert.equal(new Set(north(result).flatMap(piece=>piece.source_occurrences.map(source=>source.feature_id))).size,3);
  assert.equal(north(result).reduce((sum,piece)=>sum+piece.length_m,0),100);
  noAuthority(result);
});

test("four sourced metric sides produce exact candidate text and count 400m once", () => {
  const { input, expected } = neighborhoodPerimeterDescriptionFixture();
  const before = structuredClone(input);
  const result = run(input);
  assert.equal(PERIMETER_DESCRIPTION_VERSION, "perimeter-description-v1");
  assert.equal(result.computation_status, "complete");
  assert.equal(result.description_status, "supported");
  assert.equal(result.effective_date_support, "supported");
  assert.deepEqual(result.cardinal_summaries, expected.cardinal_summaries);
  assert.equal(result.exterior_pieces.length, 4);
  assert.deepEqual(result.coverage, { perimeter_length_m: 400, named_length_m: 400, unnamed_length_m: 0, ambiguous_length_m: 0 });
  assert.ok(result.exterior_pieces.every(piece => piece.length_m === 100));
  assert.match(result.description_revision, /^perimeter-description:[a-f0-9]{64}$/);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.exterior_pieces[0]));
  input.label_records[0].literal_name = "Changed after capture";
  assert.deepEqual(result.cardinal_summaries, expected.cardinal_summaries);
  noAuthority(result);
});

test("dictionary arrival order is irrelevant while every topology byte is still bound", () => {
  const input = fixture("alias");
  const before = run(input);
  for (const key of ["source_features", "source_aliases", "cells", "edges", "nodes"]) input.topology[key].reverse();
  for (const key of ["feature_bindings", "source_snapshots", "label_records", "alias_decisions"]) input[key].reverse();
  const after = run(input);
  assert.deepEqual(after, before);
});

test("rotating a ring preserves descriptions but changes its producer evidence identity", () => {
  const input = fixture();
  const before = run(input);
  const rows = input.selected_boundary.exterior.segments;
  rows.push(rows.shift());
  rehashPerimeterFixture(input);
  const after = run(input);
  assert.equal(after.computation_status, "complete");
  assert.deepEqual(after.cardinal_summaries, before.cardinal_summaries);
  assert.deepEqual(after.exterior_pieces, before.exterior_pieces);
  assert.notEqual(after.input_sha256, before.input_sha256);
});

test("rounded display coordinates never supply metric direction or distance", () => {
  const input = fixture();
  const before = run(input);
  for (const edge of input.topology.edges) edge.geometry.coordinates = [[-97, 32], [-96, 33]];
  for (const node of input.topology.nodes) node.geometry.coordinates = [-97, 32];
  rehashPerimeterFixture(input);
  const after = run(input);
  assert.deepEqual(after.coverage, before.coverage);
  assert.deepEqual(after.cardinal_summaries, before.cardinal_summaries);
  assert.notEqual(after.input_sha256, before.input_sha256);
});

test("a claimed edge length cannot replace the distance from exact metric coordinates", () => {
  const input=fixture(); input.topology.edges[0].length_meters=999;
  rehashPerimeterFixture(input); incomplete(run(input));
});

test("a diagonal diamond keeps two candidate sides and charges ambiguous length once", () => {
  const {input, expected} = neighborhoodPerimeterDescriptionFixture("diamond");
  const result = run(input);
  assert.equal(result.computation_status, "complete");
  assert.equal(result.description_status, "review_required");
  assert.ok(Math.abs(result.coverage.perimeter_length_m - expected.exterior_length_m) < 1e-10);
  assert.equal(result.coverage.ambiguous_length_m, result.coverage.perimeter_length_m);
  assert.ok(result.exterior_pieces.every(piece => piece.side_assignment === "ambiguous" && piece.candidate_sides.length === 2));
  assert.ok(Object.values(result.cardinal_summaries).every(value => value === null));
  noAuthority(result);
});

test("a concave U retains its indentation and cannot certify four cardinal summaries", () => {
  const {input, expected} = neighborhoodPerimeterDescriptionFixture("concave");
  const result = run(input);
  assert.equal(result.computation_status, "complete");
  assert.equal(result.description_status, "review_required");
  assert.equal(result.exterior_pieces.length, 8);
  assert.equal(result.coverage.perimeter_length_m, expected.exterior_length_m);
  assert.ok(Object.values(result.cardinal_summaries).some(value => value === null));
  assert.match(JSON.stringify(result), /concav/);
});

test("curving source intervals survive individually without a fabricated chord", () => {
  const {input, expected} = neighborhoodPerimeterDescriptionFixture("curved_north");
  const result = run(input);
  assert.equal(result.computation_status, "complete");
  assert.equal(result.exterior_pieces.length, 7);
  const pieces = result.exterior_pieces.filter(piece => piece.labels.some(label => label.literal_name === "Curving North Road"));
  assert.equal(pieces.length, 4);
  assert.equal(new Set(pieces.flatMap(piece => piece.source_occurrences.map(row => row.feature_id))).size, 1);
  assert.deepEqual(pieces.flatMap(piece => piece.source_occurrences.map(row => row.source_segment_index)).sort((a,b) => a-b), [1,2,3,4]);
  assert.ok(Math.abs(result.coverage.perimeter_length_m - expected.exterior_length_m) < 1e-10);
  assert.ok(pieces.reduce((sum, piece) => sum + piece.length_m, 0) > 100);
  for (const piece of pieces) for (const occurrence of piece.source_occurrences) {
    assert.equal(occurrence.source_fraction_basis, "source_segment");
    assert.equal(occurrence.traversal_start_fraction, piece.reversed ? occurrence.end_fraction : occurrence.start_fraction);
    assert.equal(occurrence.traversal_end_fraction, piece.reversed ? occurrence.start_fraction : occurrence.end_fraction);
  }
});

test("a road, creek and unnamed portion remain separate on one geographic side", () => {
  const result = run(fixture("mixed_north"));
  assert.equal(result.computation_status, "complete");
  assert.equal(result.coverage.perimeter_length_m, 400);
  assert.equal(result.coverage.named_length_m, 375);
  assert.equal(result.coverage.unnamed_length_m, 25);
  assert.equal(result.cardinal_summaries.north, null);
  const pieces = north(result);
  assert.equal(pieces.length, 4);
  assert.ok(pieces.flatMap(piece => piece.labels).some(label => label.kind === "watercourse" && label.display_name === "Clear Creek"));
  assert.match(result.sides.north.candidate_text, /Unnamed boundary segment/);
  assert.match(result.sides.north.candidate_text, /North Road East/);
  assert.match(result.sides.north.candidate_text, /North Road West/);
});

for (const variant of ["duplicate_source", "conflicting_source"]) {
  test(`${variant} retains every source occurrence but never doubles perimeter length`, () => {
    const result = run(fixture(variant));
    assert.equal(result.computation_status, "complete");
    assert.equal(result.coverage.perimeter_length_m, 400);
    assert.equal(result.coverage.named_length_m, 400);
    const pieces = north(result);
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0].source_occurrences.length, 2);
    assert.equal(pieces[0].labels.length, 2);
    assert.equal(pieces[0].length_m, 100);
    assert.equal(result.cardinal_summaries.north, null, "unresolved source labels remain competing, even if literals match");
  });
}

test("explicit applicable reviews can resolve two source labels to one corridor", () => {
  const input=fixture("duplicate_source"), sourceId=input.source_snapshots[0].id;
  const alias={normalized_alias:"NORTH ROAD",corridor_key:"verified-synthetic-corridor",canonical_name:"North Road",source:"reviewed",updated_at:"2024-07-01T00:00:00.000Z"};
  input.topology.source_aliases.push(alias);
  input.alias_decisions=input.label_records.filter(label => label.literal_name==="North Road").map((label,index) => ({
    id:`shared-review:${index}`,feature_id:label.feature_id,label_record_id:label.id,
    alias_row_sha256:assessmentEvidenceDigest(alias),matched_field:"name",matched_literal:"North Road",decision:"accepted",
    review_record_ref:{source_id:sourceId,record_id:`synthetic-review:${index}`,record_sha256:assessmentEvidenceDigest({synthetic_review:index})},
    source_refs:[sourceId],observed_at:"2024-07-01T00:00:00.000Z",valid_from:"2024-01-01",valid_to:null,historical_availability:"reconstructed",
  }));
  rehashPerimeterFixture(input);
  const result=run(input), piece=north(result)[0];
  assert.equal(result.computation_status,"complete");
  assert.equal(result.cardinal_summaries.north,"North Road");
  assert.equal(piece.source_occurrences.length,2);
  assert.ok(piece.labels.every(label => label.disposition==="accepted_alias"));
  assert.equal(result.coverage.perimeter_length_m,400);
  noAuthority(result);
});

test("interior rings retain their own coverage and never fill exterior sides", () => {
  const result = run(fixture("hole"));
  assert.equal(result.computation_status, "complete");
  assert.equal(result.exterior_pieces.length, 4);
  assert.equal(result.interior_pieces.length, 4);
  assert.equal(result.interior_pieces.reduce((sum,piece) => sum+piece.length_m,0), 80);
  assert.ok(result.interior_pieces.every(piece => piece.side_assignment === "interior"));
  assert.equal(result.coverage.perimeter_length_m, 400);
  assert.doesNotMatch(JSON.stringify(result.cardinal_summaries), /Interior Boundary/);
});

test("a shared edge of two selected cells is excluded from the union perimeter", () => {
  const input = fixture("two_cells");
  const shared = input.topology.edges.find(edge => edge.cell_ids.length === 2);
  const result = run(input);
  assert.equal(result.computation_status, "complete");
  assert.equal(result.exterior_pieces.length, 6);
  assert.ok(result.exterior_pieces.every(piece => piece.edge_id !== shared.id));
  assert.equal(result.coverage.perimeter_length_m, 400);
});

for (const [name, change] of [
  ["missing perimeter edge", input => input.selected_boundary.exterior.segments.pop()],
  ["duplicate perimeter edge", input => input.selected_boundary.exterior.segments.push({...input.selected_boundary.exterior.segments[0]})],
  ["broken cycle ordering", input => { const s=input.selected_boundary.exterior.segments; [s[1],s[2]]=[s[2],s[1]]; }],
  ["foreign endpoint", input => { input.selected_boundary.exterior.segments[0].from_node_id="node:"+"f".repeat(64); }],
  ["unknown selected cell", input => { input.selected_boundary.selected_cell_ids=["cell:"+"e".repeat(64)]; }],
  ["missing upstream validation", input => { input.selected_boundary.validation.valid=false; }],
  ["missing subject containment", input => { input.selected_boundary.validation.contains_subject=false; }],
  ["missing connected union", input => { input.selected_boundary.validation.connected=false; }],
  ["missing label anchor validation", input => { input.selected_boundary.label_anchor.validation_revision="different-validation"; }],
]) test(`${name} cannot return a prefix of completed descriptions`, () => {
  const input = fixture(); change(input); rehashPerimeterFixture(input); incomplete(run(input));
});

test("an internal shared edge cannot be added as a perimeter shortcut", () => {
  const input = fixture("two_cells");
  const edge = input.topology.edges.find(row => row.cell_ids.length === 2);
  input.selected_boundary.exterior.segments.push({edge_id:edge.id,from_node_id:edge.from_node_id,to_node_id:edge.to_node_id,reversed:false});
  rehashPerimeterFixture(input); incomplete(run(input));
});

for (const [name, change] of [
  ["changed topology bytes without a new manifest", input => { input.topology.nodes[0].degree++; }],
  ["changed selected boundary without a new digest", input => { input.selected_boundary.revision="silent-correction"; }],
  ["changed label without a new digest", input => { input.label_records[0].literal_name="Silent correction"; }],
  ["literal contradicting its exact feature", input => { input.label_records[0].literal_name="Different road"; rehashPerimeterFixture(input); }],
  ["foreign assignment source", input => { const s=input.source_snapshots[0]; s.visibility="assignment"; s.scope={...input.scope,account_id:"FOREIGN-SYNTHETIC"}; }],
  ["public source with private scope", input => { input.source_snapshots[0].scope={...input.scope}; }],
  ["unresolved record source", input => { input.label_records[0].record_ref.source_id="missing-source"; rehashPerimeterFixture(input); }],
  ["wrong source fraction basis", input => { input.topology.edges[0].source_parts[0].source_fraction_basis="whole_part"; rehashPerimeterFixture(input); }],
  ["out-of-range source interval", input => { input.topology.edges[0].source_parts[0].end_fraction=1.1; rehashPerimeterFixture(input); }],
]) test(`${name} rejects with a fixed structural error`, () => { const input=fixture(); change(input); invalid(() => run(input)); });

for (const [name, mutate] of [
  ["foreign EWKB SRID", buffer => buffer.writeUInt32LE(4326,5)],
  ["impossible EWKB point count", buffer => buffer.writeUInt32LE(0xffffffff,9)],
  ["nonfinite metric coordinate", buffer => buffer.writeDoubleLE(Infinity,13)],
]) test(`${name} cannot be made valid by rehashing the topology manifest`, () => {
  const input=fixture(), edge=input.topology.edges[0];
  const buffer=Buffer.from(edge.geometry_ewkb,"hex"); mutate(buffer); edge.geometry_ewkb=buffer.toString("hex");
  rehashPerimeterFixture(input); incomplete(run(input));
});

test("accepted alias review targets one exact feature and label", () => {
  const input=fixture("alias"), result=run(input);
  assert.equal(result.computation_status,"complete");
  assert.equal(result.cardinal_summaries.north,"North Road");
  const label=north(result)[0].labels[0];
  assert.equal(label.literal_name,"Old North Road");
  assert.equal(label.display_name,"North Road");
  assert.equal(label.alias_decision_id,input.alias_decisions[0].id);
  assert.equal(label.disposition,"accepted_alias");
});

for (const [name, mutate] of [
  ["no review decision", input => { input.alias_decisions=[]; }],
  ["rejected decision", input => { input.alias_decisions[0].decision="rejected"; }],
  ["review observed after cutoff", input => { input.alias_decisions[0].observed_at="2024-07-03T00:00:00.000Z"; }],
  ["review has unknown historical support", input => { input.alias_decisions[0].historical_availability="unknown"; input.alias_decisions[0].valid_from=null; }],
]) test(`${name} leaves the valid source literal intact`, () => {
  const input=fixture("alias"); mutate(input); rehashPerimeterFixture(input);
  const result=run(input);
  assert.equal(result.computation_status,"complete");
  assert.equal(north(result)[0].labels[0].display_name,"Old North Road");
  assert.equal(north(result)[0].labels[0].alias_decision_id,null);
});

test("a digest of a different alias row cannot authorize this name", () => {
  const input=fixture("alias"); input.alias_decisions[0].alias_row_sha256="f".repeat(64);
  rehashPerimeterFixture(input); invalid(() => run(input));
});

test("a review cannot adopt an alias revision which did not yet exist", () => {
  const input=fixture("alias");
  input.topology.source_aliases[0].updated_at="2024-07-01T12:00:00.000Z";
  input.alias_decisions[0].alias_row_sha256=assessmentEvidenceDigest(input.topology.source_aliases[0]);
  rehashPerimeterFixture(input);
  const earlier=run(input);
  assert.equal(earlier.computation_status,"complete");
  assert.equal(north(earlier)[0].labels[0].display_name,"Old North Road");
  assert.equal(north(earlier)[0].labels[0].alias_decision_id,null);
  input.alias_decisions[0].observed_at="2024-07-01T18:00:00.000Z";
  rehashPerimeterFixture(input);
  assert.equal(run(input).cardinal_summaries.north,"North Road");
});

test("ready flags cannot override an explicit fatal topology diagnostic", () => {
  const input=fixture(); input.topology.diagnostics.unsupported_boundary_count=1;
  rehashPerimeterFixture(input); incomplete(run(input));
});

test("a ready topology cannot contradict its own admitted geometry-row byte limit", () => {
  const input=fixture();
  input.topology.limits.row_bytes=bytes(input.topology.cells[0])-1;
  rehashPerimeterFixture(input); incomplete(run(input));
});

for (const [name, mutate] of [
  ["different subject", input => { input.scope.subject_snapshot_id="30000000-0000-4000-8000-000000000002"; }],
  ["different assignment", input => { input.scope.appraisal_case_id="20000000-0000-4000-8000-000000000002"; }],
  ["different account", input => { input.scope.account_id="SYNTHETIC-P2"; }],
  ["different effective date", input => { input.effective_date="2024-06-29"; }],
  ["different knowledge cutoff", input => { input.knowledge_cutoff="2024-07-04T00:00:00.000Z"; }],
  ["different verified topology", input => { input.topology.nodes[0].geometry.coordinates=[-97.001,32.001]; input.topology.topology_revision=perimeterFixtureTopologyRevision(input.topology); }],
  ["different source capture", input => { input.topology.source_capture_sha256="d".repeat(64); input.topology.topology_revision=perimeterFixtureTopologyRevision(input.topology); }],
]) test(`all-public evidence cannot replay an old selected boundary for a ${name}`, () => {
  const input=fixture();
  assert.ok(input.source_snapshots.every(source => source.visibility==="public"));
  mutate(input);
  // Rehashing the unchanged producer envelope does not rebind its context.
  rehashPerimeterFixtureRecord(input.selected_boundary);
  invalid(() => run(input));
});

test("conflicting accepted alias decisions need review instead of last-row-wins", () => {
  const input=fixture("alias");
  const original=input.alias_decisions[0];
  input.topology.source_features.find(feature => feature.feature_id===original.feature_id).base_name="Alternate North Road";
  const alias={...input.topology.source_aliases[0],normalized_alias:"ALTERNATE NORTH ROAD",corridor_key:"different-corridor",canonical_name:"Other Corridor"};
  input.topology.source_aliases.push(alias);
  input.alias_decisions.push({...original,id:"alias-decision:2",alias_row_sha256:assessmentEvidenceDigest(alias),matched_field:"base_name",matched_literal:"Alternate North Road"});
  rehashPerimeterFixture(input);
  const before=run(input);
  assert.equal(before.computation_status,"complete");
  assert.equal(before.cardinal_summaries.north,null);
  input.alias_decisions.reverse(); input.topology.source_aliases.reverse();
  assert.deepEqual(run(input),before);
});

for (const [name, mutate] of [
  ["unknown source fact validity", input => { input.source_snapshots[0].valid_from=null; input.source_snapshots[0].historical_availability="unknown"; }],
  ["source observed after knowledge cutoff", input => { input.source_snapshots[0].observed_at="2024-07-03T00:00:00.000Z"; }],
  ["unknown label fact validity", input => { input.label_records.forEach(row => {row.valid_from=null; row.historical_availability="unknown";}); }],
  ["label observed after knowledge cutoff", input => { input.label_records.forEach(row => {row.observed_at="2024-07-03T00:00:00.000Z";}); }],
]) test(`${name} retains candidate names while withholding supported summaries`, () => {
  const input=fixture(); mutate(input); rehashPerimeterFixture(input); const result=run(input);
  assert.equal(result.computation_status,"complete");
  assert.equal(result.description_status,"review_required");
  assert.notEqual(result.effective_date_support,"supported");
  assert.ok(Object.values(result.cardinal_summaries).every(value => value===null));
  assert.equal(result.exterior_pieces.length,4);
  assert.ok(result.exterior_pieces.every(piece => piece.labels[0].display_name));
});

test("reconstructed historical names may be observed after the effective date within cutoff", () => {
  const input=fixture();
  assert.ok(input.source_snapshots[0].observed_at.slice(0,10)>input.effective_date);
  assert.equal(run(input).effective_date_support,"supported");
});

test("caps reject atomically rather than drop a perimeter edge or label", () => {
  for (const key of ["perimeter_edges","feature_records","label_records"]) {
    incomplete(run(fixture(),{[key]:3}));
    assert.equal(run(fixture(),{[key]:4}).computation_status,"complete",`${key} exact cap`);
    assert.equal(run(fixture(),{[key]:5}).computation_status,"complete",`${key} cap plus one`);
  }
  incomplete(run(fixture(),{source_occurrences:3}));
  assert.equal(run(fixture(),{source_occurrences:4}).computation_status,"complete");
});

test("lowered full UTF8 input and output budgets fail without a ready prefix", () => {
  const input=rename(fixture(),"North Road","北の道路😀".repeat(20));
  const result=run(input);
  assert.equal(result.computation_status,"complete");
  assert.ok(bytes(result)<=PERIMETER_DESCRIPTION_LIMITS.output_bytes);
  incomplete(run(input,{topology_bytes:bytes(input.topology)-1}));
  incomplete(run(input,{request_bytes:bytes(input)-1}));
  incomplete(run(input,{output_bytes:1024}));
  incomplete(run(input,{summary_length:20}));
  assert.equal(run(input).cardinal_summaries.north,"北の道路😀".repeat(20));
});

test("full UTF8 result admits its exact byte cap and rejects one byte less", () => {
  const input=rename(fixture("duplicate_source"),"North Road","北の道路😀".repeat(20));
  const roomy=run(input,{output_bytes:999999});
  assert.equal(roomy.computation_status,"complete");
  // Only the decimal limit field changes width; identities remain SHA256.
  // Measure the entire public JSON independently, including repeated label
  // text, source lineage, diagnostics, framing and the result revision.
  const count=bytes(roomy), exact=count-String(999999).length+String(count).length;
  const at=run(input,{output_bytes:exact});
  assert.equal(at.computation_status,"complete");
  assert.equal(bytes(at),exact);
  assert.equal(run(input,{output_bytes:exact+1}).computation_status,"complete");
  incomplete(run(input,{output_bytes:exact-1}));
  assert.equal(at.exterior_pieces.length,4);
  assert.equal(north(at)[0].labels.length,2);
});

test("digest keys are canonical while caller accessors never execute", () => {
  assert.equal(perimeterDescriptionDigest({a:1,b:"é"}),perimeterDescriptionDigest({b:"é",a:1}));
  let accessed=0;
  const input=fixture();
  Object.defineProperty(input,"scope",{enumerable:true,get(){accessed++; throw new Error("caller-marker");}});
  invalid(() => run(input));
  assert.equal(accessed,0);
});

test("cycles and sparse collections reject before unsafe traversal", () => {
  const cyclic=fixture(); cyclic.self=cyclic; invalid(() => run(cyclic));
  const sparse=fixture(); delete sparse.label_records[0]; invalid(() => run(sparse));
});

test("options.limits accessors reject without executing caller code", () => {
  let accessed=0;
  const options={};
  Object.defineProperty(options,"limits",{enumerable:true,get(){accessed++; throw new Error("synthetic-options-marker");}});
  invalid(() => describeNeighborhoodPerimeter(fixture(),options));
  assert.equal(accessed,0);
});

test("individual limit accessors reject without executing caller code", () => {
  let accessed=0;
  const limits={};
  Object.defineProperty(limits,"output_bytes",{enumerable:true,get(){accessed++; throw new Error("synthetic-limit-marker");}});
  invalid(() => describeNeighborhoodPerimeter(fixture(),{limits}));
  assert.equal(accessed,0);
});

function addAliasRejection(input) {
  const accepted=input.alias_decisions[0];
  const rejected={...accepted,id:"alias-decision:rejection",decision:"rejected",source_refs:[...accepted.source_refs],
    review_record_ref:{...accepted.review_record_ref,record_id:"synthetic-rejection:1",record_sha256:assessmentEvidenceDigest({synthetic_review:"rejected"})}};
  input.alias_decisions.push(rejected);
  return rejected;
}

for(const acceptanceIsLater of [false,true]) test(`opposite applicable alias decisions conflict even when ${acceptanceIsLater?"acceptance":"rejection"} is later`, () => {
  const input=fixture("alias"), rejected=addAliasRejection(input);
  input.alias_decisions[0].observed_at=acceptanceIsLater?"2024-07-01T02:00:00.000Z":"2024-07-01T01:00:00.000Z";
  rejected.observed_at=acceptanceIsLater?"2024-07-01T01:00:00.000Z":"2024-07-01T02:00:00.000Z";
  rehashPerimeterFixture(input);
  const result=run(input), label=north(result)[0].labels[0];
  assert.equal(result.computation_status,"complete");
  assert.equal(result.description_status,"review_required");
  assert.equal(result.cardinal_summaries.north,null);
  assert.equal(label.display_name,"Old North Road");
  assert.equal(label.alias_decision_id,null);
  assert.equal(label.disposition,"conflicting");
  assert.match(result.sides.north.candidate_text,/Old North Road/);
  input.alias_decisions.reverse();
  assert.deepEqual(run(input),result,"arrival order cannot choose an acceptance or rejection");
});

test("a rejection alone leaves the valid literal supported", () => {
  const input=fixture("alias"); input.alias_decisions[0].decision="rejected";
  rehashPerimeterFixture(input); const result=run(input);
  assert.equal(result.computation_status,"complete");
  assert.equal(result.description_status,"supported");
  assert.equal(result.cardinal_summaries.north,"Old North Road");
  assert.equal(north(result)[0].labels[0].alias_decision_id,null);
});

for(const [name,change] of [
  ["expired", (_input,row)=>{row.valid_to="2024-06-29";}],
  ["not yet effective", (_input,row)=>{row.valid_from="2024-07-01";}],
  ["observed after cutoff", (_input,row)=>{row.observed_at="2024-07-03T00:00:00.000Z";}],
  ["unknown historical applicability", (_input,row)=>{row.valid_from=null;row.historical_availability="unknown";}],
  ["review predates alias revision", (_input,row)=>{row.observed_at="2024-06-30T00:00:00.000Z";}],
  ["unknown review-source applicability", (input,row)=>{
    const source={...input.source_snapshots[0],id:"uncertain-review-source",valid_from:null,historical_availability:"unknown"};
    input.source_snapshots.push(source);row.source_refs=[source.id];row.review_record_ref.source_id=source.id;
  }],
  ["review source observed after cutoff", (input,row)=>{
    const source={...input.source_snapshots[0],id:"later-review-source",observed_at:"2024-07-03T00:00:00.000Z"};
    input.source_snapshots.push(source);row.source_refs=[source.id];row.review_record_ref.source_id=source.id;
  }],
]) test(`an ${name} rejection does not veto applicable alias acceptance`, () => {
  const input=fixture("alias"), acceptedId=input.alias_decisions[0].id, rejected=addAliasRejection(input);
  change(input,rejected);rehashPerimeterFixture(input);
  const result=run(input);
  assert.equal(result.computation_status,"complete");
  assert.equal(result.cardinal_summaries.north,"North Road");
  assert.equal(north(result)[0].labels[0].alias_decision_id,acceptedId);
  assert.equal(north(result)[0].labels[0].disposition,"accepted_alias");
  input.alias_decisions.reverse();
  assert.deepEqual(run(input),result);
});
