export const SKETCH_CLASSIFICATIONS = Object.freeze([
  ["above_grade_finished", "Above-grade finished"],
  ["above_grade_nonstandard_finished", "Above-grade nonstandard finished"],
  ["above_grade_noncontinuous_finished", "Above-grade noncontinuous finished"],
  ["above_grade_unfinished", "Above-grade unfinished"],
  ["below_grade_finished", "Below-grade finished"],
  ["below_grade_nonstandard_finished", "Below-grade nonstandard finished"],
  ["below_grade_unfinished", "Below-grade unfinished"],
  ["garage", "Garage"],
  ["porch", "Porch"],
  ["patio", "Patio"],
  ["deck", "Deck"],
  ["outbuilding", "Outbuilding"],
  ["other", "Other"],
] as const);

export const SKETCH_ROOM_TYPES = Object.freeze([
  ["living_room", "Living room"],
  ["family_room", "Family room"],
  ["dining_room", "Dining room"],
  ["kitchen", "Kitchen"],
  ["bedroom", "Bedroom"],
  ["bathroom", "Bathroom"],
  ["utility", "Utility"],
  ["office", "Office"],
  ["foyer", "Foyer"],
  ["hall", "Hall"],
  ["closet", "Closet"],
  ["garage", "Garage"],
  ["storage", "Storage"],
  ["other", "Other"],
] as const);

export type SketchClassification = typeof SKETCH_CLASSIFICATIONS[number][0];
export type SketchRoomType = typeof SKETCH_ROOM_TYPES[number][0];
export type SketchPoint = Readonly<{ x: number; y: number }>;
export type SketchGlaTreatment = "included" | "excluded" | "deduction";
export type SketchDimensionLabel = Readonly<{
  segmentIndex: number;
  offset: SketchPoint;
}>;

export type SketchClosureTarget = Readonly<{
  kind: "projected_corner" | "starting_point";
  point: SketchPoint;
  label: string;
}>;

export type SketchCalculation = Readonly<{
  closed: boolean;
  closureGapFeet: number;
  selfIntersecting: boolean;
  perimeterFeet: number;
  calculatedAreaSqft: number | null;
  reportedAreaSqft: number | null;
  ready: boolean;
  centroid: SketchPoint | null;
}>;

export type SketchAreaDraft = Readonly<{
  id: string;
  label: string;
  levelLabel: string;
  classification: SketchClassification;
  glaTreatment: SketchGlaTreatment;
  parentAreaId: string | null;
  notes: string;
  vertices: SketchPoint[];
  dimensionLabels: SketchDimensionLabel[];
  position: number;
}>;

export type SketchRoomDraft = Readonly<{
  id: string;
  areaId: string;
  label: string;
  roomType: SketchRoomType;
  anchor: SketchPoint;
  position: number;
}>;

export type ManualSketchDraft = Readonly<{
  measurementStandard: "ansi_z765_2021" | "jurisdiction_required_other";
  alternateStandardName: string;
  measurementMethod: "exterior" | "interior_perimeter" | "plans" | "mixed";
  reviewStatus: "draft" | "appraiser_confirmed";
  reviewNotes: string;
  areas: SketchAreaDraft[];
  rooms: SketchRoomDraft[];
}>;

export type ManualSketchApiDocument = Readonly<{
  schema_version?: string;
  source?: "manual";
  units?: "feet";
  dimension_precision_feet?: number;
  measurement_standard: ManualSketchDraft["measurementStandard"];
  alternate_standard_name: string | null;
  measurement_method: ManualSketchDraft["measurementMethod"];
  review_status: ManualSketchDraft["reviewStatus"];
  review_notes: string | null;
  areas: Array<{
    id: string;
    label: string;
    level_label: string;
    classification: SketchClassification;
    gla_treatment?: SketchGlaTreatment;
    parent_area_id?: string | null;
    notes: string | null;
    vertices: SketchPoint[];
    dimension_labels?: Array<{
      segment_index: number;
      offset: SketchPoint;
    }>;
    position: number;
  }>;
  rooms: Array<{
    id: string;
    room_ref?: string;
    area_id: string;
    label: string;
    room_type: SketchRoomType;
    level_label?: string;
    anchor: SketchPoint;
    position: number;
  }>;
}>;

