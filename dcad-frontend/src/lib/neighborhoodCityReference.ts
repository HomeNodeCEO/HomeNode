export type CityReferenceEntry = { geoid: string; name: string; bytes: number; sha256: string };
type Point = [number, number];
export type CityReferenceCollection = {
  type: 'FeatureCollection';
  features: Array<{ type: 'Feature'; properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown } }>;
};
export type CityReference = { data: CityReferenceCollection; bounds: [Point, Point] };
type CityReferenceCamera = { center: Point; zoom: number; bearing: number; pitch: number };
export type CityReferenceMap = {
  getSource: (id: string) => { setData: (data: CityReferenceCollection) => void } | undefined;
  addSource: (id: string, source: Record<string, unknown>) => void;
  getLayer: (id: string) => unknown;
  addLayer: (layer: Record<string, unknown>) => void;
  fitBounds: (bounds: [Point, Point], options: Record<string, unknown>) => void;
  getCenter: () => { lng: number; lat: number };
  getZoom: () => number;
  getBearing: () => number;
  getPitch: () => number;
  jumpTo: (camera: CityReferenceCamera) => void;
};
const analysisCameras = new WeakMap<CityReferenceMap, CityReferenceCamera>();
const SOURCE = 'homenode-city-reference';
const EMPTY: CityReferenceCollection = { type: 'FeatureCollection', features: [] };
const MAX_BYTES = 2_000_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeCityReference(value: unknown, entry: CityReferenceEntry): CityReference {
  if (!record(value) || value.type !== 'Feature' || !record(value.properties) || !record(value.geometry)
    || value.properties.GEOID !== entry.geoid || value.properties.BASENAME !== entry.name
    || value.properties.STATE !== '48') throw new Error('City snapshot identity does not match the catalog.');
  const geometry = value.geometry;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : null;
  if (!Array.isArray(polygons) || !polygons.length) throw new Error('City snapshot has no polygons.');
  const low: Point = [180, 90], high: Point = [-180, -90];
  let count = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) throw new Error('Invalid city polygon.');
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) throw new Error('Invalid city ring.');
      for (const position of ring) {
        if (++count > 100_000 || !Array.isArray(position) || position.length !== 2
          || !position.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))
          || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) throw new Error('Invalid city coordinates.');
        low[0] = Math.min(low[0], position[0]); low[1] = Math.min(low[1], position[1]);
        high[0] = Math.max(high[0], position[0]); high[1] = Math.max(high[1], position[1]);
      }
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) throw new Error('City ring is not closed.');
    }
  }
  if (low[0] === high[0] || low[1] === high[1]) throw new Error('Empty city extent.');
  return { data: { type: 'FeatureCollection', features: [{ type: 'Feature',
    properties: { city: entry.name, geoid: entry.geoid, vintage: '2026-01-01' },
    geometry: { type: String(geometry.type), coordinates: geometry.coordinates } }] }, bounds: [low, high] };
}

/** Fixed same-app snapshots only. Never fetch the external source URL during report use. */
export function createCityReferenceLoader(fetcher: typeof fetch) {
  const cache = new Map<string, Promise<CityReference>>();
  return (entry: CityReferenceEntry) => {
    if (!/^48\d{5}$/.test(entry.geoid) || !Number.isSafeInteger(entry.bytes)
      || entry.bytes <= 0 || entry.bytes > MAX_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      return Promise.reject(new Error('Invalid city catalog entry.'));
    }
    const key = `${entry.geoid}:${entry.sha256}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const requestCity = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(`neighborhood-city-boundaries/2026-01-01/${entry.geoid}.geojson`,
          { signal: controller.signal, credentials: 'omit', cache: 'force-cache', redirect: 'error' });
        if (!response.ok || !response.body) throw new Error('The saved city snapshot could not be loaded.');
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > entry.bytes || size > MAX_BYTES) throw new Error('City snapshot exceeds its recorded size.');
            chunks.push(next.value);
          }
        } catch (error) { await reader.cancel(); throw error; }
        finally { reader.releaseLock(); }
        if (size !== entry.bytes) throw new Error('City snapshot is incomplete.');
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const actualHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (actualHash !== entry.sha256) throw new Error('City snapshot does not match its verified source.');
        return decodeCityReference(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), entry);
      } finally { clearTimeout(timer); }
    };
    const pending = requestCity();
    cache.set(key, pending);
    void pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    return pending;
  };
}

export function showCityReference(map: CityReferenceMap, city: CityReference) {
  const center = map.getCenter();
  const previousCamera: CityReferenceCamera = analysisCameras.get(map) ?? {
    center: [center.lng, center.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
  };
  const source = map.getSource(SOURCE);
  if (source) source.setData(city.data);
  else map.addSource(SOURCE, { type: 'geojson', data: city.data });
  for (const [id, color, width] of [[`${SOURCE}-gold`, '#f6c95a', 5], [`${SOURCE}-purple`, '#7c3aed', 2]] as const) {
    if (!map.getLayer(id)) map.addLayer({ id, type: 'line', source: SOURCE,
      paint: { 'line-color': color, 'line-width': width, 'line-opacity': 0.9 } });
  }
  map.fitBounds(city.bounds, { padding: 36, duration: 400 });
  // Keep the original analysis view when switching between reference cities.
  analysisCameras.set(map, previousCamera);
}

export function hideCityReference(map: CityReferenceMap) {
  map.getSource(SOURCE)?.setData(EMPTY);
  const camera = analysisCameras.get(map);
  if (camera) {
    // Works before a boundary is drawn and after it is cleared; no selection changes.
    map.jumpTo(camera);
    analysisCameras.delete(map);
  }
}
