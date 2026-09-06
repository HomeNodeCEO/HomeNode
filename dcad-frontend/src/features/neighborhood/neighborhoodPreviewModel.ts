/** Dormant display-only boundary. The host owns access/context; these checks
 * prove local data consistency only, never source authority or a report save. */
export const NEIGHBORHOOD_PREVIEW_LIMITS = Object.freeze({
  input_bytes: 1_000_000, output_bytes: 1_000_000, nodes: 50_000, depth: 24,
  populations: 100, pockets: 256, fields: 1_000, evidence: 1_000, review_items: 256,
  metrics: 1_000, references: 10_000, id_length: 300, label_length: 160, text_length: 5_000,
  outline_features: 256, outline_rings: 1_024, outline_points: 16_384,
});
type Support = 'supported' | 'unknown' | 'conflicting';
type Availability = 'available' | 'needs_review' | 'not_available';
export interface EvidencePreview {
  key: string; kind: 'geographic_neighborhood' | 'analysis_geography' | 'population' | 'statistic' | 'source';
  id: string | null; label: string; observation_text: string | null; support: Support; detail: string;
}
export interface MetricPreview {
  id: string; population_id: string; label: string; display_value: string | null;
  unit: string | null; estimator_label: string; status: Availability; evidence_keys: string[];
}
export interface PopulationPreview {
  id: string; role: 'geographic_stock' | 'competitive_stock' | 'sales_sample'; definition: string;
  member_count: number | null; unique_property_count: number | null; coverage_text: string | null;
  evidence_key: string; metrics: MetricPreview[];
}
export interface PocketPreview {
  id: string; label: string; disposition: 'recommended' | 'needs_review' | 'excluded';
  explanation: string; overlap_text: string | null; evidence_keys: string[];
}
export interface ProposedFieldPreview {
  id: string; label: string; disposition: 'new' | 'reused' | 'conflict' | 'unmapped' | 'empty_companion';
  proposed: { status: 'value' | 'not_proposed'; text: string | null };
  current: { status: 'known_empty' | 'known_value' | 'not_supplied'; text: string | null };
  explanation: string; evidence_keys: string[];
}
export interface ReviewItem { id: string; label: string; detail: string; blocks_review: boolean; evidence_keys: string[] }
export interface OutlinePreview {
  target_key: string; operation_key: string; preview_key: string; evidence_keys: string[];
  frame: [number, number, number, number];
  features: { id: string; role: 'subject' | 'neighborhood' | 'analysis_area' | 'pocket'; label: string;
    evidence_keys: string[]; polygons: [number, number][][][] }[];
}
export interface BoundaryPreview {
  neighborhood: { status: 'available' | 'not_available'; description: string | null; evidence_key: string | null };
  analysis_area: BoundaryPreview['neighborhood'];
  cardinals: Record<'north' | 'east' | 'south' | 'west', {
    status: 'supported' | 'needs_review' | 'not_available'; text: string | null; evidence_keys: string[];
  }>;
  outline_required_for_review: boolean; outline: OutlinePreview | null;
}
export interface PreviewDocument {
  target_key: string; operation_key: string; preview_key: string;
  origin: 'synthetic_fixture' | 'workflow_supplied'; workflow: 'custom_appraisal' | 'uad_3_6';
  subject_label: string; effective_date: string; observation_period: { start_date: string; end_date: string };
  data_cutoff: string; boundary: BoundaryPreview; populations: PopulationPreview[];
  pockets: PocketPreview[]; fields: ProposedFieldPreview[]; evidence: EvidencePreview[]; review_items: ReviewItem[];
}
interface CurrentContext {
  target_key: string | null; operation_key: string | null; preview_key: string | null;
  access: 'none' | 'inspect' | 'review'; read_only: boolean; dirty: boolean; spatial_review: 'clear' | 'required';
  actions: { refresh: boolean; open_review: boolean; edit_area: boolean };
}
interface Envelope { preview_version: 1; current: CurrentContext; load: 'empty' | 'loading' | 'failed' | 'complete'; preview: PreviewDocument | null }
type FailureCode = 'invalid_input' | 'input_limit' | 'structure_limit' | 'unsupported_version' | 'invalid_references' | 'output_limit';
export type PreparedNeighborhoodPreview =
  | { view_version: 1; phase: 'unavailable'; reason: FailureCode | 'access_unavailable' | 'target_changed' }
  | { view_version: 1; phase: 'loading' | 'empty' | 'error' }
  | { view_version: 1; phase: 'shown'; render_key: string; freshness: 'current' | 'stale'; read_only: boolean; dirty: boolean;
      spatial_blocked: boolean; review_blocked: boolean; outline_unavailable: boolean; document: PreviewDocument };
