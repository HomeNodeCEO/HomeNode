import { buildNeighborhoodReviewView, neighborhoodReviewBlockers } from './neighborhoodReviewModel';
import type { NeighborhoodReviewState } from './neighborhoodReviewModel';
import { formatNeighborhoodAssessmentDisplay } from '../neighborhood/neighborhoodAssessmentDisplay';
import { prepareNeighborhoodPreview, createNeighborhoodPreviewIntent, NEIGHBORHOOD_PREVIEW_LIMITS } from '../neighborhood/neighborhoodPreviewModel';
import type { BoundaryPreview, EvidencePreview, PreviewDocument, ProposedFieldPreview, ReviewItem } from '../neighborhood/neighborhoodPreviewModel';

/** Dormant owner adapter. Inputs from the controller are trusted state, not an
 * authentication mechanism. Only primitive projection/intent JSON is ingress.
 * No transport, selection, confirmation, report writes or source authority. */
export interface UadPreviewOwnerContext {
  owner_version: 1; mount_epoch: string; target_epoch: string;
  binding: { workfile_id: string; report_file_id: string; specification_release: string; editor_revision: number; session_key: string };
  access: 'none' | 'inspect' | 'review'; read_only: boolean; spatial_review: 'clear' | 'required';
  outline_required_for_review: boolean; allow_analysis_geography: boolean;
  allowed_intents: { refresh: boolean; open_review: boolean; edit_area: boolean };
  subject_label: string;
  projection: null | { epoch: string; load_generation: number; load_sequence: number; retained_json: string };
}
type Reason = 'owner_context_changed' | 'invalid_projection' | 'unsupported_projection' | 'stale_projection' | 'projection_limit' | 'display_capacity';
export type UadPreviewEnvelopeResult = Readonly<{ status: 'ready'; envelopeJson: string }> | Readonly<{ status: 'unavailable'; reason: Reason }>;
type Target = { target_key: string; operation_key: string };
type PreviewTarget = Target & { preview_key: string };
export type UadPreviewOwnerAction = Readonly<
  | ({ type: 'refresh_review' } & Target)
  | ({ type: 'open_group_review' | 'request_area_edit' } & PreviewTarget)
  | ({ type: 'inspect_evidence' | 'inspect_pocket'; item_key: string } & PreviewTarget)
>;
type ObjectValue = Record<string, unknown>;
type Descriptors = { boundary: BoundaryPreview; pockets: []; evidence: EvidencePreview[]; review_items: ReviewItem[] };
const L = NEIGHBORHOOD_PREVIEW_LIMITS;
const EPOCH = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DIRECTIONS = ['north', 'east', 'south', 'west'] as const;
const GEOGRAPHY = ['geographic_neighborhood', 'analysis_geography'];
const RESERVED = ['uad-owner:', 'assessment-display:'];
const REFERENCE_ARRAYS = new Set(['evidence_keys', 'evidence_refs', 'source_refs', 'pocket_ids', 'required_evidence_keys']);
const RECORD_CAPS: Record<string, number> = { populations: 100, statistics: 1000, source_snapshots: 1000,
  required_evidence_keys: 1000, source_refs: 1000, reasons: 1000, pocket_ids: 5000 };
class Refused extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) { super(reason); this.reason = reason; }
}
function requireThat(condition: unknown, reason: Reason = 'invalid_projection'): asserts condition {
  if (!condition) throw new Refused(reason);
}
function object(value: unknown, keys?: readonly string[], reason: Reason = 'invalid_projection'): ObjectValue {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), reason);
  const row = value as ObjectValue;
  if (keys) requireThat(Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)), reason);
  return row;
}
function array(value: unknown, maximum: number, reason: Reason = 'projection_limit'): unknown[] {
  requireThat(Array.isArray(value) && value.length <= maximum, reason); return value;
}
function text(value: unknown, maximum: number = L.text_length, reason: Reason = 'invalid_projection'): string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= maximum, reason);
  utf8(value, L.input_bytes, reason); return value;
}
function identifier(value: unknown, reason: Reason = 'invalid_projection'): string {
  const result = text(value, L.id_length, reason); requireThat(result === result.trim(), reason); return result;
}
function epoch(value: unknown, reason: Reason = 'owner_context_changed'): string {
  requireThat(typeof value === 'string' && EPOCH.test(value), reason); return value;
}
function hash(value: unknown): string { requireThat(typeof value === 'string' && DIGEST.test(value)); return value; }
function integer(value: unknown, minimum = 0, reason: Reason = 'owner_context_changed'): number {
  requireThat(Number.isSafeInteger(value) && Number(value) >= minimum, reason); return value as number;
}
function bool(value: unknown, reason: Reason = 'owner_context_changed'): void { requireThat(typeof value === 'boolean', reason); }

