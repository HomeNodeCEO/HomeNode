import { checkCustomCohortPrivateSales } from './customCohortPrivateSales.ts';
import { isCustomCohortPreviewCapacityError } from './customCohortPreviewTransport.ts';
import type { CheckedPrivateSalesObservations } from './customCohortPrivateSales';

/** Request lifecycle only: this never writes a workfile or authorizes report Apply.
 * The transport owner supplies the existing authenticated API boundary. */
export interface CustomCohortContextRef {
  readonly context_id: string; readonly context_revision: '1'; readonly context_sha256: string;
}
export interface CustomCohortPocket {
  readonly id: string; readonly label: string; readonly account_ids: readonly string[];
}
export interface CustomCohortPreviewInput {
  readonly accountId: string; readonly assignmentFileId: string; readonly contextRef: CustomCohortContextRef;
  readonly selection: { readonly revision: number; readonly pockets: readonly CustomCohortPocket[] };
}
export interface CustomCohortPreviewRequest extends CustomCohortPreviewInput { readonly include_map: boolean }
/** A single response delivered with this session's opening catalog. It must
 * pass the same response/fingerprint/map checks as a fresh preview request. */
export interface CustomCohortInitialResponse { readonly input: CustomCohortPreviewInput; readonly value: unknown }
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = Record<string, unknown>;
interface ParcelFeature {
  readonly type: 'Feature'; readonly id: string;
  readonly properties: { readonly object_id: string; readonly account_id: string; readonly selected: boolean };
  readonly geometry: { readonly type: 'Polygon' | 'MultiPolygon'; readonly coordinates: Json[] };
}
interface AvailableMap {
  readonly status: 'available'; readonly geometry_semantics: string;
  readonly geojson: { readonly type: 'FeatureCollection'; readonly features: readonly ParcelFeature[] };
  readonly counts: { readonly parcels: number; readonly accounts: number; readonly selected_accounts: number;
    readonly coordinates: number; readonly geometry_bytes: number; readonly geojson_bytes: number };
}
type ParcelMap = AvailableMap | { readonly status: 'unavailable'; readonly reason: string;
  readonly geojson: null; readonly geometry_semantics: string };
