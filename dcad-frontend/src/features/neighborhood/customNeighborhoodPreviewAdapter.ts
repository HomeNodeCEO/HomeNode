import { formatNeighborhoodAssessmentDisplay } from './neighborhoodAssessmentDisplay';
import { createNeighborhoodPreviewIntent, prepareNeighborhoodPreview } from './neighborhoodPreviewModel';
import type { EvidencePreview, NeighborhoodPreviewIntent, PreparedNeighborhoodPreview, PreviewDocument, ReviewItem } from './neighborhoodPreviewModel';

/** Inactive inspection composition only. The owner must supply an authorized
 * request-start binding and recheck current host state when receiving an intent.
 * Matching strings establish consistency, never publication or source authority. */
type Failure = 'invalid_input' | 'input_limit' | 'structure_limit' | 'unsupported_version'
  | 'binding_unavailable' | 'binding_mismatch' | 'invalid_assessment' | 'unsupported_records'
  | 'invalid_references' | 'display_capacity';
type ObjectValue = Record<string, unknown>;
type Correlation = Pick<PreviewDocument, 'target_key' | 'operation_key' | 'preview_key'>;
type Scope = { organization_id: string; appraisal_case_id: string; subject_snapshot_id: string; account_id: string };
type DateBasis = 'closing_date' | 'contract_date' | 'status_as_of' | 'effective_date';
type Period = { start_date: string; end_date: string; date_basis: DateBasis };
type Reference = { id: string; revision: number; evidence_digest_sha256: string };
interface Expected {
  request_context: Correlation; assignment_file_id: number; account_id: string; workfile_key: string;
  scope: Scope; assessment_reference: Reference; effective_date: string; data_cutoff: string; observation_period: Period;
}
interface Current {
  target_key: string | null; operation_key: string | null; preview_key: string | null;
  access: 'none' | 'inspect' | 'review'; read_only: boolean; dirty: boolean; spatial_review: 'clear' | 'required';
  actions: { refresh: boolean; open_review: boolean; edit_area: boolean };
}
interface Controller {
  custom_inspection_version: 1; current: Current; load: 'empty' | 'loading' | 'failed' | 'complete';
  subject_label: string | null; expected: Expected | null;
}
type Result = Readonly<{ status: 'ready'; envelopeJson: string }> | Readonly<{ status: 'unavailable'; reason: Failure }>;
interface Built { result: Extract<Result, { status: 'ready' }>; prepared: PreparedNeighborhoodPreview; intent: ObjectValue | null }

const L = { bytes: 1_000_000, nodes: 50_000, depth: 24, references: 10_000,
  controller_bytes: 16_384, controller_nodes: 2_048, controller_depth: 8,
  intent_bytes: 8_192, intent_nodes: 32, intent_depth: 2, text: 5_000, evidence: 1_000, reviews: 256 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const CORRELATION = ['target_key', 'operation_key', 'preview_key'] as const;
const SCOPE_KEYS = ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'] as const;
const PERIOD_KEYS = ['start_date', 'end_date', 'date_basis'] as const;
const REFERENCE_KEYS = ['id', 'revision', 'evidence_digest_sha256'] as const;
const STATES = ['ready', 'incomplete', 'unsupported'] as const;
const BASIS = { closing_date: 'closing date', contract_date: 'contract date', status_as_of: 'status as of', effective_date: 'effective date' };
const ARRAY_REFS = new Set(['source_refs', 'required_population_ids', 'required_statistic_ids', 'population_refs',
  'pocket_ids', 'required_evidence_keys', 'evidence_keys']);
const SCALAR_REFS = new Set(['population_id', 'members_resource_id', 'pocket_id', 'evidence_key']);
const faults = new WeakMap<object, Failure>();
function ensure(condition: unknown, reason: Failure = 'invalid_input'): asserts condition {
  if (!condition) { const error = new Error(); faults.set(error, reason); throw error; }
}

// Incremental UTF-8 admission, also used for the escaped public string wrapper.
function bytes(value: string, maximum: number, reason: Failure, quoted = false): number {
  ensure(value.length <= maximum, reason);
  let size = quoted ? 2 : 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (quoted && (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code))) size += 2;
    else if (quoted && code < 32) size += 6;
    else if (code < 128) size++;
    else if (code < 2048) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i); ensure(next >= 0xdc00 && next <= 0xdfff); size += 4;
    } else { ensure(code < 0xdc00 || code > 0xdfff); size += 3; }
    ensure(size <= maximum, reason);
  }
  ensure(size <= maximum, reason); return size;
}
interface Budget { bytes: number; nodes: number; references: number }
/** Parser-owned/generated values only. Unknown extension subtrees and malformed
 * reference occurrences are charged before any display-bearing semantic path. */
