import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { loadMapLibreRuntime, MAPLIBRE_BASE_STYLE } from '../../../lib/mapLibreRuntime';
import type { ParcelMapClick, ParcelMapRuntimeInstance } from '../../../lib/mapLibreRuntime';
import NeighborhoodCityReferenceControl from '../../../components/NeighborhoodCityReferenceControl';
import { buildCustomCohortMapPresentation } from '../customCohortMapPresentation';
import type { CustomCohortMapLabel, CustomCohortMapScore } from '../customCohortMapPresentation';
import { CUSTOM_COHORT_UNASSIGNED_GROUP } from '../customCohortPocketCatalog';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import type { CustomCohortPreviewGroup, CustomCohortPreviewState } from '../customCohortPreviewController';
import type { CustomCohortSubdivisionFamilies } from '../customCohortSubdivisionFamilies';
import { createCustomCohortSubdivisionPhaseReader } from '../customCohortSubdivisionFamilies';

interface Props {
  group: CustomCohortPreviewGroup;
  catalog: CheckedPocketCatalog;
  freshness: CustomCohortPreviewState['freshness'];
  inspectedPocketId?: string | null;
  inspectedPocketIds?: readonly string[];
  subdivisionFamilies?: CustomCohortSubdivisionFamilies;
  onActivatePocket?: (pocketId: string, mode: 'subdivision' | 'phase') => void;
  onExcludePocket?: (pocketId: string, mode: 'subdivision' | 'phase') => void;
  onInspectPocket?: (pocketId: string) => void;
  onInspectAccount?: (accountId: string) => void;
  overlay?: ReactNode;
}
const SOURCE = 'custom-cohort-parcels', FILL = 'custom-cohort-parcels-fill';
const LABEL_SOURCE = 'custom-cohort-group-labels', LABEL_LAYER = `${LABEL_SOURCE}-text`;
const SUBJECT_SOURCE = 'custom-cohort-subject-parcels', SUBJECT_LAYER = `${SUBJECT_SOURCE}-text`;
// A display/interaction threshold, not evidence of legal phase boundaries.
export const CUSTOM_COHORT_PHASE_ZOOM = 15;
type ActivationMode = 'subdivision' | 'phase';
type DisplayLabel = CustomCohortMapLabel & { readonly properties: CustomCohortMapLabel['properties'] & {
  readonly subdivision_label?: string;
  readonly phase_label?: string;
} };
function activationMode(map: ParcelMapRuntimeInstance | null): ActivationMode | null {
  try { const zoom = map?.getZoom(); return typeof zoom === 'number' && Number.isFinite(zoom)
    ? zoom < CUSTOM_COHORT_PHASE_ZOOM ? 'subdivision' : 'phase' : null; }
  catch { return null; }
}
function subdivisionLabels(labels: readonly CustomCohortMapLabel[], catalog: CheckedPocketCatalog,
  model: CustomCohortSubdivisionFamilies | undefined): readonly DisplayLabel[] {
  if (!model) return labels;
  const a = model.context_ref, b = catalog.binding.context_ref;
  if (model.profile_version !== 1 || a.context_id !== b.context_id || a.context_revision !== b.context_revision
    || a.context_sha256 !== b.context_sha256) return labels;
  const pockets = new Map(catalog.pockets.map(p => [p.id, p]));
  const anchors = new Map(labels.map(label => [label.properties.pocket_id, label]));
  const parents = new Map<string, string>(), phases = new Map<string, string>(), seen = new Set<string>();
  let readPhases: ReturnType<typeof createCustomCohortSubdivisionPhaseReader>;
  try { readPhases = createCustomCohortSubdivisionPhaseReader(catalog); }
  catch { return labels; }
  const chooseAnchor = (ids: readonly string[]) => ids.reduce<string | null>((chosen, id) =>
    anchors.has(id) && (chosen === null || pockets.get(id)!.member_count > pockets.get(chosen)!.member_count
      || (pockets.get(id)!.member_count === pockets.get(chosen)!.member_count && id < chosen)) ? id : chosen, null);
  for (const family of model.families) {
    for (const id of family.pocket_ids) {
      if (!pockets.has(id) || seen.has(id) || model.family_id_by_pocket_id[id] !== family.id) return labels;
      seen.add(id);
    }
    const chosen = chooseAnchor(family.pocket_ids);
    if (chosen !== null) parents.set(chosen, family.label);
    try {
      for (const phase of readPhases(family)) {
        const anchor = chooseAnchor(phase.pocket_ids);
        if (anchor !== null) phases.set(anchor, phase.label);
      }
    } catch { return labels; } // Optional view grouping cannot replace exact labels with a partial result.
  }
  if (seen.size !== pockets.size) return labels;
  // Keep the exact chosen child's retained point, account and parcel identity.
  // Both levels live in one source; renderer zoom expressions need no setData.
  return labels.map(label => ({ ...label, properties: { ...label.properties,
    subdivision_label: parents.get(label.properties.pocket_id) ?? '', phase_label: phases.get(label.properties.pocket_id) ?? '' } }));
}
function visibleLabel(label: DisplayLabel, mode: ActivationMode | null): boolean {
  const text = mode === 'phase' ? label.properties.phase_label : label.properties.subdivision_label;
  return mode !== null && (text === undefined || text.length > 0);
}
const COLORS = { included: '#dc2626', excluded: '#64748b', unresolved: '#d97706', inspected: '#eab308', subject: '#7e22ce' };
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
type SubjectMarker = { readonly type: 'Feature'; readonly id: string;
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
  readonly properties: { readonly subject_marker: true; readonly account_id: string; readonly parcel_id: string;
    readonly anchor_basis: 'retained_exterior_ring_vertex' } };
