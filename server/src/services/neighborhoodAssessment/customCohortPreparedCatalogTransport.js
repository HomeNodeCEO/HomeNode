import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextScope } from './customCohortContextContract.js';
import { prepareNeighborhoodCohortBlob as blob, prepareNeighborhoodCohortBlobReference as blobRef } from './cohortEvidenceBlobRepository.js';

export const CUSTOM_COHORT_PREPARED_CATALOG_REQUEST_BYTES = 2_048;
export const CUSTOM_COHORT_PREPARED_CATALOG_RESPONSE_BYTES = 512_000;
const SHA = /^[a-f0-9]{64}$/, GROUP = /^recorded-cad:[a-f0-9]{64}$/;
function fail(output = false) {
  throw Object.assign(new TypeError(output ? 'custom_cohort_prepared_catalog_invalid_response' : 'invalid_input'),
    { reason: output ? 'prepared_catalog_response_invalid' : 'invalid_input' });
}
function check(ok) { if (!ok) fail(); }
function closed(value, keys) {
  check(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length);
  const result = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key); check(d?.enumerable && Object.hasOwn(d, 'value')); result[key] = d.value;
  }
  return result;
}
const same = (a, b) => json(a) === json(b);
const context = value => prepareCustomCohortContextReference(json(closed(value, ['context_id', 'context_revision', 'context_sha256'])));
function integer(value, maximum) { check(Number.isSafeInteger(value) && value >= 0 && value <= maximum); return value; }
function decimal(value, maximum) { check(typeof value === 'string' && /^(0|[1-9]\d{0,6})$/.test(value)); return integer(Number(value), maximum); }
function text(value, maximum = 512) {
  check(typeof value === 'string' && value.length > 0 && value.trim() === value && value.isWellFormed()
    && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/.test(value)); return value;
}
function ref(value, maximum) {
  const r = closed(value, ['content_sha256', 'canonical_utf8_bytes']), result = blobRef(r.content_sha256, r.canonical_utf8_bytes);
  check(Number(result.canonical_utf8_bytes) <= maximum); return result;
}
function original(encoded, reference, maximum) {
  check(typeof encoded === 'string' && Buffer.byteLength(encoded) <= maximum);
  check(same(blob(encoded), ref(reference, maximum))); return JSON.parse(encoded);
}

/** Closed read syntax only. Roots, digests, members, roles and prepare commands
 * cannot enter through a browser. Auth is supplied only by route middleware. */
export function prepareCustomCohortPreparedCatalogRequest(body, paged = false) {
  try {
    const value = closed(body, ['assignment_file_id', 'context_ref', ...(paged ? ['page_index'] : [])]);
    check(typeof value.assignment_file_id === 'string' && /^[1-9]\d{0,18}$/.test(value.assignment_file_id)
      && BigInt(value.assignment_file_id) <= 9223372036854775807n);
    return Object.freeze({ assignment_file_id: value.assignment_file_id, context_ref: context(value.context_ref),
      ...(paged ? { page_index: integer(value.page_index, 20) } : {}) });
  } catch { fail(); }
}

/** Versioned bounded display originals only. Current ownership/source checking
 * is the service's responsibility; hashes and syntax do NOT supply a grant.
 * A directory is not a complete catalog, a page is not an individual membership
 * proof, and a cache miss never triggers synchronous source reconstruction. */