function inspect(value: unknown, reason: Failure, maxNodes: number = L.nodes, maxDepth: number = L.depth): Budget {
  const stack = [{ value, depth: 0 }];
  let size = 0, nodes = 0, references = 0;
  while (stack.length) {
    const item = stack.pop()!;
    ensure(++nodes <= maxNodes && item.depth <= maxDepth, reason);
    if (item.value === null) size += 4;
    else if (typeof item.value === 'string') size += bytes(item.value, L.bytes, reason, true);
    else if (typeof item.value === 'number') { ensure(Number.isFinite(item.value)); size += String(item.value).length; }
    else if (typeof item.value === 'boolean') size += item.value ? 4 : 5;
    else {
      ensure(typeof item.value === 'object' && item.value !== null);
      const array = Array.isArray(item.value), entries = Object.entries(item.value);
      ensure(nodes + stack.length + entries.length <= maxNodes, reason);
      if (entries.length) ensure(item.depth < maxDepth, reason);
      size += 2 + Math.max(0, entries.length - 1);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        if (!array) {
          size += bytes(key, L.bytes, reason, true) + 1;
          if (ARRAY_REFS.has(key) && Array.isArray(child)) references += child.length;
          if (SCALAR_REFS.has(key) && child !== null) references++;
          ensure(references <= L.references, reason);
        }
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
    ensure(size <= L.bytes, reason);
  }
  return { bytes: size, nodes, references };
}
function object(value: unknown, reason: Failure = 'invalid_input'): ObjectValue {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), reason); return value as ObjectValue;
}
function record(value: unknown, keys: readonly string[], reason: Failure = 'invalid_input'): ObjectValue {
  const r = object(value, reason), actual = Object.keys(r);
  ensure(actual.length === keys.length && keys.every(key => Object.hasOwn(r, key)), reason); return r;
}
function text(value: unknown, maximum = 200, reason: Failure = 'invalid_input'): string {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value, reason);
  for (let i = 0; i < value.length; i++) ensure(value.charCodeAt(i) >= 32 && value.charCodeAt(i) !== 127, reason);
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], reason: Failure = 'invalid_input'): T {
  ensure(typeof value === 'string' && values.includes(value as T), reason); return value as T;
}
function integer(value: unknown, reason: Failure = 'invalid_input'): number {
  ensure(Number.isSafeInteger(value) && Number(value) > 0, reason); return value as number;
}
function digest(value: unknown, reason: Failure = 'invalid_input'): string {
  const result = text(value, 64, reason); ensure(HASH.test(result), reason); return result;
}
function uuid(value: unknown, reason: Failure = 'invalid_input'): string {
  const result = text(value, 36, reason); ensure(UUID.test(result), reason); return result;
}
function date(value: unknown, reason: Failure = 'invalid_input'): string {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), reason);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  ensure(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, reason); return value;
}
function period(value: unknown, reason: Failure = 'invalid_input'): Period {
  const r = record(value, PERIOD_KEYS, reason);
  const start_date = date(r.start_date, reason), end_date = date(r.end_date, reason);
  ensure(start_date <= end_date, reason);
  return { start_date, end_date, date_basis: choice(r.date_basis, Object.keys(BASIS) as DateBasis[], reason) };
}
function scope(value: unknown, reason: Failure = 'invalid_input'): Scope {
  const r = record(value, SCOPE_KEYS, reason);
  for (const key of SCOPE_KEYS.slice(0, 3)) uuid(r[key], reason);
  text(r.account_id, 100, reason); return r as Scope;
}
function reference(value: unknown, reason: Failure = 'invalid_input'): Reference {
  const r = record(value, REFERENCE_KEYS, reason); uuid(r.id, reason); integer(r.revision, reason); digest(r.evidence_digest_sha256, reason);
  return r as Reference;
}
function same(left: object, right: object, keys: readonly string[]): boolean {
  return keys.every(key => (left as ObjectValue)[key] === (right as ObjectValue)[key]);
}
function references(value: unknown, maximum = 1_000): string[] {
  ensure(Array.isArray(value), 'invalid_assessment'); ensure(value.length <= maximum, 'structure_limit');
  const result = value.map(v => text(v, 200, 'invalid_references'));
  ensure(new Set(result).size === result.length, 'invalid_references'); return result;
}
function rows(value: unknown, maximum: number): ObjectValue[] {
  ensure(Array.isArray(value), 'invalid_assessment'); ensure(value.length <= maximum, 'structure_limit');
  return value.map(v => object(v, 'invalid_assessment'));
}
function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id));
}
const sortedUnion = (...lists: string[][]): string[] => [...new Set(lists.flat())].sort();

