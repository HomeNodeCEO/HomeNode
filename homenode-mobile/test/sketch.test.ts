import assert from "node:assert/strict";
import test from "node:test";

import {
  appendMeasuredWall,
  calculateSketchGla,
  calculateSketchOutline,
  canvasToModel,
  closeSketchOutline,
  connectSketchTarget,
  draftFromApiDocument,
  emptySketchDraft,
  garageCutoutFitsParent,
  modelToCanvas,
  nearestPointOnSketchWall,
  normalizeSketchBearing,
  resizeSketchWall,
  sketchClosureTargets,
  sketchReadyForConfirmation,
  sketchRoomRef,
  toSketchApiDocument,
} from "../src/sketch/model";

test("normalizes fine-angle sketch bearings in either direction", () => {
  assert.equal(normalizeSketchBearing(361), 1);
  assert.equal(normalizeSketchBearing(-1), 359);
  assert.equal(normalizeSketchBearing(45.25), 45.3);
  assert.equal(normalizeSketchBearing(Number.NaN), 0);
});

test("builds and closes a measured rectangular outline", () => {
  let vertices = appendMeasuredWall([], 40, 0);
  vertices = appendMeasuredWall(vertices, 30, 90);
  vertices = appendMeasuredWall(vertices, 40, 180);
  vertices = closeSketchOutline(vertices);
  const calculation = calculateSketchOutline(vertices);
  assert.equal(calculation.closed, true);
  assert.equal(calculation.selfIntersecting, false);
  assert.equal(calculation.reportedAreaSqft, 1200);
  assert.equal(calculation.perimeterFeet, 140);
  assert.deepEqual(calculation.centroid, { x: 20, y: 15 });
});

test("resizes a closed wall while preserving connected square corners and closure", () => {
  const vertices = [
    { x: 0, y: 0 },
    { x: 25, y: 0 },
    { x: 25, y: -15 },
    { x: 0, y: -15 },
    { x: 0, y: 0 },
  ];
  const resized = resizeSketchWall(vertices, 0, 30);
  assert.deepEqual(resized, [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: -15 },
    { x: 0, y: -15 },
    { x: 0, y: 0 },
  ]);
  assert.equal(calculateSketchOutline(resized).reportedAreaSqft, 450);
});

test("resizes any closed wall and keeps the duplicated closing point synchronized", () => {
  const vertices = [
    { x: 0, y: 0 },
    { x: 25, y: 0 },
    { x: 25, y: -15 },
    { x: 0, y: -15 },
    { x: 0, y: 0 },
  ];
  const resized = resizeSketchWall(vertices, 3, 20);
  assert.deepEqual(resized, [
    { x: 0, y: 5 },
    { x: 25, y: 5 },
    { x: 25, y: -15 },
    { x: 0, y: -15 },
    { x: 0, y: 5 },
  ]);
  assert.equal(calculateSketchOutline(resized).reportedAreaSqft, 500);
});

test("resizes an open wall by translating its downstream measured walls", () => {
  const resized = resizeSketchWall([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: -8 },
  ], 0, 14);
  assert.deepEqual(resized, [
    { x: 0, y: 0 },
    { x: 14, y: 0 },
    { x: 14, y: -8 },
  ]);
});

test("rejects a closed wall resize that collapses the opposite wall", () => {
  const vertices = [
    { x: 0, y: 0 },
    { x: 25, y: 0 },
    { x: 25, y: -15 },
    { x: 20, y: -15 },
    { x: 20, y: 0 },
    { x: 0, y: 0 },
  ];
  assert.throws(() => resizeSketchWall(vertices, 0, 20), /invalid_sketch_wall_resize/);
});

test("projects a closing corner and closes a 10 by 10 outline from tappable targets", () => {
  let vertices = appendMeasuredWall([], 10, 90);
  vertices = appendMeasuredWall(vertices, 10, 0);

  const initialTargets = sketchClosureTargets(vertices);
  const projected = initialTargets.find((target) => target.kind === "projected_corner")!;
  assert.equal(initialTargets.some((target) => target.kind === "starting_point"), true);
  assert.deepEqual(projected.point, { x: 10, y: 0 });
  vertices = connectSketchTarget(vertices, projected);

  const startingPoint = sketchClosureTargets(vertices);
  assert.equal(startingPoint.length, 1);
  assert.equal(startingPoint[0]!.kind, "starting_point");
  assert.deepEqual(startingPoint[0]!.point, { x: 0, y: 0 });
  vertices = connectSketchTarget(vertices, startingPoint[0]!);

  const calculation = calculateSketchOutline(vertices);
  assert.equal(calculation.closed, true);
  assert.equal(calculation.reportedAreaSqft, 100);
  assert.equal(calculation.perimeterFeet, 40);
});

test("projects the closing corner for rotated walls", () => {
  let vertices = appendMeasuredWall([], 10, 45);
  vertices = appendMeasuredWall(vertices, 8, 315);
  vertices = connectSketchTarget(
    vertices,
    sketchClosureTargets(vertices).find((target) => target.kind === "projected_corner")!,
  );
  vertices = connectSketchTarget(
    vertices,
    sketchClosureTargets(vertices).find((target) => target.kind === "starting_point")!,
  );
  const calculation = calculateSketchOutline(vertices);
  assert.equal(calculation.closed, true);
  assert.equal(calculation.selfIntersecting, false);
  assert.equal(calculation.reportedAreaSqft, 80);
});

