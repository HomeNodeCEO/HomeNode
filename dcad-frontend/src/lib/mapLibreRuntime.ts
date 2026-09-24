/** Shared, lazy same-origin MapLibre runtime for report and neighborhood maps. */
export const MAPLIBRE_BASE_STYLE = 'https://tiles.openfreemap.org/styles/bright';

export interface ParcelMapClick {
  readonly point?: { readonly x: number; readonly y: number };
  readonly features?: readonly { readonly properties?: Readonly<Record<string, unknown>> }[];
  readonly originalEvent?: { preventDefault?: () => void };
}
export interface ParcelMapRuntimeInstance {
  on: {
    (event: 'load' | 'error' | 'idle' | 'zoom', callback: () => void): void;
    (event: 'click' | 'contextmenu', layer: string, callback: (event: ParcelMapClick) => void): void;
    (event: 'mouseenter' | 'mouseleave', layer: string, callback: () => void): void;
  };
  addSource: (id: string, source: Record<string, unknown>) => void;
  getSource: (id: string) => { setData: (data: unknown) => void } | undefined;
  getLayer: (id: string) => unknown;
  queryRenderedFeatures: (point: { readonly x: number; readonly y: number }, options: { layers: string[] }) =>
    readonly { readonly properties?: Readonly<Record<string, unknown>> }[];
  addLayer: (layer: Record<string, unknown>) => void;
  setFeatureState: (feature: { source: string; id: string }, state: Record<string, unknown>) => void;
  getCanvas: () => { style: { cursor: string } };
  fitBounds: (bounds: [[number, number], [number, number]], options: Record<string, unknown>) => void;
  getCenter: () => { lng: number; lat: number };
  getZoom: () => number;
  getBearing: () => number;
  getPitch: () => number;
  jumpTo: (camera: { center: [number, number]; zoom: number; bearing: number; pitch: number }) => void;
  resize: () => void;
  remove: () => void;
}
export interface MapLibreRuntime {
  Map: new (options: Record<string, unknown>) => ParcelMapRuntimeInstance;
  setWorkerUrl: (url: string) => void;
}
let pending: Promise<MapLibreRuntime> | null = null;

export function loadMapLibreRuntime(): Promise<MapLibreRuntime> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.reject(new Error('map_browser_required'));
  if (pending) return pending;
  let timeout: number | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = window.setTimeout(() => reject(new Error('map_load_timeout')), 15_000);
  });
  const bundled = Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl.css'),
    import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
  ]).then(([module, , worker]) => {
    if (typeof module.Map !== 'function' || typeof module.setWorkerUrl !== 'function' || typeof worker.default !== 'string') {
      throw new Error('map_runtime_unavailable');
    }
    // Vite bundles this worker as a self-contained, same-origin asset. Set it before any map is created.
    module.setWorkerUrl(worker.default);
    return module as unknown as MapLibreRuntime;
  });
  pending = Promise.race([bundled, deadline])
    .catch(error => { pending = null; throw error; })
    .finally(() => { if (timeout !== undefined) window.clearTimeout(timeout); });
  return pending;
}