export interface CustomCohortPreviewBinding {
  readonly accountId: string; readonly assignmentFileId: string; readonly contextRef: CustomCohortContextRef;
  readonly selectionRevision: number; readonly selectionFingerprint: string;
}
export interface CustomCohortPreviewGroup {
  readonly binding: CustomCohortPreviewBinding;
  readonly summary: Readonly<Record<string, Json>>;
  readonly private_sales?: CheckedPrivateSalesObservations;
  readonly parcel_map: ParcelMap;
  readonly apply: { readonly status: 'blocked'; readonly reasons: readonly string[] };
}
export interface CustomCohortPreviewState {
  readonly status: 'idle' | 'debouncing' | 'loading' | 'ready' | 'failed' | 'disposed';
  readonly freshness: 'none' | 'current' | 'stale';
  readonly requested: CustomCohortPreviewInput | null;
  readonly group: CustomCohortPreviewGroup | null;
  readonly error: 'invalid_input' | 'request_failed' | 'request_timeout' | 'invalid_response' | 'capacity_exceeded' | null;
}
interface Options {
  transport: (request: CustomCohortPreviewRequest, options: { signal: AbortSignal }) => Promise<unknown>;
  timer: { set: (callback: () => void, delayMs: number) => unknown; clear: (handle: unknown) => void };
  debounceMs?: number;
  requestTimeoutMs?: number;
  /** Injectable for deterministic tests. Production uses Web Crypto SHA-256. */
  fingerprint?: (canonicalSelection: string) => Promise<string>;
  onChange?: (state: CustomCohortPreviewState) => void;
  initialResponse?: CustomCohortInitialResponse | null;
}
const L = { pockets: 128, accounts: 50_000, memberships: 100_000, selectionBytes: 3_900_000,
  summaryBytes: 2_000_000, summaryNodes: 150_000, mapBytes: 24_001_024, mapNodes: 3_500_000,
  features: 100_000, coordinates: 500_000, geojsonBytes: 24_000_000 };
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMANTICS = 'current_observed_cached_parcels_not_legal_subdivision_boundary';
const utf8 = new TextEncoder();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function ensure(ok: unknown): asserts ok { if (!ok) throw new TypeError('invalid_custom_cohort_preview'); }
function object(value: unknown): RecordValue {
  ensure(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  return value as RecordValue;
}
function exact(value: unknown, keys: string[], optional: string[] = []): RecordValue {
  const result = object(value); ensure(Object.keys(result).every(key => keys.includes(key) || optional.includes(key))
    && keys.every(key => Object.hasOwn(result, key)));
  return result;
}
function text(value: unknown, maximum: number): string {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value);
  for (let i = 0; i < value.length; i++) ensure(value.charCodeAt(i) >= 32 && value.charCodeAt(i) !== 127);
  return value;
}
function context(value: unknown): CustomCohortContextRef {
  const r = exact(value, ['context_id', 'context_revision', 'context_sha256']);
  ensure(UUID.test(text(r.context_id, 36)) && r.context_revision === '1' && HASH.test(text(r.context_sha256, 64)));
  return { context_id: r.context_id as string, context_revision: '1', context_sha256: r.context_sha256 as string };
}
function sameContext(a: CustomCohortContextRef, b: CustomCohortContextRef): boolean {
  return a.context_id === b.context_id && a.context_revision === b.context_revision && a.context_sha256 === b.context_sha256;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
/** Parser-owned JSON only. Bound the walk before copying; reject accessors,
 * cycles, non-finite values and oversized extensions, not just known fields. */
function copyJson(value: unknown, maxBytes: number, maxNodes: number): Json {
  const seen = new WeakSet<object>(); let nodes = 0, bytes = 0;
  const walk = (item: unknown, depth: number): void => {
    ensure(++nodes <= maxNodes && depth <= 24);
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      ensure(typeof item !== 'number' || Number.isFinite(item)); bytes += JSON.stringify(item).length;
    } else if (typeof item === 'string') {
      ensure(item.length <= maxBytes); bytes += utf8.encode(JSON.stringify(item)).length;
    } else {
      ensure(typeof item === 'object' && item !== null && !seen.has(item)); seen.add(item);
      const array = Array.isArray(item); if (!array) object(item);
      const keys = Object.keys(item); ensure(nodes + keys.length <= maxNodes);
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!; ensure(Object.hasOwn(descriptor, 'value'));
        if (!array) bytes += utf8.encode(JSON.stringify(key)).length + 1;
        ensure(bytes <= maxBytes); walk(descriptor.value, depth + 1);
      }
      if (array) ensure(keys.length === item.length && keys.every((key, i) => key === String(i)));
    }
    ensure(bytes <= maxBytes);
  };
  walk(value, 0); return JSON.parse(JSON.stringify(value)) as Json;
}
function prepare(value: unknown): { input: CustomCohortPreviewInput; selectionJson: string; key: string; target: string } {
  const r = exact(value, ['accountId', 'assignmentFileId', 'contextRef', 'selection']);
  const accountId = text(r.accountId, 64), assignmentFileId = text(r.assignmentFileId, 19);
  ensure(/^[1-9]\d{0,18}$/.test(assignmentFileId) && BigInt(assignmentFileId) <= 9223372036854775807n);
  const contextRef = context(r.contextRef), selection = exact(r.selection, ['revision', 'pockets']);
  ensure(Number.isSafeInteger(selection.revision) && Number(selection.revision) > 0
    && Array.isArray(selection.pockets) && selection.pockets.length <= L.pockets
    && Object.keys(selection.pockets).length === selection.pockets.length);
  let memberships = 0; const ids = new Set<string>();
  const pockets = selection.pockets.map(value => {
    const p = exact(value, ['id', 'label', 'account_ids']), id = text(p.id, 200), label = text(p.label, 200);
    ensure(!ids.has(id)); ids.add(id);
    ensure(Array.isArray(p.account_ids) && p.account_ids.length <= L.accounts
      && Object.keys(p.account_ids).length === p.account_ids.length);
    memberships += p.account_ids.length; ensure(memberships <= L.memberships);
    const account_ids = p.account_ids.map(id => text(id, 100));
    ensure(new Set(account_ids).size === account_ids.length);
    return { account_ids: account_ids.sort(compare), id, label };
  }).sort((a, b) => compare(a.id, b.id));
  const ordered = { pockets, revision: selection.revision as number }, selectionJson = JSON.stringify(ordered);
  ensure(utf8.encode(selectionJson).length <= L.selectionBytes);
  const input = freeze({ accountId, assignmentFileId, contextRef, selection: ordered });
  const target = JSON.stringify([accountId, assignmentFileId, contextRef]);
  return { input, selectionJson, target, key: `${target}\n${selectionJson}` };
}
async function fingerprint(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', utf8.encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function selectedAccounts(input: CustomCohortPreviewInput): Set<string> {
  return new Set(input.selection.pockets.flatMap(p => [...p.account_ids]));
}
function mapOf(value: unknown, selected: Set<string>): ParcelMap {
  const map = object(copyJson(value, L.mapBytes, L.mapNodes));
  ensure(map.geometry_semantics === SEMANTICS);
  if (map.status === 'unavailable') {
    exact(map, ['status', 'reason', 'geojson', 'geometry_semantics']); text(map.reason, 200); ensure(map.geojson === null);
    return freeze(map as unknown as ParcelMap);
  }
  exact(map, ['status', 'geojson', 'geometry_semantics', 'counts']); ensure(map.status === 'available');
  const geo = exact(map.geojson, ['type', 'features']);
  ensure(geo.type === 'FeatureCollection' && Array.isArray(geo.features) && geo.features.length <= L.features);
  const counts = exact(map.counts, ['parcels', 'accounts', 'selected_accounts', 'coordinates', 'geometry_bytes', 'geojson_bytes']);
  ensure(Object.values(counts).every(v => Number.isSafeInteger(v) && Number(v) >= 0));
  const accounts = new Set<string>(), features = new Set<string>(); let coordinates = 0;
  const polygon = (value: unknown) => {
    ensure(Array.isArray(value) && value.length > 0);
    for (const ring of value) {
      ensure(Array.isArray(ring) && ring.length >= 4);
      for (const point of ring) {
        ensure(++coordinates <= L.coordinates && Array.isArray(point) && point.length === 2
          && typeof point[0] === 'number' && typeof point[1] === 'number'
          && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90);
      }
      ensure(ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]);
    }
  };
  for (const raw of geo.features) {
    const f = exact(raw, ['type', 'id', 'properties', 'geometry']), props = exact(f.properties, ['object_id', 'account_id', 'selected']);
    const id = text(f.id, 100), account = text(props.account_id, 100), objectId = text(props.object_id, 30);
    ensure(f.type === 'Feature' && id === `gis.dcad_parcels:${objectId}` && !features.has(id)
      && props.selected === selected.has(account)); features.add(id); accounts.add(account);
    const geometry = exact(f.geometry, ['type', 'coordinates']);
    if (geometry.type === 'Polygon') polygon(geometry.coordinates);
    else {
      ensure(geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0);
      geometry.coordinates.forEach(polygon);
    }
  }
  ensure(accounts.size <= L.accounts && [...selected].every(id => accounts.has(id))
    && counts.parcels === features.size && counts.accounts === accounts.size && counts.selected_accounts === selected.size
    && counts.coordinates === coordinates && Number(counts.geojson_bytes) <= L.geojsonBytes && Number(counts.geometry_bytes) <= 16_000_000);
  return freeze(map as unknown as AvailableMap);
}
function restyle(map: AvailableMap, selected: Set<string>): AvailableMap {
  let byteChange = 0; const represented = new Set<string>();
  const features = map.geojson.features.map(feature => {
    const include = selected.has(feature.properties.account_id); represented.add(feature.properties.account_id);
    byteChange += Number(feature.properties.selected) - Number(include);
    return feature.properties.selected === include ? feature
      : freeze({ ...feature, properties: { ...feature.properties, selected: include } });
  });
  ensure([...selected].every(id => represented.has(id)) && map.counts.geojson_bytes + byteChange <= L.geojsonBytes);
  return freeze({ ...map, geojson: { ...map.geojson, features },
    counts: { ...map.counts, selected_accounts: selected.size, geojson_bytes: map.counts.geojson_bytes + byteChange } });
}
/** Inspection reuses the exact summary/target/content binding without requiring
 * a second parcel geometry download. This never admits geometry or report Apply. */
