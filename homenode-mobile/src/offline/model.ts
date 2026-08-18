export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type FieldState = Readonly<
  | { exists: false }
  | { exists: true; value: JsonValue }
>;

export type SyncOperationKind = "field.upsert" | "field.delete" | "conflict.resolve";
export type LocalSyncState = "queued" | "uploading" | "conflict" | "failed" | "synchronized";

export type SyncOperationRequest = Readonly<{
  client_operation_id: string;
  operation_kind: SyncOperationKind;
  base_session_revision: number;
  payload_sha256: string;
  payload: Record<string, JsonValue>;
}>;

export function stableJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid_json_value");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`
  )).join(",")}}`;
}

export function retryDelayMs(attempt: number, entropy = 0.5) {
  const boundedAttempt = Math.max(1, Math.min(10, Math.floor(attempt)));
  const boundedEntropy = Math.max(0, Math.min(1, entropy));
  const base = Math.min(5 * 60_000, 2_000 * (2 ** (boundedAttempt - 1)));
  return Math.round(base * (0.75 + boundedEntropy * 0.5));
}

export function networkAvailable(state: { isConnected?: boolean; isInternetReachable?: boolean }) {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

