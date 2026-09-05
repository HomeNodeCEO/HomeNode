import { performance } from 'node:perf_hooks';
import * as publicCatalog from '../../security/publicCadastralCatalog.js';
import { hasApplicationPermission } from '../../security/applicationAccess.js';
import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { validateCachedTransactionClosure } from './cachedTransactionClosure.js';

// Runtime capabilities only. None of these maps, issuers, or mint operations is
// exported. Copying/serializing a token never preserves its authority.
const authorities = new WeakMap();
const selections = new WeakMap();
const markets = new WeakMap();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_KEYS = ['target', 'scope', 'effective_date', 'selection', 'account_ids',
  'selection_sha256', 'observation_period', 'knowledge_cutoff', 'market_decision', 'transaction_closure'];
const SCOPE_KEYS = ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export const NEIGHBORHOOD_CACHED_READ_ACCESS_LIMITS = Object.freeze({
  account_ids: 50_000, ttl_ms: 60_000, reference_length: 200,
});

function deny(reason) {
  throw Object.assign(new Error(`neighborhood_cached_read_access_denied:${reason}`), {
    code: 'NEIGHBORHOOD_CACHED_READ_ACCESS_DENIED', reason,
  });
}
function keys(value, allowed, name) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) deny(name);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) deny(`${name}.unknown_key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) deny(`${name}.accessor`);
  }
  return value;
}
function text(value, name, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) deny(name);
  return value;
}
function uuid(value, name) {
  if (!UUID.test(text(value, name, 36))) deny(name);
  return value.toLowerCase();
}
function revision(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) deny(name);
  return value;
}
function hash(value, name) {
  if (!SHA256.test(text(value, name, 64))) deny(name);
  return value;
}
function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function same(a, b) { return canonicalAssessmentJson(a) === canonicalAssessmentJson(b); }
function requireCatalog() {
  if (typeof publicCatalog.authorizePublicCadastralCatalogRead !== 'function'
    || typeof publicCatalog.assertPublicCadastralCatalogGrant !== 'function'
    || typeof publicCatalog.normalizePublicCadastralAccountId !== 'function') deny('public_catalog_security_unavailable');
}
function account(value) {
  text(value, 'account_id', 64); // Never stringify objects/numbers through the catalog normalizer.
  return publicCatalog.normalizePublicCadastralAccountId(value);
}
function scopeOf(value) {
  keys(value, SCOPE_KEYS, 'scope');
  return Object.fromEntries(SCOPE_KEYS.map(key => [key,
    key === 'account_id' ? account(value[key]) : uuid(value[key], `scope.${key}`)]));
}
function targetOf(value) {
  keys(value, ['report_file_id', 'workflow_type', 'workflow_target_id'], 'target');
  const workflow = value.workflow_type;
  if (!['custom_appraisal', 'uad_3_6'].includes(workflow)) deny('target.workflow_type');
  let targetId = text(value.workflow_target_id, 'target.workflow_target_id', 36);
  if (workflow === 'uad_3_6') targetId = uuid(targetId, 'target.workflow_target_id');
  else if (!/^[1-9]\d{0,18}$/.test(targetId) || BigInt(targetId) > 9223372036854775807n) deny('target.workflow_target_id');
  return { report_file_id: uuid(value.report_file_id, 'target.report_file_id'),
    workflow_type: workflow, workflow_target_id: targetId };
}
function referenceOf(value) {
  keys(value, ['id', 'revision'], 'selection_reference');
  return { id: text(value.id, 'selection_reference.id'), revision: revision(value.revision, 'selection_reference.revision') };
}
function selectionOf(value) {
  keys(value, ['id', 'revision', 'definition_sha256', 'source_sha256'], 'selection');
  return { id: text(value.id, 'selection.id'), revision: revision(value.revision, 'selection.revision'),
    definition_sha256: hash(value.definition_sha256, 'selection.definition_sha256'),
    source_sha256: hash(value.source_sha256, 'selection.source_sha256') };
}
function periodOf(value, effectiveDate) {
  keys(value, ['start_date', 'end_date'], 'observation_period');
  const start = assessmentDate(value.start_date, 'observation_period.start_date');
  const end = assessmentDate(value.end_date, 'observation_period.end_date');
  if (start > end || end > effectiveDate) deny('observation_period');
  return { start_date: start, end_date: end };
}
function cutoffOf(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) deny('knowledge_cutoff');
  return value;
}
function accountIds(value, subject) {
  if (!Array.isArray(value) || !value.length || value.length > NEIGHBORHOOD_CACHED_READ_ACCESS_LIMITS.account_ids) deny('account_ids');
  const result = value.map(account).sort(compare);
  if (new Set(result).size !== result.length || !result.includes(subject)) deny('account_ids');
  return result;
}
function actor(auth) { return text(auth?.userId, 'authentication_required', 200); }
function permission(auth, context, expectedActor) {
  if (actor(auth) !== expectedActor) deny('actor_mismatch');
  if (!hasApplicationPermission(auth, context.target.workflow_type, 'read', context.scope.organization_id)) deny('workflow_read_required');
}
function selectionDigest(request) {
  return assessmentEvidenceDigest({ scope: request.scope, effective_date: request.effective_date,
    selection: request.selection, account_ids: request.account_ids });
}
function marketDecision(value, fromAuthorizer = false) {
  if (fromAuthorizer && (!value || typeof value !== 'object' || value.allowed !== true)) deny('market_data_access_denied');
  keys(value, fromAuthorizer ? ['allowed', 'decision_id', 'policy_revision'] : ['decision_id', 'policy_revision'], 'market_decision');
  if (fromAuthorizer && value.allowed !== true) deny('market_data_access_denied');
  return { decision_id: text(value.decision_id, 'market_decision.decision_id'),
    policy_revision: text(value.policy_revision, 'market_decision.policy_revision') };
}
function closureOf(value, selectedIds) {
  keys(value, ['version', 'selected_account_ids', 'source_revision', 'transactions', 'links', 'legacy',
    'closure_account_ids', 'source_record_ids', 'legacy_sale_ids', 'closure_sha256'], 'transaction_closure');
  if (value.version !== 1) deny('transaction_closure.version');
  const normalized = validateCachedTransactionClosure({ selected_account_ids: value.selected_account_ids,
    source_revision: value.source_revision, transactions: value.transactions, links: value.links, legacy: value.legacy });
  if (!same(normalized.selected_account_ids, selectedIds)
    || value.closure_sha256 !== normalized.closure_sha256
    || !same(value.closure_account_ids, normalized.closure_account_ids)
    || !same(value.source_record_ids, normalized.source_record_ids)
    || !same(value.legacy_sale_ids, normalized.legacy_sale_ids)) deny('transaction_closure.binding');
  return normalized;
}
function requestDigest(request) {
  // The closure validator streams its bounded full identity manifest. Bind that
  // verified content digest, not another multi-megabyte canonical serialization.
  const { transaction_closure: closure, ...metadata } = request;
  return assessmentEvidenceDigest({ ...metadata, transaction_closure: {
    version: closure.version, source_revision: closure.source_revision, closure_sha256: closure.closure_sha256,
  } });
}
function requestOf(value) {
  // Reader transport may carry these three fields; they are deliberately absent
  // from hashes, source captures, persistence and the immutable canonical request.
  keys(value, [...REQUEST_KEYS, 'auth', 'selection_grant', 'market_grant'], 'request');
  const scope = scopeOf(value.scope);
  const effectiveDate = assessmentDate(value.effective_date);
  const result = { target: targetOf(value.target), scope, effective_date: effectiveDate,
    selection: selectionOf(value.selection), account_ids: accountIds(value.account_ids, scope.account_id),
    observation_period: periodOf(value.observation_period, effectiveDate), knowledge_cutoff: cutoffOf(value.knowledge_cutoff) };
  result.selection_sha256 = selectionDigest(result);
  if (hash(value.selection_sha256, 'selection_sha256') !== result.selection_sha256) deny('selection_digest_mismatch');
  result.market_decision = marketDecision(value.market_decision);
  result.transaction_closure = closureOf(value.transaction_closure, result.account_ids);
  return frozen(result);
}

/** Verify the ORIGINAL server-composition authority, not an injected verifier. */
export function assertNeighborhoodCachedReadAccess(access) {
  if (!access || !authorities.has(access)) deny('authority_required');
  return access;
}

/**
 * Server-only composition boundary. All callbacks are mandatory trusted services:
 * - resolveAuthorizedAssignment performs current target/workflow assignment
 *   authorization and returns canonical target/scope/effective_date.
 * - resolveTrustedSelection loads/computes the exact authorized server-owned
 *   selection revision. It must NEVER echo HTTP account_ids or trust a caller hash.
 * - authorizeMarketData separately authorizes the stated MLS dataset purpose and
 *   full transaction-association metadata, returning an explicit policy decision.
 *   Its policy must cover ALL source rows in the declared tables for the exact
 *   seeded transactions, across all available event dates. observation_period is
 *   an analytic cohort, not a read-permission filter. Partial source/date/license
 *   entitlement must deny: this reader does not implement licensed-row filtering.
 * - resolveTransactionClosure runs only after that permission check and returns
 *   trusted identity-only transactions/one-hop links/legacy rows seeded solely by
 *   the original selection. It must not seed more transactions from linked accounts.
 * This factory does not authenticate a browser auth object or replace existing
 * assignment/license policies. No callback is configurable from request payloads.
 * Capabilities cannot be saved in jobs: reauthorize and prepare each worker attempt.
 */
export function createNeighborhoodCachedReadAccess(options) {
  keys(options, ['resolveAuthorizedAssignment', 'resolveTrustedSelection', 'authorizeMarketData', 'resolveTransactionClosure', 'ttl_ms'], 'options');
  const { resolveAuthorizedAssignment, resolveTrustedSelection, authorizeMarketData, resolveTransactionClosure } = options;
  if ([resolveAuthorizedAssignment, resolveTrustedSelection, authorizeMarketData, resolveTransactionClosure].some(fn => typeof fn !== 'function')) deny('trusted_callbacks_required');
  const ttl = options.ttl_ms ?? 30_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > NEIGHBORHOOD_CACHED_READ_ACCESS_LIMITS.ttl_ms) deny('ttl_ms');
  requireCatalog();
  const issuer = Object.freeze({});
  const access = Object.freeze({ async prepare(auth, input) {
    // Age includes authorization/selection latency; a stalled trusted service
    // cannot mint a fresh capability from arbitrarily old assignment authority.
    const expires = performance.now() + ttl;
    const checkDeadline = () => { if (performance.now() >= expires) deny('preparation_expired'); };
    requireCatalog();
    keys(input, ['target', 'selection_reference', 'observation_period', 'knowledge_cutoff'], 'prepare');
    const requestedTarget = frozen(targetOf(input.target));
    const reference = frozen(referenceOf(input.selection_reference));
    // Validate/copy caller-controlled values BEFORE crossing an async boundary.
    keys(input.observation_period, ['start_date', 'end_date'], 'observation_period');
    const requestedPeriod = frozen({ start_date: assessmentDate(input.observation_period.start_date),
      end_date: assessmentDate(input.observation_period.end_date) });
    if (requestedPeriod.start_date > requestedPeriod.end_date) deny('observation_period');
    const cutoff = cutoffOf(input.knowledge_cutoff);
    const user = actor(auth);
    const resolved = await resolveAuthorizedAssignment(auth, requestedTarget);
    checkDeadline();
    keys(resolved, ['target', 'scope', 'effective_date'], 'authorized_context');
    const context = frozen({ target: targetOf(resolved.target), scope: scopeOf(resolved.scope),
      effective_date: assessmentDate(resolved.effective_date) });
    if (!same(context.target, requestedTarget)) deny('authorized_target_mismatch');
    permission(auth, context, user);
    const period = periodOf(requestedPeriod, context.effective_date);
    const selected = await resolveTrustedSelection(auth, context, reference);
    checkDeadline();
    keys(selected, ['id', 'revision', 'definition_sha256', 'source_sha256', 'account_ids'], 'trusted_selection');
    const selection = selectionOf({ id: selected.id, revision: selected.revision,
      definition_sha256: selected.definition_sha256, source_sha256: selected.source_sha256 });
    if (!same(reference, { id: selection.id, revision: selection.revision })) deny('selection_reference_mismatch');
    const draft = { target: context.target, scope: context.scope, effective_date: context.effective_date,
      selection, account_ids: accountIds(selected.account_ids, context.scope.account_id),
      observation_period: period, knowledge_cutoff: cutoff };
    const selectedRequest = frozen({ ...draft, selection_sha256: selectionDigest(draft) });
    permission(auth, context, user);
    const purpose = frozen({ kind: 'neighborhood_cached_market_data', selection_sha256: selectedRequest.selection_sha256,
      source_classes: ['core.sales_source_records', 'core.sales', 'core.sale_parcels'],
      source_classification: { 'core.sales_source_records': 'licensed_mls_source_records',
        'core.sales': 'canonical_sales', 'core.sale_parcels': 'transaction_parcel_associations' },
      transaction_scope: 'transactions_intersecting_selection', association_metadata: 'all_transaction_parcel_links',
      event_date_scope: 'all_available_dates_for_seeded_transactions',
      additional_cadastral_accounts: false, private_assignment_overlays: false,
      observation_period: period, knowledge_cutoff: cutoff });
    checkDeadline();
    const authorization = await authorizeMarketData(auth, context, purpose);
    checkDeadline();
    const decision = frozen(marketDecision(authorization, true));
    permission(auth, context, user);
    const closureSelection = frozen({ ...selectedRequest.selection, account_ids: selectedRequest.account_ids,
      selection_sha256: selectedRequest.selection_sha256 });
    const rawClosure = await resolveTransactionClosure(auth, context, closureSelection, purpose);
    checkDeadline();
    const closure = validateCachedTransactionClosure(rawClosure);
    if (!same(closure.selected_account_ids, selectedRequest.account_ids)) deny('transaction_closure.selection');
    permission(auth, context, user);
    const request = frozen({ ...selectedRequest, market_decision: decision, transaction_closure: closure });
    const authorizedAccounts = [...new Set([...request.account_ids, ...closure.closure_account_ids])].sort(compare);
    if (authorizedAccounts.length > NEIGHBORHOOD_CACHED_READ_ACCESS_LIMITS.account_ids) deny('authorized_account_limit');
    const publicGrants = authorizedAccounts.map(accountId => {
      const grant = publicCatalog.authorizePublicCadastralCatalogRead(auth, accountId, {
        workflows: [context.target.workflow_type],
        permissionChecker: (candidate, workflow, requestedPermission) => workflow === context.target.workflow_type
          && requestedPermission === 'read'
          && hasApplicationPermission(candidate, workflow, requestedPermission, context.scope.organization_id),
      });
      publicCatalog.assertPublicCadastralCatalogGrant(grant);
      if (grant.accountId !== accountId || grant.actorUserId !== user) deny('public_grant_mismatch');
      return grant;
    });
    checkDeadline();
    const selectionGrant = Object.freeze({});
    const marketGrant = Object.freeze({});
    const metadata = { issuer, actor: user, request, requestDigest: requestDigest(request),
      publicGrants, authorizedAccounts, purpose, expires, selectionGrant, marketGrant };
    checkDeadline();
    selections.set(selectionGrant, metadata);
    markets.set(marketGrant, metadata);
    return Object.freeze({ request, selection_grant: selectionGrant, market_grant: marketGrant });
  } });
  authorities.set(access, issuer);
  return access;
}

/**
 * Synchronous preflight BEFORE reader normalization/pool.connect/queries. Both
 * tokens are consumed together only after every check succeeds. A failed/expired
 * capture requires fresh server authorization, not restoring serialized tokens.
 * Public catalog grants cover the selected/closure union to authorize its exact
 * identity metadata. They do not expand this reader's CAD/statistical population:
 * CAD detail queries remain limited to account_ids, with no linked-account private
 * overlays, documents or reports. Full transaction links remain metadata only.
 */
export function consumeNeighborhoodCachedReadAccess(access, auth, inputRequest, grants) {
  assertNeighborhoodCachedReadAccess(access);
  requireCatalog();
  keys(grants, ['selection_grant', 'market_grant'], 'grants');
  const selected = selections.get(grants.selection_grant);
  const market = markets.get(grants.market_grant);
  if (!selected || !market || selected !== market || selected.issuer !== authorities.get(access)) deny('original_matching_grants_required');
  if (performance.now() >= selected.expires) {
    selections.delete(selected.selectionGrant); markets.delete(selected.marketGrant);
    deny('expired_grants');
  }
  const request = requestOf(inputRequest);
  if (requestDigest(request) !== selected.requestDigest) deny('request_binding_mismatch');
  permission(auth, request, selected.actor);
  if (selected.purpose.selection_sha256 !== request.selection_sha256
    || !same(selected.purpose.source_classes, ['core.sales_source_records', 'core.sales', 'core.sale_parcels'])
    || selected.purpose.association_metadata !== 'all_transaction_parcel_links'
    || selected.purpose.event_date_scope !== 'all_available_dates_for_seeded_transactions'
    || selected.purpose.additional_cadastral_accounts !== false
    || selected.purpose.private_assignment_overlays !== false) deny('market_purpose_mismatch');
  for (let index = 0; index < selected.publicGrants.length; index++) {
    const grant = publicCatalog.assertPublicCadastralCatalogGrant(selected.publicGrants[index]);
    if (grant.accountId !== selected.authorizedAccounts[index] || grant.actorUserId !== selected.actor) deny('public_grant_mismatch');
  }
  if (performance.now() >= selected.expires) deny('expired_grants');
  selections.delete(selected.selectionGrant); markets.delete(selected.marketGrant);
  return request;
}
