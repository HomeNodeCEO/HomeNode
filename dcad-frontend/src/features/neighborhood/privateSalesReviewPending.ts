import { checkPrivateSalesIdentity, checkPrivateSalesReceipt, PrivateSalesError } from './privateSalesImports.ts';
import type { PrivateSalesIdentity, PrivateSalesReceipt } from './privateSalesImports';
import { preparePrivateSalesReviewCommand } from './privateSalesReview.ts';
import type { PrivateSalesReviewCommand } from './privateSalesReview';

export interface PrivateSalesReviewPending {
  pending_version: 1; account_id: string; assignment_file_id: string; session_key: string;
  report_file_id: string; batch_id: string; source_sha256: string; preparation_sha256: string;
  operation_id: string; command: PrivateSalesReviewCommand;
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (identity: PrivateSalesIdentity, receipt: PrivateSalesReceipt) => {
  checkPrivateSalesIdentity(identity); checkPrivateSalesReceipt(receipt, identity, receipt.report_file_id);
  return 'homenode:private-sales-review:1:' + JSON.stringify([identity.accountId, identity.assignmentFileId,
    identity.sessionKey, receipt.report_file_id, receipt.batch_id]);
};
export function makePrivateSalesReviewPending(identity: PrivateSalesIdentity, receipt: PrivateSalesReceipt,
  operationId: string, command: PrivateSalesReviewCommand): PrivateSalesReviewPending {
  key(identity, receipt);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)) throw new PrivateSalesError('invalid_pending_review');
  return { pending_version: 1, account_id: identity.accountId, assignment_file_id: String(identity.assignmentFileId),
    session_key: identity.sessionKey, report_file_id: receipt.report_file_id, batch_id: receipt.batch_id,
    source_sha256: receipt.source_sha256, preparation_sha256: receipt.preparation_sha256,
    operation_id: operationId, command: preparePrivateSalesReviewCommand(command) };
}
export function readPrivateSalesReviewPending(storage: Storage, identity: PrivateSalesIdentity,
  receipt: PrivateSalesReceipt): PrivateSalesReviewPending | null {
  try {
    const raw = storage.getItem(key(identity, receipt));
    if (raw === null) return null;
    if (raw.length > 300000) throw new Error();
    const value = JSON.parse(raw);
    const expected = makePrivateSalesReviewPending(identity, receipt, value.operation_id, value.command);
    if (Object.keys(value).length !== Object.keys(expected).length || Object.entries(expected).some(([name, field]) =>
      name === 'command' ? JSON.stringify(value.command) !== JSON.stringify(field) : value[name] !== field)) throw new Error();
    return expected;
  } catch { throw new PrivateSalesError('pending_storage_unavailable'); }
}
export function savePrivateSalesReviewPending(storage: Storage, identity: PrivateSalesIdentity,
  receipt: PrivateSalesReceipt, pending: PrivateSalesReviewPending) {
  try {
    const normalized = makePrivateSalesReviewPending(identity, receipt, pending.operation_id, pending.command);
    if (JSON.stringify(normalized) !== JSON.stringify(pending)) throw new Error();
    const previous = readPrivateSalesReviewPending(storage, identity, receipt);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) throw new Error();
    const value = JSON.stringify(normalized);
    storage.setItem(key(identity, receipt), value);
    if (storage.getItem(key(identity, receipt)) !== value) throw new Error();
  } catch { throw new PrivateSalesError('pending_storage_unavailable'); }
}
export function clearPrivateSalesReviewPending(storage: Storage, identity: PrivateSalesIdentity, receipt: PrivateSalesReceipt) {
  try {
    const name = key(identity, receipt); storage.removeItem(name);
    if (storage.getItem(name) !== null) throw new Error();
  } catch { throw new PrivateSalesError('pending_storage_unavailable'); }
}
