import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";

import type {
  InspectionConflict,
  InspectionSession,
  InspectionSnapshot,
  InspectionSyncResponse,
  MobileUser,
  PropertyResult,
  ReportFile,
} from "../api/client";
import {
  retryDelayMs,
  stableJson,
  type FieldState,
  type JsonValue,
  type SyncOperationKind,
  type SyncOperationRequest,
} from "./model";

const DATABASE_KEY = "homenode.mobile.offline-database-key.v1";
const ACTIVE_USER_KEY = "homenode.mobile.active-offline-user.v1";
const DATABASE_NAME = "homenode-field-v1.db";
const GENERAL_COMMENTS_PATH = "inspection.general.appraiser_comments";

type QueueRow = {
  client_operation_id: string;
  session_id: string;
  operation_kind: SyncOperationKind;
  base_session_revision: number;
  payload_sha256: string;
  payload_json: string;
  state: string;
  attempts: number;
  conflict_json: string | null;
};

type DraftRow = {
  server_exists: number;
  server_value_json: string | null;
  local_exists: number;
  local_value_json: string | null;
  state: string;
  last_operation_id: string | null;
};

type InspectionRow = {
  property_json: string;
  report_file_json: string;
  session_json: string;
  server_revision: number;
  status: string;
  updated_at: number;
};

export type CachedInspection = Readonly<{
  property: PropertyResult;
  file: ReportFile;
  session: InspectionSession;
  serverRevision: number;
  status: string;
  updatedAt: number;
}>;

export type QueueSummary = Readonly<{
  pending: number;
  conflicts: number;
  synchronized: number;
}>;

export type LocalConflict = Readonly<{
  clientOperationId: string;
  conflict: InspectionConflict["conflict"];
}>;

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function fieldState(row: DraftRow | null, side: "server" | "local"): FieldState {
  if (!row || !row[`${side}_exists`]) return { exists: false };
  return {
    exists: true,
    value: parseJson<JsonValue>(row[`${side}_value_json`], null),
  };
}

