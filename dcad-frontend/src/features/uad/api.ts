import { makeUrl } from "@/lib/api";

import { withUadAuthorization } from "./auth";

export const UAD_WORKFILE_MUTATED_EVENT = "homenode:uad-workfile-mutated";

function announceUadWorkfileMutation(workfileId: string) {
  window.dispatchEvent(new CustomEvent(UAD_WORKFILE_MUTATED_EVENT, { detail: { workfileId } }));
}

async function uadFetchJSON<T = unknown>(input: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), init?.timeoutMs ?? 25_000);
  try {
    const authorizedInit = await withUadAuthorization(init);
    const response = await fetch(input, { ...authorizedInit, signal: controller.signal });
    const isJson = (response.headers.get("content-type") || "").includes("application/json");
    if (!response.ok) {
      const body = isJson ? await response.json().catch(() => null) as {
        error?: string;
        message?: string;
        details?: unknown;
      } | null : null;
      const details = Array.isArray(body?.details)
        ? body.details
            .map((detail) => (
              detail && typeof detail === "object" && "message" in detail
                ? String(detail.message || "")
                : ""
            ))
            .filter(Boolean)
        : [];
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
    isolated: boolean;
  };
  delivery_package?: {
    profile: string;
    requires_signed_revision: boolean;
    includes_external_images: boolean;
  };
  compliance?: {
    enabled: boolean;
    providers: Record<string, {
      provider: string;
      enabled: boolean;
      configured: boolean;
      environment: string | null;
    }>;
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

export type UadSectionKey = "assignment" | "subject" | "site" | "disaster_mitigation" | "energy_green" | "sketch" | "dwelling_exterior" | "manufactured_home" | "unit_interior" | "functional_obsolescence" | "outbuilding" | "vehicle_storage" | "subject_property_amenities" | "overall_quality_condition" | "highest_best_use" | "market" | "project_information" | "subject_listing_information" | "sales_contract" | "prior_sale_transfer_history" | "sales_comparison" | "reconciliation" | "certifications";
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
  dataType: "string" | "text" | "enum" | "multi_enum" | "boolean" | "integer" | "percentage" | "currency" | "measurement" | "date" | "month" | "year" | "state" | "postal_code";
  entityType?: string;
  required?: boolean;
  readOnly?: boolean;
  calculated?: boolean;
  maxLength?: number;
  options?: string[];
  units?: string[];
  minimum?: number;
  maximum?: number;
  minimumExclusive?: number;
  showWhen?: UadCondition;
  requiredWhen?: UadCondition;
  guidance?: string;
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
    maxItems?: number;
    createEnabled?: boolean;
    parentEntityType?: string;
    parentEntityTypes?: string[];
    showWhen?: UadCondition;
    entityDataFilter?: Record<string, unknown>;
    createData?: Record<string, unknown>;
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
  expectedRevision: number,
  options: { saveReason?: "manual_save" | "autosave" } = {},
): Promise<{ current_revision: number; save_reason: "manual_save" | "autosave"; changed_field_count: number }> {
  const result = await uadFetchJSON<{ current_revision: number; save_reason: "manual_save" | "autosave"; changed_field_count: number }>(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/sections/${section}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      values,
      expected_revision: expectedRevision,
      save_reason: options.saveReason || "manual_save",
    }),
  });
  announceUadWorkfileMutation(workfileId);
  return result;
}

export async function createUadEntity(
  workfileId: string,
  entityType: string,
  parentEntityId?: string,
  data?: Record<string, unknown>,
): Promise<UadEntity> {
  const response = await uadFetchJSON<{ entity: UadEntity }>(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/entities`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entity_type: entityType, parent_entity_id: parentEntityId || null, data: data || {} }),
  });
  announceUadWorkfileMutation(workfileId);
  return response.entity;
}

export async function deleteUadEntity(workfileId: string, entityId: string): Promise<void> {
  await uadFetchJSON(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/entities/${encodeURIComponent(entityId)}`), { method: "DELETE" });
  announceUadWorkfileMutation(workfileId);
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
    webp: "image/webp", heic: "image/heic", heif: "image/heif",
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
  announceUadWorkfileMutation(workfileId);
  return verified.asset;
}

