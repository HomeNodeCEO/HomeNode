import { types } from 'node:util';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { prepareCustomNeighborhoodRecordedGroupIds } from './customWorkspaceCheckpoint.js';
import { createCustomCohortGroupSelectionRepository,
  prepareCustomCohortGroupSelectionReference } from './customCohortGroupSelectionRepository.js';
import { prepareCustomCohortRecordedGroupSelection,
  prepareCustomCohortGroupSelectionCommandOriginal } from './customCohortRecordedGroupSelection.js';
import { createCohortPagedGroupSelectionV1Store } from './cohortPagedGroupSelectionV1Store.js';
import { prepareNeighborhoodCohortBlobReference as blobRef } from './cohortEvidenceBlobRepository.js';
import { COHORT_PAGED_GROUP_SELECTION_V1_LIMITS as L,
  prepareCohortPagedGroupSelectionV1Metadata } from './cohortPagedGroupSelectionV1.js';
import { CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS } from './customCohortObservationPreview.js';
import { prepareCustomCohortViewport } from './customCohortViewportMap.js';
import { prepareCustomCohortGroupMemberInspection } from './customCohortGroupMemberTransport.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fail(reason) { throw new TypeError(`custom_cohort_recorded_group_owner_${reason}`); }
function admit(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail('invalid_input');
  const result = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail('invalid_input');
    result[key] = d.value;
  }
  return result;
}
function reference(value, limit) {
  const v = admit(value, ['content_sha256', 'canonical_utf8_bytes']);
  const r = blobRef(v.content_sha256, v.canonical_utf8_bytes);
  if (Number(r.canonical_utf8_bytes) > limit) fail('invalid_reference');
  return r;
}

/** Internal methods only. execute owns a single bounded transaction, freshly
 * reloads actor/assignment/source rights before opening catalog or roster facts,
 * and repeats the subject/rights fences before COMMIT/delivery. No public body
 * can provide a source roster, catalog, manifest, actor stamp or group members.
 * Selection intent is not an accepted report, legal boundary or reliability.
 */
