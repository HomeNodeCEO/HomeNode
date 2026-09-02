import type { MobileConfig } from "../config";
import type { AccessTokenRequest } from "../auth/refreshPolicy";
import { canReplayAfterAuthenticationFailure } from "../auth/refreshPolicy";
import type { WorkflowType } from "../domain/workflows";
import type { FieldState, JsonValue, SyncOperationRequest } from "../offline/model";
import type { ManualSketchApiDocument } from "../sketch/model";

export type Organization = {
  organizationId: string;
  displayName: string;
  roles: string[];
};

export type MobileUser = {
  userId: string;
  email: string;
  displayName: string;
  organizations: Organization[];
};

export type CurrentFile = {
  id: string;
  file_number: string;
  updated_at: string;
};

export type PropertyResult = {
  account_id: string;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  county: string | null;
  neighborhood_code: string | null;
  subdivision: string | null;
  year_built: number | null;
  living_area_sqft: number | null;
  bedroom_count: number | null;
  bath_count: number | null;
  workflows: Record<WorkflowType, { count: number; current_file: CurrentFile | null }>;
};

export type ReportFile = {
  id: string;
  account_id: string;
  workflow_type: WorkflowType;
  file_number: string;
  previous_report_file_id: string | null;
  is_current: boolean;
  ready_for_inspection: boolean;
  updated_at: string;
};

export type ReportDiscovery = {
  account_id: string;
  workflow_type: WorkflowType;
  files: ReportFile[];
  recommended_file: ReportFile | null;
  recently_created: boolean;
  requires_creation: boolean;
};

export type InspectionSession = {
  id: string;
  report_file_id: string;
  status: string;
  revision: number;
};

export type InspectionField = {
  field_path: string;
  state: FieldState;
  source_type: string;
  appraiser_confirmed: boolean;
  session_revision: number;
  applied_at: string;
};

export type InspectionConflict = {
  client_operation_id: string;
  operation_kind: string;
  base_session_revision: number;
  conflict: {
    field_path: string;
    base: FieldState;
    server: FieldState;
    mobile: FieldState;
    detected_at: string;
    session_revision: number;
  };
  received_at: string;
};

export type InspectionSnapshot = {
  session: InspectionSession;
  fields: InspectionField[];
  conflicts: InspectionConflict[];
};

export type SyncOperationResult = {
  client_operation_id: string;
  operation_kind: string;
  status: "applied" | "conflict" | "rejected";
  result: Record<string, JsonValue> | null;
  conflict: InspectionConflict["conflict"] | null;
  resolved_at?: string | null;
  resolution?: string | null;
};

export type InspectionSyncResponse = {
  session: InspectionSession;
  operations: SyncOperationResult[];
};

export type InspectionCompletionCheck = {
  key: string;
  label: string;
  required: boolean;
  passed: boolean;
  open_count: number;
  detail: string;
};

export type InspectionCompletionReadiness = {
  session: InspectionSession;
  workflow_type: WorkflowType;
  report_file: { id: string; file_number: string; registry_revision: number };
  ready_to_complete: boolean;
  completed: boolean;
  checks: InspectionCompletionCheck[];
  blockers: string[];
};

export type InspectionCompletionResponse = {
  session: InspectionSession;
  readiness: InspectionCompletionReadiness;
  completed: boolean;
  already_completed: boolean;
  report_registry_revision: number;
};

export type CustomAppraisalFieldDefinition = {
  field_path: string;
  group: string;
  label: string;
  target_kind: "assignment_details" | "report_section";
  section_key: "report.assignment_details" | "report.property_characteristics";
  target_path: string[];
  value_type: "text" | "number" | "integer" | "boolean" | "condition";
  minimum: number | null;
  maximum: number | null;
  maximum_length: number | null;
  multiline: boolean;
};

export type CustomAppraisalProposal = {
  id: string;
  field_edit_id: string;
  field_path: string;
  label: string;
  group: string;
  target_kind: "assignment_details" | "report_section";
  section_key: string;
  target_path: string[];
  base_target_revision: number;
  base: FieldState;
  proposed: FieldState;
  current: FieldState | null;
  source_type: string;
  appraiser_confirmed: boolean;
  status: "pending" | "accepted" | "rejected" | "conflict" | "superseded";
  conflict: { base: FieldState; current: FieldState; detected_at: string } | null;
  reviewed_at: string | null;
  applied_target_revision: number | null;
  created_at: string;
  updated_at: string;
};

