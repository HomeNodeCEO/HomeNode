import { CUSTOM_COHORT_CAPTURE_INPUT_LIMITS as L } from './customCohortCaptureInputs.js';
import { NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS as B } from './cohortEvidenceBlobRepository.js';
import { customCohortSelectionBinding } from './customCohortPreviewPresentation.js';

const fail = () => { throw Object.assign(new Error('invalid_selection'), { reason: 'invalid_selection' }); };
function closed(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key))) fail();
}
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 100
  && Buffer.byteLength(value) <= 400 && !/[\u0000-\u001f\u007f]/.test(value);

/** Open only the original request's account roster AFTER current source rights
 * have been checked. No geometry, source payload, statistics or effective-date
 * interpretation is needed to authorize an independent market observation. */
export async function checkCustomCohortMarketMembership({ store, rosterRef, selection, contextRef, checkBudget }) {
  const binding = customCohortSelectionBinding(selection, contextRef);
  checkBudget();
  const original = await store.get(rosterRef?.content_sha256, rosterRef?.canonical_utf8_bytes);
  if (original === null) fail();
  const manifest = JSON.parse(original);
  closed(manifest, ['collection_version', 'kind', 'entry_count', 'pages']);
  if (manifest.collection_version !== 1 || manifest.kind !== 'request_accounts'
    || !/^(?:0|[1-9]\d*)$/.test(manifest.entry_count) || Number(manifest.entry_count) > L.accounts
    || !Array.isArray(manifest.pages) || manifest.pages.length > L.blobs) fail();
  let totalBytes = 0, count = 0;
  const roster = new Set(), refs = manifest.pages.map((page, index) => {
    closed(page, ['page_index', 'entry_count', 'page']);
    if (page.page_index !== String(index) || !/^[1-9]\d*$/.test(page.entry_count)
      || Number(page.entry_count) > L.page_entries) fail();
    closed(page.page, ['content_sha256', 'canonical_utf8_bytes']);
    if (!/^[a-f0-9]{64}$/.test(page.page.content_sha256) || !/^[1-9]\d*$/.test(page.page.canonical_utf8_bytes)
      || Number(page.page.canonical_utf8_bytes) > L.page_utf8_bytes) fail();
    totalBytes += Number(page.page.canonical_utf8_bytes);
    // 50,000 bounded identifiers plus page envelopes, not the whole capture.
    if (totalBytes > 8_000_000) fail();
    return page.page;
  });
  for (let offset = 0; offset < refs.length;) {
    checkBudget();
    const batch = []; let bytes = 0;
    while (offset + batch.length < refs.length && batch.length < B.records) {
      const ref = refs[offset + batch.length], size = Number(ref.canonical_utf8_bytes);
      if (batch.length && bytes + size > B.bytes) break;
      batch.push(ref); bytes += size;
    }
    const values = await store.getPreparedBatch(batch);
    if (!Array.isArray(values) || values.length !== batch.length) fail();
    values.forEach((value, index) => {
      if (typeof value?.canonicalJson !== 'string') fail();
      const page = JSON.parse(value.canonicalJson), pageIndex = offset + index;
      closed(page, ['collection_version', 'kind', 'page_index', 'entries']);
      if (page.collection_version !== 1 || page.kind !== 'request_accounts' || page.page_index !== String(pageIndex)
        || !Array.isArray(page.entries) || page.entries.length !== Number(manifest.pages[pageIndex].entry_count)) fail();
      for (const account of page.entries) {
        if (!id(account) || roster.has(account) || ++count > L.accounts) fail();
        roster.add(account);
      }
    });
    offset += batch.length;
  }
  if (count !== Number(manifest.entry_count)) fail();
  const accountIds = [...new Set(selection.pockets.flatMap(pocket => pocket.account_ids))].sort();
  if (accountIds.some(account => !id(account) || !roster.has(account))) fail();
  checkBudget();
  return { binding, accountIds };
}
