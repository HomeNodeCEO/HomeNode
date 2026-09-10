import type { CustomCohortContextRef } from './customCohortPreviewController';
import { reportedObservationMeasurements } from './customReportedObservationPresentation.ts';
import type { ReportedStatistic } from './customReportedObservationPresentation';

type Data = Record<string, unknown>;
export interface ReportedReplacementIntent { kind: 'accepted_custom_reported_group' }
export interface ReportedReplacement extends ReportedReplacementIntent {
  predecessor: { acceptance_id: string; operation_id: string; accepted_editor_revision: number; section_value_sha256: string };
}
export interface ReportedProposalExpectation {
  accountId: string; assignmentFileId: string; contextRef: CustomCohortContextRef;
  workspaceRevision: number; editorRevision: number; operationId: string;
  replacement?: ReportedReplacementIntent | ReportedReplacement;
}
export interface ReportedProposal {
  status: 'proposed' | 'incomplete'; editorRevision: number; operationId: string;
  attachment: { attachment_id: string; attachment_revision: number; binding_digest: string } | null;
  boundary: { geometry: { type: 'Polygon'; coordinates: [number, number][][] } | null;
    cardinal_summaries: { north: string | null; east: string | null; south: string | null; west: string | null } } | null;
  populations: { id: string; kind: string; member_unit: string; member_count: number | null; unique_account_count: number | null; account_link_count: number | null }[];
  statistics: ReportedStatistic[]; issues: string[];
  replacement?: ReportedReplacement;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[a-f0-9]{64}$/;
function check(ok: unknown): asserts ok { if (!ok) throw new Error('custom_reported_proposal_invalid_response'); }
function object(value: unknown): Data { check(value && Object.getPrototypeOf(value) === Object.prototype); return value as Data; }
function fields(value: Data, keys: string[]) { check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))); }
const text = (value: unknown, limit = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit
  && value.trim() === value && !Array.from(value).some(char => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159));
