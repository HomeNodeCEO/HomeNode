import { createHash } from 'node:crypto';
import { canonicalAssessmentJson } from './contract.js';

export const CACHED_TRANSACTION_CLOSURE_VERSION = 1;
export const CACHED_TRANSACTION_CLOSURE_LIMITS = Object.freeze({ accounts: 50_000, identity_records: 100_000, bytes: 8_000_000 });
const INPUT = ['selected_account_ids', 'source_revision', 'transactions', 'links', 'legacy'];
const TRANSACTION = ['source_record_id', 'sale_id', 'primary_account_id', 'sale_account_id', 'source_record_hash'];
const LINK = ['parcel_link_id', 'source_record_id', 'source_position', 'parcel_sequence', 'account_id', 'is_resolved'];
const LEGACY = ['sale_id', 'sale_account_id'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareBig = (a, b) => a === null ? (b === null ? 0 : -1) : b === null ? 1 : a.length - b.length || compare(a, b);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function fail(reason) {
  const error = new TypeError(`invalid_neighborhood_transaction_closure:${reason}`);
  error.code = 'NEIGHBORHOOD_TRANSACTION_CLOSURE_INVALID'; error.reason = reason; throw error;
}
function object(value, fields, field) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== fields.length) fail(field);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) fail(field);
  }
  return value;
}
function array(value, field) { if (!Array.isArray(value)) fail(field); return value; }
function at(rows, index) {
  const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('identity_array_entry');
  return descriptor.value;
}
function account(value, optional = false) {
  if (optional && value === null) return null;
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) fail('account_id');
  // Surrounding space is an alias only. Keep Collin R prefixes, punctuation,
  // leading zeroes, and case intact; no numeric/string coercion or fuzzy match.
  const normalized = value.trim();
  if (!normalized || normalized.length > 64) fail('account_id');
  return normalized;
}
function text(value, field) {
  if (typeof value !== 'string' || !value || value.length > 200 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) fail(field);
  return value;
}
function bigint(value, field, optional = false) {
  if (value === null && optional) return null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail(field);
  return value;
}
function position(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32767) fail('parcel_position');
  return value;
}
function limitsOf(requested = {}) {
  if (!requested || Object.getPrototypeOf(requested) !== Object.prototype) fail('limits');
  const limits = { ...CACHED_TRANSACTION_CLOSURE_LIMITS };
  for (const [key, value] of Object.entries(requested)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) fail('limits');
    limits[key] = value;
  }
  return limits;
}

/** Validate identity-only one-hop closure supplied by the trusted, licensed
 * server resolver. This is not authorization or evidence that parcel membership
 * is complete. Never pass raw browser rows or echo a reader's own result as its
 * expected closure. A source revision/digest binds content, not provider trust.
 * Selected stock stays exact: closure does not recursively select other source
 * transactions merely because they mention a newly associated parcel.
 */
