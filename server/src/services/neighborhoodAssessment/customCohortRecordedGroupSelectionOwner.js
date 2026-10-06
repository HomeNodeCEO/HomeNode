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
async function headOriginal(owned, selectionRef) {
  const read = async ref => {
    owned.budget.check();
    const text = await owned.blobs.get(ref.content_sha256, ref.canonical_utf8_bytes);
    if (text === null) fail('missing_original');
    owned.budget.check(); return text;
  };
  const manifest = JSON.parse(await read(reference(selectionRef.manifest_ref, L.manifest_bytes)));
  const metadataJson = await read(reference(manifest.metadata_ref, L.metadata_bytes));
  const metadata = prepareCohortPagedGroupSelectionV1Metadata(metadataJson);
  const catalogOriginal = await read(reference(metadata.catalog_ref, L.metadata_bytes));
  const original = JSON.parse(catalogOriginal), receipt = original.selection_command;
  if (!receipt) fail('missing_command_original');
  const identityVersion = original.selection_catalog_version;
  if (identityVersion !== 1 && identityVersion !== 2) fail('invalid_catalog_identity_version');
  return { metadataJson, catalogOriginal, receipt, identityVersion };
}

/** Internal methods only. execute owns a single bounded transaction, freshly
 * reloads actor/assignment/source rights before opening catalog or roster facts,
 * and repeats the subject/rights fences before COMMIT/delivery. No public body
 * can provide a source roster, catalog, manifest, actor stamp or group members.
 * Selection intent is not an accepted report, legal boundary or reliability.
 */
export function createCustomCohortRecordedGroupSelectionOwner({ identityOf, execute } = {}) {
  if (typeof identityOf !== 'function' || typeof execute !== 'function') fail('dependencies_required');
  function inputOf(value, write) {
    const v = admit(value, ['auth', 'accountId', 'assignmentFileId', 'contextRef',
      ...(write ? ['operationId', 'expectedSelectionRef', 'includedRecordedGroupIds'] : [])]);
    const identity = identityOf(v);
    if (!UUID.test(identity.auth.userId)) fail('invalid_actor');
    const contextRef = prepareCustomCohortContextReference(json(v.contextRef));
    if (!write) return Object.freeze({ ...identity, contextRef });
    if (typeof v.operationId !== 'string' || !UUID.test(v.operationId)) fail('invalid_operation');
    const expectedSelectionRef = v.expectedSelectionRef === null ? null
      : prepareCustomCohortGroupSelectionReference(v.expectedSelectionRef);
    if (expectedSelectionRef?.selection_revision === 2147483647) fail('revision_exhausted');
    const includedRecordedGroupIds = Object.freeze([...prepareCustomNeighborhoodRecordedGroupIds(v.includedRecordedGroupIds, 3)].sort());
    return Object.freeze({ ...identity, contextRef, operationId: v.operationId,
      expectedSelectionRef, includedRecordedGroupIds });
  }
  async function derive(owned, input, commandJson, catalogIdentityVersion) {
    const command = prepareCustomCohortGroupSelectionCommandOriginal(commandJson);
    return prepareCustomCohortRecordedGroupSelection({ scopeJson: owned.scopeJson,
      contextJson: json(input.contextRef), catalogJson: owned.catalogJson, rosterJson: owned.rosterJson,
      includedGroupIds: command.included_recorded_group_ids, revision: command.selection_revision,
      commandJson, catalogIdentityVersion, signal: owned.budget.signal, checkBudget: owned.budget.check });
  }
  return Object.freeze({
    async selectRecordedGroups(value, options = {}) {
      const input = inputOf(value, true);
      return execute(input, options, true, async owned => {
        // The transaction owner supplies its CURRENT authenticated actor; never
        // accept actor_user_id or request-time role claims as reviewer authority.
        const commandJson = json({ command_version: 1, actor_user_id: owned.auth.userId,
          operation_id: input.operationId, expected_selection_ref: input.expectedSelectionRef,
          included_recorded_group_ids: input.includedRecordedGroupIds,
          selection_revision: (input.expectedSelectionRef?.selection_revision ?? 0) + 1 });
        const repository = createCustomCohortGroupSelectionRepository(owned.client, owned.scopeJson,
          json(input.contextRef), { signal: owned.budget.signal, checkBudget: owned.budget.check });
        const { selection_ref: current } = await repository.peekCurrent();
        let identityVersion = 2;
        if (current !== null && json(current) !== json(input.expectedSelectionRef)) {
          const original = await headOriginal(owned, current);
          // An exact lost-ACK replay must use its retained producer version;
          // never rewrite an older original or silently reinterpret v1 bytes.
          // The repository still verifies the full request and current head.
          if (original.receipt.operation_id === input.operationId) identityVersion = original.identityVersion;
        }
        const derived = await derive(owned, input, commandJson, identityVersion);
        const stored = await owned.blobs.put(derived.catalog_original_json);
        if (json(stored) !== json(derived.catalog_ref)) fail('storage_conflict');
        const staged = await createCohortPagedGroupSelectionV1Store(owned.blobs).stage({
          metadataJson: derived.metadata_json, membershipPages: derived.membershipPages(),
          signal: owned.budget.signal, checkBudget: owned.budget.check });
        const result = await repository.put({
          operationId: input.operationId, expectedSelectionRef: input.expectedSelectionRef,
          metadataJson: derived.metadata_json, manifestRef: staged.manifest_ref });
        return Object.freeze({ ...result, context_ref: input.contextRef,
          included_recorded_group_ids: derived.included_recorded_group_ids });
      });
    },
    async readRecordedGroupSelection(value, options = {}) {
      const input = inputOf(value, false);
      return execute(input, options, false, async owned => {
        const repository = createCustomCohortGroupSelectionRepository(owned.client, owned.scopeJson,
          json(input.contextRef), { signal: owned.budget.signal, checkBudget: owned.budget.check });
        const { selection_ref } = await repository.peekCurrent();
        if (selection_ref === null) return Object.freeze({ status: 'absent', authority: 'not_established',
          context_ref: input.contextRef, selection_ref: null, included_recorded_group_ids: null });
        const { metadataJson, catalogOriginal, receipt, identityVersion } = await headOriginal(owned, selection_ref);
        // An older actor stamp is retained intent, not permission for this reader.
        // Re-derive against today's authorized complete catalog/roster using
        // the ORIGINAL producer version (v2 ignores presentation only), then
        // verify all paged originals and that this is still the current head.
        const derived = await derive(owned, input, json(receipt), identityVersion);
        if (derived.catalog_original_json !== catalogOriginal || derived.metadata_json !== metadataJson)
          fail('original_mismatch');
        await repository.getCurrent({ metadataJson, selectionRef: selection_ref });
        return Object.freeze({ status: 'selected', authority: 'not_established', context_ref: input.contextRef,
          selection_ref, included_recorded_group_ids: derived.included_recorded_group_ids });
      });
    },
  });
}