export type NeighborhoodPreviewIntent =
  | { type: 'refresh'; target_key: string; operation_key: string }
  | { type: 'inspect-pocket' | 'inspect-evidence'; target_key: string; operation_key: string; preview_key: string; item_key: string }
  | { type: 'review-group' | 'edit-area'; target_key: string; operation_key: string; preview_key: string };
interface GuardMetadata { envelope: Envelope; view: PreparedNeighborhoodPreview; evidence: Set<string>; pockets: Set<string> }
const admitted = new WeakMap<object, GuardMetadata>();
const L = NEIGHBORHOOD_PREVIEW_LIMITS;
class Invalid extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(code); this.code = code; }
}
const ensure = (condition: unknown, code: FailureCode = 'invalid_input'): void => { if (!condition) throw new Invalid(code); };

// Count incrementally; no encoded copy or reflection of an unknown object.
function bytes(value: string, maximum: number, failure: FailureCode): number {
  ensure(value.length <= maximum, failure);
  let total = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) total++;
    else if (code < 0x800) total += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      ensure(next >= 0xdc00 && next <= 0xdfff);
      total += 4;
    } else { ensure(code < 0xdc00 || code > 0xdfff); total += 3; }
    ensure(total <= maximum, failure);
  }
  return total;
}
function structure(value: unknown, failure: FailureCode = 'structure_limit'): void {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0, references = 0;
  while (stack.length) {
    const item = stack.pop()!;
    ensure(++visited <= L.nodes && item.depth <= L.depth, failure);
    if (typeof item.value === 'string') bytes(item.value, L.input_bytes, failure);
    if (typeof item.value === 'number') ensure(Number.isFinite(item.value));
    if (item.value && typeof item.value === 'object') {
      // Charge the entire parsed envelope before optional-outline isolation.
      // Invalid/early-exit geometry must not hide later reference occurrences.
      const object = item.value as Record<string, unknown>;
      if (Array.isArray(object.evidence_keys)) references += object.evidence_keys.length;
      if (Object.hasOwn(object, 'evidence_key') && object.evidence_key !== null) references++;
      ensure(references <= L.references, failure);
      const children = Object.values(item.value);
      ensure(visited + stack.length + children.length <= L.nodes, failure);
      if (children.length) ensure(item.depth < L.depth, failure);
      for (let i = children.length - 1; i >= 0; i--) stack.push({ value: children[i], depth: item.depth + 1 });
    }
  }
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  ensure(actual.length === keys.length && keys.every(key => Object.hasOwn(object, key)));
  return object;
}
function list(value: unknown, maximum: number): unknown[] {
  ensure(Array.isArray(value) && value.length <= maximum, 'structure_limit'); return value as unknown[];
}
function text(value: unknown, maximum: number = L.text_length, nullable = false): void {
  if (nullable && value === null) return;
  ensure(typeof value === 'string' && value.length > 0 && value.length <= maximum);
}
const id = (value: unknown, nullable = false) => {
  text(value, L.id_length, nullable);
  if (value !== null) ensure(typeof value === 'string' && value.trim() === value);
};
const label = (value: unknown) => text(value, L.label_length);
const bool = (value: unknown) => ensure(typeof value === 'boolean');
const oneOf = (value: unknown, options: string[]) => ensure(typeof value === 'string' && options.includes(value));
function count(value: unknown): void { ensure(value === null || (Number.isSafeInteger(value) && Number(value) >= 0)); }
function date(value: unknown): void {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  const parsed = new Date(`${value}T00:00:00.000Z`);
  ensure(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value);
}
function unique(value: unknown, seen: Set<string>): void { id(value); ensure(!seen.has(value as string)); seen.add(value as string); }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
function context(value: unknown): void {
  const r = record(value, ['target_key', 'operation_key', 'preview_key', 'access', 'read_only', 'dirty', 'spatial_review', 'actions']);
  for (const key of ['target_key', 'operation_key', 'preview_key']) id(r[key], true);
  oneOf(r.access, ['none', 'inspect', 'review']); bool(r.read_only); bool(r.dirty); oneOf(r.spatial_review, ['clear', 'required']);
  const actions = record(r.actions, ['refresh', 'open_review', 'edit_area']); Object.values(actions).forEach(bool);
  if (r.access !== 'none') { id(r.target_key); id(r.operation_key); }
}
function documentOf(value: unknown): { document: PreviewDocument; outlineUnavailable: boolean } {
  const d = record(value, ['target_key', 'operation_key', 'preview_key', 'origin', 'workflow', 'subject_label', 'effective_date',
    'observation_period', 'data_cutoff', 'boundary', 'populations', 'pockets', 'fields', 'evidence', 'review_items']);
  for (const key of ['target_key', 'operation_key', 'preview_key']) id(d[key]);
  oneOf(d.origin, ['synthetic_fixture', 'workflow_supplied']); oneOf(d.workflow, ['custom_appraisal', 'uad_3_6']); label(d.subject_label);
  date(d.effective_date); date(d.data_cutoff);
  const period = record(d.observation_period, ['start_date', 'end_date']); date(period.start_date); date(period.end_date);
  ensure(String(period.start_date) <= String(period.end_date));
  const registry = new Set<string>();
  for (const item of list(d.evidence, L.evidence)) {
    const e = record(item, ['key', 'kind', 'id', 'label', 'observation_text', 'support', 'detail']);
    unique(e.key, registry); label(e.label); text(e.observation_text, L.text_length, true); text(e.detail);
    oneOf(e.kind, ['geographic_neighborhood', 'analysis_geography', 'population', 'statistic', 'source']);
    oneOf(e.support, ['supported', 'unknown', 'conflicting']);
    if (['geographic_neighborhood', 'analysis_geography'].includes(String(e.kind))) ensure(e.id === null && e.key === e.kind);
    else { id(e.id); ensure(e.key === `${e.kind}:${e.id}`); }
  }
  let referenceCount = 0;
  function refs(value: unknown): void {
    const entries = list(value, L.references); referenceCount += entries.length;
    ensure(referenceCount <= L.references, 'structure_limit');
    const seen = new Set<string>();
    for (const key of entries) { id(key); ensure(registry.has(key as string) && !seen.has(key as string), 'invalid_references'); seen.add(key as string); }
  }
  const b = record(d.boundary, ['neighborhood', 'analysis_area', 'cardinals', 'outline_required_for_review', 'outline']);
  for (const key of ['neighborhood', 'analysis_area']) {
    const area = record(b[key], ['status', 'description', 'evidence_key']);
    oneOf(area.status, ['available', 'not_available']);
    text(area.description, L.text_length, true); id(area.evidence_key, true);
    if (area.status === 'available') { text(area.description); refs([area.evidence_key]); }
    else ensure(area.description === null && area.evidence_key === null);
  }
  const cardinals = record(b.cardinals, ['north', 'east', 'south', 'west']);
  for (const item of Object.values(cardinals)) {
    const c = record(item, ['status', 'text', 'evidence_keys']); oneOf(c.status, ['supported', 'needs_review', 'not_available']);
    text(c.text, L.text_length, true); refs(c.evidence_keys); if (c.status === 'supported') text(c.text);
  }
  bool(b.outline_required_for_review);
  let metricCount = 0; const metrics = new Set<string>(); const populations = new Set<string>();
  for (const item of list(d.populations, L.populations)) {
    const p = record(item, ['id', 'role', 'definition', 'member_count', 'unique_property_count', 'coverage_text', 'evidence_key', 'metrics']);
    unique(p.id, populations); oneOf(p.role, ['geographic_stock', 'competitive_stock', 'sales_sample']); text(p.definition);
    count(p.member_count); count(p.unique_property_count); text(p.coverage_text, L.text_length, true);
    ensure(p.evidence_key === `population:${p.id}`, 'invalid_references'); refs([p.evidence_key]);
    const rows = list(p.metrics, L.metrics); metricCount += rows.length; ensure(metricCount <= L.metrics, 'structure_limit');
    for (const item of rows) {
      const m = record(item, ['id', 'population_id', 'label', 'display_value', 'unit', 'estimator_label', 'status', 'evidence_keys']);
      unique(m.id, metrics); ensure(m.population_id === p.id, 'invalid_references'); label(m.label); label(m.estimator_label);
      text(m.display_value, L.text_length, true); text(m.unit, L.label_length, true); oneOf(m.status, ['available', 'needs_review', 'not_available']);
      if (m.status === 'available') text(m.display_value); refs(m.evidence_keys);
    }
  }
  const pockets = new Set<string>();
  for (const item of list(d.pockets, L.pockets)) {
    const p = record(item, ['id', 'label', 'disposition', 'explanation', 'overlap_text', 'evidence_keys']);
    unique(p.id, pockets); label(p.label); oneOf(p.disposition, ['recommended', 'needs_review', 'excluded']);
    text(p.explanation); text(p.overlap_text, L.text_length, true); refs(p.evidence_keys);
  }
  const fields = new Set<string>();
  for (const item of list(d.fields, L.fields)) {
    const f = record(item, ['id', 'label', 'disposition', 'proposed', 'current', 'explanation', 'evidence_keys']);
    unique(f.id, fields); label(f.label); oneOf(f.disposition, ['new', 'reused', 'conflict', 'unmapped', 'empty_companion']);
    text(f.explanation); refs(f.evidence_keys);
    const proposed = record(f.proposed, ['status', 'text']); oneOf(proposed.status, ['value', 'not_proposed']);
    const current = record(f.current, ['status', 'text']); oneOf(current.status, ['known_empty', 'known_value', 'not_supplied']);
    if (proposed.status === 'value') text(proposed.text); else ensure(proposed.text === null);
    if (current.status === 'known_value') text(current.text); else ensure(current.text === null);
    if (f.disposition === 'empty_companion') ensure(proposed.status === 'not_proposed');
    if (f.disposition === 'new' || f.disposition === 'reused') ensure(proposed.status === 'value');
  }
  const reviews = new Set<string>();
  for (const item of list(d.review_items, L.review_items)) {
    const r = record(item, ['id', 'label', 'detail', 'blocks_review', 'evidence_keys']);
    unique(r.id, reviews); label(r.label); text(r.detail); bool(r.blocks_review); refs(r.evidence_keys);
  }
  let outlineUnavailable = b.outline === null;
  if (b.outline !== null) {
    try { outlineOf(b.outline, d, refs); }
    catch { b.outline = null; outlineUnavailable = true; }
    // An outline failure may not evade the whole-document reference allowance.
    ensure(referenceCount <= L.references, 'structure_limit');
  }
  return { document: d as unknown as PreviewDocument, outlineUnavailable };
}

