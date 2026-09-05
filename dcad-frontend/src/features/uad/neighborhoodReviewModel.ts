/** Inactive presentation/state model. No requests, storage or authorization.
 * The server owns catalog mapping, occupancy/provenance classification and save.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface NeighborhoodReviewContext {
  workfileId: string; reportFileId: string; revision: number; specificationRelease: string;
  sessionKey: string; dirty: boolean; canApply: boolean; status: string;
  signedAt: string | null; hasSignatures: boolean;
}
export interface NeighborhoodCandidate {
  status: "ready"; candidate_version: 1; mapper_version: string; candidate_digest_sha256: string;
  attachment: { uad_workfile_id: string; report_file_id: string; editor_revision: number;
    specification_release: string; binding_digest_sha256: string; application_group_id: string;
    effective_date: string; data_cutoff: string };
  group: { id: string; status: "ready"; application_mode: "atomic"; policy: "all_or_nothing";
    required_statistic_ids: string[]; source_refs: string[]; population_refs: { id: string }[] };
  suggestions: { id: string; target_key: string; value: string | number;
    application_group_id: string; dependency_ids: string[]; evidence_refs: string[] }[];
  evidence: { geographic_neighborhood: Json; populations: Json[]; statistics: Json[]; sources: Json[];
    market_context: { analysis_geometry: Json; search_criteria: string; observation_period: Json;
      population_ref: Json; [key: string]: Json }; [key: string]: Json };
  omissions: string[];
}
export interface NeighborhoodReviewPreview {
  preview_version: 1;
  binding_digest_sha256: string;
  candidate: NeighborhoodCandidate;
  // Exact complete projection from trusted server preflight. Equal text or a
  // legacy source label is never sufficient for browser-inferred compatibility.
  members: { id: string; state: "new" | "reuse" | "conflict"; reason: string | null }[];
  blocking_issues: string[];
}
export interface NeighborhoodOperationToken { generation: number; sequence: number }
interface PendingApply {
  token: NeighborhoodOperationToken; workfileId: string; candidateDigest: string;
  groupId: string; revision: number; newCount: number; reuseCount: number;
}
export interface NeighborhoodReviewState {
  context: NeighborhoodReviewContext; generation: number; sequence: number;
  pendingLoad: NeighborhoodOperationToken | null; pendingApply: PendingApply | null;
  preview: NeighborhoodReviewPreview | null; selected: boolean; confirmed: boolean;
  error: string | null; notice: string | null; needsRefresh: boolean;
  acceptance: { acceptedRevision: number; alreadyApplied: boolean; appliedCount: number; reusedCount: number } | null;
}
export interface NeighborhoodCommittedResult {
  status: "applied" | "already_applied" | "conflict";
  workfile_id: string; candidate_digest_sha256: string; application_group_id: string;
  accepted_revision: number; current_revision: number; applied_count: number; reused_count: number;
}

const labels: Record<string, string> = {
  "market:3000.0008": "Market area boundary", "market:3000.0010": "Search criteria",
  "market:3000.0009": "Lookback period (months)", "market_total_sales:3000.0026": "Sales in lookback period",
  "market_total_sales:3000.0028": "Lowest sale price", "market_total_sales:3000.0029": "Median sale price",
  "market_total_sales:3000.0027": "Highest sale price",
};
const omissionLabels: Record<string, string> = {
  active_listing_coverage_not_mapped: "Active listing coverage has not been mapped.",
  pending_sales_coverage_not_mapped: "Pending sales coverage has not been mapped.",
  price_trend_review_required: "Price trends still need appraiser review.",
  housing_trend_review_required: "Housing trends still need appraiser review.",
  land_use_has_no_verified_section17_mapping: "Land-use evidence has no verified Section 17 field mapping.",
  development_project_evidence_not_mapped: "Development and project evidence has not been mapped.",
};
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonemptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const jsonRecord = (value: Json | undefined): value is { [key: string]: Json } =>
  !!value && typeof value === "object" && !Array.isArray(value);
const dateShape = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const uniqueIds = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 &&
  value.every(nonemptyString) && new Set(value).size === value.length;
function recordIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: unknown[] = value.map(item => item && typeof item === "object" && !Array.isArray(item) ? item.id : null);
  return uniqueIds(ids) ? ids : null;
}
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
const clone = <T>(value: T): T => structuredClone(value);
const tokenMatches = (a: NeighborhoodOperationToken | null, b: NeighborhoodOperationToken) =>
  !!a && a.generation === b.generation && a.sequence === b.sequence;
const editable = (context: NeighborhoodReviewContext) => context.canApply === true &&
  context.signedAt === null && context.hasSignatures === false &&
  ["draft", "validating", "ready", "revised"].includes(context.status);

export function createNeighborhoodReviewState(context: NeighborhoodReviewContext): NeighborhoodReviewState {
  return { context: clone(context), generation: 0, sequence: 0, pendingLoad: null, pendingApply: null,
    preview: null, selected: false, confirmed: false, error: null, notice: null, needsRefresh: false, acceptance: null };
}

export function updateNeighborhoodReviewContext(state: NeighborhoodReviewState, context: NeighborhoodReviewContext): NeighborhoodReviewState {
  if (JSON.stringify(state.context) === JSON.stringify(context)) return state;
  const sameTarget = context.workfileId === state.context.workfileId && context.sessionKey === state.context.sessionKey;
  return { ...state, context: clone(context), generation: state.generation + 1, pendingLoad: null,
    // A dirty/revision change does not cancel an already-sent server operation.
    // Keep it pending for this target until it settles, preventing duplicate save.
    pendingApply: sameTarget ? state.pendingApply : null,
    preview: null, selected: false, confirmed: false, error: null, notice: null, needsRefresh: true, acceptance: null };
}

export function startNeighborhoodReviewLoad(state: NeighborhoodReviewState) {
  const token = { generation: state.generation + 1, sequence: state.sequence + 1 };
  return { token, state: { ...state, generation: token.generation, sequence: token.sequence, pendingLoad: token, preview: null,
    selected: false, confirmed: false, error: null, notice: null, needsRefresh: false, acceptance: null } };
}

function validPreview(input: NeighborhoodReviewPreview, context: NeighborhoodReviewContext): boolean {
  try {
    const candidate = input.candidate;
    const attachment = candidate.attachment;
    if (!Number.isSafeInteger(context.revision) || context.revision < 1 || !nonemptyString(context.sessionKey) ||
      !nonemptyString(context.workfileId) || !nonemptyString(context.reportFileId) || !nonemptyString(context.specificationRelease) ||
      input.preview_version !== 1 || candidate.candidate_version !== 1 || candidate.status !== "ready" ||
      !digest(candidate.candidate_digest_sha256) || !digest(attachment.binding_digest_sha256) ||
      !dateShape(attachment.effective_date) || !dateShape(attachment.data_cutoff) ||
      input.binding_digest_sha256 !== attachment.binding_digest_sha256 ||
      attachment.uad_workfile_id !== context.workfileId || attachment.report_file_id !== context.reportFileId ||
      attachment.editor_revision !== context.revision || attachment.specification_release !== context.specificationRelease ||
      candidate.group.status !== "ready" || candidate.group.application_mode !== "atomic" ||
      candidate.group.policy !== "all_or_nothing" || candidate.group.id !== attachment.application_group_id ||
      !Array.isArray(candidate.suggestions) || ![4, 7].includes(candidate.suggestions.length) ||
      !Array.isArray(input.members) || input.members.length !== candidate.suggestions.length ||
      !Array.isArray(input.blocking_issues) || !input.blocking_issues.every(value => typeof value === "string") ||
      !Array.isArray(candidate.omissions) || !candidate.omissions.every(value => typeof value === "string")) return false;
    const ids = new Set(candidate.suggestions.map(item => item.id));
    const keys = new Set(candidate.suggestions.map(item => item.target_key));
    const count = candidate.suggestions.find(item => item.target_key === "market_total_sales:3000.0026")?.value;
    const commonKeys = ["market:3000.0008", "market:3000.0010", "market:3000.0009", "market_total_sales:3000.0026"];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 ||
      candidate.suggestions.length !== (count === 0 ? 4 : 7) || !commonKeys.every(key => keys.has(key))) return false;
    if (ids.size !== candidate.suggestions.length || keys.size !== ids.size ||
      new Set(input.members.map(item => item.id)).size !== ids.size) return false;
    if (!input.members.every(item => ids.has(item.id) && ["new", "reuse", "conflict"].includes(item.state) &&
      (item.reason === null || typeof item.reason === "string"))) return false;
    if (!candidate.suggestions.every(item => nonemptyString(item.id) &&
      Object.hasOwn(labels, item.target_key) && item.application_group_id === candidate.group.id &&
      (typeof item.value === "string" || (typeof item.value === "number" && Number.isFinite(item.value))) &&
      Array.isArray(item.dependency_ids) && new Set(item.dependency_ids).size === item.dependency_ids.length &&
      item.dependency_ids.every(id => ids.has(id)) &&
      Array.isArray(item.evidence_refs) && item.evidence_refs.every(id => typeof id === "string"))) return false;
    const evidence = candidate.evidence;
    const populations = recordIds(evidence.populations);
    const statistics = recordIds(evidence.statistics);
    const sources = recordIds(evidence.sources);
    const groupPopulations = recordIds(candidate.group.population_refs);
    if (!populations || !statistics || !sources || !groupPopulations ||
      !uniqueIds(candidate.group.required_statistic_ids) || !uniqueIds(candidate.group.source_refs) ||
      !sameIds(populations, groupPopulations) || !sameIds(statistics, candidate.group.required_statistic_ids) ||
      !sameIds(sources, candidate.group.source_refs)) return false;
    const displayRefs = new Set(["geographic_neighborhood", ...populations.map(id => `population:${id}`),
      ...statistics.map(id => `statistic:${id}`), ...sources.map(id => `source:${id}`)]);
    const referenced = new Set(candidate.suggestions.flatMap(item => item.evidence_refs));
    if (!candidate.suggestions.every(item => uniqueIds(item.evidence_refs) && item.evidence_refs.every(id => displayRefs.has(id))) ||
      ![...displayRefs].every(id => referenced.has(id))) return false;
    return jsonRecord(evidence.geographic_neighborhood) && jsonRecord(evidence.market_context?.analysis_geometry) &&
      nonemptyString(evidence.market_context.search_criteria) && jsonRecord(evidence.market_context.observation_period) &&
      dateShape(evidence.market_context.observation_period.start_date) && dateShape(evidence.market_context.observation_period.end_date) &&
      evidence.market_context.observation_period.date_basis === "closing_date" &&
      jsonRecord(evidence.market_context.population_ref) && nonemptyString(evidence.market_context.population_ref.id) &&
      populations.includes(evidence.market_context.population_ref.id);
  } catch { return false; }
}

export function receiveNeighborhoodReviewLoad(state: NeighborhoodReviewState, token: NeighborhoodOperationToken,
  preview: NeighborhoodReviewPreview | null): NeighborhoodReviewState {
  if (token.generation !== state.generation || !tokenMatches(state.pendingLoad, token)) return state;
  if (!preview || !validPreview(preview, state.context)) return { ...state, pendingLoad: null, preview: null,
    selected: false, confirmed: false, needsRefresh: true,
    error: "The neighborhood review is incomplete or has changed. Refresh the review before applying it." };
  return { ...state, pendingLoad: null, preview: clone(preview), selected: false, confirmed: false, error: null };
}

export function failNeighborhoodReviewLoad(state: NeighborhoodReviewState, token: NeighborhoodOperationToken): NeighborhoodReviewState {
  if (token.generation !== state.generation || !tokenMatches(state.pendingLoad, token)) return state;
  return { ...state, pendingLoad: null, preview: null, selected: false, confirmed: false,
    needsRefresh: true, error: "The neighborhood review could not be loaded. Try again." };
}

export function neighborhoodReviewBlockers(state: NeighborhoodReviewState): string[] {
  const result: string[] = [];
  if (state.pendingApply) result.push("Applying the reviewed neighborhood group.");
  if (state.pendingLoad) result.push("Loading neighborhood evidence.");
  if (state.context.dirty !== false) result.push("Save or discard current edits, then refresh this review.");
  if (!editable(state.context)) result.push("This workfile is signed, locked, or unavailable for editing.");
  if (state.needsRefresh) result.push("Refresh the neighborhood review.");
  if (!state.preview) result.push("No complete neighborhood review is available.");
  if (state.preview) {
    result.push(...state.preview.blocking_issues);
    if (state.preview.members.some(item => item.state === "conflict")) result.push("Existing report data conflicts with this group and will be preserved.");
  }
  return result;
}

export function selectNeighborhoodReviewGroup(state: NeighborhoodReviewState, selected: boolean): NeighborhoodReviewState {
  return { ...state, selected: selected === true && neighborhoodReviewBlockers(state).length === 0, confirmed: false, notice: null, acceptance: null };
}

export function confirmNeighborhoodReviewGroup(state: NeighborhoodReviewState, confirmed: boolean): NeighborhoodReviewState {
  return { ...state, confirmed: confirmed === true && state.selected && neighborhoodReviewBlockers(state).length === 0 };
}

export function beginNeighborhoodReviewApply(state: NeighborhoodReviewState) {
  if (!state.preview || !state.selected || !state.confirmed || neighborhoodReviewBlockers(state).length) return null;
  const candidate = state.preview.candidate;
  const token = { generation: state.generation, sequence: state.sequence + 1 };
  const pendingApply: PendingApply = { token, workfileId: state.context.workfileId,
    candidateDigest: candidate.candidate_digest_sha256, groupId: candidate.group.id, revision: state.context.revision,
    newCount: state.preview.members.filter(item => item.state === "new").length,
    reuseCount: state.preview.members.filter(item => item.state === "reuse").length };
  return { token, state: { ...state, sequence: token.sequence, pendingApply, confirmed: false, error: null, notice: null, acceptance: null },
    command: { workfileId: state.context.workfileId, body: {
      confirmed: true, preserve_existing: true, expected_revision: state.context.revision,
      expected_candidate_digest_sha256: candidate.candidate_digest_sha256,
      expected_binding_digest_sha256: candidate.attachment.binding_digest_sha256,
      selected_suggestion_ids: candidate.suggestions.map(item => item.id),
    } } };
}

export function finishNeighborhoodReviewApply(state: NeighborhoodReviewState, token: NeighborhoodOperationToken,
  result: NeighborhoodCommittedResult | null): { state: NeighborhoodReviewState; mutation: { workfileId: string; revision: number } | null } {
  const pending = state.pendingApply;
  if (!pending || !tokenMatches(pending.token, token)) return { state, mutation: null };
  const cleared = { ...state, pendingApply: null, selected: false, confirmed: false, needsRefresh: true };
  if (token.generation !== state.generation) return { state: cleared, mutation: null };
  const matching = result && result.workfile_id === pending.workfileId && result.candidate_digest_sha256 === pending.candidateDigest &&
    result.application_group_id === pending.groupId && Number.isSafeInteger(result.accepted_revision) &&
    result.current_revision === result.accepted_revision && Number.isSafeInteger(result.applied_count) &&
    Number.isSafeInteger(result.reused_count) && result.applied_count >= 0 && result.reused_count >= 0;
  if (matching && result.status === "applied" && result.accepted_revision === pending.revision + 1 &&
    result.applied_count === pending.newCount && result.reused_count === pending.reuseCount && result.applied_count > 0) {
    return { state: { ...cleared, preview: null, error: null, notice: "Reviewed neighborhood changes saved.",
      acceptance: { acceptedRevision: result.accepted_revision, alreadyApplied: false,
        appliedCount: result.applied_count, reusedCount: result.reused_count } },
      mutation: { workfileId: result.workfile_id, revision: result.current_revision } };
  }
  if (matching && result.status === "already_applied" && result.applied_count === 0 &&
    result.reused_count === pending.newCount + pending.reuseCount &&
    [pending.revision, pending.revision + 1].includes(result.accepted_revision)) {
    return { state: { ...cleared, preview: null, error: null,
      notice: "This neighborhood group was already saved. No additional changes were made.",
      acceptance: { acceptedRevision: result.accepted_revision, alreadyApplied: true,
        appliedCount: 0, reusedCount: result.reused_count } }, mutation: null };
  }
  return { state: { ...cleared, error: "The save could not be confirmed. Refresh the report before trying again.", notice: null }, mutation: null };
}

export function buildNeighborhoodReviewView(state: NeighborhoodReviewState) {
  const preview = state.preview;
  return { selected: state.selected, confirmed: state.confirmed,
    canApply: !!preview && state.selected && state.confirmed && neighborhoodReviewBlockers(state).length === 0,
    blockers: neighborhoodReviewBlockers(state), error: state.error, notice: state.notice,
    acceptance: state.acceptance ? clone(state.acceptance) : null,
    fields: preview?.candidate.suggestions.map(item => {
      const member = preview.members.find(member => member.id === item.id)!;
      return { id: item.id, label: labels[item.target_key], rawValue: item.value,
        displayValue: typeof item.value === "number" ? item.value.toLocaleString("en-US", { maximumFractionDigits: 20 }) : item.value,
        state: member.state, explanation: member.reason ?? (member.state === "reuse" ? "Previously accepted value retained."
          : member.state === "conflict" ? "Existing report value preserved." : "Requires appraiser review."),
        evidenceRefs: [...item.evidence_refs], dependencyIds: [...item.dependency_ids], required: true, selected: state.selected };
    }) ?? [],
    evidence: preview ? {
      geographicNeighborhood: { label: "Geographic neighborhood", value: clone(preview.candidate.evidence.geographic_neighborhood) },
      analysisGeography: { label: "Market analysis geography", value: clone(preview.candidate.evidence.market_context.analysis_geometry) },
      populations: clone(preview.candidate.evidence.populations), statistics: clone(preview.candidate.evidence.statistics),
      sources: clone(preview.candidate.evidence.sources), period: clone(preview.candidate.evidence.market_context.observation_period),
      effectiveDate: preview.candidate.attachment.effective_date, dataCutoff: preview.candidate.attachment.data_cutoff,
      searchCriteria: preview.candidate.evidence.market_context.search_criteria,
    } : null,
    omissions: preview?.candidate.omissions.map(code => ({ code, message: omissionLabels[code] ?? "Additional evidence requires review." })) ?? [],
  };
}
