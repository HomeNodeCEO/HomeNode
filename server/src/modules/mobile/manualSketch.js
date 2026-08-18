const MAX_VERTICES = 500;
const DEFAULT_CLOSURE_TOLERANCE_FEET = 0.05;

function finiteCoordinate(value, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 100_000) throw new Error(code);
  return number;
}

function distance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function orientation(a, b, c) {
  const cross = ((b.y - a.y) * (c.x - b.x)) - ((b.x - a.x) * (c.y - b.y));
  if (Math.abs(cross) < 1e-9) return 0;
  return cross > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return b.x <= Math.max(a.x, c.x) + 1e-9
    && b.x >= Math.min(a.x, c.x) - 1e-9
    && b.y <= Math.max(a.y, c.y) + 1e-9
    && b.y >= Math.min(a.y, c.y) - 1e-9;
}

function segmentsIntersect(a, b, c, d) {
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

function hasSelfIntersection(vertices) {
  const segmentCount = vertices.length - 1;
  for (let first = 0; first < segmentCount; first += 1) {
    for (let second = first + 1; second < segmentCount; second += 1) {
      if (Math.abs(first - second) <= 1) continue;
      if (first === 0 && second === segmentCount - 1) continue;
      if (segmentsIntersect(
        vertices[first],
        vertices[first + 1],
        vertices[second],
        vertices[second + 1],
      )) return true;
    }
  }
  return false;
}

function rounded(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function calculateManualSketch(input = {}) {
  if (!Array.isArray(input.vertices) || input.vertices.length < 4 || input.vertices.length > MAX_VERTICES) {
    throw new Error("invalid_sketch_vertices");
  }
  const vertices = input.vertices.map((vertex) => ({
    x: finiteCoordinate(vertex?.x, "invalid_sketch_coordinate"),
    y: finiteCoordinate(vertex?.y, "invalid_sketch_coordinate"),
  }));
  const tolerance = input.closure_tolerance_feet == null
    ? DEFAULT_CLOSURE_TOLERANCE_FEET
    : finiteCoordinate(input.closure_tolerance_feet, "invalid_closure_tolerance");
  if (tolerance < 0 || tolerance > 1) throw new Error("invalid_closure_tolerance");
  const closureGapFeet = distance(vertices[0], vertices.at(-1));
  const closed = closureGapFeet <= tolerance;
  const normalizedVertices = closed
    ? [...vertices.slice(0, -1), { ...vertices[0] }]
    : vertices;
  const selfIntersecting = closed && hasSelfIntersection(normalizedVertices);
  let signedDoubleArea = 0;
  let perimeterFeet = 0;
  for (let index = 0; index < normalizedVertices.length - 1; index += 1) {
    const current = normalizedVertices[index];
    const next = normalizedVertices[index + 1];
    signedDoubleArea += (current.x * next.y) - (next.x * current.y);
    perimeterFeet += distance(current, next);
  }
  const areaSquareFeet = closed && !selfIntersecting ? Math.abs(signedDoubleArea) / 2 : null;
  return Object.freeze({
    schema_version: "1.0",
    units: "feet",
    vertices: normalizedVertices,
    closed,
    closure_gap_feet: rounded(closureGapFeet, 3),
    self_intersecting: selfIntersecting,
    perimeter_feet: rounded(perimeterFeet),
    calculated_area_sqft: areaSquareFeet == null ? null : rounded(areaSquareFeet),
    ready_for_area_classification: closed && !selfIntersecting && areaSquareFeet > 0,
    ansi_review_required: true,
  });
}
