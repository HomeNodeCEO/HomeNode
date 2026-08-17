import { fetchJSON, makeUrl } from "@/lib/api";

export interface UadCapabilities {
  enabled: boolean;
  specification_release_key: string;
  initial_property_type: "traditional_single_family";
  object_storage: {
    provider: string;
    configured: boolean;
  };
}

export interface UadWorkfile {
  id: string;
  organization_id: string | null;
  account_id: string;
  file_number: string;
  specification_release_key: string;
  status: string;
  property_type: string;
  inspection_method: string;
  assignment_purpose: string | null;
  assigned_appraiser_user_id: string | null;
  supervisory_appraiser_user_id: string | null;
  current_revision: number;
  created_at: string;
  updated_at: string;
}

export async function getUadCapabilities(): Promise<UadCapabilities> {
  return fetchJSON<UadCapabilities>(makeUrl("/api/uad/capabilities"), { timeoutMs: 10_000 });
}

export async function listUadWorkfiles(accountId: string): Promise<UadWorkfile[]> {
  const response = await fetchJSON<{ workfiles: UadWorkfile[] }>(
    makeUrl(`/api/uad/accounts/${encodeURIComponent(accountId)}/workfiles`),
  );
  return response.workfiles || [];
}

export async function createUadWorkfile(
  accountId: string,
  input: { file_number?: string; assignment_purpose?: string } = {},
): Promise<UadWorkfile> {
  const response = await fetchJSON<{ workfile: UadWorkfile }>(
    makeUrl(`/api/uad/accounts/${encodeURIComponent(accountId)}/workfiles`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return response.workfile;
}