export function checkCustomCohortSummaryResponse(value: unknown, input: CustomCohortPreviewInput, hash: string) {
  prepare(input); ensure(HASH.test(hash));
  const r = exact(value, ['status', 'target', 'context_ref', 'selection_revision', 'subject_freshness', 'summary', 'parcel_map', 'apply'], ['private_sales']);
  const target = exact(r.target, ['account_id', 'assignment_file_id']);
  ensure(r.status === 'preview' && r.subject_freshness === 'matched' && target.account_id === input.accountId
    && target.assignment_file_id === input.assignmentFileId && sameContext(context(r.context_ref), input.contextRef)
    && r.selection_revision === input.selection.revision);
  const summary = object(copyJson(r.summary, L.summaryBytes, L.summaryNodes)), binding = exact(summary.binding,
    ['context_ref', 'selection_revision', 'selection_sha256']);
  ensure(summary.presentation_version === 1 && summary.preview_version === 1 && summary.status === 'observations_only'
    && summary.members_included === false && summary.contents === 'population_summaries_only'
    && sameContext(context(binding.context_ref), input.contextRef) && binding.selection_revision === input.selection.revision
    && binding.selection_sha256 === hash);
  const apply = exact(r.apply, ['status', 'reasons']), summaryApply = exact(summary.apply, ['status', 'reasons']);
  ensure(apply.status === 'blocked' && summaryApply.status === 'blocked' && Array.isArray(apply.reasons)
    && apply.reasons.length > 0 && apply.reasons.length <= 100 && Array.isArray(summaryApply.reasons)
    && summaryApply.reasons.length > 0 && summaryApply.reasons.length <= 100);
  apply.reasons.forEach(v => text(v, 200)); summaryApply.reasons.forEach(v => text(v, 200));
  const privateSales = Object.hasOwn(r, 'private_sales') ? checkCustomCohortPrivateSales(r.private_sales, input, hash) : null;
  if (privateSales) {
    const period = exact(summary.observation_period, ['start_date', 'end_date']);
    ensure(privateSales.effective_date === summary.effective_date && privateSales.observation_period.start_date === period.start_date
      && privateSales.observation_period.end_date === period.end_date);
  }
  return freeze({ binding: { accountId: input.accountId, assignmentFileId: input.assignmentFileId,
    contextRef: input.contextRef, selectionRevision: input.selection.revision, selectionFingerprint: hash },
  summary: summary as Record<string, Json>, apply: { status: 'blocked' as const, reasons: [...apply.reasons] as string[] },
  ...(privateSales ? { private_sales: privateSales } : {}) });
}