const count = (value: unknown, max = 250000): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const oneOf = (value: unknown, values: string[]): value is string => typeof value === 'string' && values.includes(value);
const counts = ['observed_count', 'missing_count', 'invalid_count', 'conflicting_count', 'unsupported_count'];
function checkedExpectation(value: ReportedProposalExpectation) {
  check(value && text(value.accountId, 100) && typeof value.assignmentFileId === 'string' && /^[1-9]\d{0,18}$/.test(value.assignmentFileId)
    && BigInt(value.assignmentFileId) <= 9223372036854775807n && count(value.workspaceRevision, 2147483647) && value.workspaceRevision > 0
    && count(value.editorRevision, 2147483646) && typeof value.operationId === 'string' && uuid.test(value.operationId));
  const ref = object(value.contextRef); fields(ref, ['context_id', 'context_revision', 'context_sha256']);
  check(typeof ref.context_id === 'string' && uuid.test(ref.context_id) && ref.context_revision === '1'
    && typeof ref.context_sha256 === 'string' && sha.test(ref.context_sha256));
  if (Object.hasOwn(value, 'replacement')) {
    const intent = object(value.replacement);
    fields(intent, Object.hasOwn(intent, 'predecessor') ? ['kind', 'predecessor'] : ['kind']);
    check(intent.kind === 'accepted_custom_reported_group' && value.editorRevision > 0);
    if (Object.hasOwn(intent, 'predecessor')) replacement(intent, value.editorRevision);
  }
}
function replacement(value: unknown, editorRevision: number): ReportedReplacement {
  const r = object(value); fields(r, ['kind', 'predecessor']);
  check(r.kind === 'accepted_custom_reported_group');
  const p = object(r.predecessor); fields(p, ['acceptance_id', 'operation_id', 'accepted_editor_revision', 'section_value_sha256']);
  check(typeof p.acceptance_id === 'string' && uuid.test(p.acceptance_id) && typeof p.operation_id === 'string' && uuid.test(p.operation_id)
    && p.accepted_editor_revision === editorRevision && editorRevision > 0 && typeof p.section_value_sha256 === 'string' && sha.test(p.section_value_sha256));
  return r as unknown as ReportedReplacement;
}
function responseReplacement(response: Data, expected: ReportedProposalExpectation, applying = false) {
  if (!Object.hasOwn(expected, 'replacement')) return undefined;
  const r = replacement(response.replacement, expected.editorRevision), pinned = expected.replacement;
  check(pinned && (!applying || 'predecessor' in pinned));
  if ('predecessor' in pinned) check(Object.keys(r.predecessor).every(key =>
    r.predecessor[key as keyof typeof r.predecessor] === pinned.predecessor[key as keyof typeof pinned.predecessor]));
  return r;
}
function calendar(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function detached(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const encoder = new TextEncoder(), charge = (text: string) => { check(text.length <= 524288); bytes += encoder.encode(JSON.stringify(text)).length; check(bytes <= 524288); };
  const visit = (item: unknown, depth: number): unknown => {
    check(++nodes <= 100000 && depth <= 40);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { check(Number.isFinite(item)); return item; }
    if (typeof item === 'string') { charge(item); check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)); return item; }
    check(item && typeof item === 'object'); const array = Array.isArray(item), keys = Object.keys(item);
    check(Object.getPrototypeOf(item) === (array ? Array.prototype : Object.prototype) && Reflect.ownKeys(item).length === keys.length + (array ? 1 : 0));
    if (array) check(keys.length === item.length);
    const copy = array ? [] : {};
    for (const key of keys) { if (!array) charge(key); const descriptor = Object.getOwnPropertyDescriptor(item, key); check(descriptor && Object.hasOwn(descriptor, 'value'));
      Object.defineProperty(copy, key, { value: visit(descriptor.value, depth + 1), enumerable: true }); }
    return Object.freeze(copy);
  };
  const copy = visit(value, 0); check(encoder.encode(JSON.stringify(copy)).length <= 524288); return copy;
}
function responseTarget(value: unknown, expected: ReportedProposalExpectation) {
  const target = object(value); fields(target, ['account_id', 'assignment_file_id']);
  check(target.account_id === expected.accountId && target.assignment_file_id === expected.assignmentFileId);
}
function context(value: unknown, expected: CustomCohortContextRef) {
  const ref = object(value); fields(ref, ['context_id', 'context_revision', 'context_sha256']);
  check(ref.context_id === expected.context_id && ref.context_revision === expected.context_revision && ref.context_sha256 === expected.context_sha256);
}

/** Bounded browser DTO admission, not evidence/hash verification or permission.
 * The server owns the retained proposal and never accepts these displayed facts
 * back as Apply input. Reject partial/foreign responses as one whole group. */