export async function deleteUadAsset(workfileId: string, assetId: string): Promise<void> {
  await uadFetchJSON(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/assets/${encodeURIComponent(assetId)}`),
    { method: "DELETE" },
  );
  announceUadWorkfileMutation(workfileId);
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
  announceUadWorkfileMutation(workfileId);
  return response.sketch;
}

export interface UadCompletionSuggestionField {
  suggestion_id: string;
  field_key: string;
  value: UadFieldValue;
  target_entity?: { entity_type: string; entity_identifier: string };
  source_reference: string;
  source_digest_sha256: string;
  observed_at: string | null;
  requires_appraiser_confirmation: true;
}

export interface UadCompletionSuggestionEntity {
  suggestion_id: string;
  entity_type: string;
  ordinal: number;
  source_key?: string;
  values: Record<string, UadFieldValue>;
  related_entities?: Array<Omit<UadCompletionSuggestionEntity, "suggestion_id">>;
  source_reference: string;
  source_digest_sha256: string;
  observed_at: string | null;
  requires_appraiser_confirmation: true;
}

export interface UadCompletionSuggestions {
  schema_version: number;
  adapter_version: string;
  source_kind?: "custom_appraisal_completion" | "homenode_shared_data";
  status: "ready_for_review" | "source_review_required";
  source_completion: {
    source_report_file_id: string;
    target_report_file_id: string;
    appraisal_case_id: string | null;
    subject_snapshot_id: string | null;
    source_digest_sha256: string;
  };
  xml: {
    specification_release_key: string;
    delivery_specification_version: string;
    subschema_version: string;
    mismo_reference_model_identifier: string;
    source_sha256: string;
    mapped_unique_ids: number;
    mapped_entity_types: number;
  };
  suggestions: {
    assignment_fields: UadCompletionSuggestionField[];
    subject_entity_fields: UadCompletionSuggestionField[];
    subject_amenity_fields: UadCompletionSuggestionField[];
    subject_amenity_entities: UadCompletionSuggestionEntity[];
    site_fields: UadCompletionSuggestionField[];
    site_influence_entities: UadCompletionSuggestionEntity[];
    condition_fields: UadCompletionSuggestionField[];
    project_fields: UadCompletionSuggestionField[];
    highest_best_use_fields: UadCompletionSuggestionField[];
    subject_listing_fields: UadCompletionSuggestionField[];
    subject_listing_entities: UadCompletionSuggestionEntity[];
    sales_contract_fields: UadCompletionSuggestionField[];
    subject_prior_transfer_fields: UadCompletionSuggestionField[];
    subject_prior_transfer_entities: UadCompletionSuggestionEntity[];
    market_fields: UadCompletionSuggestionField[];
    market_entities: UadCompletionSuggestionEntity[];
    sales_comparison_fields: UadCompletionSuggestionField[];
    sales_comparable_entities: UadCompletionSuggestionEntity[];
    sales_comparison_additional_property_entities: UadCompletionSuggestionEntity[];
    reconciliation_fields: UadCompletionSuggestionField[];
  };
  omissions: Array<{ scope?: string; code: string; source_value?: unknown; target_field_key?: string; target_field_keys?: string[] }>;
  counts: { field_suggestions: number; entity_suggestions: number; omissions: number };
  apply_mode: "review_only";
  requires_appraiser_confirmation: true;
}

export interface UadCompletionApplyResult {
  current_revision: number;
  applied_suggestion_count: number;
  applied_field_count?: number;
  applied_entity_count?: number;
  conflicts: Array<{ suggestion_id: string; reason: string }>;
  created_entities: Array<{ id: string; entity_type: string }>;
}

export async function getUadSharedData(workfileId: string): Promise<{
  suggestions: {
    site_fields: unknown[];
    site_entities: unknown[];
    market_fields: unknown[];
    subject_listing_fields: unknown[];
    subject_listing_entities: unknown[];
    subject_prior_transfer_fields: unknown[];
    subject_prior_transfer_entities: unknown[];
    custom_completion: UadCompletionSuggestions | null;
    review_document: UadCompletionSuggestions | null;
  };
  adapters: Record<string, { ready: boolean; mode: string; enabled_in_uad_editor: boolean }>;
}> {
  return uadFetchJSON(makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/shared-data`));
}