function rounded(value: number, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function distance(left: SketchPoint, right: SketchPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function orientation(a: SketchPoint, b: SketchPoint, c: SketchPoint) {
  const cross = ((b.y - a.y) * (c.x - b.x)) - ((b.x - a.x) * (c.y - b.y));
  if (Math.abs(cross) < 1e-9) return 0;
  return cross > 0 ? 1 : 2;
}

function onSegment(a: SketchPoint, b: SketchPoint, c: SketchPoint) {
  return b.x <= Math.max(a.x, c.x) + 1e-9
    && b.x >= Math.min(a.x, c.x) - 1e-9
    && b.y <= Math.max(a.y, c.y) + 1e-9
    && b.y >= Math.min(a.y, c.y) - 1e-9;
}

function segmentsIntersect(a: SketchPoint, b: SketchPoint, c: SketchPoint, d: SketchPoint) {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  if (first !== second && third !== fourth) return true;
  return (first === 0 && onSegment(a, c, b))
    || (second === 0 && onSegment(a, d, b))
    || (third === 0 && onSegment(c, a, d))
    || (fourth === 0 && onSegment(c, b, d));
}

function selfIntersects(vertices: SketchPoint[]) {
  const segmentCount = vertices.length - 1;
  for (let first = 0; first < segmentCount; first += 1) {
    for (let second = first + 1; second < segmentCount; second += 1) {
      if (Math.abs(first - second) <= 1) continue;
      if (first === 0 && second === segmentCount - 1) continue;
      if (segmentsIntersect(vertices[first]!, vertices[first + 1]!, vertices[second]!, vertices[second + 1]!)) return true;
    }
  }
  return false;
}

export function calculateSketchOutline(vertices: SketchPoint[], tolerance = 0.05): SketchCalculation {
  if (vertices.length < 2) {
    return {
      closed: false,
      closureGapFeet: 0,
      selfIntersecting: false,
      perimeterFeet: 0,
      calculatedAreaSqft: null,
      reportedAreaSqft: null,
      ready: false,
      centroid: null,
    };
  }
  const closureGapFeet = distance(vertices[0]!, vertices[vertices.length - 1]!);
  const closed = vertices.length >= 4 && closureGapFeet <= tolerance;
  const normalized = closed
    ? [...vertices.slice(0, -1), { ...vertices[0]! }]
    : vertices;
  const selfIntersecting = closed && selfIntersects(normalized);
  let signedDoubleArea = 0;
  let perimeterFeet = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const current = normalized[index]!;
    const next = normalized[index + 1]!;
    const cross = (current.x * next.y) - (next.x * current.y);
    signedDoubleArea += cross;
    centroidX += (current.x + next.x) * cross;
    centroidY += (current.y + next.y) * cross;
    perimeterFeet += distance(current, next);
  }
  const area = closed && !selfIntersecting ? Math.abs(signedDoubleArea) / 2 : null;
  const ready = area != null && area > 0;
  return {
    closed,
    closureGapFeet: rounded(closureGapFeet),
    selfIntersecting,
    perimeterFeet: rounded(perimeterFeet, 2),
    calculatedAreaSqft: area == null ? null : rounded(area, 2),
    reportedAreaSqft: area == null ? null : Math.round(area),
    ready,
    centroid: ready && Math.abs(signedDoubleArea) > 1e-9
      ? { x: rounded(centroidX / (3 * signedDoubleArea)), y: rounded(centroidY / (3 * signedDoubleArea)) }
      : null,
  };
}

export function appendMeasuredWall(vertices: SketchPoint[], distanceFeet: number, bearingDegrees: number): SketchPoint[] {
  if (!Number.isFinite(distanceFeet) || distanceFeet < 0.1 || distanceFeet > 10_000) {
    throw new Error("invalid_sketch_wall_length");
  }
  if (!Number.isFinite(bearingDegrees)) throw new Error("invalid_sketch_wall_bearing");
  const start: SketchPoint = vertices.length ? vertices[vertices.length - 1]! : { x: 0, y: 0 };
  const radians = bearingDegrees * (Math.PI / 180);
  const next = {
    x: rounded(start.x + (distanceFeet * Math.cos(radians))),
    y: rounded(start.y + (distanceFeet * Math.sin(radians))),
  };
  return vertices.length ? [...vertices, next] : [start, next];
}

export function normalizeSketchBearing(value: number) {
  if (!Number.isFinite(value)) return 0;
  const normalized = ((value % 360) + 360) % 360;
  return rounded(normalized, 1);
}

function lineIntersection(
  firstOrigin: SketchPoint,
  firstDirection: SketchPoint,
  secondOrigin: SketchPoint,
  secondDirection: SketchPoint,
) {
  const cross = (firstDirection.x * secondDirection.y) - (firstDirection.y * secondDirection.x);
  if (Math.abs(cross) < 1e-9) return null;
  const offset = {
    x: secondOrigin.x - firstOrigin.x,
    y: secondOrigin.y - firstOrigin.y,
  };
  const scalar = ((offset.x * secondDirection.y) - (offset.y * secondDirection.x)) / cross;
  return {
    x: rounded(firstOrigin.x + (scalar * firstDirection.x)),
    y: rounded(firstOrigin.y + (scalar * firstDirection.y)),
  };
}

export function sketchClosureTargets(vertices: SketchPoint[]): SketchClosureTarget[] {
  if (vertices.length < 3 || calculateSketchOutline(vertices).closed) return [];
  const start = vertices[0]!;
  const current = vertices[vertices.length - 1]!;
  const previous = vertices[vertices.length - 2]!;
  const recentDirection = {
    x: current.x - previous.x,
    y: current.y - previous.y,
  };
  const perpendicularDirection = {
    x: -recentDirection.y,
    y: recentDirection.x,
  };
  const projected = lineIntersection(current, perpendicularDirection, start, recentDirection);
  const duplicatesExistingPoint = projected
    ? vertices.some((vertex) => distance(vertex, projected) <= 0.05)
    : true;
  const projectedOutline = projected ? [...vertices, projected, { ...start }] : [];
  const projectedIsValid = projected
    && !duplicatesExistingPoint
    && distance(current, projected) >= 0.1
    && distance(start, projected) >= 0.1
    && !calculateSketchOutline(projectedOutline).selfIntersecting;
  const targets: SketchClosureTarget[] = [];
  if (projectedIsValid) {
    targets.push({
      kind: "projected_corner",
      point: projected,
      label: `Add ${rounded(distance(current, projected), 1)} foot logical closing wall`,
    });
  }
  targets.push({
    kind: "starting_point",
    point: { ...start },
    label: "Connect to the starting point and calculate area",
  });
  return targets;
}

export function connectSketchTarget(vertices: SketchPoint[], target: SketchClosureTarget): SketchPoint[] {
  if (vertices.length < 3) throw new Error("sketch_needs_three_walls");
  if (target.kind === "starting_point") return closeSketchOutline(vertices);
  const current = vertices[vertices.length - 1]!;
  if (distance(current, target.point) < 0.1) throw new Error("invalid_sketch_wall_length");
  return [...vertices, { x: rounded(target.point.x), y: rounded(target.point.y) }];
}

export function closeSketchOutline(vertices: SketchPoint[]): SketchPoint[] {
  if (vertices.length < 3) throw new Error("sketch_needs_three_walls");
  const first = vertices[0]!;
  const last = vertices[vertices.length - 1]!;
  if (distance(first, last) <= 0.05) return [...vertices.slice(0, -1), { ...first }];
  return [...vertices, { ...first }];
}

export function sketchRoomRef(roomId: string) {
  return `sketch-room:${roomId.toLowerCase()}`;
}

export function pointInArea(point: SketchPoint, vertices: SketchPoint[]) {
  let inside = false;
  for (let left = 0, right = vertices.length - 1; left < vertices.length; right = left, left += 1) {
    const a = vertices[left]!;
    const b = vertices[right]!;
    const cross = ((point.y - a.y) * (b.x - a.x)) - ((point.x - a.x) * (b.y - a.y));
    const onEdge = Math.abs(cross) < 1e-7
      && point.x >= Math.min(a.x, b.x) - 1e-7
      && point.x <= Math.max(a.x, b.x) + 1e-7
      && point.y >= Math.min(a.y, b.y) - 1e-7
      && point.y <= Math.max(a.y, b.y) + 1e-7;
    if (onEdge) return true;
    const crosses = ((a.y > point.y) !== (b.y > point.y))
      && point.x < (((b.x - a.x) * (point.y - a.y)) / (b.y - a.y)) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export type SketchWallSnap = Readonly<{
  areaId: string;
  point: SketchPoint;
  distanceFeet: number;
}>;

export function nearestPointOnSketchWall(point: SketchPoint, areas: SketchAreaDraft[]): SketchWallSnap | null {
  let nearest: SketchWallSnap | null = null;
  for (const area of areas) {
    if (area.glaTreatment !== "included" || !calculateSketchOutline(area.vertices).ready) continue;
    for (let index = 0; index < area.vertices.length - 1; index += 1) {
      const start = area.vertices[index]!;
      const end = area.vertices[index + 1]!;
      const delta = { x: end.x - start.x, y: end.y - start.y };
      const squaredLength = (delta.x * delta.x) + (delta.y * delta.y);
      if (squaredLength < 1e-9) continue;
      const scalar = Math.max(0, Math.min(1, (
        ((point.x - start.x) * delta.x) + ((point.y - start.y) * delta.y)
      ) / squaredLength));
      const snapped = {
        x: rounded(start.x + (scalar * delta.x)),
        y: rounded(start.y + (scalar * delta.y)),
      };
      const distanceFeet = rounded(distance(point, snapped));
      if (!nearest || distanceFeet < nearest.distanceFeet) {
        nearest = { areaId: area.id, point: snapped, distanceFeet };
      }
    }
  }
  return nearest;
}

export function garageCutoutFitsParent(area: SketchAreaDraft, areas: SketchAreaDraft[]) {
  if (area.glaTreatment !== "deduction" || !area.parentAreaId) return false;
  const parent = areas.find((candidate) => candidate.id === area.parentAreaId);
  return Boolean(
    parent
    && parent.glaTreatment === "included"
    && calculateSketchOutline(parent.vertices).ready
    && calculateSketchOutline(area.vertices).ready
    && area.vertices.every((point) => pointInArea(point, parent.vertices)),
  );
}

export function calculateSketchGla(areas: SketchAreaDraft[]) {
  const grossAreaSqft = areas.reduce((total, area) => (
    area.glaTreatment === "included"
      ? total + (calculateSketchOutline(area.vertices).reportedAreaSqft || 0)
      : total
  ), 0);
  const deductionAreaSqft = areas.reduce((total, area) => (
    area.glaTreatment === "deduction"
      ? total + (calculateSketchOutline(area.vertices).reportedAreaSqft || 0)
      : total
  ), 0);
  return {
    grossAreaSqft,
    deductionAreaSqft,
    netGlaSqft: Math.max(0, grossAreaSqft - deductionAreaSqft),
  };
}

export function sketchBounds(vertices: SketchPoint[]) {
  if (!vertices.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };
  const xs = vertices.map((point) => point.x);
  const ys = vertices.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export function modelToCanvas(point: SketchPoint, vertices: SketchPoint[], width: number, height: number, padding = 20) {
  const bounds = sketchBounds(vertices);
  const scale = Math.min((width - (padding * 2)) / bounds.width, (height - (padding * 2)) / bounds.height);
  return {
    x: padding + ((point.x - bounds.minX) * scale),
    y: height - padding - ((point.y - bounds.minY) * scale),
  };
}

export function canvasToModel(point: SketchPoint, vertices: SketchPoint[], width: number, height: number, padding = 20) {
  const bounds = sketchBounds(vertices);
  const scale = Math.min((width - (padding * 2)) / bounds.width, (height - (padding * 2)) / bounds.height);
  return {
    x: rounded(bounds.minX + ((point.x - padding) / scale)),
    y: rounded(bounds.minY + ((height - padding - point.y) / scale)),
  };
}

export function emptySketchDraft(areaId: string): ManualSketchDraft {
  return {
    measurementStandard: "ansi_z765_2021",
    alternateStandardName: "",
    measurementMethod: "exterior",
    reviewStatus: "draft",
    reviewNotes: "",
    areas: [{
      id: areaId,
      label: "First floor",
      levelLabel: "Level 1",
      classification: "above_grade_finished",
      glaTreatment: "included",
      parentAreaId: null,
      notes: "",
      vertices: [],
      dimensionLabels: [],
      position: 1,
    }],
    rooms: [],
  };
}

export function toSketchApiDocument(draft: ManualSketchDraft): ManualSketchApiDocument {
  return {
    measurement_standard: draft.measurementStandard,
    alternate_standard_name: draft.alternateStandardName.trim() || null,
    measurement_method: draft.measurementMethod,
    review_status: draft.reviewStatus,
    review_notes: draft.reviewNotes.trim() || null,
    areas: draft.areas.map((area) => ({
      id: area.id,
      label: area.label,
      level_label: area.levelLabel,
      classification: area.classification,
      gla_treatment: area.glaTreatment,
      parent_area_id: area.parentAreaId,
      notes: area.notes.trim() || null,
      vertices: area.vertices,
      dimension_labels: area.dimensionLabels.map((label) => ({
        segment_index: label.segmentIndex,
        offset: label.offset,
      })),
      position: area.position,
    })),
    rooms: draft.rooms.map((room) => ({
      id: room.id,
      area_id: room.areaId,
      label: room.label,
      room_type: room.roomType,
      anchor: room.anchor,
      position: room.position,
    })),
  };
}

export function draftFromApiDocument(document: ManualSketchApiDocument): ManualSketchDraft {
  return {
    measurementStandard: document.measurement_standard,
    alternateStandardName: document.alternate_standard_name || "",
    measurementMethod: document.measurement_method,
    reviewStatus: document.review_status,
    reviewNotes: document.review_notes || "",
    areas: document.areas.map((area) => ({
      id: area.id,
      label: area.label,
      levelLabel: area.level_label,
      classification: area.classification,
      glaTreatment: area.gla_treatment || (area.classification === "above_grade_finished" ? "included" : "excluded"),
      parentAreaId: area.parent_area_id || null,
      notes: area.notes || "",
      vertices: area.vertices,
      dimensionLabels: (area.dimension_labels || []).map((label) => ({
        segmentIndex: label.segment_index,
        offset: label.offset,
      })),
      position: area.position,
    })),
    rooms: document.rooms.map((room) => ({
      id: room.id,
      areaId: room.area_id,
      label: room.label,
      roomType: room.room_type,
      anchor: room.anchor,
      position: room.position,
    })),
  };
}

export function sketchReadyForConfirmation(draft: ManualSketchDraft) {
  return draft.areas.length > 0 && draft.areas.every((area) => (
    calculateSketchOutline(area.vertices).ready
    && (area.glaTreatment !== "deduction" || garageCutoutFitsParent(area, draft.areas))
  ));
}
