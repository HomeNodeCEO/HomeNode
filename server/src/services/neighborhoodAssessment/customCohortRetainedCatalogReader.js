import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextScope } from './customCohortContextContract.js';
import { prepareNeighborhoodCohortBlob as blob, prepareNeighborhoodCohortBlobReference as blobRef }
  from './cohortEvidenceBlobRepository.js';
import { CUSTOM_COHORT_RECORDED_CATALOG_PAGE_LIMITS as L } from './customCohortRecordedCatalogPages.js';

const SHA = /^[a-f0-9]{64}$/, GROUP = /^recorded-cad:[a-f0-9]{64}$/, UNASSIGNED = 'discovery:unassigned';
function fail(reason) { throw new TypeError(`custom_cohort_retained_catalog_${reason}`); }
function check(ok, reason = 'shape') { if (!ok) fail(reason); }
function closed(value, keys) {
  check(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length);
  const result = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    check(d?.enumerable && Object.hasOwn(d, 'value')); result[key] = d.value;
  }
  return result;
}
function ref(value, maximum) {
  const r = closed(value, ['content_sha256', 'canonical_utf8_bytes']);
  const checked = blobRef(r.content_sha256, r.canonical_utf8_bytes);
  check(Number(checked.canonical_utf8_bytes) <= maximum, 'reference'); return checked;
}
const same = (a, b) => json(a) === json(b);
function number(value, maximum = 1_000_000) {
  check(Number.isSafeInteger(value) && value >= 0 && value <= maximum, 'count'); return value;
}
function decimal(value, maximum) {
  check(typeof value === 'string' && /^(0|[1-9]\d{0,6})$/.test(value), 'count'); return number(Number(value), maximum);
}
function text(value, maximum = 512) {
  check(typeof value === 'string' && value.length && value.trim() === value && value.isWellFormed()
    && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/.test(value), 'text'); return value;
}
function list(value, maximum) {
  check(Array.isArray(value) && value.length <= maximum, 'array'); return value;
}
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
};

/** Internal display-original reader, NOT registration or authorization.
 * Binding must come from a freshly authorized, exact original-context-scoped
 * prepared registry which registered an ACTUAL complete compiler receipt.
 * Neither the root nor source/roster digests may come from a browser, memory
 * cache, selected subset or caller-supplied catalog. The registry/current-owner
 * must check actual immutable source pins and current assignment/source/subject
 * rights before AND after this read. That registry/transport is not installed
 * here. No source member arrays, compiler replay, inference or analytical
 * membership claim is made; this reads the retained display graph only.
 */