export type CustomAppraisalReview = {
  session: InspectionSession;
  report_file: {
    id: string;
    account_id: string;
    file_number: string;
    registry_revision: number;
    assignment_file_id: number;
  };
  catalog: CustomAppraisalFieldDefinition[];
  sections: Record<string, { value: Record<string, JsonValue>; revision: number; source: string }>;
  proposals: CustomAppraisalProposal[];
  photos: {
    verified_count: number;
    items: Array<{
      id: string;
      category: string;
      room_ref: string | null;
      room_label: string | null;
      caption: string | null;
      position: number;
      retention_until: string;
      verified_at: string;
    }>;
  };
};

export type TargetFieldDefinition = {
  field_path: string;
  group: string;
  label: string;
  value_type: "string" | "text" | "enum" | "multi_enum" | "boolean" | "integer" | "number" | "percentage" | "measurement" | "date" | "year" | "state" | "postal_code";
  target_reference: Record<string, JsonValue>;
  options: string[];
  units: string[];
  required: boolean;
  minimum: number | null;
  maximum: number | null;
  maximum_length: number | null;
  multiline: boolean;
};

export type TargetFieldProposal = {
  id: string;
  field_edit_id: string;
  workflow_type: "uad_3_6" | "property_tax_protest";
  field_path: string;
  label: string;
  group: string;
  target_reference: Record<string, JsonValue>;
  base_target_revision: number;
  base: FieldState;
  proposed: FieldState;
  current: FieldState | null;
  source_type: string;
  appraiser_confirmed: boolean;
  status: "pending" | "accepted" | "rejected" | "conflict" | "superseded";
  conflict: { base: FieldState; current: FieldState; detected_at: string } | null;
  reviewed_at: string | null;
  applied_target_revision: number | null;
  created_at: string;
  updated_at: string;
};

export type TargetFieldReview = {
  session: InspectionSession;
  report_file: {
    id: string;
    account_id: string;
    file_number: string;
    workflow_type: "uad_3_6" | "property_tax_protest";
    registry_revision: number;
    target_id: string;
  };
  target: { revision: number; status: string; specification_release_key: string | null };
  catalog: TargetFieldDefinition[];
  values: Record<string, FieldState>;
  entities: Array<{
    id: string;
    parent_entity_id: string | null;
    entity_type: string;
    entity_identifier: string;
    ordinal: number;
    label: string | null;
  }>;
  proposals: TargetFieldProposal[];
  photos: {
    verified_count: number;
    items: Array<{
      id: string;
      category: string;
      room_ref: string | null;
      room_label: string | null;
      caption: string | null;
      position: number;
      retention_until: string;
      verified_at: string;
    }>;
  };
};

export type UadEntity = {
  id: string;
  workfile_id: string;
  parent_entity_id: string | null;
  entity_type: string;
  entity_identifier: string;
  ordinal: number;
  label: string | null;
  data: Record<string, JsonValue>;
  created_at: string;
  updated_at: string;
};

export type UadEntityGroup = {
  key: string;
  entity_type: string;
  title: string;
  add_label: string;
  min_items: number;
  max_items: number | null;
  parent_entity_types: string[];
  create_enabled: boolean;
  data: Record<string, JsonValue>;
};

export type UadEntityProposalRequest = {
  client_operation_id: string;
  action: "create" | "delete";
  entity_type: string;
  parent_entity_id?: string;
  target_entity_id?: string;
  label?: string;
  data?: Record<string, JsonValue>;
  base_target_revision: number;
  base_entity?: UadEntity;
};