function subjectParcelMarkers(group: CustomCohortPreviewGroup, matches: boolean) {
  const features: SubjectMarker[] = [];
  if (matches && group.parcel_map.status === 'available') for (const parcel of group.parcel_map.geojson.features) {
    if (parcel.properties.account_id !== group.binding.accountId) continue;
    const shape = parcel.geometry.coordinates;
    const polygon = parcel.geometry.type === 'Polygon' ? shape : Array.isArray(shape) ? shape[0] : null;
    const ring = Array.isArray(polygon) ? polygon[0] : null, coordinates = Array.isArray(ring) ? ring[0] : null;
    if (!Array.isArray(coordinates) || coordinates.length !== 2) continue;
    const [x, y] = coordinates;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
      || Math.abs(x) > 180 || Math.abs(y) > 90) continue;
    features.push({ type: 'Feature', id: parcel.id, geometry: { type: 'Point', coordinates: [x, y] },
      properties: { subject_marker: true, account_id: group.binding.accountId, parcel_id: parcel.id,
        anchor_basis: 'retained_exterior_ring_vertex' } });
  }
  return { type: 'FeatureCollection' as const, features };
}

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
export default function CustomCohortParcelMap({ group, catalog, freshness, inspectedPocketId, inspectedPocketIds,
  subdivisionFamilies, onActivatePocket, onExcludePocket, onInspectPocket, onInspectAccount, overlay }: Props) {
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<ParcelMapRuntimeInstance | null>(null);
  const painted = useRef<readonly PaintedParcel[]>([]);
  const paintedLabels = useRef(''), cityViewActive = useRef(false);
  const paintedSubject = useRef('');
  const [cityMap, setCityMap] = useState<ParcelMapRuntimeInstance | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [displayMode, setDisplayMode] = useState<ActivationMode | null>(null);
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
  const labels = useMemo(() => showLabels && presentation?.status === 'available'
    ? { type: 'FeatureCollection' as const, features: subdivisionLabels(presentation.labels.features, catalog, subdivisionFamilies) }
    : EMPTY_LABELS, [showLabels, presentation, catalog, subdivisionFamilies]);
  const labelsKey = useMemo(() => JSON.stringify(labels), [labels]);
  const subjectMarkers = useMemo(() => subjectParcelMarkers(group, matches), [group, matches]);
  const subjectKey = useMemo(() => JSON.stringify(subjectMarkers), [subjectMarkers]);
  const subjectParcelIds = useMemo(() => new Set(subjectMarkers.features.map(marker => marker.properties.parcel_id)), [subjectMarkers]);
  const memberships = useMemo(() => {
    const index = new Map<string, string>();
    if (matches) {
      catalog.pockets.forEach(p => p.account_ids.forEach(account => index.set(account, p.id)));
      catalog.unassigned.account_ids.forEach(account => index.set(account, CUSTOM_COHORT_UNASSIGNED_GROUP));
    }
    return index;
  }, [catalog, matches]);
  const inspectedIds = useMemo(() => new Set(inspectedPocketIds ?? (inspectedPocketId ? [inspectedPocketId] : [])),
    [inspectedPocketIds, inspectedPocketId]);
  const geojson = useMemo(() => ({ type: 'FeatureCollection' as const,
    features: group.parcel_map.status !== 'available' || !matches ? [] : group.parcel_map.geojson.features.map(f => {
      const pocket = memberships.get(f.properties.account_id);
      const unresolved = !pocket || pocket === CUSTOM_COHORT_UNASSIGNED_GROUP;
      return { ...f, properties: { ...f.properties, map_feature_id: f.id, unresolved,
        inspected: Boolean(pocket && inspectedIds.has(pocket)),
        subject: f.properties.account_id === group.binding.accountId,
        fillColor: similarityColor(presentation?.status === 'available' && pocket ? presentation.scoresByGroup[pocket] : undefined) },
      };
    }),
  }), [group, matches, memberships, inspectedIds, presentation]);
  const latest = useRef({ geojson, labels, labelsKey, subjectMarkers, subjectKey, subjectParcelIds,
    memberships, onActivatePocket, onExcludePocket, onInspectPocket, onInspectAccount });
  latest.current = { geojson, labels, labelsKey, subjectMarkers, subjectKey, subjectParcelIds,
    memberships, onActivatePocket, onExcludePocket, onInspectPocket, onInspectAccount };
  const hasGeometry = matches && group.parcel_map.status === 'available' && geojson.features.length > 0;
  const ref = group.binding.contextRef;
  const contextKey = JSON.stringify([group.binding.accountId, group.binding.assignmentFileId,
    ref.context_id, ref.context_revision, ref.context_sha256]);

  useEffect(() => {
    if (!hasGeometry || !container.current) return;
    let disposed = false, loaded = false;
    let instance: ParcelMapRuntimeInstance | null = null;
    let observer: ResizeObserver | null = null;
    setMapState('loading'); setTileError(false); painted.current = []; paintedLabels.current = ''; paintedSubject.current = '';
    setCityMap(null); cityViewActive.current = false;
    setDisplayMode(null);
    const timeout = window.setTimeout(() => { if (!disposed && !loaded) setMapState('failed'); }, 20_000);
    const onResize = () => { if (!disposed) instance?.resize(); };
    void loadMapLibreRuntime().then(runtime => {
      if (disposed || !container.current) return;
      instance = new runtime.Map({ container: container.current, style: MAPLIBRE_BASE_STYLE,
        center: [0, 0], zoom: 1, attributionControl: true });
      mapRef.current = instance;
      // Camera motion only changes display copy. A click reads live zoom below.
      const updateDisplayMode = () => { if (!disposed) setDisplayMode(activationMode(instance)); };
      instance.on('zoom', updateDisplayMode); updateDisplayMode();
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
            'fill-opacity': ['case', state('selected'), 0.72, 0.38],
          } });
          instance.addLayer({ id: `${SOURCE}-outline`, type: 'line', source: SOURCE, paint: {
            'line-color': ['case', state('selected'), COLORS.included, state('inspected'), COLORS.inspected,
              state('subject'), COLORS.subject, state('unresolved'), COLORS.unresolved, COLORS.excluded],
            // Keep the appraiser's red inclusion outline even during inspection;
            // a thicker edge distinguishes the actively inspected included parcel.
            'line-width': ['case', ['all', state('selected'), state('inspected')], 4,
              state('selected'), 2.5, state('subject'), 2, state('inspected'), 2, 0.75],
          } });
          instance.addSource(LABEL_SOURCE, { type: 'geojson', data: latest.current.labels });
          instance.addLayer({ id: LABEL_LAYER, type: 'symbol', source: LABEL_SOURCE, minzoom: 9,
            // OpenFreeMap serves Noto Sans. MapLibre's implicit Open Sans/Arial
            // stack returns 404s here and forces repeated local glyph fallback.
            layout: { 'text-field': ['step', ['zoom'], ['coalesce', ['get', 'subdivision_label'], ['get', 'label']],
              CUSTOM_COHORT_PHASE_ZOOM, ['coalesce', ['get', 'phase_label'], ['get', 'label']]], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-max-width': 16,
              'text-anchor': 'left', 'text-offset': [0.5, 0], 'text-allow-overlap': false, 'text-optional': true },
            paint: { 'text-color': '#3b0764', 'text-halo-color': '#fff8e7', 'text-halo-width': 2 },
          });
          paintedLabels.current = latest.current.labelsKey;
          instance.addSource(SUBJECT_SOURCE, { type: 'geojson', data: latest.current.subjectMarkers });
          instance.addLayer({ id: SUBJECT_LAYER, type: 'symbol', source: SUBJECT_SOURCE,
            layout: { 'text-field': 'SUBJECT\n▼', 'text-font': ['Noto Sans Regular'], 'text-size': 12,
              'text-anchor': 'bottom', 'text-allow-overlap': true, 'text-ignore-placement': true },
            paint: { 'text-color': COLORS.subject, 'text-halo-color': '#fff8e7', 'text-halo-width': 2 },
          });
          paintedSubject.current = latest.current.subjectKey;
          const subjectHit = (properties: Readonly<Record<string, unknown>> | undefined) => properties?.subject_marker === true
            && typeof properties.parcel_id === 'string' && latest.current.subjectParcelIds.has(properties.parcel_id);
          const interactParcel = (event: ParcelMapClick, remove: boolean) => {
            if (remove) event.originalEvent?.preventDefault?.();
            const account = event.features?.[0]?.properties?.account_id;
            if (disposed || typeof account !== 'string') return;
            const current = latest.current, mode = activationMode(instance);
            if (mode === null) return;
            // A label can extend over a different parcel. Its own listener wins
            // without opening that underlying account, regardless of listener order.
            if (event.point) {
              try {
                const labelHits = instance?.queryRenderedFeatures(event.point, { layers: [SUBJECT_LAYER, LABEL_LAYER] }) ?? [];
                if (labelHits.some(hit => subjectHit(hit.properties) || current.labels.features.some(label => visibleLabel(label, mode)
                  && label.properties.pocket_id === hit.properties?.pocket_id))) return;
              } catch { return; }
            }
            const pocket = current.memberships.get(account);
            if (!pocket) return;
            if (remove) { current.onExcludePocket?.(pocket, mode); return; }
            if (current.onActivatePocket) current.onActivatePocket(pocket, mode);
            else current.onInspectPocket?.(pocket);
            current.onInspectAccount?.(account);
          };
          instance.on('click', FILL, event => interactParcel(event, false));
          instance.on('contextmenu', FILL, event => interactParcel(event, true));
          instance.on('mouseenter', FILL, () => { if (!disposed && instance) instance.getCanvas().style.cursor = 'pointer'; });
          instance.on('mouseleave', FILL, () => { if (!disposed && instance) instance.getCanvas().style.cursor = ''; });
          const interactLabel = (event: ParcelMapClick, remove: boolean) => {
            if (remove) event.originalEvent?.preventDefault?.();
            const pocket = event.features?.[0]?.properties?.pocket_id;
            if (disposed || typeof pocket !== 'string') return;
            const current = latest.current, mode = activationMode(instance);
            if (mode === null || !current.labels.features.some(label => visibleLabel(label, mode)
              && label.properties.pocket_id === pocket)) return;
            if (event.point) {
              try { if (instance?.queryRenderedFeatures(event.point, { layers: [SUBJECT_LAYER] }).some(hit => subjectHit(hit.properties))) return; }
              catch { return; }
            }
            if (remove) { current.onExcludePocket?.(pocket, mode); return; }
            if (current.onActivatePocket) current.onActivatePocket(pocket, mode);
            else current.onInspectPocket?.(pocket);
          };
          instance.on('click', LABEL_LAYER, event => interactLabel(event, false));
          instance.on('contextmenu', LABEL_LAYER, event => interactLabel(event, true));
          instance.on('mouseenter', LABEL_LAYER, () => { if (!disposed && instance) instance.getCanvas().style.cursor = 'pointer'; });
          instance.on('mouseleave', LABEL_LAYER, () => { if (!disposed && instance) instance.getCanvas().style.cursor = ''; });
          const interactSubject = (event: ParcelMapClick, remove: boolean) => {
            if (remove) event.originalEvent?.preventDefault?.();
            if (disposed || !subjectHit(event.features?.[0]?.properties)) return;
            const current = latest.current, mode = activationMode(instance);
            const marker = current.subjectMarkers.features.find(item => item.properties.parcel_id === event.features?.[0]?.properties?.parcel_id);
            const pocket = marker && current.memberships.get(marker.properties.account_id);
            if (mode === null || !pocket) return;
            if (remove) { current.onExcludePocket?.(pocket, mode); return; }
            if (current.onActivatePocket) current.onActivatePocket(pocket, mode);
            else current.onInspectPocket?.(pocket);
            current.onInspectAccount?.(marker.properties.account_id);
          };
          instance.on('click', SUBJECT_LAYER, event => interactSubject(event, false));
          instance.on('contextmenu', SUBJECT_LAYER, event => interactSubject(event, true));
          instance.on('mouseenter', SUBJECT_LAYER, () => { if (!disposed && instance) instance.getCanvas().style.cursor = 'pointer'; });
          instance.on('mouseleave', SUBJECT_LAYER, () => { if (!disposed && instance) instance.getCanvas().style.cursor = ''; });
          const bounds = parcelBounds(data.features);
          if (bounds) instance.fitBounds(bounds, { padding: 28, maxZoom: 16, duration: 0 });
          updateDisplayMode();
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
      setCityMap(null); cityViewActive.current = false; paintedLabels.current = ''; paintedSubject.current = '';
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
      if (paintedSubject.current !== subjectKey) {
        map.getSource(SUBJECT_SOURCE)?.setData(subjectMarkers); paintedSubject.current = subjectKey;
      }
      if (changed) {
        awaitingDraw.current = true; setMapState('drawing');
        if (drawTimeout.current !== null) window.clearTimeout(drawTimeout.current);
        drawTimeout.current = window.setTimeout(() => { awaitingDraw.current = false; setMapState('failed'); }, 20_000);
      }
    } catch { awaitingDraw.current = false; setMapState('failed'); }
  }, [geojson, labels, labelsKey, subjectMarkers, subjectKey, mapState, hasGeometry]);

  return <section className="hn-subtle-panel overflow-hidden rounded-xl border border-purple-200 print:hidden" aria-label="Captured parcel selection map"
    data-selection-revision={group.binding.selectionRevision} data-freshness={freshness}>
    <div className="space-y-2 px-4 py-3">
      <h3 className="font-semibold">Captured parcel selection</h3>
      <p className="text-xs text-slate-600">{onActivatePocket
        ? 'Click a subdivision or phase to include it and compare the updated statistics. Right-click to remove it. Zooming does not change your choices. '
        : 'Click a parcel or subdivision label to inspect its recorded CAD group. '}
        Shapes follow cached parcels, not legal subdivision or neighborhood boundaries.</p>
      {onActivatePocket && <p className="text-xs font-medium text-violet-900" role="status" data-map-interaction-mode={displayMode ?? 'unavailable'}>
        {displayMode === 'subdivision' ? 'Subdivision view: clicks include all captured related phases.'
          : displayMode === 'phase' ? 'Phase view: clicks include the selected phase.' : 'Map interaction is not ready.'}
        {' '}Related names are review groupings, not verified legal phases or coverage outside this capture.
      </p>}
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="inline-flex items-center gap-2"><input type="checkbox" checked={showLabels} disabled={presentation?.status !== 'available'}
          onChange={event => setShowLabels(event.target.checked)} />Show recorded subdivision labels</label>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Pocket similarity and inclusion colors">
        {SIMILARITY_COLORS.map(([label, color]) => <li key={label} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-3 w-3 rounded-sm border" style={{ backgroundColor: color }} />{label}</li>)}
        <li className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-3 w-3 rounded-sm border-[3px] bg-white" style={{ borderColor: COLORS.included }} />Included · red outline</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-3 w-3 rounded-sm border" style={{ borderColor: COLORS.subject }} />Subject pointer</li>
      </ul>
      <p className="text-xs text-slate-600">Fill reflects recorded-group similarity to the subject, not an individual parcel score or statistical reliability. Missing observations remain unknown.</p>
      {catalog.prepared_secondary_map && <p className="text-xs text-slate-600">Map colors include up to 10% supporting bedroom, bath, garage, pool and outbuilding similarity from the prepared CAD snapshot observed {new Date(catalog.prepared_secondary_map.source_observed_at).toLocaleString()}. This is current-recorded review support, not historical condition or a change to the report statistics.</p>}
      {matches && hasGeometry && !subjectMarkers.features.length && <p className="text-xs text-slate-600">Subject pointer unavailable because captured subject geometry is missing.</p>}
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
        {mapState !== 'failed' && overlay}
      </div>}
    <div className="px-4 pb-3"><NeighborhoodCityReferenceControl map={mapState === 'failed' ? null : cityMap}
      onViewChange={active => { if (cityMap && mapRef.current === cityMap && mapState !== 'failed') cityViewActive.current = active; }} /></div>
  </section>;
}
