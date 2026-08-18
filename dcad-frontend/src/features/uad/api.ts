import { makeUrl } from "@/lib/api";

async function uadFetchJSON<T = unknown>(input: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), init?.timeoutMs ?? 25_000);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const isJson = (response.headers.get("content-type") || "").includes("application/json");
    if (!response.ok) {
      const body = isJson ? await response.json().catch(() => null) as {
        error?: string;
        message?: string;
        details?: Array<{ message?: string }>;
      } | null : null;
      const details = body?.details?.map((detail) => detail.message).filter(Boolean) || [];
      throw new Error(details.length ? details.join(" ") : body?.error || body?.message || `HTTP ${response.status}`);
    }
    return (isJson ? response.json() : response.text()) as Promise<T>;
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") throw new Error("Request timed out");
    throw reason;
  } finally {
    window.clearTimeout(timeout);
  }
}

export type UadPropertyType =
  | "traditional_single_family"
  | "manufactured_home"
  | "two_to_four_unit"
  | "condominium"
  | "cooperative";

export interface UadCapabilities {
  enabled: boolean;
  specification_release_key: string;
  initial_property_type: UadPropertyType;
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
  property_type: UadPropertyType;
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

export type UadSectionKey = "assignment" | "subject" | "site" | "disaster_mitigation" | "energy_green" | "sketch" | "dwelling_exterior" | "manufactured_home";
export type UadMeasurement = { amount: number | null; unit: string };
export type UadFieldValue = string | number | boolean | string[] | UadMeasurement | null;

export interface UadCondition {
  key?: string;
  uid?: string;
  equals?: UadFieldValue;
  notEquals?: UadFieldValue;
  greaterThan?: number;
  contains?: string;
  present?: boolean;
  all?: UadCondition[];
  any?: UadCondition[];
  not?: UadCondition;
}

export interface UadFieldDefinition {
  key: string;
  section: UadSectionKey;
  group: string;
  contextKey: string;
  uid: string;
  reportFieldId: string;
  label: string;
  dataType: "string" | "text" | "enum" | "multi_enum" | "boolean" | "integer" | "percentage" | "measurement" | "date" | "year" | "state" | "postal_code";
  entityType?: string;
  required?: boolean;
  maxLength?: number;
  options?: string[];
  units?: string[];
  minimum?: number;
  maximum?: number;
  minimumExclusive?: number;
  showWhen?: UadCondition;
  requiredWhen?: UadCondition;
  ordinal: number;
}

export interface UadEditorSection {
  key: UadSectionKey;
  title: string;
  officialSectionNumber: number;
  applicable?: boolean;
  appliesToEntityType?: string;
  appliesWhen?: UadCondition;
  groups: Array<{
    name: string;
    fields: UadFieldDefinition[];
    entityType?: string;
    addLabel?: string;
    minItems?: number;
    createEnabled?: boolean;
    parentEntityType?: string;
    showWhen?: UadCondition;
  }>;
}

export interface UadEntity {
  id: string;
  workfile_id: string;
  parent_entity_id: string | null;
  entity_type: string;
  entity_identifier: string;
  ordinal: number;
  label: string | null;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UadSavedFieldValue {
  id: string;
  entity_id: string | null;
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
  entities: UadEntity[];
  values: UadSavedFieldValue[];
  completion: Record<UadSectionKey, UadSectionCompletion>;
}

export interface UadAsset {
  id: string;
  entity_id: string | null;
  asset_kind: string;
  section_number: number | null;
  caption_type: string | null;
  caption: string | null;
  original_file_name: string | null;
  content_type: string;
  byte_size: number | null;
  status: string;
  capture_metadata: Record<string, unknown>;
  uploaded_at: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface UadSketch {
  id: string;
  workfile_id: string;
  entity_id: string | null;
  schema_version: string;
  geometry: Record<string, unknown>;
  measurements: Record<string, unknown>;
  calculated_areas: Record<string, unknown>;
  area_overrides: Record<string, unknown>;
  rendered_asset_id: string | null;
  source: "homenode" | "mobile" | "imported" | "third_party";
  created_at: string;
  updated_at: string;
}

export async function getUadCapabilities(): Promise<UadCapabilities> {
  return uadFetchJSON<UadCapabilities>(makeUrl("/api/uad/capabilities"), { timeoutMs: 10_000 });
}

export async function getUadSubjectSummary(accountId: string): Promise<UadSubjectSummary> {
  const response = await uadFetchJSON<{ subject: UadSubjectSummary }>(
    makeUrl(`/api/uad/accounts/${encodeURIComponent(accountId)}/subject-summary`),
  );
  return response.subject;
}

export async function listUadWorkfiles(accountId: string): Promise<UadWorkfile[]> {
  const response = await uadFetchJSON<{ workfiles: UadWorkfile[] }>(
    makeUrl(`/api/uad/accounts/${encodeURIComponent(accountId)}/workfiles`),
  );
  return response.workfiles || [];
}

export async function createUadWorkfile(
  accountId: string,
  input: { file_number?: string; assignment_purpose?: string } = {},
): Promise<UadWorkfile> {
  const response = await uadFetchJSON<{ workfile: UadWorkfile }>(
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
  return uadFetchJSON<UadEditorResponse>(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/editor`));
}

export async function saveUadSection(
  workfileId: string,
  section: UadSectionKey,
  values: Array<{ uid: string; context_key: string; entity_id?: string | null; value: UadFieldValue }>,
): Promise<void> {
  await uadFetchJSON(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/sections/${section}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
}

export async function createUadEntity(workfileId: string, entityType: string, parentEntityId?: string): Promise<UadEntity> {
  const response = await uadFetchJSON<{ entity: UadEntity }>(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/entities`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entity_type: entityType, parent_entity_id: parentEntityId || null }),
  });
  return response.entity;
}

export async function deleteUadEntity(workfileId: string, entityId: string): Promise<void> {
  await uadFetchJSON(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/entities/${encodeURIComponent(entityId)}`), { method: "DELETE" });
}

export async function listUadAssets(workfileId: string): Promise<UadAsset[]> {
  const response = await uadFetchJSON<{ assets: UadAsset[] }>(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/assets`));
  return response.assets || [];
}

