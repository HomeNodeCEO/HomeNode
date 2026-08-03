const EARTH_RADIUS_METERS = 6_378_137;
const SQ_METERS_TO_SQ_FEET = 10.76391041671;

function toRadians(degrees) {
  return Number(degrees) * Math.PI / 180;
}

function sphericalRingAreaSquareMeters(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const lower = ring[(index + ring.length - 1) % ring.length];
    const middle = ring[index];
    const upper = ring[(index + 1) % ring.length];
    sum += (toRadians(upper[0]) - toRadians(lower[0])) * Math.sin(toRadians(middle[1]));
  }
  return Math.abs(sum * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS / 2);
}

function polygonAreaSquareMeters(rings) {
  if (!Array.isArray(rings) || !rings.length) return 0;
  const shell = sphericalRingAreaSquareMeters(rings[0]);
  const holes = rings.slice(1).reduce(
    (sum, ring) => sum + sphericalRingAreaSquareMeters(ring),
    0,
  );
  return Math.max(0, shell - holes);
}

export function geoJsonAreaSquareFeet(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) {
    throw new Error("invalid_parcel_geometry");
  }
  let squareMeters;
  if (geometry.type === "Polygon") {
    squareMeters = polygonAreaSquareMeters(geometry.coordinates);
  } else if (geometry.type === "MultiPolygon") {
    squareMeters = geometry.coordinates.reduce(
      (sum, polygon) => sum + polygonAreaSquareMeters(polygon),
      0,
    );
  } else {
    throw new Error("unsupported_parcel_geometry");
  }
  if (!Number.isFinite(squareMeters) || squareMeters <= 0) {
    throw new Error("empty_parcel_geometry");
  }
  return squareMeters * SQ_METERS_TO_SQ_FEET;
}

export function esriGeometryToGeoJson(geometry) {
  if (!geometry || !Array.isArray(geometry.rings)) {
    throw new Error("invalid_esri_parcel_geometry");
  }
  // ArcGIS polygon rings can include multiple shells. County parcel services
  // normally return one shell; preserve every additional ring as a hole here.
  return { type: "Polygon", coordinates: geometry.rings };
}

