import assert from "node:assert/strict";
import test from "node:test";

import {
  appendMeasuredWall,
  calculateSketchOutline,
  canvasToModel,
  closeSketchOutline,
  connectSketchTarget,
  draftFromApiDocument,
  emptySketchDraft,
  modelToCanvas,
  normalizeSketchBearing,
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

test("projects a closing corner and closes a 10 by 10 outline from tappable targets", () => {
  let vertices = appendMeasuredWall([], 10, 90);
  vertices = appendMeasuredWall(vertices, 10, 0);

  const projected = sketchClosureTargets(vertices);
  assert.equal(projected.length, 1);
  assert.equal(projected[0]!.kind, "projected_corner");
  assert.deepEqual(projected[0]!.point, { x: 10, y: 0 });
  vertices = connectSketchTarget(vertices, projected[0]!);

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
  vertices = connectSketchTarget(vertices, sketchClosureTargets(vertices)[0]!);
  vertices = connectSketchTarget(vertices, sketchClosureTargets(vertices)[0]!);
  const calculation = calculateSketchOutline(vertices);
  assert.equal(calculation.closed, true);
  assert.equal(calculation.selfIntersecting, false);
  assert.equal(calculation.reportedAreaSqft, 80);
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

test("serializes offline sketch drafts without losing stable room identity", () => {
  const areaId = "10000000-0000-4000-8000-000000000031";
  const roomId = "10000000-0000-4000-8000-000000000032";
  const base = emptySketchDraft(areaId);
  const draft = {
    ...base,
    reviewStatus: "appraiser_confirmed" as const,
    areas: [{
      ...base.areas[0]!,
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
  assert.equal(draftFromApiDocument(api).rooms[0]!.label, "Kitchen");
  assert.equal(sketchRoomRef(roomId), `sketch-room:${roomId}`);
});