export async function fingerprintCustomCohortSelection(input: CustomCohortPreviewInput) {
  return fingerprint(prepare(input).selectionJson);
}

function accept(value: unknown, input: CustomCohortPreviewInput, hash: string, cached: AvailableMap | null,
  includeMap: boolean): CustomCohortPreviewGroup {
  const accepted = checkCustomCohortSummaryResponse(value, input, hash), r = object(value);
  const rawMap = object(r.parcel_map), selected = selectedAccounts(input); let parcelMap: ParcelMap;
  if (rawMap.status === 'omitted') {
    exact(rawMap, ['status', 'reason']); ensure(rawMap.reason === 'geometry_not_requested' && !includeMap && cached !== null);
    parcelMap = restyle(cached, selected);
  } else parcelMap = mapOf(rawMap, selected);
  return freeze({ ...accepted, parcel_map: parcelMap });
}

export function createCustomCohortPreviewController(options: Options) {
  const delay = options.debounceMs ?? 250, timeout = options.requestTimeoutMs ?? 65_000;
  ensure(Number.isFinite(delay) && delay >= 0 && delay <= 5000 && typeof options.transport === 'function'
    && Number.isFinite(timeout) && timeout > 0 && timeout <= 65_000
    && typeof options.timer.set === 'function' && typeof options.timer.clear === 'function');
  let state: CustomCohortPreviewState = freeze({ status: 'idle', freshness: 'none', requested: null, group: null, error: null });
  let generation = 0, timer: { handle: unknown } | null = null, abort: AbortController | null = null;
  let deadline: { handle: unknown } | null = null;
  let current: ReturnType<typeof prepare> | null = null, cached: AvailableMap | null = null;
  let initialResponse = options.initialResponse ?? null;
  const publish = (next: CustomCohortPreviewState) => {
    state = freeze(next);
    // A rendering observer cannot corrupt request ownership by throwing.
    try { options.onChange?.(state); } catch { /* The observer owns rendering error reporting. */ }
  };
  const cancel = () => {
    generation++;
    if (timer !== null) { options.timer.clear(timer.handle); timer = null; }
    if (deadline !== null) { options.timer.clear(deadline.handle); deadline = null; }
    abort?.abort(); abort = null;
  };
  const load = async (prepared: ReturnType<typeof prepare>, token: number) => {
    if (token !== generation || state.status === 'disposed') return;
    timer = null; const controller = new AbortController(); abort = controller;
    const isCurrent = () => token === generation && !controller.signal.aborted && state.status !== 'disposed';
    publish({ ...state, status: 'loading', error: null });
    let phase: 'request_failed' | 'invalid_response' = 'request_failed';
    try {
      if (!isCurrent()) return;
      deadline = { handle: options.timer.set(() => {
        if (!isCurrent()) return;
        generation++; deadline = null; controller.abort(); abort = null;
        publish({ ...state, status: 'failed', freshness: state.group === null ? 'none' : 'stale', error: 'request_timeout' });
      }, timeout) };
      const hash = await (options.fingerprint ?? fingerprint)(prepared.selectionJson);
      if (!isCurrent()) return; ensure(HASH.test(hash));
      const includeMap = cached === null;
      const opening = initialResponse; initialResponse = null;
      const response = opening && prepare(opening.input).key === prepared.key
        ? opening.value
        : await options.transport(freeze({ ...prepared.input, include_map: includeMap }), { signal: controller.signal });
      if (!isCurrent()) return;
      phase = 'invalid_response';
      const group = accept(response, prepared.input, hash, cached, includeMap);
      cached = group.parcel_map.status === 'available' ? group.parcel_map : null;
      if (deadline !== null) { options.timer.clear(deadline.handle); deadline = null; }
      abort = null; publish({ status: 'ready', freshness: 'current', requested: prepared.input, group, error: null });
    } catch (error) {
      if (!isCurrent()) return;
      if (deadline !== null) { options.timer.clear(deadline.handle); deadline = null; }
      abort = null; publish({ ...state, status: 'failed', freshness: state.group === null ? 'none' : 'stale',
        error: phase === 'request_failed' && isCustomCohortPreviewCapacityError(error) ? 'capacity_exceeded' : phase });
    }
  };
  return Object.freeze({
    getState: () => state,
    setSelection(value: CustomCohortPreviewInput | null): void {
      if (state.status === 'disposed') return;
      if (value === null) {
        cancel(); current = null; cached = null; initialResponse = null;
        publish({ status: 'idle', freshness: 'none', requested: null, group: null, error: null }); return;
      }
      let prepared: ReturnType<typeof prepare>;
      try { prepared = prepare(value); }
      catch {
        cancel(); current = null; cached = null; initialResponse = null;
        publish({ status: 'failed', freshness: 'none', requested: null, group: null, error: 'invalid_input' }); return;
      }
      // Identical renders, including after failure, never start implicit retries.
      if (current?.key === prepared.key) return;
      cancel(); const token = generation, sameTarget = current?.target === prepared.target;
      const previous = sameTarget ? state.group : null;
      if (!sameTarget) cached = null;
      current = prepared;
      timer = { handle: options.timer.set(() => { void load(prepared, token); }, delay) };
      publish({ status: 'debouncing', freshness: previous === null ? 'none' : 'stale', requested: prepared.input, group: previous, error: null });
    },
    dispose(): void {
      if (state.status === 'disposed') return;
      cancel(); current = null; cached = null; initialResponse = null;
      publish({ status: 'disposed', freshness: 'none', requested: null, group: null, error: null });
    },
  });
}
