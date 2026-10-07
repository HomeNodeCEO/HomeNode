import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlob as blob, prepareNeighborhoodCohortBlobReference as blobRef }
  from './cohortEvidenceBlobRepository.js';
import { createCustomCohortRetainedMembershipReader } from './customCohortRetainedMembershipReader.js';
import { prepareCustomCohortGroupSelectionCommandOriginal } from './customCohortRecordedGroupSelection.js';
import { createCohortPagedGroupSelectionV1Store } from './cohortPagedGroupSelectionV1Store.js';

// Representation/staging budget only, NOT a live acquisition/cap increase.
const L = Object.freeze({ operations:1024,bytes:256_000_000,page_entries:1000 });
function check(ok,reason) { if (!ok) throw new TypeError(`custom_cohort_retained_group_stage_${reason}`); }
const same = (a,b) => json(a) === json(b);
function closed(value,keys) {
  check(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length,'shape');
  const out = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value,key);
    check(d?.enumerable && Object.hasOwn(d,'value'),'shape'); out[key] = d.value;
  }
  return out;
}

/** Stage exact existing v2 command/catalog identity from ACTUAL stored whole
 * membership originals, not dense catalog/roster arrays. Binding must come from
 * a current source-checked registry in the owner's same transaction. Counts are
 * not substituted for members: every original member/union page is verified at
 * both ends; selected pages also pass the unchanged exact paged-store verifier.
 * No current source grant, selected-head registration, COMMIT, map/numeric/report
 * result or browser command is supplied here. Caller rolls back ALL failed work
 * and independently fences current actor/assignment/subject/source both ends. */
export function createCustomCohortRetainedGroupSelectionStage(repository,binding,{ signal,checkBudget = () => {} } = {}) {
  check(repository && !isProxy(repository),'repository');
  const get = Object.getOwnPropertyDescriptor(repository,'get'),put = Object.getOwnPropertyDescriptor(repository,'put');
  check(typeof get?.value === 'function' && typeof put?.value === 'function','repository');
  const read = get.value.bind(repository),write = put.value.bind(repository);
  const b = closed(binding,['scopeJson','contextJson','manifestRef','originalCatalogRef',
    'sourceReadModelSha256','rosterAccountIdsSha256','witnessRef']);
  check(typeof checkBudget === 'function' && (signal === undefined || signal instanceof AbortSignal),'options');
  const live = () => { check(!signal?.aborted,'cancelled'); checkBudget(); check(!signal?.aborted,'cancelled'); };
  let busy = false,operations = 0,bytes = 0;
  const charge = size => {
    live(); check(Number.isSafeInteger(size) && size > 0 && size <= 1_500_000,'io_size');
    check(++operations <= L.operations,'operations_limit'); bytes += size; check(bytes <= L.bytes,'io_bytes_limit');
  };
  const bounded = Object.freeze({
    async get(hash,length) { charge(Number(length)); const value = await read(hash,length); live(); return value; },
    async put(text) { charge(Buffer.byteLength(text)); const value = await write(text); live(); return value; },
  });
  const op = { signal,checkBudget:live };
  // Validate nested references BEFORE encoding, so a getter/proxy cannot run
  // while detaching. Constructor validation alone is not a graph witness.
  createCustomCohortRetainedMembershipReader(bounded,b,op);
  const captured = JSON.parse(json(b));
  async function load(ref) {
    const text = await bounded.get(ref.content_sha256,ref.canonical_utf8_bytes);
    check(typeof text === 'string' && same(blob(text),ref),'missing_or_changed_original'); return text;
  }
  return Object.freeze({ async stage(commandJson) {
    live(); check(!busy,'operation_in_progress');
    const command = prepareCustomCohortGroupSelectionCommandOriginal(commandJson);
    const context = JSON.parse(captured.contextJson);
    if (command.command_version === 3) check(command.expected_workspace_checkpoint.pending_capture.operation_id === context.context_id,'command_mismatch');
    busy = true;
    try {
      const original = await createCustomCohortRetainedMembershipReader(bounded,captured,op).reopen();
      const baseText = await load(captured.originalCatalogRef),base = JSON.parse(baseText);
      const whole = JSON.parse(original.metadata_json),manifest = JSON.parse(original.manifest_json);
      check(same(base.groups,whole.groups) && same(base.scope,whole.scope)
        && same(base.context_ref,whole.context_ref) && base.roster_account_ids_sha256 === captured.rosterAccountIdsSha256,'binding');
      const included = new Set(command.included_recorded_group_ids);
      check(command.included_recorded_group_ids.every(id => base.groups.some(g => g.id === id)),'unknown_group');
      const catalog_original_json = json({ ...base,selection_command:command }),catalog_ref = blob(catalog_original_json);
      const metadata_json = json({ ...whole,catalog_ref,revision:command.selection_revision,
        groups:base.groups.filter(g => included.has(g.id)) });
      async function* pages() {
        // Consume only one original page and one output buffer at a time.
        // Rechunk AFTER filtering, preserving the unchanged producer's exact
        // selected page bytes and ordered digest, not source-page boundaries.
        let pending = [];
        for (let index = 0; index < manifest.membership_pages.length; index++) {
          live(); const p = manifest.membership_pages[index],page = JSON.parse(await load(p.page));
          check(page.selection_version === 1 && page.kind === 'recorded_group_memberships'
            && page.page_index === String(index) && page.entries.length === Number(p.entry_count),'page');
          for (const row of page.entries) if (included.has(row.group_id)) {
            pending.push(row);
            if (pending.length === L.page_entries) { yield pending; pending = []; live(); }
          }
        }
        if (pending.length) { yield pending; live(); } live();
      }
      const ack = closed(await bounded.put(catalog_original_json),['content_sha256','canonical_utf8_bytes']);
      check(same(blobRef(ack.content_sha256,ack.canonical_utf8_bytes),catalog_ref),'storage_ack');
      const store = createCohortPagedGroupSelectionV1Store(bounded);
      const args = { metadataJson:metadata_json,...op };
      const selected = await store.stage({ ...args,membershipPages:pages() });
      const verified = await store.verify({ ...args,manifestRef:selected.manifest_ref });
      check(verified.manifest_json === selected.manifest_json
        && selected.account_count === base.groups.filter(g => included.has(g.id)).reduce((n,g) => n + g.member_count,0),'selection');
      // No provisional pages/counts are delivered until a FRESH whole-original
      // verification and the derived command original both still agree.
      const ending = await createCustomCohortRetainedMembershipReader(bounded,captured,op).reopen();
      check(same(ending,original) && await load(captured.originalCatalogRef) === baseText
        && await load(catalog_ref) === catalog_original_json,'ending_original'); live();
      const selectedManifest = JSON.parse(selected.manifest_json);
      const refs = [...original.retention_refs,catalog_ref,blob(metadata_json),selected.manifest_ref,
        ...selectedManifest.membership_pages.map(p => p.page),...selectedManifest.account_pages.map(p => p.page)];
      return Object.freeze({ authority:'not_established',status:'staged_group_selection',
        source_witness_ref:original.witness_ref,catalog_original_json,catalog_ref,metadata_json,
        manifest_json:selected.manifest_json,manifest_ref:selected.manifest_ref,
        selection_revision:command.selection_revision,selection_sha256:selected.selection_sha256,
        account_count:selected.account_count,included_recorded_group_ids:Object.freeze([...command.included_recorded_group_ids]),
        retention_refs:Object.freeze([...new Map(refs.map(r => [r.content_sha256,Object.freeze(r)])).values()]) });
    } finally { busy = false; }
  } });
}
