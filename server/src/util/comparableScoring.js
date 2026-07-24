const EARTH_RADIUS_MILES = 3958.7613;

export const DEFAULT_COMPARABLE_SCORING = Object.freeze({
  locationWeight: 0.6,
  squareFootageWeight: 0.4,
  locationScaleMiles: 1,
  squareFootageScaleRatio: 0.1,
});

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function softSimilarity(value, scale) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  return 100 / (1 + value / scale);
}

export function haversineMiles(latitudeA, longitudeA, latitudeB, longitudeB) {
  const latA = finiteNumber(latitudeA);
  const lonA = finiteNumber(longitudeA);
  const latB = finiteNumber(latitudeB);
  const lonB = finiteNumber(longitudeB);
  if ([latA, lonA, latB, lonB].some((value) => value === null)) return null;

  const toRadians = (degrees) => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(latB - latA);
  const deltaLongitude = toRadians(lonB - lonA);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(latA)) *
      Math.cos(toRadians(latB)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function scoreComparable(
  {
    subjectLatitude,
    subjectLongitude,
    comparableLatitude,
    comparableLongitude,
    subjectSquareFeet,
    comparableSquareFeet,
  },
  config = DEFAULT_COMPARABLE_SCORING,
) {
  const subjectSqft = finiteNumber(subjectSquareFeet);
  const comparableSqft = finiteNumber(comparableSquareFeet);
  const distanceMiles = haversineMiles(
    subjectLatitude,
    subjectLongitude,
    comparableLatitude,
    comparableLongitude,
  );

  if (
    distanceMiles === null ||
    subjectSqft === null ||
    comparableSqft === null ||
    subjectSqft <= 0 ||
    comparableSqft <= 0
  ) {
    return null;
  }

  const squareFootageDifference = Math.abs(comparableSqft - subjectSqft);
  const squareFootageDifferenceRatio = squareFootageDifference / subjectSqft;
  const locationScore = softSimilarity(distanceMiles, config.locationScaleMiles);
  const squareFootageScore = softSimilarity(
    squareFootageDifferenceRatio,
    config.squareFootageScaleRatio,
  );
  const totalWeight = config.locationWeight + config.squareFootageWeight;
  if (
    locationScore === null ||
    squareFootageScore === null ||
    !Number.isFinite(totalWeight) ||
    totalWeight <= 0
  ) {
    return null;
  }

  const comparableScore =
    (
      locationScore * config.locationWeight +
      squareFootageScore * config.squareFootageWeight
    ) / totalWeight;

  return {
    comparableScore: round(comparableScore, 1),
    distanceMiles: round(distanceMiles, 3),
    locationScore: round(locationScore, 1),
    squareFootageScore: round(squareFootageScore, 1),
    squareFootageDifference: round(squareFootageDifference, 0),
    squareFootageDifferenceRatio: round(squareFootageDifferenceRatio, 4),
    squareFootageDifferencePercent: round(squareFootageDifferenceRatio * 100, 1),
  };
}

function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let crossSum = 0;
  let longitudeSum = 0;
  let latitudeSum = 0;

  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const currentLongitude = finiteNumber(current?.[0]);
    const currentLatitude = finiteNumber(current?.[1]);
    const nextLongitude = finiteNumber(next?.[0]);
    const nextLatitude = finiteNumber(next?.[1]);
    if (
      currentLongitude === null ||
      currentLatitude === null ||
      nextLongitude === null ||
      nextLatitude === null
    ) {
      continue;
    }
    const cross = currentLongitude * nextLatitude - nextLongitude * currentLatitude;
    crossSum += cross;
    longitudeSum += (currentLongitude + nextLongitude) * cross;
    latitudeSum += (currentLatitude + nextLatitude) * cross;
  }

  if (Math.abs(crossSum) < 1e-14) return null;
  return {
    longitude: longitudeSum / (3 * crossSum),
    latitude: latitudeSum / (3 * crossSum),
    signedArea: crossSum / 2,
  };
}

export function polygonCentroid(rings) {
  if (!Array.isArray(rings) || !rings.length) return null;
  const centroids = rings.map(ringCentroid).filter(Boolean);
  if (centroids.length) {
    const signedArea = centroids.reduce((sum, item) => sum + item.signedArea, 0);
    if (Math.abs(signedArea) >= 1e-14) {
      return {
        longitude:
          centroids.reduce(
            (sum, item) => sum + item.longitude * item.signedArea,
            0,
          ) / signedArea,
        latitude:
          centroids.reduce(
            (sum, item) => sum + item.latitude * item.signedArea,
            0,
          ) / signedArea,
        area: Math.abs(signedArea),
      };
    }
  }

  const points = rings
    .flat()
    .filter(
      (point) =>
        Array.isArray(point) &&
        finiteNumber(point[0]) !== null &&
        finiteNumber(point[1]) !== null,
    );
  if (!points.length) return null;
  const longitudes = points.map((point) => Number(point[0]));
  const latitudes = points.map((point) => Number(point[1]));
  return {
    longitude: (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    latitude: (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
    area: 0,
  };
}
