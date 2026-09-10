import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { loadMapLibreRuntime, MAPLIBRE_BASE_STYLE } from '../../../lib/mapLibreRuntime';
import type { ParcelMapRuntimeInstance } from '../../../lib/mapLibreRuntime';
import NeighborhoodCityReferenceControl from '../../../components/NeighborhoodCityReferenceControl';
import { buildCustomCohortMapPresentation } from '../customCohortMapPresentation';
import type { CustomCohortMapScore } from '../customCohortMapPresentation';
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
const LABEL_SOURCE = 'custom-cohort-group-labels', LABEL_LAYER = `${LABEL_SOURCE}-text`;
const COLORS = { included: '#15803d', excluded: '#94a3b8', unresolved: '#d97706', inspected: '#eab308', subject: '#7e22ce' };
const SIMILARITY_COLORS = [['75–100', '#15803d'], ['50–<75', '#84cc16'], ['25–<50', '#eab308'], ['0–<25', '#ea580c'],
  ['Unknown / insufficient observations', '#94a3b8']] as const;
const EMPTY_LABELS = { type: 'FeatureCollection' as const, features: [] };
function similarityColor(score: CustomCohortMapScore | undefined) {
  if (!score || score.status !== 'available' || score.lower === null) return '#94a3b8';
  return score.lower >= 75 ? '#15803d' : score.lower >= 50 ? '#84cc16' : score.lower >= 25 ? '#eab308' : '#ea580c';
}
type AvailableMap = Extract<CustomCohortPreviewGroup['parcel_map'], { status: 'available' }>;
type Parcel = AvailableMap['geojson']['features'][number];
type Paint = { selected: boolean; inspected: boolean; unresolved: boolean; subject: boolean; fillColor: string };
type PaintedParcel = Parcel & { properties: Parcel['properties'] & Paint & { map_feature_id: string } };

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
function sameGeometry(previous: readonly Parcel[], next: readonly Parcel[]) {
  return previous.length === next.length && previous.every((f, i) => f.id === next[i].id
    && f.properties.account_id === next[i].properties.account_id && f.geometry === next[i].geometry);
}
const paintFor = (f: PaintedParcel): Paint => ({ selected: f.properties.selected, inspected: f.properties.inspected,
  unresolved: f.properties.unresolved, subject: f.properties.subject, fillColor: f.properties.fillColor });
const state = (key: keyof Paint) => ['coalesce', ['feature-state', key], ['get', key]];

/** Exact cached parcel outlines with optional existing group-level similarity.
 * View controls never change the accepted controller selection or statistics. */
