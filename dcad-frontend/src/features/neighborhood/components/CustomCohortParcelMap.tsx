import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { loadMapLibreRuntime, MAPLIBRE_BASE_STYLE } from '../../../lib/mapLibreRuntime';
import type { ParcelMapRuntimeInstance } from '../../../lib/mapLibreRuntime';
import { CUSTOM_COHORT_UNASSIGNED_GROUP } from '../customCohortPocketCatalog';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import type { CustomCohortPreviewGroup, CustomCohortPreviewState } from '../customCohortPreviewController';

interface Props {
  group: CustomCohortPreviewGroup;
  catalog: CheckedPocketCatalog;
  freshness: CustomCohortPreviewState['freshness'];
  inspectedPocketId?: string | null;
  onInspectPocket?: (pocketId: string) => void;
  onInspectAccount?: (accountId: string) => void;
}
const SOURCE = 'custom-cohort-parcels', FILL = 'custom-cohort-parcels-fill';
const COLORS = { included: '#15803d', excluded: '#94a3b8', unresolved: '#d97706', inspected: '#eab308', subject: '#7e22ce' };
type AvailableMap = Extract<CustomCohortPreviewGroup['parcel_map'], { status: 'available' }>;
type Parcel = AvailableMap['geojson']['features'][number];
type Paint = { selected: boolean; inspected: boolean; unresolved: boolean; subject: boolean };
type PaintedParcel = Parcel & { properties: Parcel['properties'] & Paint };

function contextMatches(group: CustomCohortPreviewGroup, catalog: CheckedPocketCatalog) {
  const a = group.binding.contextRef, b = catalog.binding.context_ref;
  return a.context_id === b.context_id && a.context_revision === b.context_revision && a.context_sha256 === b.context_sha256
    && group.binding.accountId === catalog.subject_membership.account_id;
}
function parcelBounds(features: readonly Parcel[]): [[number, number], [number, number]] | null {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      west = Math.min(west, value[0]); east = Math.max(east, value[0]);
      south = Math.min(south, value[1]); north = Math.max(north, value[1]);
    } else value.forEach(visit);
  };
  features.forEach(f => visit(f.geometry.coordinates));
  return Number.isFinite(west) ? [[west, south], [east, north]] : null;
}
function sameGeometry(previous: readonly PaintedParcel[], next: readonly PaintedParcel[]) {
  return previous.length === next.length && previous.every((f, i) => f.id === next[i].id
    && f.properties.account_id === next[i].properties.account_id && f.geometry === next[i].geometry);
}
const paintFor = (f: PaintedParcel): Paint => ({ selected: f.properties.selected, inspected: f.properties.inspected,
  unresolved: f.properties.unresolved, subject: f.properties.subject });
const state = (key: keyof Paint) => ['coalesce', ['feature-state', key], ['get', key]];

/** Exact cached parcel outlines; neither a generated neighborhood boundary nor a
 * similarity heat map. Only an accepted controller group can change map colors. */