export async function applyUadCompletionSuggestions(
  workfileId: string,
  input: {
    selected_suggestion_ids: string[];
    expected_source_digest_sha256: string;
    expected_adapter_version: string;
    expected_revision: number;
    preserve_existing: true;
    confirmed: true;
  },
): Promise<UadCompletionApplyResult> {
  const result = await uadFetchJSON<UadCompletionApplyResult>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/completion-suggestions/apply`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  announceUadWorkfileMutation(workfileId);
  return result;
}

export interface UadValidationFinding {
  id: string;
  rule_id: string | null;
  severity: "fatal" | "warning";
  uad_uid: string | null;
  report_field_id: string | null;
  entity_id: string | null;
  message: string;
  status: "open" | "resolved" | "accepted" | "superseded";
  metadata: {
    section?: UadSectionKey | "catalog";
    field_key?: string | null;
    context_key?: string | null;
    code?: string;
    validator_version?: string;
  };
  created_at: string;
}

export interface UadValidationRun {
  id: string;
  workfile_id: string;
  revision_number: number;
  specification_release_key: string;
  validator_type: "local_compliance";
  status: "passed" | "failed" | "error" | "running";
  fatal_count: number;
  warning_count: number;
  started_at: string;
  completed_at: string | null;
  metadata: {
    validator_version?: string;
    applicable_sections?: UadSectionKey[];
    field_value_count?: number;
    entity_count?: number;
    asset_count?: number;
    sketch_count?: number;
    input_digest_sha256?: string;
  };
  workfile_status: string;
  is_current_revision: boolean;
  ready_for_export: boolean;
  findings: UadValidationFinding[];
}

export async function getLatestUadValidation(workfileId: string): Promise<UadValidationRun | null> {
  const response = await uadFetchJSON<{ validation: UadValidationRun | null }>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/validation`),
  );
  return response.validation;
}

export async function runLocalUadValidation(workfileId: string): Promise<UadValidationRun> {
  const response = await uadFetchJSON<{ validation: UadValidationRun }>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/validation`),
    { method: "POST" },
  );
  return response.validation;
}

export interface UadCertificationSigner {
  role: "appraiser" | "supervisory_appraiser";
  user_id: string | null;
  display_name: string | null;
  signature_policy: string | null;
  profile_status: string | null;
  organization_name: string | null;
  license: {
    jurisdiction: string | null;
    license_number: string | null;
    license_type: string;
    expires_on: string | null;
  } | null;
  ready: boolean;
  missing: string[];
}

export interface UadCertificationReadiness {
  workfile_id: string;
  revision_number: number;
  workfile_status: string;
  ready: boolean;
  artifact_readiness?: {
    pdf_ready: boolean;
    missing: Array<"current_pdf">;
  };
  signers: UadCertificationSigner[];
  current_signer: UadCertificationSigner;
}

export interface UadSignatureResult {
  signature: {
    id: string;
    workfile_id: string;
    revision_number: number;
    signer_user_id: string;
    signer_role: "appraiser" | "supervisory_appraiser";
    signature_asset_id: string | null;
    authentication_method: string;
    signed_at: string;
    execution_date: string;
    workfile_input_digest_sha256: string;
    credential_snapshot_sha256: string;
  };
  workfile_status: string;
}

export async function getUadCertificationReadiness(workfileId: string): Promise<UadCertificationReadiness> {
  const response = await uadFetchJSON<{ readiness: UadCertificationReadiness }>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/certification-readiness`),
  );
  return response.readiness;
}

export async function signUadWorkfile(
  workfileId: string,
  input: { execution_date: string; authentication_method: string; signature_asset_id?: string },
): Promise<UadSignatureResult> {
  const result = await uadFetchJSON<UadSignatureResult>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/signatures`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  announceUadWorkfileMutation(workfileId);
  return result;
}

export interface UadXmlArtifact {
  id: string;
  workfile_id: string;
  revision_number: number;
  artifact_type: "xml";
  storage_provider: string;
  storage_bucket: string | null;
  object_key: string;
  content_type: string;
  byte_size: number | null;
  checksum_sha256: string | null;
  generation_status: "pending" | "generating" | "ready" | "failed" | "superseded";
  generated_at: string | null;
  metadata: {
    file_name?: string;
    input_digest_sha256?: string;
    validation_run_id?: string;
    generator_version?: string;
    delivery_specification_version?: string;
    subschema_version?: string;
    schema_valid?: boolean;
    signer_count?: number;
    image_reference_count?: number;
    storage_etag?: string | null;
    upload_error?: string;
  };
  created_at: string;
  is_current_revision: boolean;
  ready_for_download: boolean;
  download?: {
    method: "GET";
    url: string;
    expires_in_seconds: number;
  };
}

export interface UadSchemaValidationFinding {
  id: string;
  rule_id: string | null;
  severity: "fatal" | "warning";
  message: string;
  status: "open" | "resolved" | "accepted" | "superseded";
  metadata: {
    line?: number | null;
    column?: number | null;
    code?: string | null;
    validator_version?: string;
  };
  created_at: string;
}

export interface UadSchemaValidationRun {
  id: string;
  workfile_id: string;
  revision_number: number;
  specification_release_key: string;
  validator_type: "local_schema";
  status: "passed" | "failed" | "error" | "running";
  fatal_count: number;
  warning_count: number;
  started_at: string;
  completed_at: string | null;
  metadata: {
    validator_version?: string;
    subschema_version?: string;
    schema_sha256?: string;
    input_digest_sha256?: string;
    xml_checksum_sha256?: string;
    xml_byte_size?: number;
    generator_version?: string;
    delivery_specification_version?: string;
    mapped_value_count?: number;
  };
  findings: UadSchemaValidationFinding[];
}

export interface UadXmlArtifactResult {
  artifact: UadXmlArtifact | null;
  schema_validation: UadSchemaValidationRun | null;
}

export async function getLatestUadXmlArtifact(workfileId: string): Promise<UadXmlArtifactResult> {
  return uadFetchJSON<UadXmlArtifactResult>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/artifacts/xml`),
  );
}

