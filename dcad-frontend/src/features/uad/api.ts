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

export interface UadSubjectSummary {
  account_id: string;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  county: string | null;
  neighborhood_code: string | null;
  subdivision: string | null;
  legal_description: string | null;
}

export type UadFieldValue = string | number | boolean | string[] | null;

export interface UadFieldDefinition {
  key: string;
  section: "assignment" | "subject";
  group: string;
  contextKey: string;
  uid: string;
  reportFieldId: string;
  label: string;
  dataType: "string" | "text" | "enum" | "multi_enum" | "boolean" | "integer" | "date" | "state" | "postal_code";
  required?: boolean;
  maxLength?: number;
  options?: string[];
  showWhen?: { uid: string; equals: UadFieldValue };
  ordinal: number;
}

export interface UadEditorSection {
  key: "assignment" | "subject";
  title: string;
  officialSectionNumber: number;
  groups: Array<{ name: string; fields: UadFieldDefinition[] }>;
}

export interface UadSavedFieldValue {
  id: string;
  uid: string;
  context_key: string;
  report_field_id: string;
  value: UadFieldValue;
  source_type: string;
  source_reference: string | null;
  is_appraiser_confirmed: boolean;
  is_override: boolean;
  override_reason: string | null;
  updated_at: string;
}

export interface UadSectionCompletion {
  completed: number;
  required: number;
  percent: number;
}

export interface UadEditorResponse {
  workfile: Pick<UadWorkfile, "id" | "account_id" | "file_number" | "specification_release_key" | "status" | "current_revision" | "updated_at">;
  sections: UadEditorSection[];
  values: UadSavedFieldValue[];
  completion: Record<"assignment" | "subject", UadSectionCompletion>;
}

export async function getUadCapabilities(): Promise<UadCapabilities> {
  return fetchJSON<UadCapabilities>(makeUrl("/api/uad/capabilities"), { timeoutMs: 10_000 });
}

export async function getUadSubjectSummary(accountId: string): Promise<UadSubjectSummary> {
  const response = await fetchJSON<{ subject: UadSubjectSummary }>(
    makeUrl(`/api/uad/accounts/${encodeURIComponent(accountId)}/subject-summary`),
  );
  return response.subject;
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

export async function getUadEditor(workfileId: string): Promise<UadEditorResponse> {
  return fetchJSON<UadEditorResponse>(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/editor`));
}

export async function saveUadSection(
  workfileId: string,
  section: "assignment" | "subject",
  values: Array<{ uid: string; context_key: string; value: UadFieldValue }>,
): Promise<void> {
  await fetchJSON(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/sections/${section}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
}