export type UadEntityProposal = {
  id: string;
  client_operation_id: string;
  action: "create" | "delete";
  entity_type: string;
  parent_entity_id: string | null;
  target_entity_id: string | null;
  label: string | null;
  data: Record<string, JsonValue>;
  base_target_revision: number;
  base_entity: UadEntity | null;
  status: "pending" | "accepted" | "rejected" | "conflict";
  conflict: Record<string, JsonValue> | null;
  applied_entity_id: string | null;
  applied_target_revision: number | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type UadEntityReview = {
  session: InspectionSession;
  target: {
    id: string;
    revision: number;
    status: string;
    specification_release_key: string;
  };
  catalog: UadEntityGroup[];
  entities: UadEntity[];
  proposals: UadEntityProposal[];
};

export type InspectionSketchSummary = {
  area_count: number;
  room_count: number;
  all_areas_closed: boolean;
  any_self_intersections: boolean;
  above_grade_finished_sqft: number;
  below_grade_finished_sqft: number;
  above_grade_nonstandard_finished_sqft: number;
  below_grade_nonstandard_finished_sqft: number;
  above_grade_noncontinuous_finished_sqft: number;
  above_grade_unfinished_sqft: number;
  below_grade_unfinished_sqft: number;
  garage_sqft: number;
  porch_patio_deck_sqft: number;
  by_classification: Record<string, number>;
};

export type InspectionSketch = {
  id: string;
  client_sketch_id: string;
  inspection_session_id: string;
  report_file_id: string;
  workflow_type: WorkflowType;
  revision: number;
  document: ManualSketchApiDocument;
  summary: InspectionSketchSummary;
  review_status: "draft" | "appraiser_confirmed";
  ansi_review_required: boolean;
  confirmed_by_user_id: string | null;
  confirmed_at: string | null;
  rooms: Array<{
    id: string;
    room_ref: string;
    area_id: string;
    label: string;
    room_type: string;
    level_label: string;
    anchor: { x: number; y: number };
    position: number;
    photo_count: number;
  }>;
  created_at: string;
  updated_at: string;
};

export type MobilePhotoObject = {
  id: string;
  client_object_id: string;
  variant: "original" | "display";
  file_name: string;
  content_type: string;
  expected_byte_size: number;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  status: "pending_upload" | "verified" | "rejected";
  uploaded_at: string | null;
  verified_at: string | null;
};

export type MobilePhoto = {
  id: string;
  inspection_session_id: string;
  report_file_id: string;
  client_photo_id: string;
  workflow_type: WorkflowType;
  category: string;
  category_source: "custom_catalog" | "uad_catalog" | "sketch_room" | "manual";
  room_ref: string | null;
  room_label: string | null;
  caption: string | null;
  caption_source: "category" | "room_auto" | "manual";
  source: "camera" | "library";
  position: number;
  captured_at: string | null;
  capture_metadata: Record<string, JsonValue>;
  status: "pending_upload" | "verifying" | "verified" | "failed" | "excluded";
  revision: number;
  retention_starts_at: string | null;
  retention_until: string | null;
  required_retention_years: number;
  legal_hold: boolean;
  verified_at: string | null;
  excluded_at: string | null;
  objects: MobilePhotoObject[];
  created_at: string;
  updated_at: string;
};

export type PhotoObjectUploadRequest = {
  client_object_id: string;
  variant: "original" | "display";
  file_name: string;
  content_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
};

export type PhotoUploadRequest = {
  client_photo_id: string;
  category: string;
  category_source: "custom_catalog" | "uad_catalog" | "sketch_room" | "manual";
  room_ref: string | null;
  room_label: string | null;
  caption: string | null;
  source: "camera" | "library";
  captured_at: string;
  capture_metadata: Record<string, JsonValue>;
  objects: PhotoObjectUploadRequest[];
};

export type PresignedPhotoUpload = {
  object_id: string;
  variant: "original" | "display";
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expires_in_seconds: number;
};

export type PhotoUploadBatchItem = {
  photo: MobilePhoto;
  uploads: PresignedPhotoUpload[];
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: unknown = null,
  ) {
    super(code);
  }
}

export function propertySearchPath(query: string, limit = 20) {
  const params = new URLSearchParams({ q: query.trim(), limit: String(limit) });
  return `/api/mobile/properties/search?${params.toString()}`;
}

export class MobileApi {
  constructor(
    private readonly config: MobileConfig,
    private readonly getAccessToken: (request?: AccessTokenRequest) => Promise<string>,
  ) {}

