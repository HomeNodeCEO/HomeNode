import type { EditableInspectionSketch } from '@/lib/api';

export type SketchDocument = EditableInspectionSketch['document'];
export type SketchArea = SketchDocument['areas'][number];
export type SketchPoint = SketchArea['vertices'][number];

export type LiveSketchSummary = {
  grossIncludedSqft: number;
  deductionSqft: number;
  netGlaSqft: number;
  belowGradeFinishedSqft: number;
  selectedAreaSqft: number | null;
  byClassification: Record<string, number>;
};

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
      if (segmentsIntersect(
        vertices[first]!,
        vertices[first + 1]!,
        vertices[second]!,
        vertices[second + 1]!,
      )) return true;
    }
  }
  return false;
}

function bearingDegrees(left: SketchPoint, right: SketchPoint) {
  const degrees = Math.atan2(right.y - left.y, right.x - left.x) * (180 / Math.PI);
  return rounded((degrees + 360) % 360, 1);
}

function calculateArea(vertices: SketchPoint[]) {
  const first = vertices[0];
  const last = vertices.at(-1);
  const closureGap = first && last ? distance(first, last) : 0;
  const closed = vertices.length >= 4 && closureGap <= 0.05;
  const normalized = closed && first ? [...vertices.slice(0, -1), { ...first }] : vertices;
  const crossing = closed && selfIntersects(normalized);
  let signedDoubleArea = 0;
  let perimeter = 0;
  let centroidX = 0;
  let centroidY = 0;
  const segments = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const current = normalized[index]!;
    const next = normalized[index + 1]!;
    const cross = (current.x * next.y) - (next.x * current.y);
    const length = distance(current, next);
    signedDoubleArea += cross;
    centroidX += (current.x + next.x) * cross;
    centroidY += (current.y + next.y) * cross;
    perimeter += length;
    segments.push({
      index: index + 1,
      from: current,
      to: next,
      length_feet: rounded(length, 1),
      bearing_degrees: bearingDegrees(current, next),
    });
  }
  const calculatedArea = closed && !crossing ? Math.abs(signedDoubleArea) / 2 : null;
  const ready = calculatedArea != null && calculatedArea > 0;
  const xs = normalized.map((point) => point.x);
  const ys = normalized.map((point) => point.y);
  return {
    vertices: normalized,
    calculation: {
      closed,
      self_intersecting: crossing,
      perimeter_feet: rounded(perimeter, 2),
      reported_area_sqft: calculatedArea == null ? null : Math.round(calculatedArea),
      closure_gap_feet: rounded(closureGap),
      calculated_area_sqft: calculatedArea == null ? null : rounded(calculatedArea, 2),
      ready_for_area_classification: ready,
      bounds: {
        min_x: xs.length ? Math.min(...xs) : 0,
        min_y: ys.length ? Math.min(...ys) : 0,
        max_x: xs.length ? Math.max(...xs) : 0,
        max_y: ys.length ? Math.max(...ys) : 0,
      },
      centroid: ready && Math.abs(signedDoubleArea) > 1e-9
        ? {
            x: rounded(centroidX / (3 * signedDoubleArea)),
            y: rounded(centroidY / (3 * signedDoubleArea)),
          }
        : null,
      segments,
    },
  };
}

export function recalculateSketchArea(area: SketchArea, vertices = area.vertices): SketchArea {
  const calculated = calculateArea(vertices);
  return { ...area, vertices: calculated.vertices, calculation: calculated.calculation };
}

export function recalculateSketchDocument(document: SketchDocument): SketchDocument {
  return { ...document, areas: document.areas.map((area) => recalculateSketchArea(area)) };
}

export function appendMeasuredWall(
  vertices: SketchPoint[],
  lengthFeet: number,
  bearing: number,
): SketchPoint[] {
  if (!Number.isFinite(lengthFeet) || lengthFeet < 0.1 || lengthFeet > 10_000) {
    throw new Error('Enter a wall length between 0.1 and 10,000 feet.');
  }
  if (!Number.isFinite(bearing)) throw new Error('Enter a valid wall direction.');
  const start = vertices.length ? vertices.at(-1)! : { x: 0, y: 0 };
  const radians = bearing * (Math.PI / 180);
  const next = {
    x: rounded(start.x + (lengthFeet * Math.cos(radians))),
    y: rounded(start.y + (lengthFeet * Math.sin(radians))),
  };
  return vertices.length ? [...vertices, next] : [start, next];
}

export function closeSketchArea(vertices: SketchPoint[]): SketchPoint[] {
  if (vertices.length < 3) throw new Error('Add at least three walls before closing the area.');
  const first = vertices[0]!;
  return distance(first, vertices.at(-1)!) <= 0.05
    ? [...vertices.slice(0, -1), { ...first }]
    : [...vertices, { ...first }];
}

export function undoSketchWall(vertices: SketchPoint[]): SketchPoint[] {
  if (vertices.length <= 2) return [];
  const closed = distance(vertices[0]!, vertices.at(-1)!) <= 0.05;
  return closed ? vertices.slice(0, -1) : vertices.slice(0, -1);
}

export function liveSketchSummary(
  document: SketchDocument,
  selectedAreaId = '',
): LiveSketchSummary {
  const byClassification: Record<string, number> = {};
  let grossIncludedSqft = 0;
  let deductionSqft = 0;
  let selectedAreaSqft: number | null = null;
  for (const area of document.areas) {
    const squareFeet = recalculateSketchArea(area).calculation.reported_area_sqft || 0;
    byClassification[area.classification] = (byClassification[area.classification] || 0) + squareFeet;
    if ((area.gla_treatment || (area.classification === 'above_grade_finished' ? 'included' : 'excluded')) === 'included') {
      grossIncludedSqft += squareFeet;
    }
    if (area.gla_treatment === 'deduction') deductionSqft += squareFeet;
    if (area.id === selectedAreaId) selectedAreaSqft = squareFeet || null;
  }
  return {
    grossIncludedSqft,
    deductionSqft,
    netGlaSqft: Math.max(0, grossIncludedSqft - deductionSqft),
    belowGradeFinishedSqft: byClassification.below_grade_finished || 0,
    selectedAreaSqft,
    byClassification,
  };
}

function blankCalculation(): SketchArea['calculation'] {
  return calculateArea([]).calculation;
}

export function createBlankSketchDocument(areaId: string): SketchDocument {
  return {
    schema_version: '2.1',
    source: 'manual',
    units: 'feet',
    dimension_precision_feet: 0.1,
    measurement_standard: 'ansi_z765_2021',
    alternate_standard_name: null,
    measurement_method: 'exterior',
    review_status: 'draft',
    ansi_review_required: true,
    review_notes: null,
    areas: [{
      id: areaId,
      label: 'First floor',
      level_label: 'Level 1',
      classification: 'above_grade_finished',
      gla_treatment: 'included',
      parent_area_id: null,
      notes: null,
      vertices: [],
      dimension_labels: [],
      calculation: blankCalculation(),
      position: 1,
    }],
    rooms: [],
  };
}