export function presentCustomCohortPreparedCatalogResponse(result, request, accountId, paged = false) {
  try {
    const r = closed(result, ['status', 'authority', 'target', 'context_ref', 'catalog', ...(paged ? ['page_index'] : [])]);
    const target = closed(r.target, ['account_id', 'assignment_file_id']), c = context(r.context_ref);
    check(r.authority === 'not_established' && same(c, request.context_ref)
      && target.account_id === accountId && target.assignment_file_id === request.assignment_file_id
      && ['available', 'not_prepared'].includes(r.status) && (!paged || r.page_index === request.page_index));
    if (r.status === 'not_prepared') check(r.catalog === null);
    else if (paged) {
      const page = closed(r.catalog, ['page_ref', 'page_json']);
      const p = closed(original(page.page_json, page.page_ref, 200_000),
        ['recorded_catalog_version', 'kind', 'metadata_ref', 'page_index', 'groups']);
      check(p.recorded_catalog_version === 1 && p.kind === 'recorded_group_display' && p.page_index === String(request.page_index));
      ref(p.metadata_ref, 32_000); check(Array.isArray(p.groups) && p.groups.length > 0 && p.groups.length <= 100);
      let prior = '';
      for (const raw of p.groups) {
        const g = closed(raw, ['id', 'label', 'county', 'member_count', 'account_ids_sha256']);
        check(typeof g.id === 'string' && (GROUP.test(g.id) || g.id === 'discovery:unassigned') && g.id > prior
          && integer(g.member_count, 1_000_000) > 0 && typeof g.account_ids_sha256 === 'string' && SHA.test(g.account_ids_sha256));
        text(g.label); if (g.id === 'discovery:unassigned') check(g.county === null && g.label === 'Unresolved recorded groups'); else text(g.county);
        prior = g.id;
      }
    } else {
      const d = closed(r.catalog, ['status', 'authority', 'manifest_ref', 'manifest_json', 'metadata_json']);
      check(d.status === 'display_directory' && d.authority === 'not_established');
      const root = closed(original(d.manifest_json, d.manifest_ref, 16_000),
        ['recorded_catalog_version', 'kind', 'metadata_ref', 'group_count', 'account_count', 'pages']);
      check(root.recorded_catalog_version === 1 && root.kind === 'recorded_group_display');
      const groups = decimal(root.group_count, 2049), accounts = decimal(root.account_count, 1_000_000);
      check(Array.isArray(root.pages) && root.pages.length === Math.ceil(groups / 100));
      const hashes = new Set();
      root.pages.forEach((raw, i) => {
        const p = closed(raw, ['page_index', 'group_count', 'page_ref']);
        check(p.page_index === String(i) && decimal(p.group_count, 100) === Math.min(100, groups - i * 100));
        const key = ref(p.page_ref, 200_000).content_sha256; check(!hashes.has(key)); hashes.add(key);
      });
      const m = closed(original(d.metadata_json, root.metadata_ref, 32_000), ['recorded_catalog_version', 'usage', 'scope',
        'context_ref', 'catalog_version', 'original_catalog_ref', 'original_read_model_sha256', 'roster_account_ids_sha256',
        'group_count', 'account_count', 'assigned_account_count', 'unassigned_account_count', 'subject_membership',
        'limitations', 'unassigned_reason_counts']);
      const scope = prepareCustomCohortContextScope(json(m.scope));
      check(m.recorded_catalog_version === 1 && m.usage === 'retained_recorded_group_display_only' && m.catalog_version === 3
        && same(context(m.context_ref), c) && scope.account_id === accountId && scope.assignment_file_id === request.assignment_file_id
        && m.group_count === groups && m.account_count === accounts
        && typeof m.original_read_model_sha256 === 'string' && SHA.test(m.original_read_model_sha256)
        && typeof m.roster_account_ids_sha256 === 'string' && SHA.test(m.roster_account_ids_sha256));
      ref(m.original_catalog_ref, 750_000);
      check(integer(m.assigned_account_count, accounts) + integer(m.unassigned_account_count, accounts) === accounts);
      const subject = closed(m.subject_membership, ['account_id', 'assigned_pocket_id', 'recorded_label_match_only', 'status']);
      check(subject.account_id === accountId && subject.recorded_label_match_only === true
        && ['recorded_label_matched', 'unassigned', 'conflicting_evidence', 'invalid_evidence', 'not_in_discovery'].includes(subject.status)
        && (subject.assigned_pocket_id === null || (typeof subject.assigned_pocket_id === 'string' && GROUP.test(subject.assigned_pocket_id))));
      check(Array.isArray(m.limitations) && m.limitations.length <= 64); m.limitations.forEach(v => text(v, 200));
      check(Array.isArray(m.unassigned_reason_counts) && m.unassigned_reason_counts.length <= 64);
      for (const raw of m.unassigned_reason_counts) {
        const reason = closed(raw, ['reason', 'member_count']); text(reason.reason, 200);
        check(integer(reason.member_count, m.unassigned_account_count) > 0);
      }
    }
    check(Buffer.byteLength(JSON.stringify(r)) <= CUSTOM_COHORT_PREPARED_CATALOG_RESPONSE_BYTES);
    return Object.freeze({ status: r.status, authority: 'not_established', target: Object.freeze(target),
      context_ref: c, ...(paged ? { page_index: r.page_index } : {}), catalog: r.catalog });
  } catch { fail(true); }
}
