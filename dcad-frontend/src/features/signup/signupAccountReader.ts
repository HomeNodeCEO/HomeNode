import type { AccountDetail } from '../../lib/api';
import { mapAccountDetailToLegacy, type LegacyDcadResponse } from '../../lib/legacyDcadDetail.ts';

/** Share one account response across the signup form's independent prefill effects. */
export function createSignupAccountReader(
  accountId: string,
  getAccount: (id: string) => Promise<AccountDetail>,
  getLegacyDetail: (id: string) => Promise<LegacyDcadResponse>,
) {
  let accountPromise: Promise<AccountDetail> | null = null;
  let detailPromise: Promise<LegacyDcadResponse> | null = null;

  const account = () => {
    accountPromise ??= getAccount(accountId);
    return accountPromise;
  };
  const detail = () => {
    // The legacy adapter calls the same account endpoint. Only retry that path
    // if the shared request or compatibility mapping actually failed.
    detailPromise ??= account().then(mapAccountDetailToLegacy).catch(() => getLegacyDetail(accountId));
    return detailPromise;
  };
  return { account, detail };
}