function controllerOf(value: unknown): Controller {
  const r = record(value, ['custom_inspection_version', 'current', 'load', 'subject_label', 'expected']);
  ensure(r.custom_inspection_version === 1, 'unsupported_version');
  const c = record(r.current, ['target_key', 'operation_key', 'preview_key', 'access', 'read_only', 'dirty', 'spatial_review', 'actions']);
  for (const key of CORRELATION) if (c[key] !== null) text(c[key], 300);
  choice(c.access, ['none', 'inspect', 'review']); choice(c.spatial_review, ['clear', 'required']);
  ensure(typeof c.read_only === 'boolean' && typeof c.dirty === 'boolean');
  const actions = record(c.actions, ['refresh', 'open_review', 'edit_area']);
  ensure(Object.values(actions).every(v => typeof v === 'boolean'));
  choice(r.load, ['empty', 'loading', 'failed', 'complete']);
  if (r.subject_label !== null) text(r.subject_label, 160);
  if (c.access === 'none' || r.load !== 'complete') {
    ensure(r.expected === null && r.subject_label === null);
    if (c.access !== 'none') ensure(c.target_key !== null && c.operation_key !== null);
  } else {
    ensure(CORRELATION.every(key => c[key] !== null) && r.expected !== null && r.subject_label !== null, 'binding_unavailable');
    const e = record(r.expected, ['request_context', 'assignment_file_id', 'account_id', 'workfile_key', 'scope',
      'assessment_reference', 'effective_date', 'data_cutoff', 'observation_period']);
    const request = record(e.request_context, CORRELATION);
    for (const key of CORRELATION) text(request[key], 300);
    integer(e.assignment_file_id); text(e.account_id, 100); text(e.workfile_key, 300);
    scope(e.scope); reference(e.assessment_reference); date(e.effective_date); date(e.data_cutoff); period(e.observation_period);
  }
  return r as unknown as Controller;
}

function admission(controllerJson: unknown, assessmentJson: unknown, intentJson: unknown, resolving: boolean) {
  ensure(typeof controllerJson === 'string');
  ensure(assessmentJson === null || typeof assessmentJson === 'string');
  if (resolving) ensure(typeof intentJson === 'string');
  let remaining = L.bytes - (resolving ? 4 : 3);
  remaining -= bytes(controllerJson, remaining, 'input_limit');
  remaining -= assessmentJson === null ? 4 : bytes(assessmentJson, remaining, 'input_limit');
  ensure(remaining >= 0, 'input_limit');
  if (resolving) remaining -= bytes(intentJson as string, remaining, 'input_limit');
  ensure(remaining >= 0, 'input_limit');
  bytes(controllerJson, L.controller_bytes, 'input_limit');
  if (resolving) bytes(intentJson as string, L.intent_bytes, 'input_limit');
  let nodes = 1, refs = 0;
  const parse = (raw: string, maxNodes: number, maxDepth: number): unknown => {
    const parsed: unknown = JSON.parse(raw);
    const used = inspect(parsed, 'structure_limit', Math.min(maxNodes, L.nodes - nodes), maxDepth);
    nodes += used.nodes; refs += used.references;
    ensure(nodes <= L.nodes && refs <= L.references, 'structure_limit');
    ensure(JSON.stringify(parsed) === raw); return parsed;
  };
  const rawController = parse(controllerJson, L.controller_nodes, L.controller_depth);
  const rawIntent = resolving ? parse(intentJson as string, L.intent_nodes, L.intent_depth) : null;
  const controller = controllerOf(rawController);
  if (controller.current.access === 'none' || controller.load !== 'complete') {
    // Content suppression is intentional: a forbidden payload is byte-admitted
    // above, but its JSON and private extensions are never parsed.
    ensure(assessmentJson === null);
    ensure(++nodes <= L.nodes, 'structure_limit');
    return { controller, assessment: null, rawIntent };
  }
  ensure(assessmentJson !== null, 'binding_unavailable');
  const assessment = parse(assessmentJson, L.nodes - nodes, L.depth - 1);
  object(assessment, 'invalid_assessment');
  return { controller, assessment, rawIntent };
}

