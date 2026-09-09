/** The same pinned runtime and DOM keys used by the existing report maps.
 * This loader knows nothing about assignments, analyses, or report persistence. */
export const MAPLIBRE_BASE_STYLE = 'https://tiles.openfreemap.org/styles/bright';
const SCRIPT = 'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.js';
const STYLE = 'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.css';

export interface ParcelMapClick {
  readonly features?: readonly { readonly properties?: Readonly<Record<string, unknown>> }[];
}
export interface ParcelMapRuntimeInstance {
  on: {
    (event: 'load' | 'error' | 'idle', callback: () => void): void;
    (event: 'click', layer: string, callback: (event: ParcelMapClick) => void): void;
    (event: 'mouseenter' | 'mouseleave', layer: string, callback: () => void): void;
  };
  addSource: (id: string, source: Record<string, unknown>) => void;
  getSource: (id: string) => { setData: (data: unknown) => void } | undefined;
  addLayer: (layer: Record<string, unknown>) => void;
  setFeatureState: (feature: { source: string; id: string }, state: Record<string, unknown>) => void;
  getCanvas: () => { style: { cursor: string } };
  fitBounds: (bounds: [[number, number], [number, number]], options: Record<string, unknown>) => void;
  resize: () => void;
  remove: () => void;
}
export interface MapLibreRuntime {
  Map: new (options: Record<string, unknown>) => ParcelMapRuntimeInstance;
}
let pending: Promise<MapLibreRuntime> | null = null;
const runtime = (): MapLibreRuntime | undefined =>
  (window as unknown as { maplibregl?: MapLibreRuntime }).maplibregl;

export function loadMapLibreRuntime(): Promise<MapLibreRuntime> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.reject(new Error('map_browser_required'));
  if (!document.querySelector('link[data-homenode-map-style="maplibre"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = STYLE; link.dataset.homenodeMapStyle = 'maplibre';
    document.head.appendChild(link);
  }
  const loaded = runtime();
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  pending = new Promise<MapLibreRuntime>((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>('script[data-homenode-map-script="maplibre"]');
    if (script?.dataset.homenodeMapFailed === 'true') { script.remove(); script = null; }
    const isNew = !script;
    const element = script ?? document.createElement('script');
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      element.removeEventListener('load', onLoad); element.removeEventListener('error', onError);
    };
    const fail = (reason: string) => {
      if (settled) return; settled = true; cleanup();
      element.dataset.homenodeMapFailed = 'true'; reject(new Error(reason));
    };
    const onLoad = () => {
      if (settled) return;
      const result = runtime();
      if (!result) { fail('map_runtime_unavailable'); return; }
      settled = true; cleanup(); element.dataset.homenodeMapLoaded = 'true'; resolve(result);
    };
    const onError = () => fail('map_load_failed');
    const timeout = window.setTimeout(() => fail('map_load_timeout'), 15_000);
    element.addEventListener('load', onLoad); element.addEventListener('error', onError);
    if (isNew) {
      element.src = SCRIPT; element.async = true; element.dataset.homenodeMapScript = 'maplibre';
      document.head.appendChild(element);
    }
  }).catch(error => { pending = null; throw error; });
  return pending;
}
