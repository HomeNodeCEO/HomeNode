export type NeighborhoodPocketMapCandidate = {
  parcel_object_id: number;
  pocket_id?: string | null;
  cluster_id?: string | null;
  primary_population: boolean;
  system_selected?: boolean;
  recommended_population?: boolean;
  appraiser_override?: 'included' | 'removed' | null;
  score?: number | null;
  point: { type: 'Point'; coordinates: [number, number] };
};

type Coordinate = [number, number];

const MINIMUM_POCKET_PADDING_DEGREES = 0.00035;
const MAXIMUM_POCKET_PADDING_DEGREES = 0.0012;

function cross(origin: Coordinate, left: Coordinate, right: Coordinate): number {
  return (left[0] - origin[0]) * (right[1] - origin[1]) -
    (left[1] - origin[1]) * (right[0] - origin[0]);
}

function convexHull(coordinates: Coordinate[]): Coordinate[] {
  const unique = new Map<string, Coordinate>();
  coordinates.forEach((coordinate) => {
    unique.set(`${coordinate[0].toFixed(7)}:${coordinate[1].toFixed(7)}`, coordinate);
  });
  const sorted = [...unique.values()].sort((left, right) =>
    left[0] - right[0] || left[1] - right[1],
  );
  if (sorted.length <= 2) return sorted;

  const lower: Coordinate[] = [];
  sorted.forEach((coordinate) => {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, coordinate) <= 0) {
      lower.pop();
    }
    lower.push(coordinate);
  });
  const upper: Coordinate[] = [];
  [...sorted].reverse().forEach((coordinate) => {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, coordinate) <= 0) {
      upper.pop();
    }
    upper.push(coordinate);
  });
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function rectangularPocket(coordinates: Coordinate[], padding: number): Coordinate[] {
  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  const minimumLongitude = Math.min(...longitudes) - padding;
  const maximumLongitude = Math.max(...longitudes) + padding;
  const minimumLatitude = Math.min(...latitudes) - padding;
  const maximumLatitude = Math.max(...latitudes) + padding;
  return [
    [minimumLongitude, minimumLatitude],
    [maximumLongitude, minimumLatitude],
    [maximumLongitude, maximumLatitude],
    [minimumLongitude, maximumLatitude],
    [minimumLongitude, minimumLatitude],
  ];
}

function pocketRing(coordinates: Coordinate[]): Coordinate[] {
  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  const span = Math.max(
    Math.max(...longitudes) - Math.min(...longitudes),
    Math.max(...latitudes) - Math.min(...latitudes),
  );
  const padding = Math.max(
    MINIMUM_POCKET_PADDING_DEGREES,
    Math.min(MAXIMUM_POCKET_PADDING_DEGREES, span * 0.06),
  );
  const hull = convexHull(coordinates);
  if (hull.length < 3) return rectangularPocket(coordinates, padding);

  const center = hull.reduce(
    (current, coordinate) => [
      current[0] + coordinate[0] / hull.length,
      current[1] + coordinate[1] / hull.length,
    ] as Coordinate,
    [0, 0] as Coordinate,
  );
  const expanded = hull.map(([longitude, latitude]) => {
    const longitudeOffset = longitude - center[0];
    const latitudeOffset = latitude - center[1];
    const distance = Math.hypot(longitudeOffset, latitudeOffset) || 1;
    return [
      longitude + longitudeOffset / distance * padding,
      latitude + latitudeOffset / distance * padding,
    ] as Coordinate;
  });
  return [...expanded, expanded[0]];
}

export function makeNeighborhoodPocketFeatureCollection(
  candidates: NeighborhoodPocketMapCandidate[] = [],
) {
  const pockets = new Map<string, NeighborhoodPocketMapCandidate[]>();
  candidates.forEach((candidate) => {
    const pocketId = candidate.pocket_id || candidate.cluster_id;
    const coordinates = candidate.point?.coordinates;
    if (
      !pocketId ||
      !Array.isArray(coordinates) ||
      coordinates.length !== 2 ||
      !coordinates.every(Number.isFinite)
    ) return;
    const pocket = pockets.get(pocketId) || [];
    pocket.push(candidate);
    pockets.set(pocketId, pocket);
  });

  return {
    type: 'FeatureCollection' as const,
    features: [...pockets.entries()].map(([pocketId, pocketCandidates]) => {
      const included = pocketCandidates.some((candidate) => candidate.primary_population);
      const systemSelected = pocketCandidates.some((candidate) =>
        candidate.system_selected ?? candidate.primary_population,
      );
      const appraiserRemoved = pocketCandidates.some((candidate) =>
        candidate.appraiser_override === 'removed',
      );
      const scores = pocketCandidates
        .map((candidate) => Number(candidate.score))
        .filter(Number.isFinite);
      return {
        type: 'Feature' as const,
        id: pocketId,
        geometry: {
          type: 'Polygon' as const,
          coordinates: [pocketRing(
            pocketCandidates.map((candidate) => candidate.point.coordinates),
          )],
        },
        properties: {
          pocket_id: pocketId,
          included,
          system_selected: systemSelected,
          recommended: pocketCandidates.some((candidate) =>
            candidate.recommended_population === true,
          ),
          status: appraiserRemoved ? 'removed' : included ? 'included' : 'available',
          property_count: pocketCandidates.length,
          average_score: scores.length
            ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
            : 0,
        },
      };
    }),
  };
}