function assessmentOf(value: unknown, expected: Expected, current: Current): ObjectValue {
  // Comparison follows the complete eligible-input structural/reference walk.
  ensure(same(expected.request_context, current, CORRELATION) && expected.account_id === expected.scope.account_id, 'binding_mismatch');
  const r = record(value, ['contract_version', 'scope', 'effective_date', 'data_cutoff', 'observation_period', 'subject_facts',
    'methodology', 'source_snapshots', 'discovery', 'selection', 'required_statistic_ids', 'required_population_ids', 'id', 'revision',
    'generated_at', 'input_signature_sha256', 'geographic_neighborhood', 'populations', 'statistics', 'development_evidence',
    'diagnostics', 'application_group', 'evidence_digest_sha256'], 'invalid_assessment');
  ensure(r.contract_version === 1, 'unsupported_version');
  const s = scope(r.scope, 'invalid_assessment'), p = period(r.observation_period, 'invalid_assessment');
  const ref = reference({ id: r.id, revision: r.revision, evidence_digest_sha256: r.evidence_digest_sha256 }, 'invalid_assessment');
  const effective = date(r.effective_date, 'invalid_assessment'), cutoff = date(r.data_cutoff, 'invalid_assessment');
  ensure(same(ref, expected.assessment_reference, REFERENCE_KEYS) && same(s, expected.scope, SCOPE_KEYS)
    && same(p, expected.observation_period, PERIOD_KEYS) && effective === expected.effective_date && cutoff === expected.data_cutoff, 'binding_mismatch');
  ensure(p.end_date <= cutoff && cutoff <= effective, 'invalid_assessment');
  digest(r.input_signature_sha256, 'invalid_assessment');
  ensure(typeof r.generated_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.generated_at), 'invalid_assessment');
  const generated = new Date(r.generated_at);
  ensure(Number.isFinite(generated.getTime()) && generated.toISOString() === r.generated_at, 'invalid_assessment');
  for (const key of ['subject_facts', 'methodology', 'discovery', 'selection', 'development_evidence', 'diagnostics']) object(r[key], 'invalid_assessment');
  const discovery = r.discovery as ObjectValue;
  ensure(discovery.complete === null || typeof discovery.complete === 'boolean', 'invalid_assessment');
  return r;
}