// Independent generic JSON accounting, not a copy of the source formatter.
// No encoded copy, JSON.stringify or traversal of external objects for ingress.
function utf8(value: string, maximum: number, reason: Reason, quoted = false): number {
  requireThat(value.length <= maximum, reason);
  let size = quoted ? 2 : 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (quoted && (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c))) size += 2;
    else if (quoted && c < 32) size += 6;
    else if (c < 128) size++;
    else if (c < 2048) size += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      requireThat(next >= 0xdc00 && next <= 0xdfff, reason); size += 4;
    } else { requireThat(c < 0xdc00 || c > 0xdfff, reason); size += 3; }
    requireThat(size <= maximum, reason);
  }
  requireThat(size <= maximum, reason); return size;
}
function account(value: unknown, reason: Reason, maximum: number = L.input_bytes) {
  let bytes = 0, nodes = 0, references = 0;
  const ancestors = new WeakSet<object>();
  const charge = (amount: number) => { bytes += amount; requireThat(bytes <= maximum, reason); };
  function visit(item: unknown, depth: number): void {
    requireThat(++nodes <= L.nodes && depth <= L.depth, reason);
    if (item === null) charge(4);
    else if (typeof item === 'string') charge(utf8(item, maximum, reason, true));
    else if (typeof item === 'number') { requireThat(Number.isFinite(item), reason); charge(String(item).length); }
    else if (typeof item === 'boolean') charge(item ? 4 : 5);
    else {
      requireThat(typeof item === 'object' && item !== null && !ancestors.has(item), reason);
      const isArray = Array.isArray(item);
      requireThat(isArray || Object.getPrototypeOf(item) === Object.prototype, reason);
      const length = isArray ? item.length : Object.keys(item).length;
      requireThat(nodes + length <= L.nodes && (length === 0 || depth < L.depth), reason);
      charge(2 + Math.max(0, length - 1)); ancestors.add(item);
      if (isArray) {
        for (let index = 0; index < length; index++) visit(item[index], depth + 1);
      } else {
        for (const [key, child] of Object.entries(item)) {
          charge(utf8(key, maximum, reason, true) + 1);
          if (Array.isArray(child)) {
            if (Object.hasOwn(RECORD_CAPS, key)) requireThat(child.length <= RECORD_CAPS[key], reason);
            if (REFERENCE_ARRAYS.has(key)) references += child.length;
          }
          if (['evidence_key', 'population_id', 'members_resource_id'].includes(key) && child !== null) references++;
          requireThat(references <= L.references, reason); visit(child, depth + 1);
        }
      }
      ancestors.delete(item);
    }
  }
  visit(value, 0); return { bytes, nodes, references };
}
function compact(raw: unknown, maximum: number): { value: unknown; references: number } {
  requireThat(typeof raw === 'string'); utf8(raw, maximum, 'projection_limit');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Refused('invalid_projection'); }
  const { references } = account(value, 'projection_limit', maximum);
  requireThat(JSON.stringify(value) === raw); return { value, references };
}
function refs(value: unknown, allowed?: ReadonlySet<string>): string[] {
  const entries = array(value, L.references).map(item => identifier(item));
  requireThat(new Set(entries).size === entries.length && (!allowed || entries.every(item => allowed.has(item))));
  return entries;
}
function ownerBinding(state: NeighborhoodReviewState, owner: UadPreviewOwnerContext): void {
  const reason = 'owner_context_changed';
  object(owner, ['owner_version', 'mount_epoch', 'target_epoch', 'binding', 'access', 'read_only', 'spatial_review',
    'outline_required_for_review', 'allow_analysis_geography', 'allowed_intents', 'subject_label', 'projection'], reason);
  requireThat(owner.owner_version === 1, reason); epoch(owner.mount_epoch); epoch(owner.target_epoch);
  object(owner.binding, ['workfile_id', 'report_file_id', 'specification_release', 'editor_revision', 'session_key'], reason);
  const c = state.context, b = owner.binding;
  for (const [actual, expected] of [[b.workfile_id, c.workfileId], [b.report_file_id, c.reportFileId],
    [b.specification_release, c.specificationRelease], [b.session_key, c.sessionKey]]) {
    identifier(actual, reason); requireThat(actual === expected, reason);
  }
  requireThat(integer(b.editor_revision, 1) === c.revision, reason);
  integer(state.generation); integer(state.sequence); bool(c.dirty); bool(c.canApply); bool(c.hasSignatures);
  requireThat(['none', 'inspect', 'review'].includes(owner.access) && ['clear', 'required'].includes(owner.spatial_review), reason);
  bool(owner.read_only); bool(owner.outline_required_for_review); bool(owner.allow_analysis_geography);
  object(owner.allowed_intents, ['refresh', 'open_review', 'edit_area'], reason);
  Object.values(owner.allowed_intents).forEach(value => bool(value)); text(owner.subject_label, L.label_length, reason);
}
function descriptors(value: unknown, state: NeighborhoodReviewState, owner: UadPreviewOwnerContext): Descriptors {
  const d = object(value, ['boundary', 'pockets', 'evidence', 'review_items']);
  array(d.pockets, 0); const evidence: EvidencePreview[] = [], registered = new Set<string>();
  for (const item of array(d.evidence, 2)) {
    const e = object(item, ['key', 'kind', 'id', 'label', 'observation_text', 'support', 'detail']);
    const key = identifier(e.key);
    requireThat(GEOGRAPHY.includes(key) && key === e.kind && e.id === null && e.observation_text === null && e.support === 'unknown');
    requireThat(!registered.has(key)); registered.add(key);
    text(e.label, L.label_length); text(e.detail); evidence.push(e as unknown as EvidencePreview);
  }
  const b = object(d.boundary, ['neighborhood', 'analysis_area', 'cardinals', 'outline_required_for_review', 'outline']);
  requireThat(b.outline === null && b.outline_required_for_review === owner.outline_required_for_review);
  function area(value: unknown, evidenceKey: string) {
    const a = object(value, ['status', 'description', 'evidence_key']);
    requireThat(a.status === 'available' || a.status === 'not_available');
    if (a.status === 'available') {
      text(a.description); requireThat(a.evidence_key === evidenceKey && registered.has(evidenceKey));
    } else requireThat(a.description === null && a.evidence_key === null);
    return a;
  }
  area(b.neighborhood, 'geographic_neighborhood');
  const analysis = area(b.analysis_area, 'analysis_geography');
  const candidate = state.preview!.candidate;
  const geometry = object(candidate.evidence.market_context.analysis_geometry);
  if (analysis.status === 'available') requireThat(owner.allow_analysis_geography === true
    && analysis.description === geometry.boundary_description);
  requireThat(registered.has('analysis_geography') === (analysis.status === 'available'));
  if (!owner.allow_analysis_geography) requireThat(!registered.has('analysis_geography') && analysis.status === 'not_available');
  const cardinals = object(b.cardinals, DIRECTIONS);
  const actual = object(object(candidate.evidence.geographic_neighborhood).cardinal_summaries);
  for (const direction of DIRECTIONS) {
    const cardinal = object(cardinals[direction], ['status', 'text', 'evidence_keys']);
    const references = refs(cardinal.evidence_keys, registered), original = actual[direction];
    if (original !== null && original !== undefined) {
      text(original); requireThat(cardinal.text === original && cardinal.status === 'needs_review'
        && references.length === 1 && references[0] === 'geographic_neighborhood');
    } else requireThat(cardinal.text === null && cardinal.status === 'not_available' && references.length === 0);
  }
  const reviewItems: ReviewItem[] = [], seen = new Set<string>();
  for (const item of array(d.review_items, L.review_items)) {
    const r = object(item, ['id', 'label', 'detail', 'blocks_review', 'evidence_keys']);
    const id = identifier(r.id); requireThat(!RESERVED.some(prefix => id.startsWith(prefix)) && !seen.has(id)); seen.add(id);
    text(r.label, L.label_length); text(r.detail); requireThat(r.blocks_review === true); refs(r.evidence_keys, registered);
    reviewItems.push(r as unknown as ReviewItem);
  }
  return { boundary: b as unknown as BoundaryPreview, pockets: [], evidence, review_items: reviewItems };
}
function retainedProjection(state: NeighborhoodReviewState, owner: UadPreviewOwnerContext, raw: unknown) {
  requireThat(owner.projection !== null, 'stale_projection');
  const pin = owner.projection;
  object(pin, ['epoch', 'load_generation', 'load_sequence', 'retained_json'], 'owner_context_changed'); epoch(pin.epoch);
  requireThat(integer(pin.load_generation) === state.generation && integer(pin.load_sequence) === state.sequence, 'stale_projection');
  // Reject unknown objects before equality, reflection, parsing or stringification.
  requireThat(typeof raw === 'string' && typeof pin.retained_json === 'string');
  requireThat(raw === pin.retained_json, 'stale_projection');
  const parsed = compact(raw, L.input_bytes);
  const p = object(parsed.value, ['projection_version', 'projection_epoch', 'candidate_digest_sha256', 'binding_digest_sha256', 'descriptors']);
  requireThat(p.projection_version === 1, 'unsupported_projection');
  requireThat(epoch(p.projection_epoch, 'invalid_projection') === pin.epoch, 'stale_projection');
  const candidate = state.preview!.candidate;
  requireThat(hash(p.candidate_digest_sha256) === candidate.candidate_digest_sha256
    && hash(p.binding_digest_sha256) === candidate.attachment.binding_digest_sha256, 'stale_projection');
  return { value: descriptors(p.descriptors, state, owner), references: parsed.references };
}
function encodedEnvelope(value: unknown, accessNone = false): UadPreviewEnvelopeResult {
  account(value, 'display_capacity'); const envelopeJson = JSON.stringify(value);
  const prepared = prepareNeighborhoodPreview(envelopeJson);
  if (!(accessNone && prepared.phase === 'unavailable' && prepared.reason === 'access_unavailable')) {
    requireThat(prepared.phase !== 'unavailable', 'display_capacity');
  }
  return Object.freeze({ status: 'ready', envelopeJson });
}
function build(state: NeighborhoodReviewState, owner: UadPreviewOwnerContext, projectionJson: unknown): UadPreviewEnvelopeResult {
  ownerBinding(state, owner);
  if (owner.access === 'none') return encodedEnvelope({ preview_version: 1, current: {
    target_key: null, operation_key: null, preview_key: null, access: 'none', read_only: true, dirty: false,
    spatial_review: 'required', actions: { refresh: false, open_review: false, edit_area: false },
  }, load: 'empty', preview: null }, true);
  const target_key = identifier(JSON.stringify([owner.mount_epoch, owner.target_epoch]));
  const operation_key = identifier(JSON.stringify([owner.mount_epoch, owner.target_epoch, state.generation, state.sequence]));
  const editable = state.context.canApply === true && state.context.signedAt === null && state.context.hasSignatures === false
    && ['draft', 'validating', 'ready', 'revised'].includes(state.context.status);
  const noPending = state.pendingLoad === null && state.pendingApply === null;
  const current = { target_key, operation_key, preview_key: null as string | null, access: owner.access,
    read_only: owner.read_only, dirty: state.context.dirty, spatial_review: owner.spatial_review,
    actions: { refresh: owner.allowed_intents.refresh && noPending && state.context.dirty === false,
      open_review: false, edit_area: false } };
  if (!state.preview) return encodedEnvelope({ preview_version: 1, current,
    load: state.pendingLoad ? 'loading' : state.error ? 'failed' : 'empty', preview: null });
  const candidate = state.preview.candidate, attachment = object(candidate.attachment), evidence = candidate.evidence;
  requireThat(candidate.status === 'ready' && candidate.candidate_version === 1 && state.preview.preview_version === 1);
  hash(candidate.candidate_digest_sha256); hash(attachment.binding_digest_sha256);
  requireThat(attachment.uad_workfile_id === owner.binding.workfile_id && attachment.report_file_id === owner.binding.report_file_id
    && attachment.editor_revision === owner.binding.editor_revision && attachment.specification_release === owner.binding.specification_release
    && attachment.binding_digest_sha256 === state.preview.binding_digest_sha256, 'owner_context_changed');
  // Bound precisely what the existing view clones/iterates, not a full candidate
  // or receipt serialization. The formatter separately admits its real records.
  const viewInput = { suggestions: candidate.suggestions, members: state.preview.members,
    blocking_issues: state.preview.blocking_issues, omissions: candidate.omissions,
    geography: evidence.geographic_neighborhood, analysis: evidence.market_context.analysis_geometry };
  const viewBudget = account(viewInput, 'display_capacity');
  array(candidate.suggestions, 7, 'display_capacity'); array(state.preview.members, 7, 'display_capacity');
  array(state.preview.blocking_issues, L.review_items, 'display_capacity'); array(candidate.omissions, L.review_items, 'display_capacity');
  const projection = retainedProjection(state, owner, projectionJson);
  const required = new Set<string>();
  const input = { display_input_version: 1, source_contract_version: 1, records_kind: 'candidate_subset',
    assessment_reference: { id: attachment.assessment_id, revision: attachment.assessment_revision,
      evidence_digest_sha256: attachment.evidence_digest_sha256 },
    scope: attachment.scope, effective_date: attachment.effective_date, data_cutoff: attachment.data_cutoff,
    observation_period: evidence.market_context.observation_period, populations: evidence.populations,
    statistics: evidence.statistics, source_snapshots: evidence.sources, required_evidence_keys: [] as string[] };
  requireThat(hash(attachment.evidence_digest_sha256) === evidence.assessment_digest_sha256
    && attachment.evidence_digest_sha256 === evidence.market_context.assessment_digest_sha256);
  const inputBudget = account(input, 'display_capacity');
  requireThat(inputBudget.references + viewBudget.references + projection.references <= L.references, 'display_capacity');
  function include(key: unknown) {
    required.add(identifier(key)); requireThat(required.size <= L.evidence, 'display_capacity');
  }
  for (const item of candidate.suggestions) for (const key of refs(item.evidence_refs)) include(key);
  for (const [kind, records] of [['population', evidence.populations], ['statistic', evidence.statistics], ['source', evidence.sources]] as const) {
    for (const item of records) include(`${kind}:${identifier(object(item).id)}`);
  }
  for (const row of projection.value.evidence) include(row.key);
  input.required_evidence_keys = [...required].sort();
  account(input, 'display_capacity');
  const formatted = formatNeighborhoodAssessmentDisplay(JSON.stringify(input));
  requireThat(formatted.status === 'formatted', formatted.status === 'unavailable'
    && ['display_capacity', 'input_limit', 'structure_limit'].includes(formatted.reason) ? 'display_capacity' : 'unsupported_projection');
  const provenance = formatted.provenance, scope = object(input.scope), reference = input.assessment_reference;
  requireThat(provenance.records_kind === 'candidate_subset' && provenance.assessment_reference.id === reference.id
    && provenance.assessment_reference.revision === reference.revision
    && provenance.assessment_reference.evidence_digest_sha256 === reference.evidence_digest_sha256
    && Object.keys(provenance.scope).every(key => provenance.scope[key as keyof typeof provenance.scope] === scope[key])
    && Object.keys(scope).length === Object.keys(provenance.scope).length
    && provenance.source_authority === 'not_established' && provenance.report_eligibility === 'not_assessed');
  const period = object(input.observation_period);
  requireThat(provenance.observation_date_basis === period.date_basis && formatted.display.effective_date === input.effective_date
    && formatted.display.data_cutoff === input.data_cutoff && formatted.display.observation_period.start_date === period.start_date
    && formatted.display.observation_period.end_date === period.end_date);
  requireThat(formatted.deferred_evidence_keys.length === projection.value.evidence.length
    && formatted.deferred_evidence_keys.every(key => projection.value.evidence.some(item => item.key === key)));
  const view = buildNeighborhoodReviewView(state);
  requireThat([4, 7].includes(view.fields.length));
  const fields: ProposedFieldPreview[] = view.fields.map(field => {
    requireThat(!RESERVED.some(prefix => field.id.startsWith(prefix)));
    return { id: field.id, label: field.label, disposition: field.state === 'reuse' ? 'reused' : field.state,
      proposed: { status: 'value', text: field.displayValue }, current: { status: 'not_supplied', text: null },
      explanation: field.explanation, evidence_keys: field.evidenceRefs };
  });
  if (view.fields.length === 4) {
    requireThat(candidate.suggestions.find(item => item.target_key === 'market_total_sales:3000.0026')?.value === 0);
    for (const [slug, label] of [['lowest-sale-price', 'Lowest sale price'], ['median-sale-price', 'Median sale price'], ['highest-sale-price', 'Highest sale price']]) {
      fields.push({ id: `uad-owner:companion:${slug}`, label, disposition: 'empty_companion',
        proposed: { status: 'not_proposed', text: null }, current: { status: 'not_supplied', text: null },
        explanation: 'No price is proposed for this zero-sales group; saved values are not supplied.', evidence_keys: [] });
    }
  }
  const notice = formatted.display_notice;
  requireThat(notice.id === 'assessment-display:v1:context' && notice.label === 'About this evidence');
  requireThat(projection.value.review_items.length + view.blockers.length + view.omissions.length + 1 <= L.review_items, 'display_capacity');
  const reviewItems: ReviewItem[] = [
    { id: notice.id, label: notice.label, detail: notice.text, blocks_review: false, evidence_keys: [] },
    ...projection.value.review_items,
    ...view.blockers.map((detail, index) => ({ id: `uad-owner:blocker:${index}`, label: 'Review requirement', detail, blocks_review: true, evidence_keys: [] })),
    ...view.omissions.map((item, index) => ({ id: `uad-owner:omission:${index}`, label: 'Not included in this group', detail: item.message, blocks_review: false, evidence_keys: [] })),
  ];
  current.preview_key = identifier(JSON.stringify([candidate.candidate_digest_sha256, attachment.binding_digest_sha256, owner.projection!.epoch, 1]));
  current.actions.open_review = owner.access === 'review' && !owner.read_only && owner.allowed_intents.open_review
    && state.context.canApply && neighborhoodReviewBlockers(state).length === 0;
  current.actions.edit_area = owner.access === 'review' && !owner.read_only && owner.allowed_intents.edit_area
    && editable && noPending && state.context.dirty === false;
  const document: PreviewDocument = { target_key, operation_key, preview_key: current.preview_key,
    origin: 'workflow_supplied', workflow: 'uad_3_6', subject_label: owner.subject_label,
    effective_date: formatted.display.effective_date, data_cutoff: formatted.display.data_cutoff,
    observation_period: formatted.display.observation_period, boundary: projection.value.boundary,
    populations: formatted.display.populations, pockets: [], fields,
    evidence: [...formatted.display.evidence, ...projection.value.evidence], review_items: reviewItems };
  return encodedEnvelope({ preview_version: 1, current, load: 'complete', preview: document });
}