export async function uploadUadAsset(
  workfileId: string,
  file: File,
  input: { asset_kind: string; section_number: number; entity_id?: string; caption_type?: string; caption?: string },
): Promise<UadAsset> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const inferredContentType: Record<string, string> = {
    avif: "image/avif", bmp: "image/bmp", gif: "image/gif", jpg: "image/jpeg",
    jpeg: "image/jpeg", png: "image/png", tif: "image/tiff", tiff: "image/tiff",
    webp: "image/webp", heic: "image/heic", heif: "image/heif", svg: "image/svg+xml",
    pdf: "application/pdf", json: "application/json",
  };
  const contentType = file.type || inferredContentType[extension || ""];
  if (!contentType) throw new Error("This file type is not supported for UAD storage.");
  const created = await uadFetchJSON<{
    asset_id: string;
    upload: { method: string; url: string; headers: Record<string, string> };
  }>(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/assets/upload-url`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      file_name: file.name,
      content_type: contentType,
      byte_size: file.size,
      capture_metadata: { source: "homenode_web" },
    }),
  });
  const uploaded = await fetch(created.upload.url, {
    method: created.upload.method,
    headers: { ...created.upload.headers, "content-type": contentType },
    body: file,
  });
  if (!uploaded.ok) throw new Error(`The file could not be uploaded to secure storage (${uploaded.status}).`);
  const verified = await uadFetchJSON<{ asset: UadAsset }>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/assets/${encodeURIComponent(created.asset_id)}/verify`),
    { method: "POST" },
  );
  return verified.asset;
}

export async function deleteUadAsset(workfileId: string, assetId: string): Promise<void> {
  await uadFetchJSON(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/assets/${encodeURIComponent(assetId)}`),
    { method: "DELETE" },
  );
}

export async function listUadSketches(workfileId: string): Promise<UadSketch[]> {
  const response = await uadFetchJSON<{ sketches: UadSketch[] }>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/sketches`),
  );
  return response.sketches || [];
}

export async function saveUadSketch(
  workfileId: string,
  input: Pick<UadSketch, "schema_version" | "geometry" | "measurements" | "calculated_areas" | "area_overrides" | "source">
    & Partial<Pick<UadSketch, "entity_id" | "rendered_asset_id">>,
): Promise<UadSketch> {
  const response = await uadFetchJSON<{ sketch: UadSketch }>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/sketches`),
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return response.sketch;
}

export async function getUadSharedData(workfileId: string): Promise<{
  suggestions: { site_fields: unknown[]; site_entities: unknown[] };
  adapters: Record<string, { ready: boolean; mode: string; enabled_in_uad_editor: boolean }>;
}> {
  return uadFetchJSON(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/shared-data`));
}