export async function generateUadXmlArtifact(workfileId: string): Promise<UadXmlArtifactResult> {
  const result = await uadFetchJSON<UadXmlArtifactResult>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/artifacts/xml`),
    { method: "POST", timeoutMs: 60_000 },
  );
  announceUadWorkfileMutation(workfileId);
  return result;
}

export interface UadPdfArtifact {
  id: string;
  workfile_id: string;
  revision_number: number;
  artifact_type: "pdf";
  storage_provider: string;
  storage_bucket: string | null;
  object_key: string;
  content_type: "application/pdf";
  byte_size: number | null;
  checksum_sha256: string | null;
  generation_status: "pending" | "generating" | "ready" | "failed" | "superseded";
  generated_at: string | null;
  metadata: {
    file_name?: string;
    input_digest_sha256?: string;
    renderer?: string;
    renderer_version?: string;
    page_count?: number;
    rendered_sections?: number[];
    rendered_asset_count?: number;
    signer_count?: number;
    storage_etag?: string | null;
    upload_error?: string;
  };
  created_at: string;
  is_current_revision: boolean;
  ready_for_download: boolean;
  download?: {
    method: "GET";
    url: string;
    expires_in_seconds: number;
  };
}

export interface UadPdfArtifactResult {
  artifact: UadPdfArtifact | null;
}

export async function getLatestUadPdfArtifact(workfileId: string): Promise<UadPdfArtifactResult> {
  return uadFetchJSON<UadPdfArtifactResult>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/artifacts/pdf`),
  );
}

export async function generateUadPdfArtifact(workfileId: string): Promise<UadPdfArtifactResult> {
  const result = await uadFetchJSON<UadPdfArtifactResult>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/artifacts/pdf`),
    { method: "POST", timeoutMs: 120_000 },
  );
  announceUadWorkfileMutation(workfileId);
  return result;
}

export interface UadPackageArtifact {
  id: string;
  workfile_id: string;
  revision_number: number;
  artifact_type: "images_manifest" | "submission_package";
  storage_provider: string;
  storage_bucket: string | null;
  object_key: string;
  content_type: "application/json" | "application/zip";
  byte_size: number | null;
  checksum_sha256: string | null;
  generation_status: "pending" | "generating" | "ready" | "failed" | "superseded";
  generated_at: string | null;
  metadata: {
    file_name?: string;
    input_digest_sha256?: string;
    source_pdf_artifact_id?: string;
    source_xml_artifact_id?: string;
    source_pdf_checksum_sha256?: string;
    source_xml_checksum_sha256?: string;
    image_count?: number;
    entry_count?: number;
    manifest_artifact_id?: string;
    storage_etag?: string | null;
    upload_error?: string;
  };
  created_at: string;
  is_current_revision: boolean;
  ready_for_download: boolean;
  download?: {
    method: "GET";
    url: string;
    expires_in_seconds: number;
  };
}

export interface UadSubmissionPackageResult {
  manifest: UadPackageArtifact | null;
  package: UadPackageArtifact | null;
}

export async function getLatestUadSubmissionPackage(workfileId: string): Promise<UadSubmissionPackageResult> {
  return uadFetchJSON<UadSubmissionPackageResult>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/artifacts/submission-package`),
  );
}

export async function generateUadSubmissionPackage(workfileId: string): Promise<UadSubmissionPackageResult> {
  const result = await uadFetchJSON<UadSubmissionPackageResult>(
    makeUrl(`/api/uad/workfiles/${encodeURIComponent(workfileId)}/artifacts/submission-package`),
    { method: "POST", timeoutMs: 180_000 },
  );
  announceUadWorkfileMutation(workfileId);
  return result;
}
