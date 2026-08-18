import type { MobileConfig } from "../config";
import type { WorkflowType } from "../domain/workflows";
import type { FieldState, JsonValue, SyncOperationRequest } from "../offline/model";

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

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
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
    private readonly getAccessToken: () => Promise<string>,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getAccessToken();
    let response: Response;
    try {
      response = await fetch(`${this.config.apiBaseUrl}${path}`, {
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
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new ApiError(response.status, payload.error || `http_${response.status}`);
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
}