export function validateCachedTransactionClosure(input, { limits: requested } = {}) {
  object(input, INPUT, 'input');
  const limits = limitsOf(requested), sourceRevision = text(input.source_revision, 'source_revision');
  const selectedInput = array(input.selected_account_ids, 'selected_account_ids');
  const transactionInput = array(input.transactions, 'transactions'), linkInput = array(input.links, 'links'), legacyInput = array(input.legacy, 'legacy');
  if (selectedInput.length > limits.accounts || transactionInput.length + linkInput.length + legacyInput.length > limits.identity_records) fail('identity_limit');
  let bytes = 1024; // bounded output field names/count delimiters/version/digest
  const charge = value => {
    bytes += Buffer.byteLength(canonicalAssessmentJson(value)) + 1;
    if (bytes > limits.bytes) fail('metadata_limit');
  };
  charge(sourceRevision);
  const selected = new Set(), closure = new Set(), accountUniverse = new Set(), sources = new Map(), saleIds = new Set(), sourceSalePairs = new Set();
  const transactions = [], links = [], legacy = [], parcelIds = new Set(), parcelPositions = new Set();
  for (let index = 0; index < selectedInput.length; index++) {
    const id = account(at(selectedInput, index));
    if (selected.has(id)) fail('duplicate_selected_account');
    charge(id); selected.add(id); accountUniverse.add(id);
  }
  const includeAccount = id => {
    if (id === null || closure.has(id)) return;
    if (!accountUniverse.has(id) && accountUniverse.size >= limits.accounts) fail('account_limit');
    charge(id); closure.add(id); accountUniverse.add(id);
  };
  for (let index = 0; index < transactionInput.length; index++) {
    const raw = object(at(transactionInput, index), TRANSACTION, 'transaction');
    const row = { source_record_id: bigint(raw.source_record_id, 'source_record_id'), sale_id: bigint(raw.sale_id, 'sale_id', true),
      primary_account_id: account(raw.primary_account_id, true), sale_account_id: account(raw.sale_account_id, true),
      source_record_hash: raw.source_record_hash === null ? null : text(raw.source_record_hash, 'source_record_hash') };
    const pair = `${row.source_record_id}:${row.sale_id ?? 'null'}`;
    if (sourceSalePairs.has(pair)) fail('duplicate_transaction');
    if (row.sale_id === null && row.sale_account_id !== null) fail('sale_identity_mismatch');
    if (row.sale_id !== null && saleIds.has(row.sale_id)) fail('duplicate_sale_id');
    const previous = sources.get(row.source_record_id);
    if (previous && (previous.primary !== row.primary_account_id || previous.hash !== row.source_record_hash || previous.nullSale !== (row.sale_id === null))) fail('source_identity_mismatch');
    charge(row);
    const source = previous || { primary: row.primary_account_id, hash: row.source_record_hash, nullSale: row.sale_id === null, anchored: false };
    source.anchored ||= selected.has(row.primary_account_id) || selected.has(row.sale_account_id);
    sources.set(row.source_record_id, source); sourceSalePairs.add(pair);
    if (row.sale_id !== null) saleIds.add(row.sale_id);
    includeAccount(row.primary_account_id); includeAccount(row.sale_account_id); transactions.push(row);
  }
  for (let index = 0; index < linkInput.length; index++) {
    const raw = object(at(linkInput, index), LINK, 'link');
    const row = { parcel_link_id: bigint(raw.parcel_link_id, 'parcel_link_id'), source_record_id: bigint(raw.source_record_id, 'source_record_id'),
      source_position: position(raw.source_position), parcel_sequence: position(raw.parcel_sequence),
      account_id: account(raw.account_id, true), is_resolved: raw.is_resolved };
    if (row.is_resolved !== null && typeof row.is_resolved !== 'boolean') fail('is_resolved');
    const source = sources.get(row.source_record_id);
    if (!source) fail('unknown_source_link');
    const key = `${row.source_record_id}:${row.source_position}:${row.parcel_sequence}`;
    if (parcelIds.has(row.parcel_link_id) || parcelPositions.has(key)) fail('duplicate_link');
    charge(row); parcelIds.add(row.parcel_link_id); parcelPositions.add(key);
    source.anchored ||= selected.has(row.account_id);
    includeAccount(row.account_id); links.push(row);
  }
  for (const source of sources.values()) if (!source.anchored) fail('unanchored_source');
  for (let index = 0; index < legacyInput.length; index++) {
    const raw = object(at(legacyInput, index), LEGACY, 'legacy');
    const row = { sale_id: bigint(raw.sale_id, 'sale_id'), sale_account_id: account(raw.sale_account_id) };
    if (!selected.has(row.sale_account_id)) fail('legacy_not_selected');
    if (saleIds.has(row.sale_id)) fail('duplicate_sale_id');
    charge(row); saleIds.add(row.sale_id); includeAccount(row.sale_account_id); legacy.push(row);
  }
  transactions.sort((a, b) => compareBig(a.source_record_id, b.source_record_id) || compareBig(a.sale_id, b.sale_id));
  links.sort((a, b) => compareBig(a.source_record_id, b.source_record_id) || a.source_position - b.source_position || a.parcel_sequence - b.parcel_sequence);
  legacy.sort((a, b) => compareBig(a.sale_id, b.sale_id));
  const sourceRecordIds = [...sources.keys()].sort(compareBig), legacySaleIds = legacy.map(row => row.sale_id);
  for (const id of sourceRecordIds) charge(id);
  for (const id of legacySaleIds) charge(id);
  const result = { version: CACHED_TRANSACTION_CLOSURE_VERSION, selected_account_ids: [...selected].sort(compare), source_revision: sourceRevision,
    transactions, links, legacy, closure_account_ids: [...closure].sort(compare), source_record_ids: sourceRecordIds, legacy_sale_ids: legacySaleIds };
  const digest = createHash('sha256');
  digest.update(canonicalAssessmentJson({ version: result.version, source_revision: result.source_revision,
    policy: 'direct-selected-source-one-hop-v1' })).update('\n');
  for (const key of ['selected_account_ids', 'transactions', 'links', 'legacy', 'closure_account_ids', 'source_record_ids', 'legacy_sale_ids']) {
    digest.update(canonicalAssessmentJson({ collection: key, count: result[key].length })).update('\n');
    for (const row of result[key]) digest.update(canonicalAssessmentJson(row)).update('\n');
  }
  return freeze({ ...result, closure_sha256: digest.digest('hex') });
}
