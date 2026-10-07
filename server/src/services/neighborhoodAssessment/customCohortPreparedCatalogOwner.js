import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { createCustomCohortPreparedCatalogRegistry } from './customCohortPreparedCatalogRegistry.js';

function invalid() { throw Object.assign(new TypeError('invalid_input'), { reason: 'invalid_input' }); }
function inputOf(value, identityOf, paged) {
  const keys = ['auth', 'accountId', 'assignmentFileId', 'contextRef', ...(paged ? ['pageIndex'] : [])];
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) invalid();
  const copy = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) invalid();
    copy[key] = d.value;
  }
  const contextRef = prepareCustomCohortContextReference(json(copy.contextRef));
  if (paged && (!Number.isSafeInteger(copy.pageIndex) || copy.pageIndex < 0 || copy.pageIndex >= 21)) invalid();
  return Object.freeze({ ...identityOf(copy), contextRef, ...(paged ? { pageIndex: copy.pageIndex } : {}) });
}

/** Internal closed command owner. execute is the CURRENT context owner's
 * transaction boundary, not a browser callback or a source grant. It must
 * reopen original context dependencies and current DB actor/assignment/source/
 * subject rights before AND after work. Private-source contexts are refused:
 * a shared-only derivative must never silently replace their original study.
 * Only explicit internal preparation decodes originals; directory/page reads
 * return a cache miss without compiling, reconstructing members or writing.
 * Whole membership is an internal original-data receipt, not a selected head
 * or map result. Its executor must independently authorize the members purpose.
 * No selection, numeric summary, map projection, Apply or legacy catalog cast.
 */
export function createCustomCohortPreparedCatalogOwner({ identityOf, execute } = {}) {
  if (typeof identityOf !== 'function' || typeof execute !== 'function')
    throw new TypeError('custom_cohort_prepared_catalog_owner_dependencies');
  async function run(value, options, method) {
    const paged = method === 'page', input = inputOf(value, identityOf, paged);
    const membership = method === 'prepareMembership' || method === 'reopenMembership';
    const writing = method === 'prepare' || method === 'prepareMembership';
    return execute(input, options, writing, async ({ client, scopeJson, budget }) => {
      budget.check();
      const registry = createCustomCohortPreparedCatalogRegistry(client, scopeJson, json(input.contextRef),
        { signal: budget.signal, checkBudget: budget.check });
      const result = await registry[method](input.pageIndex); budget.check();
      const envelope = { authority: 'not_established', target: Object.freeze({ account_id: input.accountId,
        assignment_file_id: input.assignmentFileId }), context_ref: input.contextRef };
      if (writing) return Object.freeze({ ...envelope, status: result?.status ?? 'not_prepared' });
      return Object.freeze({ ...envelope, status: result ? 'available' : 'not_prepared',
        ...(paged ? { page_index: input.pageIndex } : {}), [membership ? 'membership' : 'catalog']: result });
    }, membership ? 'membership' : 'catalog');
  }
  return Object.freeze({
    /** Worker/internal-only preparation; not mounted as a browser command. */
    prepareRecordedCatalog: (value, options = {}) => run(value, options, 'prepare'),
    /** Bounded navigation directory; does not claim display pages were read. */
    openPreparedRecordedCatalog: (value, options = {}) => run(value, options, 'open'),
    /** One exact original page, never an analytical membership page. */
    pagePreparedRecordedCatalog: (value, options = {}) => run(value, options, 'page'),
    /** Internal whole-catalog preparation, not the appraiser's selected set. */
    prepareRecordedCatalogMembership: (value, options = {}) => run(value, options, 'prepareMembership'),
    /** Freshly verified original graph; no HTTP/public presenter or map cast. */
    reopenPreparedRecordedCatalogMembership: (value, options = {}) => run(value, options, 'reopenMembership'),
  });
}