export function buildUadNeighborhoodPreviewEnvelope(state: NeighborhoodReviewState, owner: UadPreviewOwnerContext,
  projectionJson: unknown): UadPreviewEnvelopeResult {
  try { return build(state, owner, projectionJson); }
  catch (error) { return Object.freeze({ status: 'unavailable', reason: error instanceof Refused ? error.reason : 'invalid_projection' }); }
}

export function resolveUadNeighborhoodPreviewIntent(latestState: NeighborhoodReviewState, owner: UadPreviewOwnerContext,
  projectionJson: unknown, intentJson: unknown): UadPreviewOwnerAction | null {
  try {
    const parsed = object(compact(intentJson, 8192).value);
    const type = parsed.type;
    requireThat(typeof type === 'string' && ['refresh', 'review-group', 'edit-area', 'inspect-evidence', 'inspect-pocket'].includes(type));
    const keys = ['type', 'target_key', 'operation_key'];
    if (type !== 'refresh') keys.push('preview_key');
    if (type === 'inspect-evidence' || type === 'inspect-pocket') keys.push('item_key');
    object(parsed, keys); keys.filter(key => key !== 'type').forEach(key => identifier(parsed[key]));
    const result = buildUadNeighborhoodPreviewEnvelope(latestState, owner, projectionJson);
    if (result.status !== 'ready') return null;
    const expected = createNeighborhoodPreviewIntent(prepareNeighborhoodPreview(result.envelopeJson), type, parsed.item_key);
    if (!expected || Object.keys(expected).length !== keys.length
      || !keys.every(key => (expected as unknown as ObjectValue)[key] === parsed[key])) return null;
    if (expected.type === 'refresh') return Object.freeze({ ...expected, type: 'refresh_review' });
    if (expected.type === 'review-group') return Object.freeze({ ...expected, type: 'open_group_review' });
    if (expected.type === 'edit-area') return Object.freeze({ ...expected, type: 'request_area_edit' });
    if (expected.type === 'inspect-evidence' || expected.type === 'inspect-pocket') {
      return Object.freeze({ ...expected, type: expected.type === 'inspect-evidence' ? 'inspect_evidence' : 'inspect_pocket' });
    }
    return null;
  } catch { return null; }
}
