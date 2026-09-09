type Point = [number, number];
type Geometry = { type: 'Polygon'; coordinates: Point[][] } | { type: 'MultiPolygon'; coordinates: Point[][][] };
export type AcceptedOutline = { paths: string[]; geometry: Geometry };

/** A saved-outline diagram, not a topology repair or a generated road boundary.
 * Closed rings are projected separately; disconnected polygons never acquire a
 * connecting segment, and holes remain holes. Invalid input is not repaired.
 */
export function acceptedNeighborhoodOutline(value: unknown): AcceptedOutline | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const geometry = value as Geometry;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : null;
  if (!Array.isArray(polygons) || !polygons.length) return null;
  const points: Point[] = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) return null;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4 || points.length + ring.length > 50_000) return null;
      for (const point of ring) {
        if (!Array.isArray(point) || point.length !== 2 || point.some(v => typeof v !== 'number' || !Number.isFinite(v))
          || point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) return null;
        points.push(point);
      }
      if (ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1]) return null;
    }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  if (maxX <= minX || maxY <= minY || maxX - minX > 180) return null;
  const longitudeScale = Math.cos((minY + maxY) / 2 * Math.PI / 180);
  const width = (maxX - minX) * longitudeScale, height = maxY - minY;
  const scale = Math.min(560 / width, 260 / height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const xOffset = (600 - width * scale) / 2, yOffset = (300 - height * scale) / 2;
  const xy = ([x, y]: Point) => `${((x - minX) * longitudeScale * scale + xOffset).toFixed(3)},${((maxY - y) * scale + yOffset).toFixed(3)}`;
  return { geometry, paths: polygons.map(polygon => polygon.map(ring =>
    `M${ring.map(xy).join(' L')} Z`).join(' ')) };
}