export function createCustomCohortRetainedCatalogReader(repository, binding, operationOptions = {}) {
  check(repository && !isProxy(repository), 'repository');
  const get = Object.getOwnPropertyDescriptor(repository, 'get');
  check(typeof get?.value === 'function', 'repository'); const read = get.value.bind(repository);
  const b = closed(binding, ['scopeJson', 'contextJson', 'manifestRef', 'originalCatalogRef',
    'sourceReadModelSha256', 'rosterAccountIdsSha256']);
  const scope = prepareCustomCohortContextScope(b.scopeJson), context = prepareCustomCohortContextReference(b.contextJson);
  const rootRef = ref(b.manifestRef, L.manifest_bytes), originalRef = ref(b.originalCatalogRef, 750_000);
  check(typeof b.sourceReadModelSha256 === 'string' && SHA.test(b.sourceReadModelSha256)
    && typeof b.rosterAccountIdsSha256 === 'string' && SHA.test(b.rosterAccountIdsSha256), 'source_binding');
  const { signal, checkBudget = () => {} } = operationOptions;
  check((signal === undefined || signal instanceof AbortSignal) && typeof checkBudget === 'function', 'options');
  const live = () => { check(!signal?.aborted, 'cancelled'); checkBudget(); check(!signal?.aborted, 'cancelled'); };
  let busy = false, operations = 0, bytes = 0;
  async function load(reference) {
    live(); check(++operations <= L.operations, 'operations_limit');
    bytes += Number(reference.canonical_utf8_bytes); check(bytes <= L.io_bytes, 'io_bytes_limit');
    const encoded = await read(reference.content_sha256, reference.canonical_utf8_bytes); live();
    check(typeof encoded === 'string' && Buffer.byteLength(encoded) === Number(reference.canonical_utf8_bytes), 'missing_or_changed_original');
    let actual; try { actual = blob(encoded); } catch { fail('missing_or_changed_original'); }
    check(same(actual, reference), 'missing_or_changed_original'); live();
    return { text: encoded, value: JSON.parse(encoded) };
  }
  async function begin() {
    const root = await load(rootRef), r = closed(root.value,
      ['recorded_catalog_version', 'kind', 'metadata_ref', 'group_count', 'account_count', 'pages']);
    check(r.recorded_catalog_version === 1 && r.kind === 'recorded_group_display', 'version');
    const groups = decimal(r.group_count, 2049), accounts = decimal(r.account_count, 1_000_000);
    const metadataRef = ref(r.metadata_ref, L.metadata_bytes);
    const pages = list(r.pages, 21).map((entry, i) => {
      const p = closed(entry, ['page_index', 'group_count', 'page_ref']);
      check(p.page_index === String(i) && decimal(p.group_count, 100) === Math.min(100, groups - i * 100), 'directory');
      return { count: Number(p.group_count), ref: ref(p.page_ref, L.page_bytes) };
    });
    check(pages.length === Math.ceil(groups / 100) && new Set(pages.map(p => p.ref.content_sha256)).size === pages.length, 'directory');
    const metadata = await load(metadataRef), m = closed(metadata.value, ['recorded_catalog_version', 'usage', 'scope',
      'context_ref', 'catalog_version', 'original_catalog_ref', 'original_read_model_sha256', 'roster_account_ids_sha256',
      'group_count', 'account_count', 'assigned_account_count', 'unassigned_account_count', 'subject_membership',
      'limitations', 'unassigned_reason_counts']);
    check(m.recorded_catalog_version === 1 && m.usage === 'retained_recorded_group_display_only' && m.catalog_version === 3
      && same(m.scope, scope) && same(m.context_ref, context) && same(ref(m.original_catalog_ref, 750_000), originalRef)
      && m.original_read_model_sha256 === b.sourceReadModelSha256 && m.roster_account_ids_sha256 === b.rosterAccountIdsSha256
      && number(m.group_count, 2049) === groups && number(m.account_count) === accounts, 'binding');
    const original = await load(originalRef), o = closed(original.value, ['selection_catalog_version', 'usage', 'scope',
      'context_ref', 'catalog_version', 'roster_account_ids_sha256', 'groups']);
    check(o.selection_catalog_version === 2 && o.usage === 'retained_recorded_group_membership_digests'
      && o.catalog_version === 3 && same(o.scope, scope) && same(o.context_ref, context)
      && o.roster_account_ids_sha256 === b.rosterAccountIdsSha256, 'binding');
    let total = 0, unresolved = 0, prior = '';
    const descriptors = list(o.groups, 2049).map(raw => {
      const g = closed(raw, ['id', 'member_count', 'account_ids_sha256']);
      check(typeof g.id === 'string' && (g.id === UNASSIGNED || GROUP.test(g.id)) && g.id > prior
        && number(g.member_count) > 0 && typeof g.account_ids_sha256 === 'string' && SHA.test(g.account_ids_sha256), 'group');
      total += g.member_count; check(total <= accounts, 'count'); if (g.id === UNASSIGNED) unresolved = g.member_count;
      prior = g.id; return g;
    });
    check(descriptors.length === groups && total === accounts && number(m.unassigned_account_count) === unresolved
      && number(m.assigned_account_count) === accounts - unresolved, 'partition');
    const subject = closed(m.subject_membership, ['account_id', 'assigned_pocket_id', 'recorded_label_match_only', 'status']);
    check(subject.account_id === scope.account_id && subject.recorded_label_match_only === true
      && ['recorded_label_matched', 'unassigned', 'conflicting_evidence', 'invalid_evidence', 'not_in_discovery'].includes(subject.status)
      && (subject.status === 'recorded_label_matched') === (subject.assigned_pocket_id !== null)
      && (subject.assigned_pocket_id === null || descriptors.some(g => g.id === subject.assigned_pocket_id && g.id !== UNASSIGNED))
      && (accounts !== 0 || subject.status === 'not_in_discovery')
      && (!['unassigned', 'conflicting_evidence', 'invalid_evidence'].includes(subject.status) || unresolved > 0), 'subject');
    const limitations = list(m.limitations, 64).map(v => text(v, 200));
    check(new Set(limitations).size === limitations.length, 'limitations');
    const reasons = list(m.unassigned_reason_counts, 64).map(raw => {
      const r = closed(raw, ['reason', 'member_count']); text(r.reason, 200);
      check(number(r.member_count) > 0 && r.member_count <= unresolved, 'reasons'); return r.reason;
    });
    check(new Set(reasons).size === reasons.length, 'reasons');
    return { root, metadata, original, metadataRef, pages, descriptors };
  }
  async function end(state) {
    check((await load(originalRef)).text === state.original.text, 'ending_original');
    check((await load(state.metadataRef)).text === state.metadata.text, 'ending_original');
    check((await load(rootRef)).text === state.root.text, 'ending_original'); live();
  }
  async function page(state, index) {
    const encoded = await load(state.pages[index].ref), p = closed(encoded.value,
      ['recorded_catalog_version', 'kind', 'metadata_ref', 'page_index', 'groups']);
    check(p.recorded_catalog_version === 1 && p.kind === 'recorded_group_display' && p.page_index === String(index)
      && same(ref(p.metadata_ref, L.metadata_bytes), state.metadataRef), 'page');
    const entries = list(p.groups, 100); check(entries.length === state.pages[index].count, 'page');
    for (let i = 0; i < entries.length; i++) {
      const g = closed(entries[i], ['id', 'label', 'county', 'member_count', 'account_ids_sha256']);
      check(same({ id: g.id, member_count: g.member_count, account_ids_sha256: g.account_ids_sha256 },
        state.descriptors[index * 100 + i]), 'page_membership');
      text(g.label);
      if (g.id === UNASSIGNED) check(g.county === null && g.label === 'Unresolved recorded groups', 'page'); else text(g.county);
    }
    return encoded;
  }
  async function run(work) {
    live(); check(!busy, 'operation_in_progress'); busy = true;
    try { return await work(); } finally { busy = false; }
  }
  return Object.freeze({
    async open() {
      return run(async () => {
        const s = await begin(); await end(s);
        // Directory is navigation only: no display page was read.
        return Object.freeze({ authority: 'not_established', status: 'display_directory', manifest_ref: rootRef,
          manifest_json: s.root.text, metadata_json: s.metadata.text });
      });
    },
    async page(index) {
      check(Number.isSafeInteger(index) && index >= 0 && index < 21, 'page_index');
      return run(async () => {
        const s = await begin(); check(index < s.pages.length, 'page_index');
        const p = await page(s, index); await end(s);
        return Object.freeze({ page_ref: s.pages[index].ref, page_json: p.text });
      });
    },
    async reopen() {
      return run(async () => {
        const s = await begin(), groups = [];
        for (let i = 0; i < s.pages.length; i++) groups.push(...(await page(s, i)).value.groups);
        await end(s);
        return freeze({ authority: 'not_established', status: 'complete_display_catalog', manifest_ref: rootRef,
          metadata: s.metadata.value, groups, retention_refs: [originalRef, s.metadataRef, ...s.pages.map(p => p.ref), rootRef] });
      });
    },
  });
}