interface Extracted { required: string[]; geographic: ObjectValue; group: ObjectValue; perimeterSources: string[] }
function extract(core: ObjectValue): Extracted {
  const populations = rows(core.populations, 100), statistics = rows(core.statistics, 1_000), sources = rows(core.source_snapshots, 1_000);
  const index = (items: ObjectValue[]): Map<string, ObjectValue> => {
    const entries = items.map(item => [text(item.id, 200, 'invalid_references'), item] as const);
    ensure(new Set(entries.map(([id]) => id)).size === entries.length, 'invalid_references'); return new Map(entries);
  };
  const popMap = index(populations), statMap = index(statistics), sourceMap = index(sources);
  const requiredPops = references(core.required_population_ids, 100), requiredStats = references(core.required_statistic_ids);
  ensure(requiredPops.every(id => popMap.has(id)) && requiredStats.every(id => statMap.has(id)), 'invalid_references');
  ensure(requiredStats.every(id => requiredPops.includes(String(statMap.get(id)!.population_id))), 'invalid_references');
  const geo = record(core.geographic_neighborhood, ['status', 'reasons', 'geometry', 'crs', 'revision', 'perimeter', 'validation', 'cardinal_summaries'], 'invalid_assessment');
  choice(geo.status, STATES, 'invalid_assessment'); text(geo.revision, 200, 'invalid_assessment');
  ensure(geo.crs === 'EPSG:4326', 'invalid_assessment');
  const reasons = references(geo.reasons);
  ensure(geo.status === 'ready' ? reasons.length === 0 : reasons.length > 0, 'invalid_assessment');
  if (geo.geometry !== null) object(geo.geometry, 'invalid_assessment'); // Retained, not rendered or spatially certified.
  const validation = record(geo.validation, ['valid', 'connected', 'contains_subject', 'engine', 'revision'], 'invalid_assessment');
  for (const key of ['valid', 'connected', 'contains_subject']) ensure(validation[key] === null || typeof validation[key] === 'boolean', 'invalid_assessment');
  for (const key of ['engine', 'revision']) if (validation[key] !== null) text(validation[key], 200, 'invalid_assessment');
  const cardinal = record(geo.cardinal_summaries, ['north', 'east', 'south', 'west'], 'invalid_assessment');
  for (const value of Object.values(cardinal)) if (value !== null) text(value, 2_000, 'invalid_assessment');
  const perimeter = rows(geo.perimeter, 5_000), edges = new Set<string>(), perimeterRefs: string[][] = [];
  for (const edge of perimeter) {
    record(edge, ['edge_id', 'source_refs', 'from_node', 'to_node', 'name'], 'invalid_assessment');
    const id = text(edge.edge_id, 200, 'invalid_assessment');
    ensure(!edges.has(id), 'invalid_references'); edges.add(id);
    text(edge.from_node, 200, 'invalid_assessment'); text(edge.to_node, 200, 'invalid_assessment');
    ensure(edge.from_node !== edge.to_node, 'invalid_assessment');
    if (edge.name !== null) text(edge.name, 200, 'invalid_assessment');
    const refs = references(edge.source_refs); ensure(refs.length > 0 && refs.every(ref => sourceMap.has(ref)), 'invalid_references');
    perimeterRefs.push(refs);
  }
  const group = record(core.application_group, ['id', 'revision', 'application_mode', 'policy', 'geometry_revision', 'geometry_sha256',
    'population_refs', 'required_statistic_ids', 'source_refs', 'effective_date', 'data_cutoff', 'status'], 'invalid_assessment');
  ensure(group.id === `${core.id}:${core.revision}:neighborhood` && group.revision === core.revision && group.application_mode === 'atomic'
    && group.policy === 'all_or_nothing' && group.geometry_revision === geo.revision && group.effective_date === core.effective_date
    && group.data_cutoff === core.data_cutoff, 'invalid_assessment');
  digest(group.geometry_sha256, 'invalid_assessment'); choice(group.status, ['ready', 'incomplete'], 'invalid_assessment');
  const groupPops = rows(group.population_refs, 100), groupIds: string[] = [];
  for (const item of groupPops) {
    record(item, ['id', 'revision', 'member_set_sha256'], 'invalid_assessment');
    const id = text(item.id, 200, 'invalid_references'), population = popMap.get(id);
    ensure(population && item.revision === population.revision && item.member_set_sha256 === population.member_set_sha256, 'invalid_references'); groupIds.push(id);
  }
  ensure(new Set(groupIds).size === groupIds.length && sameSet(groupIds, requiredPops), 'invalid_references');
  const groupStats = references(group.required_statistic_ids), groupSources = references(group.source_refs);
  ensure(sameSet(groupStats, requiredStats), 'invalid_references');
  const perimeterSources = sortedUnion(...perimeterRefs);
  const dependencySources = sortedUnion(perimeterSources, ...requiredPops.map(id => references(popMap.get(id)!.source_refs)),
    ...requiredStats.map(id => references(statMap.get(id)!.source_refs)));
  ensure(sameSet(groupSources, dependencySources) && groupSources.every(id => sourceMap.has(id)), 'invalid_references');
  return { geographic: geo, group, perimeterSources, required: sortedUnion(['geographic_neighborhood'],
    requiredPops.map(id => `population:${id}`), groupIds.map(id => `population:${id}`),
    requiredStats.map(id => `statistic:${id}`), groupStats.map(id => `statistic:${id}`),
    groupSources.map(id => `source:${id}`), perimeterSources.map(id => `source:${id}`)) };
}