function outlineOf(value: unknown, d: Record<string, unknown>, refs: (value: unknown) => void): void {
  const o = record(value, ['target_key', 'operation_key', 'preview_key', 'evidence_keys', 'frame', 'features']);
  for (const key of ['target_key', 'operation_key', 'preview_key']) ensure(o[key] === d[key]);
  refs(o.evidence_keys);
  const frame = list(o.frame, 4); ensure(frame.length === 4 && frame.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000));
  const [x0, y0, x1, y1] = frame as number[]; ensure(x1 - x0 >= 0.001 && y1 - y0 >= 0.001);
  let rings = 0, points = 0; const ids = new Set<string>();
  const features = list(o.features, L.outline_features); ensure(features.length > 0);
  for (const item of features) {
    const f = record(item, ['id', 'role', 'label', 'evidence_keys', 'polygons']);
    unique(f.id, ids); oneOf(f.role, ['subject', 'neighborhood', 'analysis_area', 'pocket']); label(f.label); refs(f.evidence_keys);
    const polygons = list(f.polygons, L.outline_rings); ensure(polygons.length > 0);
    for (const polygon of polygons) {
      const polygonRings = list(polygon, L.outline_rings); ensure(polygonRings.length > 0);
      rings += polygonRings.length; ensure(rings <= L.outline_rings);
      for (const ring of polygonRings) {
        const ringPoints = list(ring, L.outline_points); points += ringPoints.length;
        ensure(ringPoints.length >= 4 && points <= L.outline_points);
        for (const point of ringPoints) {
          const pair = list(point, 2); ensure(pair.length === 2);
          ensure(typeof pair[0] === 'number' && Number.isFinite(pair[0]) && pair[0] >= x0 && pair[0] <= x1);
          ensure(typeof pair[1] === 'number' && Number.isFinite(pair[1]) && pair[1] >= y0 && pair[1] <= y1);
        }
        const first = ringPoints[0] as number[], last = ringPoints[ringPoints.length - 1] as number[];
        ensure(first[0] === last[0] && first[1] === last[1]);
      }
    }
  }
}