export function decodeCustomReportedProposal(value: unknown, expected: ReportedProposalExpectation): ReportedProposal {
  checkedExpectation(expected);
  const response = object(detached(value));
  fields(response, ['status', 'target', 'context_ref', 'workspace_section_revision', 'editor_revision',
    'proposal_operation_id', 'reused', 'attachment_ref', 'assessment', 'issues', ...(Object.hasOwn(expected, 'replacement') ? ['replacement'] : [])]);
  const replacing = responseReplacement(response, expected);
  responseTarget(response.target, expected); context(response.context_ref, expected.contextRef);
  check(response.workspace_section_revision === expected.workspaceRevision && response.editor_revision === expected.editorRevision
    && response.proposal_operation_id === expected.operationId && typeof response.reused === 'boolean'
    && oneOf(response.status, ['proposed', 'incomplete']) && Array.isArray(response.issues) && response.issues.length <= 128);
  const issues = response.issues.map(value => { const issue = object(value); fields(issue, ['code']); check(text(issue.code, 500)); return issue.code; });
  let attachment: ReportedProposal['attachment'] = null;
  if (response.attachment_ref !== null) {
    const a = object(response.attachment_ref); fields(a, ['attachment_id', 'attachment_revision', 'binding_digest']);
    check(typeof a.attachment_id === 'string' && uuid.test(a.attachment_id) && count(a.attachment_revision, 2147483647)
      && a.attachment_revision > 0 && typeof a.binding_digest === 'string' && sha.test(a.binding_digest));
    attachment = { attachment_id: a.attachment_id, attachment_revision: a.attachment_revision, binding_digest: a.binding_digest };
  }
  const populations: ReportedProposal['populations'] = [], statistics: ReportedStatistic[] = [];
  let boundary: ReportedProposal['boundary'] = null;
  if (response.assessment !== null) {
    const a = object(response.assessment);
    fields(a, ['contract_version', 'assessment_id', 'revision', 'status', 'basis', 'statistics', 'populations', 'geography_status', 'boundary']);
    check(a.contract_version === 2 && typeof a.assessment_id === 'string' && uuid.test(a.assessment_id)
      && count(a.revision, 2147483647) && a.revision > 0 && oneOf(a.status, ['ready', 'incomplete'])
      && a.basis === 'reported_observations_not_verified_market_facts' && oneOf(a.geography_status, ['ready', 'incomplete', 'unsupported'])
      && Array.isArray(a.populations) && a.populations.length <= 100 && Array.isArray(a.statistics) && a.statistics.length <= 1000);
    const supplied = object(a.boundary); fields(supplied, ['geometry', 'cardinal_summaries']);
    const cardinals = object(supplied.cardinal_summaries); fields(cardinals, ['north', 'east', 'south', 'west']);
    check(Object.values(cardinals).every(value => value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= 2000 && !value.includes('\0'))));
    if (supplied.geometry !== null) {
      const geometry = object(supplied.geometry); fields(geometry, ['type', 'coordinates']);
      check(geometry.type === 'Polygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0);
      let coordinates = 0;
      for (const ring of geometry.coordinates) {
        check(Array.isArray(ring) && ring.length >= 4 && (coordinates += ring.length) <= 50000);
        for (const point of ring) check(Array.isArray(point) && point.length === 2 && point.every(v => typeof v === 'number' && Number.isFinite(v))
          && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90);
        check(ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]);
      }
    }
    if (a.geography_status === 'ready') check(supplied.geometry !== null && Object.values(cardinals).every(value => value !== null));
    boundary = supplied as ReportedProposal['boundary'];
    for (const raw of a.populations) {
      const p = object(raw); fields(p, ['id', 'kind', 'member_unit', 'member_count', 'unique_account_count', 'account_link_count']);
      check(text(p.id) && !populations.some(pop => pop.id === p.id) && (p.member_count === null || count(p.member_count, 100000))
        && [p.unique_account_count, p.account_link_count].every(value => value === null || count(value))
        && ((p.kind === 'account_observations' && p.member_unit === 'account') || (p.kind === 'source_record_observations' && p.member_unit === 'source_record')));
      const n = p.member_count as number | null, unique = p.unique_account_count as number | null, links = p.account_link_count as number | null;
      if (links !== null && unique !== null) check(unique <= links);
      if (n !== null && links !== null) check(p.kind === 'account_observations' ? n === links : links >= n && links <= Math.min(n * 1000, 250000));
      if (n !== null && unique !== null) check(p.kind === 'account_observations' ? n === unique : n === 0 ? unique === 0 : unique > 0);
      populations.push(p as ReportedProposal['populations'][number]);
    }
    for (const raw of a.statistics) {
      const s = object(raw), pop = populations.find(p => p.id === s.population_id);
      fields(s, ['id', 'population_id', 'measurement', 'unit', 'estimator', 'estimator_parameters', 'value', 'status', 'reason',
        ...counts, 'denominator_count', 'denominator_basis', 'observation_period', 'source_refs']);
      check(text(s.id) && !statistics.some(stat => stat.id === s.id) && pop && typeof s.measurement === 'string'
        && Object.hasOwn(reportedObservationMeasurements, s.measurement));
      const definition = reportedObservationMeasurements[s.measurement];
      check(definition.kind === pop.kind && definition.units.includes(s.unit as string | null)
        && count(s.denominator_count, 100000) && (pop.member_count === null || s.denominator_count === pop.member_count)
        && counts.every(key => count(s[key], 100000)) && counts.reduce((sum, key) => sum + Number(s[key]), 0) === s.denominator_count
        && s.denominator_basis === 'population_members' && oneOf(s.status, ['ready', 'incomplete', 'unsupported'])
        && oneOf(s.estimator, definition.count ? ['count', 'unsupported'] : ['exact_median', 'exact_quantile', 'unsupported']));
      const parameters = object(s.estimator_parameters);
      if (s.estimator === 'exact_quantile') { fields(parameters, ['convention', 'probability']); check(parameters.convention === 'type_7' && typeof parameters.probability === 'number' && [0, 1].includes(parameters.probability)); }
      else fields(parameters, []);
      if (s.status === 'ready') check(s.reason === null && s.unit !== null && s.estimator !== 'unsupported'
        && pop.member_count !== null && (definition.count ? s.estimator === 'count' && s.value === pop.member_count && s.observed_count === s.denominator_count
          : typeof s.value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(s.value)
          && s.value.replace('.', '').length <= 31 && (s.value.split('.')[1]?.length ?? 0) <= 13 && Number(s.observed_count) > 0));
      else check(s.value === null && text(s.reason, 2000));
      if (s.estimator === 'unsupported') check(s.status === 'unsupported');
      const period = object(s.observation_period); fields(period, ['start_date', 'end_date', 'date_basis']);
      check(calendar(period.start_date) && calendar(period.end_date) && period.start_date <= period.end_date
        && period.date_basis === (pop.kind === 'account_observations' ? 'capture_date' : 'closing_date')
        && (pop.kind !== 'account_observations' || period.start_date === period.end_date));
      const previous = statistics.find(stat => stat.population_id === pop.id)?.observation_period;
      if (previous) check(previous.start_date === period.start_date && previous.end_date === period.end_date && previous.date_basis === period.date_basis);
      check(Array.isArray(s.source_refs) && s.source_refs.length <= 1000 && s.source_refs.every(id => text(id))
        && new Set(s.source_refs).size === s.source_refs.length && (s.status !== 'ready' || s.source_refs.length > 0));
      statistics.push(s as unknown as ReportedStatistic);
    }
    if (response.status === 'proposed') check(a.status === 'ready' && a.geography_status === 'ready');
  }
  if (response.status === 'proposed') check(attachment && response.assessment !== null && issues.length === 0);
  else check(attachment === null && issues.length > 0);
  return detached({ status: response.status, editorRevision: expected.editorRevision,
    operationId: expected.operationId, attachment, boundary, populations, statistics, issues,
    ...(replacing ? { replacement: replacing } : {}) }) as ReportedProposal;
}

export function checkCustomReportedApply(value: unknown, expected: ReportedProposalExpectation, operationId: string): number {
  checkedExpectation(expected); check(typeof operationId === 'string' && uuid.test(operationId));
  const response = object(detached(value)); fields(response, ['status', 'target', 'context_ref', 'operation_id', 'proposal_operation_id', 'accepted_editor_revision', 'reused',
    ...(Object.hasOwn(expected, 'replacement') ? ['replacement'] : [])]);
  responseReplacement(response, expected, true);
  responseTarget(response.target, expected); context(response.context_ref, expected.contextRef);
  check(response.status === 'accepted' && response.operation_id === operationId && response.proposal_operation_id === expected.operationId
    && response.accepted_editor_revision === expected.editorRevision + 1 && typeof response.reused === 'boolean');
  return expected.editorRevision + 1;
}