function descriptiveJson(value: unknown, prefix: string, suffix = ''): string {
  const admitted = inspect(value, 'display_capacity');
  ensure(admitted.bytes <= L.bytes, 'display_capacity');
  const encoded = JSON.stringify(value);
  ensure(prefix.length + encoded.length + suffix.length <= L.text, 'display_capacity'); return prefix + encoded + suffix;
}
function compose(controller: Controller, core: ObjectValue): PreviewDocument {
  const expected = controller.expected!, extracted = extract(core);
  const input = { display_input_version: 1, source_contract_version: 1, records_kind: 'all_core_records',
    assessment_reference: expected.assessment_reference, scope: core.scope, effective_date: core.effective_date,
    data_cutoff: core.data_cutoff, observation_period: core.observation_period, populations: core.populations,
    statistics: core.statistics, source_snapshots: core.source_snapshots, required_evidence_keys: extracted.required };
  inspect(input, 'display_capacity');
  const formatted = formatNeighborhoodAssessmentDisplay(JSON.stringify(input));
  if (formatted.status !== 'formatted') {
    const mapped: Record<string, Failure> = { unsupported_population: 'unsupported_records', unsupported_metadata: 'unsupported_records',
      invalid_records: 'invalid_assessment', invalid_references: 'invalid_references', unsupported_version: 'unsupported_version',
      input_limit: 'display_capacity', structure_limit: 'display_capacity', display_capacity: 'display_capacity', invalid_input: 'invalid_assessment' };
    ensure(false, mapped[formatted.reason] ?? 'invalid_assessment');
  }
  inspect(formatted, 'display_capacity');
  const provenance = formatted.provenance, display = formatted.display, notice = formatted.display_notice;
  ensure(provenance.records_kind === 'all_core_records' && same(provenance.assessment_reference, expected.assessment_reference, REFERENCE_KEYS)
    && same(provenance.scope, expected.scope, SCOPE_KEYS) && provenance.observation_date_basis === expected.observation_period.date_basis
    && provenance.source_authority === 'not_established' && provenance.report_eligibility === 'not_assessed', 'binding_mismatch');
  ensure(display.effective_date === expected.effective_date && display.data_cutoff === expected.data_cutoff
    && same(display.observation_period, expected.observation_period, ['start_date', 'end_date']), 'binding_mismatch');
  const expectedNotice = 'Supplied core population, statistic and source records; this is not a complete assessment display.'
    + ` Observation date basis: ${BASIS[expected.observation_period.date_basis]}. Values and statuses were supplied by the producer. This preview does not verify sources or authorize report changes.`;
  ensure(notice.id === 'assessment-display:v1:context' && notice.label === 'About this evidence' && notice.text === expectedNotice, 'invalid_assessment');
  ensure(formatted.deferred_evidence_keys.length === 1 && formatted.deferred_evidence_keys[0] === 'geographic_neighborhood', 'invalid_references');
  const geo = extracted.geographic;
  const detail = descriptiveJson({ status: geo.status, revision: geo.revision, crs: geo.crs, validation: geo.validation,
    reasons: geo.reasons, perimeter: geo.perimeter, application_group: extracted.group, discovery: { complete: (core.discovery as ObjectValue).complete } },
  'Producer-supplied geographic descriptor and application context: ', ' Geometry, source authority and report eligibility are not established by this inspection.');
  const geographic: EvidencePreview = { key: 'geographic_neighborhood', kind: 'geographic_neighborhood', id: null,
    label: 'Supplied neighborhood description', observation_text: `Effective date: ${expected.effective_date}`, support: 'unknown', detail };
  const reviewItems: ReviewItem[] = [
    { id: notice.id, label: notice.label, detail: notice.text, blocks_review: false, evidence_keys: [] },
    { id: 'custom-inspection:v1:mapping', label: 'Report-field mapping unavailable',
      detail: 'Custom report-field mapping is not available. This inspection does not propose or apply report changes.', blocks_review: true, evidence_keys: [] },
  ];
  const diagnostics = core.diagnostics as ObjectValue;
  if (Object.hasOwn(diagnostics, 'omissions')) reviewItems.push({ id: 'custom-inspection:v1:omissions', label: 'Supplied omission notes',
    detail: descriptiveJson(diagnostics.omissions, 'Producer-supplied diagnostic omissions: ', '. No omission has been resolved by this inspection.'),
    blocks_review: false, evidence_keys: [] });
  const evidence = [...display.evidence, geographic];
  ensure(evidence.length <= L.evidence && reviewItems.length <= L.reviews, 'display_capacity');
  const availableKeys = new Set(evidence.map(item => item.key));
  ensure(extracted.required.every(key => availableKeys.has(key)), 'invalid_references');
  const summaries = geo.cardinal_summaries as Record<string, string | null>;
  // The core has no side-to-edge attribution. Each supplied label cites the
  // complete descriptor dependency union, without manufacturing a street map.
  const cardinals = Object.fromEntries(['north', 'east', 'south', 'west'].map(side => [side, {
    status: summaries[side] === null ? 'not_available' : 'needs_review', text: summaries[side],
    evidence_keys: summaries[side] === null ? [] : ['geographic_neighborhood', ...extracted.perimeterSources.map(id => `source:${id}`)],
  }])) as PreviewDocument['boundary']['cardinals'];
  return { ...expected.request_context, workflow: 'custom_appraisal', origin: 'workflow_supplied', subject_label: controller.subject_label!,
    ...display, evidence, review_items: reviewItems, fields: [], pockets: [], boundary: {
      neighborhood: { status: 'available', description: 'Producer-supplied neighborhood description; geographic validation and source authority are not established by this inspection.', evidence_key: 'geographic_neighborhood' },
      analysis_area: { status: 'not_available', description: null, evidence_key: null },
      cardinals, outline_required_for_review: false, outline: null,
    } };
}