export function createCustomCohortRecordedGroupSelectionOwner({ identityOf, execute } = {}) {
  if (typeof identityOf !== 'function' || typeof execute !== 'function') fail('dependencies_required');
  function inputOf(value, write, projection = 'intent') {
    const preview = ['summary', 'viewport', 'members'].includes(projection), workspace = projection === 'workspace';
    const v = admit(value, ['auth', 'accountId', 'assignmentFileId', 'contextRef',
      ...(write ? ['operationId', 'expectedSelectionRef', 'includedRecordedGroupIds'] : []),
      ...(workspace ? ['expectedWorkspaceRevision'] : []),
      ...(preview ? ['selectionRef'] : []), ...(projection === 'viewport' ? ['viewport'] : []),
      ...(projection === 'members' ? ['population', 'page'] : [])]);
    const identity = identityOf(v);
    if (!UUID.test(identity.auth.userId)) fail('invalid_actor');
    const contextRef = prepareCustomCohortContextReference(json(v.contextRef));
    if (!write) return Object.freeze({ ...identity, contextRef,
      ...(preview ? { selectionRef: prepareCustomCohortGroupSelectionReference(v.selectionRef) } : {}),
      ...(projection === 'viewport' ? { viewport: prepareCustomCohortViewport(admit(v.viewport,
        ['west', 'south', 'east', 'north'])) } : {}),
      ...(projection === 'members' ? prepareCustomCohortGroupMemberInspection(v.population, v.page) : {}) });
    if (typeof v.operationId !== 'string' || !UUID.test(v.operationId)) fail('invalid_operation');
    const expectedSelectionRef = v.expectedSelectionRef === null ? null
      : prepareCustomCohortGroupSelectionReference(v.expectedSelectionRef);
    if (expectedSelectionRef?.selection_revision === 2147483647) fail('revision_exhausted');
    if (workspace && (!Number.isInteger(v.expectedWorkspaceRevision) || v.expectedWorkspaceRevision < 1
      || v.expectedWorkspaceRevision >= 2147483647)) fail('invalid_workspace_revision');
    const includedRecordedGroupIds = Object.freeze([...prepareCustomNeighborhoodRecordedGroupIds(v.includedRecordedGroupIds, 3)].sort());
    return Object.freeze({ ...identity, contextRef, operationId: v.operationId,
      expectedSelectionRef, includedRecordedGroupIds,
      ...(workspace ? { expectedWorkspaceRevision: v.expectedWorkspaceRevision } : {}) });
  }
  async function derive(owned, input, commandJson) {
    const command = prepareCustomCohortGroupSelectionCommandOriginal(commandJson);
    return prepareCustomCohortRecordedGroupSelection({ scopeJson: owned.scopeJson,
      contextJson: json(input.contextRef), catalogJson: owned.catalogJson, rosterJson: owned.rosterJson,
      includedGroupIds: command.included_recorded_group_ids, revision: command.selection_revision,
      commandJson, signal: owned.budget.signal, checkBudget: owned.budget.check });
  }
  async function reopen(owned, input, onAccountPage) {
    const repository = createCustomCohortGroupSelectionRepository(owned.client, owned.scopeJson,
      json(input.contextRef), { signal: owned.budget.signal, checkBudget: owned.budget.check });
    const { selection_ref } = await repository.peekCurrent();
    if (input.selectionRef && json(selection_ref) !== json(input.selectionRef))
      throw new TypeError('custom_cohort_group_selection_selection_changed');
    if (selection_ref === null) return null;
    const read = async ref => {
      owned.budget.check();
      const text = await owned.blobs.get(ref.content_sha256, ref.canonical_utf8_bytes);
      if (text === null) fail('missing_original');
      owned.budget.check(); return text;
    };
    const manifest = JSON.parse(await read(reference(selection_ref.manifest_ref, L.manifest_bytes)));
    const metadataJson = await read(reference(manifest.metadata_ref, L.metadata_bytes));
    const metadata = prepareCohortPagedGroupSelectionV1Metadata(metadataJson);
    const catalogOriginal = await read(reference(metadata.catalog_ref, L.metadata_bytes));
    const receipt = JSON.parse(catalogOriginal).selection_command;
    if (!receipt) fail('missing_command_original');
    // The original actor stamp records intent, not permission for this reader.
    const derived = await derive(owned, input, json(receipt));
    if (derived.catalog_original_json !== catalogOriginal || derived.metadata_json !== metadataJson)
      fail('original_mismatch');
    await repository.getCurrent({ metadataJson, selectionRef: selection_ref }, { onAccountPage });
    return { selection_ref, included_recorded_group_ids: derived.included_recorded_group_ids };
  }
  async function completeAccounts(owned, input) {
    const accounts = [];
    const opened = await reopen(owned, input, page => {
      if (accounts.length + page.account_ids.length > CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS.accounts)
        fail('summary_account_limit');
      accounts.push(...page.account_ids);
    });
    // Only after the final original and whole union match may a consumer see it.
    return { accounts: Object.freeze(accounts), reference: opened.selection_ref };
  }
  async function select(value, options, workspace) {
      const input = inputOf(value, true, workspace ? 'workspace' : 'intent');
      return execute(input, options, true, async owned => {
        if (workspace && typeof owned.selectionWorkspace?.save !== 'function') fail('workspace_owner_required');
        // The transaction owner supplies its CURRENT authenticated actor; never
        // accept actor_user_id or request-time role claims as reviewer authority.
        const commandJson = json({ command_version: workspace ? 2 : 1, actor_user_id: owned.auth.userId,
          operation_id: input.operationId, expected_selection_ref: input.expectedSelectionRef,
          included_recorded_group_ids: input.includedRecordedGroupIds,
          selection_revision: (input.expectedSelectionRef?.selection_revision ?? 0) + 1,
          ...(workspace ? { expected_workspace_revision: input.expectedWorkspaceRevision } : {}) });
        const derived = await derive(owned, input, commandJson);
        const stored = await owned.blobs.put(derived.catalog_original_json);
        if (json(stored) !== json(derived.catalog_ref)) fail('storage_conflict');
        const staged = await createCohortPagedGroupSelectionV1Store(owned.blobs).stage({
          metadataJson: derived.metadata_json, membershipPages: derived.membershipPages(),
          signal: owned.budget.signal, checkBudget: owned.budget.check });
        const result = await createCustomCohortGroupSelectionRepository(owned.client, owned.scopeJson,
          json(input.contextRef), { signal: owned.budget.signal, checkBudget: owned.budget.check }).put({
          operationId: input.operationId, expectedSelectionRef: input.expectedSelectionRef,
          metadataJson: derived.metadata_json, manifestRef: staged.manifest_ref });
        const selected = Object.freeze({ ...result, context_ref: input.contextRef,
          included_recorded_group_ids: derived.included_recorded_group_ids });
        const saved = workspace ? await owned.selectionWorkspace.save(selected) : null;
        return saved ? Object.freeze({ ...selected, workspace: saved }) : selected;
      }, workspace ? 'workspace' : 'intent');
  }
  return Object.freeze({
    async selectRecordedGroups(value, options = {}) {
      return select(value, options, false);
    },
    async selectAndSaveRecordedGroups(value, options = {}) {
      return select(value, options, true);
    },
    async readRecordedGroupSelection(value, options = {}) {
      const input = inputOf(value, false);
      return execute(input, options, false, async owned => {
        const opened = await reopen(owned, input);
        if (opened === null) return Object.freeze({ status: 'absent', authority: 'not_established',
          context_ref: input.contextRef, selection_ref: null, included_recorded_group_ids: null });
        return Object.freeze({ status: 'selected', authority: 'not_established', context_ref: input.contextRef,
          ...opened });
      });
    },
    async previewRecordedGroupSelection(value, options = {}) {
      const input = inputOf(value, false, 'summary');
      return execute(input, options, false, async owned => {
        if (typeof owned.presentSelectionSummary !== 'function') fail('summary_owner_required');
        const { accounts, reference } = await completeAccounts(owned, input);
        // No source-statistics consumer sees a prefix. All original pages and
        // the exact current head have succeeded before numeric projection.
        const content = await owned.presentSelectionSummary(accounts, reference);
        owned.budget.check();
        return Object.freeze({ status: 'preview', authority: 'not_established',
          target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
          context_ref: input.contextRef, selection_ref: reference,
          selection_revision: reference.selection_revision, subject_freshness: 'matched',
          ...content, parcel_map: { status: 'omitted', reason: 'geometry_not_requested' },
          apply: { status: 'blocked', reasons: ['observation_preview_only'] } });
      }, 'summary');
    },
    async viewportRecordedGroupSelection(value, options = {}) {
      const input = inputOf(value, false, 'viewport');
      return execute(input, options, false, async owned => {
        if (typeof owned.presentSelectionViewport !== 'function') fail('viewport_owner_required');
        const { accounts, reference } = await completeAccounts(owned, input);
        const viewport_map = await owned.presentSelectionViewport(accounts, reference, input.viewport);
        owned.budget.check();
        return Object.freeze({ status: 'viewport', authority: 'not_established',
          selection_ref: reference, viewport_map });
      }, 'viewport');
    },
    async inspectRecordedGroupSelection(value, options = {}) {
      const input = inputOf(value, false, 'members');
      return execute(input, options, false, async owned => {
        if (typeof owned.presentSelectionMembers !== 'function') fail('members_owner_required');
        const { accounts, reference } = await completeAccounts(owned, input);
        // Paging only bounds delivery. The complete analytical union has been
        // reopened; a cursor can never become a partial replacement selection.
        const content = await owned.presentSelectionMembers(accounts, reference, input.population, input.page);
        owned.budget.check();
        return Object.freeze({ status: 'members', authority: 'not_established',
          target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
          context_ref: input.contextRef, selection_ref: reference,
          selection_revision: reference.selection_revision, subject_freshness: 'matched', ...content,
          apply: { status: 'blocked', reasons: ['observation_preview_only'] } });
      }, 'members');
    },
  });
}
