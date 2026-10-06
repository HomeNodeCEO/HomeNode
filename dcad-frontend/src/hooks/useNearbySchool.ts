import { useEffect, useState } from 'react';
import { fetchWithApplicationAuthentication, makeUrl } from '@/lib/api';
import { createNeighborhoodSchoolTransport } from '@/features/neighborhood/customCohortPreviewTransport';
import { checkedNearbySchoolContext } from '@/lib/nearbySchoolContext';
import type { NearbySchoolContext } from '@/lib/nearbySchoolContext';
const read = createNeighborhoodSchoolTransport({ request: fetchWithApplicationAuthentication, urlFor: makeUrl });

/** Optional, once per draft file; never awaited by the map or selection owner. */
export function useNearbySchool(accountId: string | undefined, fileId: number | undefined, editable: boolean,
  saved: NearbySchoolContext | undefined): NearbySchoolContext | null {
  const key = `${accountId}:${fileId}`;
  const retained = accountId && fileId ? checkedNearbySchoolContext(saved, accountId, String(fileId)) : null;
  const retainedAt = retained?.captured_at;
  const [result, setResult] = useState<{ key: string; value: NearbySchoolContext | null } | null>(null);
  useEffect(() => {
    if (!accountId || !fileId || !editable || retainedAt) return;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10_000);
    read(accountId, String(fileId), { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) setResult({ key, value: checkedNearbySchoolContext(value, accountId, String(fileId)) });
    }).catch(() => { /* Missing optional facts remain editable template placeholders. */ })
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); abort.abort(); };
  }, [accountId, fileId, editable, key, retainedAt]);
  return retained ?? (result?.key === key ? result.value : null);
}