test("offers direct and logical two-wall closure for an irregular outline", () => {
  let vertices = appendMeasuredWall([], 25, 0);
  vertices = appendMeasuredWall(vertices, 12, 270);
  vertices = appendMeasuredWall(vertices, 5, 180);
  vertices = appendMeasuredWall(vertices, 5, 90);

  const targets = sketchClosureTargets(vertices);
  const projected = targets.find((target) => target.kind === "projected_corner")!;
  const direct = targets.find((target) => target.kind === "starting_point")!;
  assert.deepEqual(projected.point, { x: 0, y: -7 });
  assert.deepEqual(direct.point, { x: 0, y: 0 });
  assert.match(projected.label, /20 foot/);

  vertices = connectSketchTarget(vertices, projected);
  const finalTarget = sketchClosureTargets(vertices);
  assert.equal(finalTarget.length, 1);
  assert.equal(finalTarget[0]!.kind, "starting_point");
  assert.deepEqual(finalTarget[0]!.point, { x: 0, y: 0 });
  vertices = connectSketchTarget(vertices, finalTarget[0]!);

  const calculation = calculateSketchOutline(vertices);
  assert.equal(calculation.closed, true);
  assert.equal(calculation.selfIntersecting, false);
  assert.equal(calculation.reportedAreaSqft, 200);
  assert.equal(calculation.perimeterFeet, 74);
});

test("keeps model and canvas points reversible for room placement", () => {
  const vertices = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 30 },
    { x: 0, y: 30 },
    { x: 0, y: 0 },
  ];
  const canvas = modelToCanvas({ x: 20, y: 15 }, vertices, 320, 260);
  const model = canvasToModel(canvas, vertices, 320, 260);
  assert.deepEqual(model, { x: 20, y: 15 });
});

test("snaps a garage start point to any position along a closed exterior wall", () => {
  const base = emptySketchDraft("10000000-0000-4000-8000-000000000041");
  const exterior = {
    ...base.areas[0]!,
    vertices: [
      { x: 0, y: 0 },
      { x: 25, y: 0 },
      { x: 25, y: -15 },
      { x: 0, y: -15 },
      { x: 0, y: 0 },
    ],
  };
  const snap = nearestPointOnSketchWall({ x: 7.4, y: -0.8 }, [exterior]);
  assert.deepEqual(snap, {
    areaId: exterior.id,
    point: { x: 7.4, y: 0 },
    distanceFeet: 0.8,
  });
});

test("deducts a closed garage cutout from the main GLA", () => {
  const base = emptySketchDraft("10000000-0000-4000-8000-000000000051");
  const exterior = {
    ...base.areas[0]!,
    vertices: [
      { x: 0, y: 0 },
      { x: 25, y: 0 },
      { x: 25, y: -15 },
      { x: 0, y: -15 },
      { x: 0, y: 0 },
    ],
  };
  const garage = {
    id: "10000000-0000-4000-8000-000000000052",
    label: "Garage",
    levelLabel: "Level 1",
    classification: "garage" as const,
    glaTreatment: "deduction" as const,
    parentAreaId: exterior.id,
    notes: "",
    vertices: [
      { x: 5, y: 0 },
      { x: 15, y: 0 },
      { x: 15, y: -10 },
      { x: 5, y: -10 },
      { x: 5, y: 0 },
    ],
    dimensionLabels: [],
    position: 2,
  };
  assert.equal(garageCutoutFitsParent(garage, [exterior, garage]), true);
  assert.deepEqual(calculateSketchGla([exterior, garage]), {
    grossAreaSqft: 375,
    deductionAreaSqft: 100,
    netGlaSqft: 275,
  });
  const restored = draftFromApiDocument(toSketchApiDocument({ ...base, areas: [exterior, garage] }));
  assert.equal(restored.areas[1]!.glaTreatment, "deduction");
  assert.equal(restored.areas[1]!.parentAreaId, exterior.id);
});

test("serializes offline sketch drafts without losing stable room identity", () => {
  const areaId = "10000000-0000-4000-8000-000000000031";
  const roomId = "10000000-0000-4000-8000-000000000032";
  const base = emptySketchDraft(areaId);
  const draft = {
    ...base,
    reviewStatus: "appraiser_confirmed" as const,
    areas: [{
      ...base.areas[0]!,
      dimensionLabels: [{ segmentIndex: 0, offset: { x: 0, y: -3 } }],
      vertices: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
        { x: 0, y: 0 },
      ],
    }],
    rooms: [{
      id: roomId,
      areaId,
      label: "Kitchen",
      roomType: "kitchen" as const,
      anchor: { x: 10, y: 5 },
      position: 1,
    }],
  };
  assert.equal(sketchReadyForConfirmation(draft), true);
  const api = toSketchApiDocument(draft);
  assert.equal(api.rooms[0]!.id, roomId);
  const restored = draftFromApiDocument(api);
  assert.equal(restored.rooms[0]!.label, "Kitchen");
  assert.deepEqual(restored.areas[0]!.dimensionLabels, [{ segmentIndex: 0, offset: { x: 0, y: -3 } }]);
  assert.equal(sketchRoomRef(roomId), `sketch-room:${roomId}`);
});