  private async authenticatedFetch(
    path: string,
    init: RequestInit,
    request: AccessTokenRequest = {},
  ) {
    const token = await this.getAccessToken(request);
    try {
      return await fetch(`${this.config.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new ApiError(0, "network_request_failed");
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response = await this.authenticatedFetch(path, init);
    if (
      response.status === 401
      && canReplayAfterAuthenticationFailure(init.method)
    ) {
      response = await this.authenticatedFetch(path, init, { forceRefresh: true });
    }
    const payload = await response.json().catch(() => ({})) as { error?: string; details?: unknown };
    if (!response.ok) {
      throw new ApiError(response.status, payload.error || `http_${response.status}`, payload.details);
    }
    return payload as T;
  }

  async me() {
    return (await this.request<{ user: MobileUser }>("/api/mobile/me")).user;
  }

  async searchProperties(query: string) {
    return (await this.request<{ query: string; results: PropertyResult[] }>(propertySearchPath(query))).results;
  }

  async getProperty(accountId: string) {
    return this.request<{ property: PropertyResult; files: ReportFile[] }>(
      `/api/mobile/properties/${encodeURIComponent(accountId)}`,
    );
  }

  async discoverFiles(accountId: string, workflowType: WorkflowType) {
    const params = new URLSearchParams({ account_id: accountId, workflow_type: workflowType });
    return this.request<ReportDiscovery>(`/api/mobile/report-files?${params.toString()}`);
  }

  async createFile(input: {
    organizationId: string;
    accountId: string;
    workflowType: WorkflowType;
    previousReportFileId?: string;
    clientRequestId: string;
  }) {
    return this.request<{ report_file: ReportFile; created: boolean }>("/api/mobile/report-files", {
      method: "POST",
      body: JSON.stringify({
        organization_id: input.organizationId,
        account_id: input.accountId,
        workflow_type: input.workflowType,
        previous_report_file_id: input.previousReportFileId,
        client_request_id: input.clientRequestId,
      }),
    });
  }

  async startInspection(reportFileId: string) {
    return this.request<{ session: InspectionSession; created: boolean }>(
      "/api/mobile/inspection-sessions",
      { method: "POST", body: JSON.stringify({ report_file_id: reportFileId }) },
    );
  }

  async inspectionSnapshot(sessionId: string) {
    return this.request<InspectionSnapshot>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/snapshot`,
    );
  }

  async syncInspection(sessionId: string, operations: SyncOperationRequest[]) {
    return this.request<InspectionSyncResponse>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/sync`,
      { method: "POST", body: JSON.stringify({ operations }) },
    );
  }

  async inspectionCompletionReadiness(sessionId: string) {
    return this.request<InspectionCompletionReadiness>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/completion-readiness`,
    );
  }