export default function CustomCohortParcelMap({ group, catalog, freshness, inspectedPocketId,
  onInspectPocket, onInspectAccount }: Props) {
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<ParcelMapRuntimeInstance | null>(null);
  const painted = useRef<readonly PaintedParcel[]>([]);
  const paintedLabels = useRef(''), cityViewActive = useRef(false);
  const [cityMap, setCityMap] = useState<ParcelMapRuntimeInstance | null>(null);
  const [colorMode, setColorMode] = useState<'selection' | 'similarity'>('selection');
  const [showLabels, setShowLabels] = useState(true);
  const [mapState, setMapState] = useState<'loading' | 'drawing' | 'ready' | 'failed'>('loading');
  const awaitingDraw = useRef(false), drawTimeout = useRef<number | null>(null);
  const [tileError, setTileError] = useState(false);
  const matches = contextMatches(group, catalog);
  const presentationCache = useRef<{ group: CustomCohortPreviewGroup; catalog: CheckedPocketCatalog;
    value: ReturnType<typeof buildCustomCohortMapPresentation> | null } | null>(null);
  const presentation = useMemo(() => {
    const prior = presentationCache.current;
    // Selection-only controller changes can reuse immutable geometry and the
    // same catalog. Avoid scanning every ring again just to change inclusion.
    if (prior?.catalog === catalog && prior.group.binding.accountId === group.binding.accountId
      && prior.group.binding.assignmentFileId === group.binding.assignmentFileId
      && contextMatches(prior.group, catalog) && matches
      && prior.group.parcel_map.status === 'available' && group.parcel_map.status === 'available'
      && sameGeometry(prior.group.parcel_map.geojson.features, group.parcel_map.geojson.features)) return prior.value;
    let value: ReturnType<typeof buildCustomCohortMapPresentation> | null;
    try { value = buildCustomCohortMapPresentation({ group, catalog }); }
    catch { value = null; } // Optional presentation must not invent a score or hide the checked selection.
    presentationCache.current = { group, catalog, value }; return value;
  }, [group, catalog, matches]);
  const labels = showLabels && presentation?.status === 'available' ? presentation.labels : EMPTY_LABELS;
  const labelsKey = useMemo(() => JSON.stringify(labels), [labels]);
  const memberships = useMemo(() => {
    const index = new Map<string, string>();
    if (matches) {
      catalog.pockets.forEach(p => p.account_ids.forEach(account => index.set(account, p.id)));
      catalog.unassigned.account_ids.forEach(account => index.set(account, CUSTOM_COHORT_UNASSIGNED_GROUP));
    }
    return index;
  }, [catalog, matches]);
  const geojson = useMemo(() => ({ type: 'FeatureCollection' as const,
    features: group.parcel_map.status !== 'available' || !matches ? [] : group.parcel_map.geojson.features.map(f => {
      const pocket = memberships.get(f.properties.account_id);
      const unresolved = !pocket || pocket === CUSTOM_COHORT_UNASSIGNED_GROUP;
      return { ...f, properties: { ...f.properties, map_feature_id: f.id, unresolved,
        inspected: Boolean(inspectedPocketId && pocket === inspectedPocketId),
        subject: f.properties.account_id === group.binding.accountId,
        fillColor: colorMode === 'similarity' ? similarityColor(presentation?.status === 'available' && pocket ? presentation.scoresByGroup[pocket] : undefined)
          : unresolved ? COLORS.unresolved : f.properties.selected ? COLORS.included : COLORS.excluded },
      };
    }),
  }), [group, matches, memberships, inspectedPocketId, colorMode, presentation]);
  const latest = useRef({ geojson, labels, labelsKey, memberships, onInspectPocket, onInspectAccount });
  latest.current = { geojson, labels, labelsKey, memberships, onInspectPocket, onInspectAccount };
  const hasGeometry = matches && group.parcel_map.status === 'available' && geojson.features.length > 0;
  const ref = group.binding.contextRef;
  const contextKey = JSON.stringify([group.binding.accountId, group.binding.assignmentFileId,
    ref.context_id, ref.context_revision, ref.context_sha256]);

  useEffect(() => {
    if (!hasGeometry || !container.current) return;
    let disposed = false, loaded = false;
    let instance: ParcelMapRuntimeInstance | null = null;
    let observer: ResizeObserver | null = null;
    setMapState('loading'); setTileError(false); painted.current = []; paintedLabels.current = '';
    setCityMap(null); cityViewActive.current = false;
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
          // GeoJSON is tiled internally. Promote the exact string ID so runtime
          // feature-state updates survive the numeric vector-tile ID boundary.
          instance.addSource(SOURCE, { type: 'geojson', data, promoteId: 'map_feature_id' });
          instance.addLayer({ id: FILL, type: 'fill', source: SOURCE, paint: {
            'fill-color': state('fillColor'),
            'fill-opacity': ['case', state('selected'), 0.55, 0.2],
          } });
          instance.addLayer({ id: `${SOURCE}-outline`, type: 'line', source: SOURCE, paint: {
            'line-color': ['case', state('subject'), COLORS.subject, state('inspected'), COLORS.inspected,
              state('selected'), COLORS.included, state('unresolved'), COLORS.unresolved, COLORS.excluded],
            'line-width': ['case', state('subject'), 3, state('inspected'), 2.5, 0.75],
          } });
          instance.addSource(LABEL_SOURCE, { type: 'geojson', data: latest.current.labels });
          instance.addLayer({ id: LABEL_LAYER, type: 'symbol', source: LABEL_SOURCE, minzoom: 9,
            layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-max-width': 16,
              'text-anchor': 'left', 'text-offset': [0.5, 0], 'text-allow-overlap': false, 'text-optional': true },
            paint: { 'text-color': '#3b0764', 'text-halo-color': '#fff8e7', 'text-halo-width': 2 },
          });
          paintedLabels.current = latest.current.labelsKey;
          instance.on('click', FILL, event => {
            const account = event.features?.[0]?.properties?.account_id;
            if (disposed || typeof account !== 'string') return;
            const current = latest.current;
            // A label can extend over a different parcel. Its own listener wins
            // without opening that underlying account, regardless of listener order.
            if (event.point) {
              try {
                const labelHits = instance?.queryRenderedFeatures(event.point, { layers: [LABEL_LAYER] }) ?? [];
                if (labelHits.some(hit => current.labels.features.some(label => label.properties.pocket_id === hit.properties?.pocket_id))) return;
              } catch { return; }
            }
            const pocket = current.memberships.get(account);
            if (!pocket) return;
            current.onInspectPocket?.(pocket); current.onInspectAccount?.(account);
          });
          instance.on('mouseenter', FILL, () => { if (!disposed && instance) instance.getCanvas().style.cursor = 'pointer'; });
          instance.on('mouseleave', FILL, () => { if (!disposed && instance) instance.getCanvas().style.cursor = ''; });
          instance.on('click', LABEL_LAYER, event => {
            const pocket = event.features?.[0]?.properties?.pocket_id;
            if (disposed || typeof pocket !== 'string') return;
            const current = latest.current;
            if (current.labels.features.some(label => label.properties.pocket_id === pocket)) current.onInspectPocket?.(pocket);
          });
          instance.on('mouseenter', LABEL_LAYER, () => { if (!disposed && instance) instance.getCanvas().style.cursor = 'pointer'; });
          instance.on('mouseleave', LABEL_LAYER, () => { if (!disposed && instance) instance.getCanvas().style.cursor = ''; });
          const bounds = parcelBounds(data.features);
          if (bounds) instance.fitBounds(bounds, { padding: 28, maxZoom: 16, duration: 0 });
          painted.current = data.features; loaded = true; window.clearTimeout(timeout); setCityMap(instance);
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
      setCityMap(null); cityViewActive.current = false; paintedLabels.current = '';
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
            map.setFeatureState({ source: SOURCE, id: f.id }, next);
            // View-only recoloring/inspection does not cover the map with a saving/drawing overlay.
            changed ||= next.selected !== previous.selected || next.unresolved !== previous.unresolved || next.subject !== previous.subject;
          }
        });
      } else {
        changed = true;
        map.getSource(SOURCE)?.setData(geojson);
        // Reset retained feature-state because IDs can survive a source refresh.
        geojson.features.forEach(f => map.setFeatureState({ source: SOURCE, id: f.id }, paintFor(f)));
        const bounds = parcelBounds(geojson.features);
        if (bounds && !cityViewActive.current) map.fitBounds(bounds, { padding: 28, maxZoom: 16, duration: 0 });
      }
      painted.current = geojson.features;
      if (paintedLabels.current !== labelsKey) {
        map.getSource(LABEL_SOURCE)?.setData(labels); paintedLabels.current = labelsKey;
      }
      if (changed) {
        awaitingDraw.current = true; setMapState('drawing');
        if (drawTimeout.current !== null) window.clearTimeout(drawTimeout.current);
        drawTimeout.current = window.setTimeout(() => { awaitingDraw.current = false; setMapState('failed'); }, 20_000);
      }
    } catch { awaitingDraw.current = false; setMapState('failed'); }
  }, [geojson, labels, labelsKey, mapState, hasGeometry]);

  return <section className="hn-subtle-panel overflow-hidden rounded-xl border border-purple-200 print:hidden" aria-label="Captured parcel selection map"
    data-selection-revision={group.binding.selectionRevision} data-freshness={freshness}>
    <div className="space-y-2 px-4 py-3">
      <h3 className="font-semibold">Captured parcel selection</h3>
      <p className="text-xs text-slate-600">Click a parcel or subdivision label to inspect its recorded CAD group. Outlines follow cached parcels, not legal subdivision or neighborhood boundaries. Phases appear only when retained in the recorded name.</p>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="inline-flex items-center gap-2">Color parcels by
          <select aria-label="Map color mode" value={colorMode} disabled={!hasGeometry}
            onChange={event => { if (event.target.value === 'selection' || event.target.value === 'similarity') setColorMode(event.target.value); }}
            className="rounded-md border border-amber-300 bg-white px-2 py-1.5 text-violet-950">
            <option value="selection">Included / excluded</option><option value="similarity">Pocket similarity</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-2"><input type="checkbox" checked={showLabels} disabled={presentation?.status !== 'available'}
          onChange={event => setShowLabels(event.target.checked)} />Show recorded subdivision labels</label>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Selection colors">
        {([['Included observations', COLORS.included], ['Excluded observations', COLORS.excluded],
          ['Unresolved recorded group', COLORS.unresolved], ['Inspected group', COLORS.inspected], ['Subject parcel', COLORS.subject]] as const).map(([label, color]) =>
          <li key={label} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-3 w-3 rounded-sm border" style={{ backgroundColor: color }} />{label}</li>)}
      </ul>
      {colorMode === 'selection' ? <p className="text-xs text-slate-600">Colors describe inclusion, not similarity or reliability. An included unresolved parcel has a green outline.</p>
        : <>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Pocket similarity colors">
            {SIMILARITY_COLORS.map(([label, color]) => <li key={label} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-3 w-3 rounded-sm border" style={{ backgroundColor: color }} />{label}</li>)}
          </ul>
          <p className="text-xs text-slate-600">Fill colors show each recorded group's existing mean similarity lower bound (0–100), not an individual property's score or statistical reliability. Unknown factors are not treated as matches. Excluded parcels stay faint; outlines still show selection, the inspected group and subject.</p>
        </>}
      {matches && hasGeometry && presentation?.status !== 'available' && <p role="status" className="text-xs text-amber-800">Recorded labels and similarity colors are unavailable for this checked preview. The parcel selection is unchanged.</p>}
      {presentation?.unlabelled_group_ids.length ? <p className="text-xs text-slate-600">{presentation.unlabelled_group_ids.length} recorded groups have no retained parcel anchor for a label.</p> : null}
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
    <div className="px-4 pb-3"><NeighborhoodCityReferenceControl map={mapState === 'failed' ? null : cityMap}
      onViewChange={active => { if (cityMap && mapRef.current === cityMap && mapState !== 'failed') cityViewActive.current = active; }} /></div>
  </section>;
}