/** Only primitive, bounded JSON enters; no arbitrary caller object is reflected. */
export function prepareNeighborhoodPreview(envelopeJson: unknown): PreparedNeighborhoodPreview {
  try {
    ensure(typeof envelopeJson === 'string');
    bytes(envelopeJson as string, L.input_bytes, 'input_limit');
    const parsed: unknown = JSON.parse(envelopeJson as string);
    structure(parsed); ensure(JSON.stringify(parsed) === envelopeJson);
    const input = record(parsed, ['preview_version', 'current', 'load', 'preview']);
    ensure(input.preview_version === 1, 'unsupported_version'); context(input.current);
    oneOf(input.load, ['empty', 'loading', 'failed', 'complete']);
    const envelope = input as unknown as Envelope;
    let view: PreparedNeighborhoodPreview;
    if (envelope.current.access === 'none') view = { view_version: 1, phase: 'unavailable', reason: 'access_unavailable' };
    else if (envelope.load !== 'complete') view = { view_version: 1, phase: envelope.load === 'failed' ? 'error' : envelope.load };
    else if (envelope.preview === null) view = { view_version: 1, phase: 'empty' };
    else {
      // Inspect only parser-owned identity before preparing private display data.
      const candidate = envelope.preview as unknown;
      ensure(candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate));
      if ((candidate as Record<string, unknown>).target_key !== envelope.current.target_key) {
        view = { view_version: 1, phase: 'unavailable', reason: 'target_changed' };
      } else {
        id(envelope.current.preview_key);
        const { document, outlineUnavailable } = documentOf(candidate);
        const fresh = document.operation_key === envelope.current.operation_key && document.preview_key === envelope.current.preview_key;
        const spatialBlocked = envelope.current.spatial_review !== 'clear' || (document.boundary.outline_required_for_review && outlineUnavailable);
        // Retained stale evidence must not retain disclosure state when the
        // controller rotates. Tuple encoding also avoids opaque-ID collisions.
        const renderKey = JSON.stringify([
          [envelope.current.target_key, envelope.current.operation_key, envelope.current.preview_key],
          [document.target_key, document.operation_key, document.preview_key],
        ]);
        view = { view_version: 1, phase: 'shown', render_key: renderKey, freshness: fresh ? 'current' : 'stale', read_only: envelope.current.read_only || envelope.current.access !== 'review',
          dirty: envelope.current.dirty, spatial_blocked: spatialBlocked,
          review_blocked: document.fields.some(f => f.disposition === 'conflict') || document.review_items.some(r => r.blocks_review),
          outline_unavailable: outlineUnavailable, document };
      }
    }
    structure(view, 'output_limit'); bytes(JSON.stringify(view), L.output_bytes, 'output_limit');
    const owned = deepFreeze(view);
    admitted.set(owned, { envelope: deepFreeze(envelope), view: owned,
      evidence: new Set(view.phase === 'shown' ? view.document.evidence.map(e => e.key) : []),
      pockets: new Set(view.phase === 'shown' ? view.document.pockets.map(p => p.id) : []) });
    return owned;
  } catch (error) {
    return Object.freeze({ view_version: 1, phase: 'unavailable', reason: error instanceof Invalid ? error.code : 'invalid_input' });
  }
}