  async completeInspection(sessionId: string, input: {
    clientOperationId: string;
    baseSessionRevision: number;
  }) {
    return this.request<InspectionCompletionResponse>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          client_operation_id: input.clientOperationId,
          base_session_revision: input.baseSessionRevision,
        }),
      },
    );
  }

  async customAppraisalReview(sessionId: string) {
    return this.request<CustomAppraisalReview>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/custom-appraisal`,
    );
  }

  async refreshCustomAppraisalProposals(sessionId: string) {
    return this.request<{
      created: CustomAppraisalProposal[];
      invalid_fields: Array<{ field_path: string; error: string }>;
    }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/custom-appraisal/proposals/refresh`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async reviewCustomAppraisalProposal(
    sessionId: string,
    proposalId: string,
    decision: "accept" | "reject",
    clientOperationId: string,
  ) {
    return this.request<{ proposal: CustomAppraisalProposal; report_registry_revision: number }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/custom-appraisal/proposals/${encodeURIComponent(proposalId)}/review`,
      {
        method: "POST",
        body: JSON.stringify({ client_operation_id: clientOperationId, decision }),
      },
    );
  }

  async inspectionSketch(sessionId: string) {
    return this.request<{ session: InspectionSession; sketch: InspectionSketch | null }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/sketch`,
    );
  }

  async targetFieldReview(sessionId: string) {
    return this.request<TargetFieldReview>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/target-fields`,
    );
  }

  async refreshTargetFieldProposals(sessionId: string) {
    return this.request<{
      workflow_type: "uad_3_6" | "property_tax_protest";
      created: TargetFieldProposal[];
      invalid_fields: Array<{ field_path: string; error: string; details?: Array<{ message?: string }> }>;
    }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/target-fields/proposals/refresh`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async reviewTargetFieldProposal(
    sessionId: string,
    proposalId: string,
    decision: "accept" | "reject",
    clientOperationId: string,
  ) {
    return this.request<{ proposal: TargetFieldProposal; report_registry_revision: number }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/target-fields/proposals/${encodeURIComponent(proposalId)}/review`,
      {
        method: "POST",
        body: JSON.stringify({ client_operation_id: clientOperationId, decision }),
      },
    );
  }

  async uadEntityReview(sessionId: string) {
    return this.request<UadEntityReview>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/uad-entities`,
    );
  }

  async createUadEntityProposal(sessionId: string, input: UadEntityProposalRequest) {
    return this.request<{ proposal: UadEntityProposal; created: boolean }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/uad-entities/proposals`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async reviewUadEntityProposal(
    sessionId: string,
    proposalId: string,
    decision: "accept" | "reject",
    clientOperationId: string,
  ) {
    return this.request<{ proposal: UadEntityProposal; report_registry_revision: number }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/uad-entities/proposals/${encodeURIComponent(proposalId)}/review`,
      {
        method: "POST",
        body: JSON.stringify({ client_operation_id: clientOperationId, decision }),
      },
    );
  }

  async saveInspectionSketch(sessionId: string, input: {
    clientOperationId: string;
    clientSketchId: string;
    baseRevision: number;
    sketch: ManualSketchApiDocument;
  }) {
    return this.request<{
      session: InspectionSession;
      sketch: InspectionSketch;
      report_registry_revision: number;
    }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/sketch`,
      {
        method: "PUT",
        body: JSON.stringify({
          client_operation_id: input.clientOperationId,
          client_sketch_id: input.clientSketchId,
          base_revision: input.baseRevision,
          sketch: input.sketch,
        }),
      },
    );
  }

  async listPhotos(sessionId: string) {
    return (await this.request<{ photos: MobilePhoto[] }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/photos`,
    )).photos;
  }

  async createPhotoUploadRequests(sessionId: string, photos: PhotoUploadRequest[]) {
    return this.request<{ photos: PhotoUploadBatchItem[] }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/photos/upload-requests`,
      { method: "POST", body: JSON.stringify({ photos }) },
    );
  }

  async verifyPhoto(sessionId: string, photoId: string) {
    return (await this.request<{ photo: MobilePhoto }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(photoId)}/verify`,
      { method: "POST", body: JSON.stringify({}) },
    )).photo;
  }

  async updatePhoto(sessionId: string, photoId: string, input: {
    clientOperationId: string;
    baseRevision: number;
    category?: string;
    categorySource?: MobilePhoto["category_source"];
    roomRef?: string | null;
    roomLabel?: string | null;
    caption?: string | null;
    position?: number;
  }) {
    return (await this.request<{ photo: MobilePhoto }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(photoId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          client_operation_id: input.clientOperationId,
          base_revision: input.baseRevision,
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.categorySource === undefined ? {} : { category_source: input.categorySource }),
          ...(input.roomRef === undefined ? {} : { room_ref: input.roomRef }),
          ...(input.roomLabel === undefined ? {} : { room_label: input.roomLabel }),
          ...(input.caption === undefined ? {} : { caption: input.caption }),
          ...(input.position === undefined ? {} : { position: input.position }),
        }),
      },
    )).photo;
  }

  async removePhoto(sessionId: string, photoId: string, clientOperationId: string, baseRevision: number) {
    return this.request<{ photo: MobilePhoto; disposition: "excluded_retained" | "placeholder_deleted" }>(
      `/api/mobile/inspection-sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(photoId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ client_operation_id: clientOperationId, base_revision: baseRevision }),
      },
    );
  }
}