function build(controllerJson: unknown, assessmentJson: unknown, intentJson: unknown = undefined, resolving = false): Built {
  const { controller, assessment, rawIntent } = admission(controllerJson, assessmentJson, intentJson, resolving);
  const preview = assessment === null ? null : compose(controller, assessmentOf(assessment, controller.expected!, controller.current));
  const envelope = { preview_version: 1, current: { ...controller.current,
    actions: { refresh: controller.current.actions.refresh, open_review: false, edit_area: false } }, load: controller.load, preview };
  inspect(envelope, 'display_capacity');
  const envelopeJson = JSON.stringify(envelope), prepared = prepareNeighborhoodPreview(envelopeJson);
  inspect(prepared, 'display_capacity');
  const phase = controller.current.access === 'none' ? 'unavailable' : controller.load === 'complete' ? 'shown'
    : controller.load === 'failed' ? 'error' : controller.load;
  ensure(prepared.phase === phase && (prepared.phase !== 'unavailable' || prepared.reason === 'access_unavailable'), 'display_capacity');
  if (prepared.phase === 'shown') ensure(prepared.freshness === 'current', 'binding_mismatch');
  const prefix = '{"status":"ready","envelopeJson":';
  bytes(envelopeJson, L.bytes - prefix.length - 1, 'display_capacity', true);
  return { result: Object.freeze({ status: 'ready', envelopeJson }), prepared, intent: rawIntent === null ? null : object(rawIntent) };
}

export function buildCustomNeighborhoodInspectionEnvelope(controllerJson: unknown, retainedAssessmentJson: unknown): Result {
  try { return build(controllerJson, retainedAssessmentJson).result; }
  catch (error) {
    const reason = typeof error === 'object' && error !== null ? faults.get(error) ?? 'invalid_input' : 'invalid_input';
    return Object.freeze({ status: 'unavailable', reason });
  }
}

export function resolveCustomNeighborhoodInspectionIntent(latestControllerJson: unknown, latestRetainedAssessmentJson: unknown, intentJson: unknown): NeighborhoodPreviewIntent | null {
  try {
    const rebuilt = build(latestControllerJson, latestRetainedAssessmentJson, intentJson, true), incoming = rebuilt.intent;
    ensure(incoming !== null);
    const keys = incoming.type === 'refresh' ? ['type', 'target_key', 'operation_key']
      : incoming.type === 'inspect-evidence' ? ['type', 'target_key', 'operation_key', 'preview_key', 'item_key'] : null;
    ensure(keys !== null); record(incoming, keys);
    for (const key of keys) text(incoming[key], key === 'type' ? 30 : 300);
    const intent = createNeighborhoodPreviewIntent(rebuilt.prepared, incoming.type,
      incoming.type === 'inspect-evidence' ? incoming.item_key : undefined);
    return intent !== null && same(intent, incoming, keys) ? intent : null;
  } catch { return null; }
}