/** Local correlation/UX guard only. The receiving host must recheck its latest
 * operation context; this intent never authorizes a server action. */
export function createNeighborhoodPreviewIntent(prepared: unknown, type: unknown, itemKey?: unknown): NeighborhoodPreviewIntent | null {
  if (prepared === null || typeof prepared !== 'object' || typeof type !== 'string') return null;
  const meta = admitted.get(prepared); if (!meta) return null;
  const { envelope, view } = meta, current = envelope.current;
  if (current.access === 'none' || !current.target_key || !current.operation_key || view.phase === 'unavailable') return null;
  if (type === 'refresh') {
    if (itemKey !== undefined || envelope.load === 'loading' || current.dirty || !current.actions.refresh) return null;
    return Object.freeze({ type, target_key: current.target_key, operation_key: current.operation_key });
  }
  if (view.phase !== 'shown' || view.freshness !== 'current' || !current.preview_key) return null;
  const binding = { target_key: current.target_key, operation_key: current.operation_key, preview_key: current.preview_key };
  if (type === 'inspect-pocket' || type === 'inspect-evidence') {
    if (typeof itemKey !== 'string' || !(type === 'inspect-pocket' ? meta.pockets : meta.evidence).has(itemKey)) return null;
    return Object.freeze({ type, ...binding, item_key: itemKey });
  }
  if (itemKey !== undefined || current.access !== 'review' || current.read_only || current.dirty) return null;
  if (type === 'review-group' && current.actions.open_review && !view.spatial_blocked && !view.review_blocked) return Object.freeze({ type, ...binding });
  if (type === 'edit-area' && current.actions.edit_area) return Object.freeze({ type, ...binding });
  return null;
}