async function databasePassword() {
  const existing = await SecureStore.getItemAsync(DATABASE_KEY);
  if (existing && /^[a-f0-9]{64}$/.test(existing)) return existing;
  const bytes = await Crypto.getRandomBytesAsync(32);
  const generated = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await SecureStore.setItemAsync(DATABASE_KEY, generated, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return generated;
}

async function initializeDatabase() {
  const password = await databasePassword();
  const database = await SQLite.openDatabaseAsync(DATABASE_NAME);
  await database.execAsync(`PRAGMA key = '${password}'`);
  await database.execAsync("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS mobile_users (
      user_id TEXT PRIMARY KEY NOT NULL,
      user_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cached_inspections (
      owner_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      property_json TEXT NOT NULL,
      report_file_json TEXT NOT NULL,
      session_json TEXT NOT NULL,
      server_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS field_drafts (
      owner_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      field_path TEXT NOT NULL,
      server_exists INTEGER NOT NULL DEFAULT 0,
      server_value_json TEXT,
      local_exists INTEGER NOT NULL DEFAULT 0,
      local_value_json TEXT,
      state TEXT NOT NULL DEFAULT 'synchronized',
      last_operation_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, session_id, field_path)
    );
    CREATE TABLE IF NOT EXISTS sync_queue (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_operation_id TEXT NOT NULL UNIQUE,
      operation_kind TEXT NOT NULL,
      base_session_revision INTEGER NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      error_code TEXT,
      result_json TEXT,
      conflict_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_queue_due_idx
      ON sync_queue (owner_user_id, state, next_attempt_at, sequence);
    CREATE INDEX IF NOT EXISTS sync_queue_session_idx
      ON sync_queue (owner_user_id, session_id, sequence);
  `);
  await database.runAsync(
    `UPDATE sync_queue SET state = 'failed', next_attempt_at = ?, updated_at = ?
      WHERE state = 'uploading'`,
    Date.now(),
    Date.now(),
  );
  return database;
}

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

function openDatabase() {
  databasePromise ||= initializeDatabase();
  return databasePromise;
}

export async function clearActiveOfflineUser() {
  await SecureStore.deleteItemAsync(ACTIVE_USER_KEY);
}

export class OfflineStore {
  private constructor(private readonly database: SQLite.SQLiteDatabase) {}

  static async open() {
    return new OfflineStore(await openDatabase());
  }

  async cacheUser(user: MobileUser) {
    const now = Date.now();
    await this.database.runAsync(
      `INSERT INTO mobile_users (user_id, user_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET user_json = excluded.user_json, updated_at = excluded.updated_at`,
      user.userId,
      JSON.stringify(user),
      now,
    );
    await SecureStore.setItemAsync(ACTIVE_USER_KEY, user.userId, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }

  async activeCachedUser() {
    const userId = await SecureStore.getItemAsync(ACTIVE_USER_KEY);
    if (!userId) return null;
    const row = await this.database.getFirstAsync<{ user_json: string }>(
      "SELECT user_json FROM mobile_users WHERE user_id = ?",
      userId,
    );
    return row ? parseJson<MobileUser>(row.user_json, null as unknown as MobileUser) : null;
  }

  async cacheInspection(ownerUserId: string, property: PropertyResult, file: ReportFile, session: InspectionSession) {
    const now = Date.now();
    await this.database.runAsync(
      `INSERT INTO cached_inspections (
         owner_user_id, session_id, property_json, report_file_json,
         session_json, server_revision, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_user_id, session_id) DO UPDATE SET
         property_json = excluded.property_json,
         report_file_json = excluded.report_file_json,
         session_json = excluded.session_json,
         server_revision = MAX(cached_inspections.server_revision, excluded.server_revision),
         status = excluded.status,
         updated_at = excluded.updated_at`,
      ownerUserId,
      session.id,
      JSON.stringify(property),
      JSON.stringify(file),
      JSON.stringify(session),
      session.revision,
      session.status,
      now,
    );
  }

  async cachedInspections(ownerUserId: string): Promise<CachedInspection[]> {
    const rows = await this.database.getAllAsync<InspectionRow>(
      `SELECT property_json, report_file_json, session_json, server_revision, status, updated_at
         FROM cached_inspections WHERE owner_user_id = ? ORDER BY updated_at DESC`,
      ownerUserId,
    );
    return rows.map((row) => ({
      property: parseJson<PropertyResult>(row.property_json, null as unknown as PropertyResult),
      file: parseJson<ReportFile>(row.report_file_json, null as unknown as ReportFile),
      session: parseJson<InspectionSession>(row.session_json, null as unknown as InspectionSession),
      serverRevision: Number(row.server_revision),
      status: row.status,
      updatedAt: Number(row.updated_at),
    }));
  }

  async generalComments(ownerUserId: string, sessionId: string) {
    const row = await this.database.getFirstAsync<DraftRow>(
      `SELECT server_exists, server_value_json, local_exists, local_value_json, state, last_operation_id
         FROM field_drafts WHERE owner_user_id = ? AND session_id = ? AND field_path = ?`,
      ownerUserId,
      sessionId,
      GENERAL_COMMENTS_PATH,
    );
    const local = fieldState(row, "local");
    return { value: local.exists && typeof local.value === "string" ? local.value : "", state: row?.state || "synchronized" };
  }

  async queueGeneralComments(ownerUserId: string, sessionId: string, value: string) {
    const operationId = Crypto.randomUUID();
    const now = Date.now();
    const session = await this.database.getFirstAsync<{ server_revision: number }>(
      `SELECT server_revision FROM cached_inspections WHERE owner_user_id = ? AND session_id = ?`,
      ownerUserId,
      sessionId,
    );
    if (!session) throw new Error("offline_inspection_not_found");
    const current = await this.database.getFirstAsync<DraftRow>(
      `SELECT server_exists, server_value_json, local_exists, local_value_json, state, last_operation_id
         FROM field_drafts WHERE owner_user_id = ? AND session_id = ? AND field_path = ?`,
      ownerUserId,
      sessionId,
      GENERAL_COMMENTS_PATH,
    );
    const payload = {
      field_path: GENERAL_COMMENTS_PATH,
      base: fieldState(current, "local"),
      value,
      source_type: "appraiser",
      appraiser_confirmed: true,
    } satisfies Record<string, JsonValue>;
    const payloadJson = stableJson(payload);
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payloadJson);
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `INSERT INTO sync_queue (
           owner_user_id, session_id, client_operation_id, operation_kind,
           base_session_revision, payload_sha256, payload_json, state,
           attempts, next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'field.upsert', ?, ?, ?, 'queued', 0, ?, ?, ?)`,
        ownerUserId,
        sessionId,
        operationId,
        Number(session.server_revision),
        digest,
        payloadJson,
        now,
        now,
        now,
      );
      await transaction.runAsync(
        `INSERT INTO field_drafts (
           owner_user_id, session_id, field_path, server_exists, server_value_json,
           local_exists, local_value_json, state, last_operation_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, 'queued', ?, ?)
         ON CONFLICT (owner_user_id, session_id, field_path) DO UPDATE SET
           local_exists = 1,
           local_value_json = excluded.local_value_json,
           state = 'queued',
           last_operation_id = excluded.last_operation_id,
           updated_at = excluded.updated_at`,
        ownerUserId,
        sessionId,
        GENERAL_COMMENTS_PATH,
        current?.server_exists || 0,
        current?.server_value_json || null,
        JSON.stringify(value),
        operationId,
        now,
      );
      await transaction.runAsync(
        `UPDATE cached_inspections SET status = 'sync_pending', updated_at = ?
          WHERE owner_user_id = ? AND session_id = ?`,
        now,
        ownerUserId,
        sessionId,
      );
    });
    return operationId;
  }

  async dueOperations(ownerUserId: string, limit = 25) {
    const rows = await this.database.getAllAsync<QueueRow>(
      `SELECT client_operation_id, session_id, operation_kind, base_session_revision,
              payload_sha256, payload_json, state, attempts, conflict_json
         FROM sync_queue
        WHERE owner_user_id = ? AND state IN ('queued', 'failed')
          AND COALESCE(next_attempt_at, 0) <= ?
        ORDER BY sequence LIMIT ?`,
      ownerUserId,
      Date.now(),
      limit,
    );
    return rows;
  }

  async markUploading(operationIds: string[]) {
    if (!operationIds.length) return;
    const now = Date.now();
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      for (const operationId of operationIds) {
        await transaction.runAsync(
          `UPDATE sync_queue SET state = 'uploading', attempts = attempts + 1, updated_at = ?
            WHERE client_operation_id = ? AND state IN ('queued', 'failed')`,
          now,
          operationId,
        );
      }
    });
  }

  async recordFailure(rows: QueueRow[], errorCode: string) {
    const now = Date.now();
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      for (const row of rows) {
        const attempt = Number(row.attempts) + 1;
        await transaction.runAsync(
          `UPDATE sync_queue
              SET state = 'failed', error_code = ?, next_attempt_at = ?, updated_at = ?
            WHERE client_operation_id = ? AND state = 'uploading'`,
          errorCode,
          now + retryDelayMs(attempt, Math.random()),
          now,
          row.client_operation_id,
        );
      }
    });
  }

  async applySyncResponse(ownerUserId: string, response: InspectionSyncResponse) {
    const now = Date.now();
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      for (const operation of response.operations) {
        const state = operation.status === "applied" ? "synchronized" : operation.status;
        await transaction.runAsync(
          `UPDATE sync_queue SET state = ?, result_json = ?, conflict_json = ?,
             error_code = NULL, next_attempt_at = NULL, updated_at = ?
           WHERE owner_user_id = ? AND client_operation_id = ?`,
          state,
          operation.result == null ? null : JSON.stringify(operation.result),
          operation.conflict == null ? null : JSON.stringify(operation.conflict),
          now,
          ownerUserId,
          operation.client_operation_id,
        );
        if (operation.conflict?.field_path) {
          await transaction.runAsync(
            `UPDATE field_drafts SET state = 'conflict', updated_at = ?
              WHERE owner_user_id = ? AND session_id = ? AND field_path = ?
                AND last_operation_id = ?`,
            now,
            ownerUserId,
            response.session.id,
            operation.conflict.field_path,
            operation.client_operation_id,
          );
        }
        const fieldPath = operation.result?.field_path;
        const resultState = operation.result?.state;
        if (
          typeof fieldPath === "string"
          && resultState !== null
          && typeof resultState === "object"
          && !Array.isArray(resultState)
          && typeof resultState.exists === "boolean"
        ) {
          const exists = resultState.exists ? 1 : 0;
          const valueJson = resultState.exists && Object.hasOwn(resultState, "value")
            ? JSON.stringify(resultState.value)
            : null;
          await transaction.runAsync(
            `UPDATE field_drafts
                SET server_exists = ?, server_value_json = ?,
                    local_exists = ?, local_value_json = ?,
                    state = 'synchronized', last_operation_id = NULL, updated_at = ?
              WHERE owner_user_id = ? AND session_id = ? AND field_path = ?
                AND last_operation_id = ?`,
            exists,
            valueJson,
            exists,
            valueJson,
            now,
            ownerUserId,
            response.session.id,
            fieldPath,
            operation.client_operation_id,
          );
        }
        const resolvedId = operation.result?.resolved_client_operation_id;
        if (typeof resolvedId === "string") {
          const resolvedConflict = await transaction.getFirstAsync<{ conflict_json: string | null }>(
            `SELECT conflict_json FROM sync_queue
              WHERE owner_user_id = ? AND client_operation_id = ?`,
            ownerUserId,
            resolvedId,
          );
          const conflict = parseJson<InspectionConflict["conflict"] | null>(
            resolvedConflict?.conflict_json || null,
            null,
          );
          await transaction.runAsync(
            `UPDATE sync_queue SET state = 'synchronized', updated_at = ?
              WHERE owner_user_id = ? AND client_operation_id = ?`,
            now,
            ownerUserId,
            resolvedId,
          );
          if (conflict) {
            const resolvedState = operation.result?.resolution === "accept_server"
              ? conflict.server
              : conflict.mobile;
            const exists = resolvedState.exists ? 1 : 0;
            const valueJson = resolvedState.exists ? JSON.stringify(resolvedState.value) : null;
            await transaction.runAsync(
              `UPDATE field_drafts
                  SET server_exists = ?, server_value_json = ?,
                      local_exists = ?, local_value_json = ?,
                      state = 'synchronized', last_operation_id = NULL, updated_at = ?
                WHERE owner_user_id = ? AND session_id = ? AND last_operation_id = ?`,
              exists,
              valueJson,
              exists,
              valueJson,
              now,
              ownerUserId,
              response.session.id,
              resolvedId,
            );
          }
        }
      }
      await transaction.runAsync(
        `UPDATE cached_inspections SET session_json = ?, server_revision = ?, status = ?, updated_at = ?
          WHERE owner_user_id = ? AND session_id = ?`,
        JSON.stringify(response.session),
        response.session.revision,
        response.session.status,
        now,
        ownerUserId,
        response.session.id,
      );
    });
  }

  async applySnapshot(ownerUserId: string, snapshot: InspectionSnapshot) {
    const now = Date.now();
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `UPDATE cached_inspections SET session_json = ?, server_revision = ?, status = ?, updated_at = ?
          WHERE owner_user_id = ? AND session_id = ?`,
        JSON.stringify(snapshot.session),
        snapshot.session.revision,
        snapshot.session.status,
        now,
        ownerUserId,
        snapshot.session.id,
      );
      for (const field of snapshot.fields) {
        const prior = await transaction.getFirstAsync<DraftRow>(
          `SELECT server_exists, server_value_json, local_exists, local_value_json, state, last_operation_id
             FROM field_drafts WHERE owner_user_id = ? AND session_id = ? AND field_path = ?`,
          ownerUserId,
          snapshot.session.id,
          field.field_path,
        );
        const preserveLocal = prior && ["queued", "uploading", "failed", "conflict"].includes(prior.state);
        const serverValue = field.state.exists ? JSON.stringify(field.state.value) : null;
        await transaction.runAsync(
          `INSERT INTO field_drafts (
             owner_user_id, session_id, field_path, server_exists, server_value_json,
             local_exists, local_value_json, state, last_operation_id, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'synchronized', NULL, ?)
           ON CONFLICT (owner_user_id, session_id, field_path) DO UPDATE SET
             server_exists = excluded.server_exists,
             server_value_json = excluded.server_value_json,
             local_exists = CASE WHEN ? THEN field_drafts.local_exists ELSE excluded.local_exists END,
             local_value_json = CASE WHEN ? THEN field_drafts.local_value_json ELSE excluded.local_value_json END,
             state = CASE WHEN ? THEN field_drafts.state ELSE 'synchronized' END,
             last_operation_id = CASE WHEN ? THEN field_drafts.last_operation_id ELSE NULL END,
             updated_at = excluded.updated_at`,
          ownerUserId,
          snapshot.session.id,
          field.field_path,
          field.state.exists ? 1 : 0,
          serverValue,
          field.state.exists ? 1 : 0,
          serverValue,
          now,
          preserveLocal ? 1 : 0,
          preserveLocal ? 1 : 0,
          preserveLocal ? 1 : 0,
          preserveLocal ? 1 : 0,
        );
      }
      for (const conflict of snapshot.conflicts) {
        await transaction.runAsync(
          `UPDATE sync_queue SET state = 'conflict', conflict_json = ?, updated_at = ?
            WHERE owner_user_id = ? AND client_operation_id = ?`,
          JSON.stringify(conflict.conflict),
          now,
          ownerUserId,
          conflict.client_operation_id,
        );
      }
    });
  }

  async queueSummary(ownerUserId: string, sessionId?: string): Promise<QueueSummary> {
    const row = await this.database.getFirstAsync<{
      pending: number;
      conflicts: number;
      synchronized: number;
    }>(
      `SELECT
         COALESCE(sum(CASE WHEN state IN ('queued', 'uploading', 'failed') THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(sum(CASE WHEN state = 'conflict' THEN 1 ELSE 0 END), 0) AS conflicts,
         COALESCE(sum(CASE WHEN state = 'synchronized' THEN 1 ELSE 0 END), 0) AS synchronized
       FROM sync_queue WHERE owner_user_id = ? AND (? IS NULL OR session_id = ?)`,
      ownerUserId,
      sessionId || null,
      sessionId || null,
    );
    return {
      pending: Number(row?.pending || 0),
      conflicts: Number(row?.conflicts || 0),
      synchronized: Number(row?.synchronized || 0),
    };
  }

  async conflicts(ownerUserId: string, sessionId: string): Promise<LocalConflict[]> {
    const rows = await this.database.getAllAsync<{
      client_operation_id: string;
      conflict_json: string;
    }>(
      `SELECT client_operation_id, conflict_json FROM sync_queue
        WHERE owner_user_id = ? AND session_id = ? AND state = 'conflict'
          AND conflict_json IS NOT NULL ORDER BY sequence`,
      ownerUserId,
      sessionId,
    );
    return rows.map((row) => ({
      clientOperationId: row.client_operation_id,
      conflict: parseJson<InspectionConflict["conflict"]>(row.conflict_json, null as unknown as InspectionConflict["conflict"]),
    }));
  }

  async queueConflictResolution(
    ownerUserId: string,
    sessionId: string,
    conflictOperationId: string,
    resolution: "accept_server" | "apply_mobile",
  ) {
    const session = await this.database.getFirstAsync<{ server_revision: number }>(
      `SELECT server_revision FROM cached_inspections WHERE owner_user_id = ? AND session_id = ?`,
      ownerUserId,
      sessionId,
    );
    if (!session) throw new Error("offline_inspection_not_found");
    const operationId = Crypto.randomUUID();
    const payload = {
      conflict_client_operation_id: conflictOperationId,
      resolution,
    } satisfies Record<string, JsonValue>;
    const payloadJson = stableJson(payload);
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payloadJson);
    const now = Date.now();
    await this.database.runAsync(
      `INSERT INTO sync_queue (
         owner_user_id, session_id, client_operation_id, operation_kind,
         base_session_revision, payload_sha256, payload_json, state,
         attempts, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'conflict.resolve', ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      ownerUserId,
      sessionId,
      operationId,
      Number(session.server_revision),
      digest,
      payloadJson,
      now,
      now,
      now,
    );
    return operationId;
  }

  operationRequest(row: QueueRow): SyncOperationRequest {
    return {
      client_operation_id: row.client_operation_id,
      operation_kind: row.operation_kind,
      base_session_revision: Number(row.base_session_revision),
      payload_sha256: row.payload_sha256,
      payload: parseJson<Record<string, JsonValue>>(row.payload_json, {}),
    };
  }
}