export default function CustomCohortParcelMap({ group, catalog, freshness, inspectedPocketId,
  onInspectPocket, onInspectAccount }: Props) {
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<ParcelMapRuntimeInstance | null>(null);
  const painted = useRef<readonly PaintedParcel[]>([]);
  const [mapState, setMapState] = useState<'loading' | 'drawing' | 'ready' | 'failed'>('loading');
  const awaitingDraw = useRef(false), drawTimeout = useRef<number | null>(null);
  const [tileError, setTileError] = useState(false);
  const matches = contextMatches(group, catalog);
  const memberships = useMemo(() => {
    const index = new Map<string, string>();
    if (matches) {
      catalog.pockets.forEach(p => p.account_ids.forEach(account => index.set(account, p.id)));
      catalog.unassigned.account_ids.forEach(account => index.set(account, CUSTOM_COHORT_UNASSIGNED_GROUP));
    }
    return index;
  }, [catalog, matches]);
  const geojson = useMemo(() => ({ type: 'FeatureCollection' as const,
    features: group.parcel_map.status !== 'available' || !matches ? [] : group.parcel_map.geojson.features.map(f => ({
      ...f, properties: { ...f.properties, unresolved: !memberships.has(f.properties.account_id)
        || memberships.get(f.properties.account_id) === CUSTOM_COHORT_UNASSIGNED_GROUP,
      inspected: Boolean(inspectedPocketId && memberships.get(f.properties.account_id) === inspectedPocketId),
      subject: f.properties.account_id === group.binding.accountId },
    })),
  }), [group, matches, memberships, inspectedPocketId]);
  const latest = useRef({ geojson, memberships, onInspectPocket, onInspectAccount });
  latest.current = { geojson, memberships, onInspectPocket, onInspectAccount };
  const hasGeometry = matches && group.parcel_map.status === 'available' && geojson.features.length > 0;
  const ref = group.binding.contextRef;
  const contextKey = JSON.stringify([group.binding.accountId, group.binding.assignmentFileId,
    ref.context_id, ref.context_revision, ref.context_sha256]);

  useEffect(() => {
    if (!hasGeometry || !container.current) return;
    let disposed = false, loaded = false;
    let instance: ParcelMapRuntimeInstance | null = null;
    let observer: ResizeObserver | null = null;
    setMapState('loading'); setTileError(false); painted.current = [];
    const timeout = window.setTimeout(() => { if (!disposed && !loaded) setMapState('failed'); }, 20_000);
    const onResize = () => { if (!disposed) instance?.resize(); };
    void loadMapLibreRuntime().then(runtime => {
      if (disposed || !container.current) return;
      instance = new runtime.Map({ container: container.current, style: MAPLIBRE_BASE_STYLE,
        center: [0, 0], zoom: 1, attributionControl: true });
      mapRef.current = instance;
      instance.on('error', () => { if (!disposed) setTileError(true); });
      instance.on('idle', () => {
        if (disposed || !loaded || !awaitingDraw.current) return;
        awaitingDraw.current = false;
        if (drawTimeout.current !== null) window.clearTimeout(drawTimeout.current);
        drawTimeout.current = null; setMapState('ready');
      });
      instance.on('load', () => {
        if (disposed || !instance) return;
        try {
          const data = latest.current.geojson;
          instance.addSource(SOURCE, { type: 'geojson', data });
          instance.addLayer({ id: FILL, type: 'fill', source: SOURCE, paint: {
            'fill-color': ['case', state('unresolved'), COLORS.unresolved, state('selected'), COLORS.included, COLORS.excluded],
            'fill-opacity': ['case', state('selected'), 0.55, 0.2],
          } });
          instance.addLayer({ id: `${SOURCE}-outline`, type: 'line', source: SOURCE, paint: {
            'line-color': ['case', state('subject'), COLORS.subject, state('inspected'), COLORS.inspected,
              state('selected'), COLORS.included, state('unresolved'), COLORS.unresolved, COLORS.excluded],
            'line-width': ['case', state('subject'), 3, state('inspected'), 2.5, 0.75],
          } });
          instance.on('click', FILL, event => {
            const account = event.features?.[0]?.properties?.account_id;
            if (disposed || typeof account !== 'string') return;
            const current = latest.current, pocket = current.memberships.get(account);
            if (!pocket) return;
            current.onInspectPocket?.(pocket); current.onInspectAccount?.(account);
          });
          instance.on('mouseenter', FILL, () => { if (!disposed && instance) instance.getCanvas().style.cursor = 'pointer'; });
          instance.on('mouseleave', FILL, () => { if (!disposed && instance) instance.getCanvas().style.cursor = ''; });
          const bounds = parcelBounds(data.features);
          if (bounds) instance.fitBounds(bounds, { padding: 28, maxZoom: 16, duration: 0 });
          painted.current = data.features; loaded = true; window.clearTimeout(timeout);
          awaitingDraw.current = true; setMapState('drawing');
          drawTimeout.current = window.setTimeout(() => { awaitingDraw.current = false; if (!disposed) setMapState('failed'); }, 20_000);
        } catch { awaitingDraw.current = false; setMapState('failed'); }
      });
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(onResize); observer.observe(container.current);
      } else window.addEventListener('resize', onResize);
    }).catch(() => { if (!disposed) setMapState('failed'); });
    return () => {
      disposed = true; window.clearTimeout(timeout); observer?.disconnect(); window.removeEventListener('resize', onResize);
      if (drawTimeout.current !== null) window.clearTimeout(drawTimeout.current);
      drawTimeout.current = null; awaitingDraw.current = false;
      instance?.remove(); if (mapRef.current === instance) mapRef.current = null; painted.current = [];
    };
  }, [contextKey, hasGeometry]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (mapState === 'loading' || mapState === 'failed' || !map || !hasGeometry) return;
    try {
      let changed = false;
      if (sameGeometry(painted.current, geojson.features)) {
        geojson.features.forEach((f, i) => {
          const next = paintFor(f), previous = paintFor(painted.current[i]);
          if (Object.keys(next).some(k => next[k as keyof Paint] !== previous[k as keyof Paint])) {
            map.setFeatureState({ source: SOURCE, id: f.id }, next); changed = true;
          }
        });
      } else {
        changed = true;
        map.getSource(SOURCE)?.setData(geojson);
        // Reset retained feature-state because IDs can survive a source refresh.
        geojson.features.forEach(f => map.setFeatureState({ source: SOURCE, id: f.id }, paintFor(f)));
        const bounds = parcelBounds(geojson.features);
        if (bounds) map.fitBounds(bounds, { padding: 28, maxZoom: 16, duration: 0 });
      }
      painted.current = geojson.features;
      if (changed) {
        awaitingDraw.current = true; setMapState('drawing');
        if (drawTimeout.current !== null) window.clearTimeout(drawTimeout.current);
        drawTimeout.current = window.setTimeout(() => { awaitingDraw.current = false; setMapState('failed'); }, 20_000);
      }
    } catch { awaitingDraw.current = false; setMapState('failed'); }
  }, [geojson, mapState, hasGeometry]);

  return <section className="hn-subtle-panel overflow-hidden rounded-xl border border-purple-200 print:hidden" aria-label="Captured parcel selection map"
    data-selection-revision={group.binding.selectionRevision} data-freshness={freshness}>
    <div className="space-y-2 px-4 py-3">
      <h3 className="font-semibold">Captured parcel selection</h3>
      <p className="text-xs text-slate-600">Click a parcel to inspect its recorded CAD group. Outlines follow cached parcels, not legal subdivision or neighborhood boundaries.</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Selection colors">
        {([['Included observations', COLORS.included], ['Excluded observations', COLORS.excluded],
          ['Unresolved recorded group', COLORS.unresolved], ['Inspected group', COLORS.inspected], ['Subject parcel', COLORS.subject]] as const).map(([label, color]) =>
          <li key={label} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-3 w-3 rounded-sm border" style={{ backgroundColor: color }} />{label}</li>)}
      </ul>
      <p className="text-xs text-slate-600">Colors describe inclusion, not similarity or reliability. An included unresolved parcel has a green outline.</p>
      {freshness === 'stale' && <p role="status" className="text-sm text-amber-800">Showing the previous map and statistics together. The changed selection is not represented yet.</p>}
    </div>
    {!matches ? <p role="alert" className="p-4">Parcel groups belong to a different captured context. Reload the preview.</p>
      : !hasGeometry ? <p role="status" className="p-4">{group.parcel_map.status === 'unavailable'
        ? `Parcel map unavailable: ${group.parcel_map.reason}.` : 'No captured parcel outlines are available for this context.'} Statistics remain observation-only.</p>
      : <div className="relative">
        <div ref={container} className="h-[440px] min-h-80 w-full" role="region" aria-label="Interactive parcel map; use the recorded group list for keyboard selection" />
        {(mapState === 'loading' || mapState === 'drawing') && <p role="status" className="absolute inset-0 grid place-content-center bg-white p-4 text-sm">{mapState === 'drawing' ? 'Drawing the matching parcel selection…' : 'Loading parcel map…'}</p>}
        {mapState === 'failed' && <p role="alert" className="absolute inset-0 grid place-content-center bg-white p-4 text-sm">The map could not be displayed. Use the recorded group list; no substitute boundary has been drawn.</p>}
        {tileError && mapState === 'ready' && <p role="status" className="absolute bottom-3 left-3 rounded bg-white/95 p-2 text-xs">Some basemap resources could not load. Parcel selection and statistics are unchanged.</p>}
      </div>}
  </section>;
}
