import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";

import type {
  CustomAppraisalReview,
  InspectionConflict,
  InspectionSession,
  InspectionSketch,
  InspectionSnapshot,
  InspectionSyncResponse,
  MobilePhoto,
  MobileUser,
  PhotoUploadRequest,
  PropertyResult,
  ReportFile,
} from "../api/client";
import { availablePhotoPositions, type LocalPhotoState, type PreparedPhoto } from "../photos/model";
import { draftFromApiDocument, type ManualSketchDraft } from "../sketch/model";
import {
  retryDelayMs,
  stableJson,
  type FieldState,
  type JsonValue,
  type LocalSyncState,
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
  state: LocalSyncState;
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

type PhotoDraftRow = {
  client_photo_id: string;
  session_id: string;
  server_photo_id: string | null;
  server_revision: number | null;
  server_photo_json: string | null;
  category: string;
  category_source: PreparedPhoto["categorySource"];
  room_ref: string | null;
  room_label: string | null;
  caption: string;
  source: PreparedPhoto["source"];
  captured_at: string;
  capture_metadata_json: string;
  original_client_object_id: string;
  original_uri: string;
  original_file_name: string;
  original_content_type: string;
  original_byte_size: number;
  original_width: number | null;
  original_height: number | null;
  display_client_object_id: string;
  display_uri: string;
  display_file_name: string;
  display_content_type: string;
  display_byte_size: number;
  display_width: number | null;
  display_height: number | null;
  position: number;
  state: LocalPhotoState;
  attempts: number;
  next_attempt_at: number | null;
  error_code: string | null;
  metadata_operation_id: string | null;
  remove_operation_id: string | null;
  created_at: number;
  updated_at: number;
};

type SketchDraftRow = {
  session_id: string;
  client_sketch_id: string;
  server_sketch_json: string | null;
  draft_json: string;
  base_revision: number;
  state: SketchSyncState;
  client_operation_id: string;
  attempts: number;
  next_attempt_at: number | null;
  error_code: string | null;
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

export type LocalPhotoDraft = Readonly<{
  clientPhotoId: string;
  sessionId: string;
  serverPhotoId: string | null;
  serverRevision: number | null;
  serverPhoto: MobilePhoto | null;
  category: string;
  categorySource: PreparedPhoto["categorySource"];
  roomRef: string | null;
  roomLabel: string | null;
  caption: string;
  source: PreparedPhoto["source"];
  capturedAt: string;
  captureMetadata: PreparedPhoto["captureMetadata"];
  objects: PreparedPhoto["objects"];
  position: number;
  state: LocalPhotoState;
  attempts: number;
  nextAttemptAt: number | null;
  errorCode: string | null;
  metadataOperationId: string | null;
  removeOperationId: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type PhotoQueueSummary = Readonly<{
  total: number;
  pending: number;
  synchronized: number;
  failed: number;
}>;

export type SketchSyncState = "pending" | "synchronizing" | "synchronized" | "conflict" | "failed";

export type LocalSketchDraft = Readonly<{
  sessionId: string;
  clientSketchId: string;
  serverSketch: InspectionSketch | null;
  draft: ManualSketchDraft;
  baseRevision: number;
  state: SketchSyncState;
  clientOperationId: string;
  attempts: number;
  nextAttemptAt: number | null;
  errorCode: string | null;
  updatedAt: number;
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

function localPhoto(row: PhotoDraftRow): LocalPhotoDraft {
  return {
    clientPhotoId: row.client_photo_id,
    sessionId: row.session_id,
    serverPhotoId: row.server_photo_id,
    serverRevision: row.server_revision == null ? null : Number(row.server_revision),
    serverPhoto: parseJson<MobilePhoto | null>(row.server_photo_json, null),
    category: row.category,
    categorySource: row.category_source,
    roomRef: row.room_ref,
    roomLabel: row.room_label,
    caption: row.caption,
    source: row.source,
    capturedAt: row.captured_at,
    captureMetadata: parseJson<PreparedPhoto["captureMetadata"]>(row.capture_metadata_json, {}),
    objects: [
      {
        clientObjectId: row.original_client_object_id,
        variant: "original",
        uri: row.original_uri,
        fileName: row.original_file_name,
        contentType: row.original_content_type,
        byteSize: Number(row.original_byte_size),
        width: row.original_width == null ? null : Number(row.original_width),
        height: row.original_height == null ? null : Number(row.original_height),
      },
      {
        clientObjectId: row.display_client_object_id,
        variant: "display",
        uri: row.display_uri,
        fileName: row.display_file_name,
        contentType: row.display_content_type,
        byteSize: Number(row.display_byte_size),
        width: row.display_width == null ? null : Number(row.display_width),
        height: row.display_height == null ? null : Number(row.display_height),
      },
    ],
    position: Number(row.position),
    state: row.state,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at == null ? null : Number(row.next_attempt_at),
    errorCode: row.error_code,
    metadataOperationId: row.metadata_operation_id,
    removeOperationId: row.remove_operation_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function localSketch(row: SketchDraftRow): LocalSketchDraft {
  return {
    sessionId: row.session_id,
    clientSketchId: row.client_sketch_id,
    serverSketch: parseJson<InspectionSketch | null>(row.server_sketch_json, null),
    draft: parseJson<ManualSketchDraft>(row.draft_json, null as unknown as ManualSketchDraft),
    baseRevision: Number(row.base_revision),
    state: row.state,
    clientOperationId: row.client_operation_id,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at == null ? null : Number(row.next_attempt_at),
    errorCode: row.error_code,
    updatedAt: Number(row.updated_at),
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
    CREATE TABLE IF NOT EXISTS custom_appraisal_cache (
      owner_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      review_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS sketch_drafts (
      owner_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_sketch_id TEXT NOT NULL,
      server_sketch_json TEXT,
      draft_json TEXT NOT NULL,
      base_revision INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending',
      client_operation_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      error_code TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS sketch_drafts_due_idx
      ON sketch_drafts (owner_user_id, state, next_attempt_at, updated_at);
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
    CREATE TABLE IF NOT EXISTS photo_drafts (
      owner_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_photo_id TEXT NOT NULL,
      server_photo_id TEXT,
      server_revision INTEGER,
      server_photo_json TEXT,
      category TEXT NOT NULL,
      category_source TEXT NOT NULL,
      room_ref TEXT,
      room_label TEXT,
      caption TEXT NOT NULL,
      source TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      capture_metadata_json TEXT NOT NULL,
      original_client_object_id TEXT NOT NULL,
      original_uri TEXT NOT NULL,
      original_file_name TEXT NOT NULL,
      original_content_type TEXT NOT NULL,
      original_byte_size INTEGER NOT NULL,
      original_width INTEGER,
      original_height INTEGER,
      display_client_object_id TEXT NOT NULL,
      display_uri TEXT NOT NULL,
      display_file_name TEXT NOT NULL,
      display_content_type TEXT NOT NULL,
      display_byte_size INTEGER NOT NULL,
      display_width INTEGER,
      display_height INTEGER,
      position INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      error_code TEXT,
      metadata_operation_id TEXT,
      remove_operation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, session_id, client_photo_id)
    );
    CREATE INDEX IF NOT EXISTS photo_drafts_due_idx
      ON photo_drafts (owner_user_id, state, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS photo_drafts_session_idx
      ON photo_drafts (owner_user_id, session_id, position, created_at);
  `);
  await database.runAsync(
    `UPDATE sync_queue SET state = 'failed', next_attempt_at = ?, updated_at = ?
      WHERE state = 'uploading'`,
    Date.now(),
    Date.now(),
  );
  await database.runAsync(
    `UPDATE photo_drafts SET state = 'failed', next_attempt_at = ?, updated_at = ?
      WHERE state IN ('registering', 'uploading', 'verifying')`,
    Date.now(),
    Date.now(),
  );
  await database.runAsync(
    `UPDATE sketch_drafts SET state = 'failed', next_attempt_at = ?, updated_at = ?
      WHERE state = 'synchronizing'`,
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

  async cacheCustomAppraisalReview(ownerUserId: string, sessionId: string, review: CustomAppraisalReview) {
    await this.database.runAsync(
      `INSERT INTO custom_appraisal_cache (owner_user_id, session_id, review_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (owner_user_id, session_id) DO UPDATE SET
         review_json = excluded.review_json, updated_at = excluded.updated_at`,
      ownerUserId,
      sessionId,
      JSON.stringify(review),
      Date.now(),
    );
  }

  async cachedCustomAppraisalReview(ownerUserId: string, sessionId: string) {
    const row = await this.database.getFirstAsync<{ review_json: string }>(
      `SELECT review_json FROM custom_appraisal_cache
        WHERE owner_user_id = ? AND session_id = ?`,
      ownerUserId,
      sessionId,
    );
    return row
      ? parseJson<CustomAppraisalReview>(row.review_json, null as unknown as CustomAppraisalReview)
      : null;
  }

  async sketchDraft(ownerUserId: string, sessionId: string) {
    const row = await this.database.getFirstAsync<SketchDraftRow>(
      "SELECT * FROM sketch_drafts WHERE owner_user_id = ? AND session_id = ?",
      ownerUserId,
      sessionId,
    );
    return row ? localSketch(row) : null;
  }

  async cacheServerSketch(ownerUserId: string, sessionId: string, sketch: InspectionSketch) {
    const existing = await this.database.getFirstAsync<SketchDraftRow>(
      "SELECT * FROM sketch_drafts WHERE owner_user_id = ? AND session_id = ?",
      ownerUserId,
      sessionId,
    );
    const now = Date.now();
    await this.database.runAsync(
      `INSERT INTO sketch_drafts (
         owner_user_id, session_id, client_sketch_id, server_sketch_json, draft_json,
         base_revision, state, client_operation_id, attempts, next_attempt_at,
         error_code, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'synchronized', ?, 0, NULL, NULL, ?)
       ON CONFLICT (owner_user_id, session_id) DO UPDATE SET
         client_sketch_id = CASE WHEN sketch_drafts.state IN ('pending', 'synchronizing', 'failed', 'conflict')
           THEN sketch_drafts.client_sketch_id ELSE excluded.client_sketch_id END,
         server_sketch_json = excluded.server_sketch_json,
         draft_json = CASE WHEN sketch_drafts.state IN ('pending', 'synchronizing', 'failed', 'conflict')
           THEN sketch_drafts.draft_json ELSE excluded.draft_json END,
         base_revision = excluded.base_revision,
         state = CASE WHEN sketch_drafts.state IN ('pending', 'synchronizing', 'failed', 'conflict')
           THEN sketch_drafts.state ELSE 'synchronized' END,
         updated_at = excluded.updated_at`,
      ownerUserId,
      sessionId,
      sketch.client_sketch_id,
      JSON.stringify(sketch),
      JSON.stringify(draftFromApiDocument(sketch.document)),
      sketch.revision,
      existing?.client_operation_id || Crypto.randomUUID(),
      now,
    );
    return this.sketchDraft(ownerUserId, sessionId);
  }

  async queueSketchDraft(
    ownerUserId: string,
    sessionId: string,
    clientSketchId: string,
    draft: ManualSketchDraft,
  ) {
    const existing = await this.database.getFirstAsync<SketchDraftRow>(
      "SELECT * FROM sketch_drafts WHERE owner_user_id = ? AND session_id = ?",
      ownerUserId,
      sessionId,
    );
    if (existing && existing.client_sketch_id !== clientSketchId) throw new Error("sketch_identity_conflict");
    const now = Date.now();
    const operationId = Crypto.randomUUID();
    await this.database.runAsync(
      `INSERT INTO sketch_drafts (
         owner_user_id, session_id, client_sketch_id, server_sketch_json, draft_json,
         base_revision, state, client_operation_id, attempts, next_attempt_at,
         error_code, updated_at
       ) VALUES (?, ?, ?, NULL, ?, 0, 'pending', ?, 0, ?, NULL, ?)
       ON CONFLICT (owner_user_id, session_id) DO UPDATE SET
         draft_json = excluded.draft_json,
         state = 'pending',
         client_operation_id = excluded.client_operation_id,
         attempts = 0,
         next_attempt_at = excluded.next_attempt_at,
         error_code = NULL,
         updated_at = excluded.updated_at`,
      ownerUserId,
      sessionId,
      clientSketchId,
      JSON.stringify(draft),
      operationId,
      now,
      now,
    );
    return this.sketchDraft(ownerUserId, sessionId);
  }

  async dueSketchDrafts(ownerUserId: string, sessionId?: string) {
    const rows = await this.database.getAllAsync<SketchDraftRow>(
      `SELECT * FROM sketch_drafts
        WHERE owner_user_id = ?
          AND (? IS NULL OR session_id = ?)
          AND state IN ('pending', 'failed')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY updated_at LIMIT 10`,
      ownerUserId,
      sessionId || null,
      sessionId || null,
      Date.now(),
    );
    return rows.map(localSketch);
  }

  async markSketchSynchronizing(ownerUserId: string, sessionId: string) {
    await this.database.runAsync(
      `UPDATE sketch_drafts SET state = 'synchronizing', attempts = attempts + 1,
              error_code = NULL, updated_at = ?
        WHERE owner_user_id = ? AND session_id = ?`,
      Date.now(),
      ownerUserId,
      sessionId,
    );
  }

  async applyServerSketch(ownerUserId: string, sessionId: string, sketch: InspectionSketch) {
    await this.database.runAsync(
      `UPDATE sketch_drafts
          SET server_sketch_json = ?, draft_json = ?, base_revision = ?,
              state = 'synchronized', attempts = 0, next_attempt_at = NULL,
              error_code = NULL, updated_at = ?
        WHERE owner_user_id = ? AND session_id = ?`,
      JSON.stringify(sketch),
      JSON.stringify(draftFromApiDocument(sketch.document)),
      sketch.revision,
      Date.now(),
      ownerUserId,
      sessionId,
    );
  }

  async recordSketchFailure(ownerUserId: string, draft: LocalSketchDraft, errorCode: string) {
    const attempts = draft.attempts + 1;
    await this.database.runAsync(
      `UPDATE sketch_drafts SET state = 'failed', error_code = ?, next_attempt_at = ?, updated_at = ?
        WHERE owner_user_id = ? AND session_id = ?`,
      errorCode,
      Date.now() + retryDelayMs(attempts),
      Date.now(),
      ownerUserId,
      draft.sessionId,
    );
  }

  async markSketchConflict(ownerUserId: string, sessionId: string, serverSketch: InspectionSketch) {
    await this.database.runAsync(
      `UPDATE sketch_drafts
          SET server_sketch_json = ?, base_revision = ?, state = 'conflict',
              error_code = 'sketch_revision_conflict', next_attempt_at = NULL, updated_at = ?
        WHERE owner_user_id = ? AND session_id = ?`,
      JSON.stringify(serverSketch),
      serverSketch.revision,
      Date.now(),
      ownerUserId,
      sessionId,
    );
  }

  async acceptServerSketch(ownerUserId: string, sessionId: string) {
    const current = await this.sketchDraft(ownerUserId, sessionId);
    if (!current?.serverSketch) throw new Error("server_sketch_not_found");
    await this.applyServerSketch(ownerUserId, sessionId, current.serverSketch);
    return this.sketchDraft(ownerUserId, sessionId);
  }

  async retryLocalSketch(ownerUserId: string, sessionId: string) {
    const current = await this.sketchDraft(ownerUserId, sessionId);
    if (!current) throw new Error("offline_sketch_not_found");
    await this.database.runAsync(
      `UPDATE sketch_drafts
          SET state = 'pending', client_operation_id = ?, attempts = 0,
              next_attempt_at = ?, error_code = NULL, updated_at = ?
        WHERE owner_user_id = ? AND session_id = ?`,
      Crypto.randomUUID(),
      Date.now(),
      Date.now(),
      ownerUserId,
      sessionId,
    );
    return this.sketchDraft(ownerUserId, sessionId);
  }

  async generalComments(ownerUserId: string, sessionId: string) {
    const drafts = await this.fieldDraftValues(ownerUserId, sessionId, [GENERAL_COMMENTS_PATH]);
    const draft = drafts[GENERAL_COMMENTS_PATH];
    return {
      value: draft?.state.exists && typeof draft.state.value === "string" ? draft.state.value : "",
      state: draft?.syncState || "synchronized",
    };
  }

  async queueGeneralComments(ownerUserId: string, sessionId: string, value: string) {
    return (await this.queueFieldValues(ownerUserId, sessionId, { [GENERAL_COMMENTS_PATH]: value }))[0];
  }

  async fieldDraftValues(ownerUserId: string, sessionId: string, fieldPaths: string[]) {
    const result: Record<string, { state: FieldState; syncState: LocalSyncState }> = {};
    for (const fieldPath of [...new Set(fieldPaths)]) {
      const row = await this.database.getFirstAsync<DraftRow>(
        `SELECT server_exists, server_value_json, local_exists, local_value_json, state, last_operation_id
           FROM field_drafts WHERE owner_user_id = ? AND session_id = ? AND field_path = ?`,
        ownerUserId,
        sessionId,
        fieldPath,
      );
      result[fieldPath] = {
        state: fieldState(row, "local"),
        syncState: row?.state || "synchronized",
      };
    }
    return result;
  }

  async queueFieldValues(
    ownerUserId: string,
    sessionId: string,
    values: Record<string, JsonValue>,
    { sourceType = "appraiser", appraiserConfirmed = true } = {},
  ) {
    const changes = Object.fromEntries(
      Object.entries(values).map(([fieldPath, value]) => [fieldPath, { exists: true, value }]),
    ) as Record<string, FieldState>;
    return this.queueFieldChanges(ownerUserId, sessionId, changes, { sourceType, appraiserConfirmed });
  }

  async queueFieldChanges(
    ownerUserId: string,
    sessionId: string,
    changes: Record<string, FieldState>,
    { sourceType = "appraiser", appraiserConfirmed = true } = {},
  ) {
    const entries = Object.entries(changes);
    if (!entries.length || entries.length > 25) throw new Error("invalid_offline_field_batch");
    const session = await this.database.getFirstAsync<{ server_revision: number }>(
      `SELECT server_revision FROM cached_inspections WHERE owner_user_id = ? AND session_id = ?`,
      ownerUserId,
      sessionId,
    );
    if (!session) throw new Error("offline_inspection_not_found");
    const prepared: Array<{
      fieldPath: string;
      change: FieldState;
      current: DraftRow | null;
      operationKind: SyncOperationKind;
      operationId: string;
      payloadJson: string;
      digest: string;
    }> = [];
    for (const [fieldPath, change] of entries) {
      const current = await this.database.getFirstAsync<DraftRow>(
        `SELECT server_exists, server_value_json, local_exists, local_value_json, state, last_operation_id
           FROM field_drafts WHERE owner_user_id = ? AND session_id = ? AND field_path = ?`,
        ownerUserId,
        sessionId,
        fieldPath,
      );
      const payload = {
        field_path: fieldPath,
        base: fieldState(current, "local"),
        ...(change.exists ? { value: change.value } : {}),
        source_type: sourceType,
        appraiser_confirmed: appraiserConfirmed,
      } satisfies Record<string, JsonValue>;
      const payloadJson = stableJson(payload);
      prepared.push({
        fieldPath,
        change,
        current,
        operationKind: change.exists ? "field.upsert" as const : "field.delete" as const,
        operationId: Crypto.randomUUID(),
        payloadJson,
        digest: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payloadJson),
      });
    }
    const now = Date.now();
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      for (const item of prepared) {
        await transaction.runAsync(
          `INSERT INTO sync_queue (
             owner_user_id, session_id, client_operation_id, operation_kind,
             base_session_revision, payload_sha256, payload_json, state,
             attempts, next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
          ownerUserId,
          sessionId,
          item.operationId,
          item.operationKind,
          Number(session.server_revision),
          item.digest,
          item.payloadJson,
          now,
          now,
          now,
        );
        await transaction.runAsync(
          `INSERT INTO field_drafts (
             owner_user_id, session_id, field_path, server_exists, server_value_json,
             local_exists, local_value_json, state, last_operation_id, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
           ON CONFLICT (owner_user_id, session_id, field_path) DO UPDATE SET
             local_exists = excluded.local_exists,
             local_value_json = excluded.local_value_json,
             state = 'queued',
             last_operation_id = excluded.last_operation_id,
             updated_at = excluded.updated_at`,
          ownerUserId,
          sessionId,
          item.fieldPath,
          item.current?.server_exists || 0,
          item.current?.server_value_json || null,
          item.change.exists ? 1 : 0,
          item.change.exists ? JSON.stringify(item.change.value) : null,
          item.operationId,
          now,
        );
      }
      await transaction.runAsync(
        `UPDATE cached_inspections SET status = 'sync_pending', updated_at = ?
          WHERE owner_user_id = ? AND session_id = ?`,
        now,
        ownerUserId,
        sessionId,
      );
    });
    return prepared.map((item) => item.operationId);
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

  async cachePreparedPhotos(
    ownerUserId: string,
    sessionId: string,
    photos: PreparedPhoto[],
  ) {
    if (!photos.length) return;
    const inspection = await this.database.getFirstAsync<{ session_id: string }>(
      `SELECT session_id FROM cached_inspections WHERE owner_user_id = ? AND session_id = ?`,
      ownerUserId,
      sessionId,
    );
    if (!inspection) throw new Error("offline_inspection_not_found");
    const capacity = await this.database.getFirstAsync<{ count: number }>(
      `SELECT count(*) AS count
         FROM photo_drafts
        WHERE owner_user_id = ? AND session_id = ? AND state <> 'excluded'`,
      ownerUserId,
      sessionId,
    );
    const occupiedRows = await this.database.getAllAsync<{ position: number }>(
      `SELECT position FROM photo_drafts
        WHERE owner_user_id = ? AND session_id = ? AND state <> 'excluded'`,
      ownerUserId,
      sessionId,
    );
    const existingIds = await this.database.getAllAsync<{ client_photo_id: string }>(
      `SELECT client_photo_id FROM photo_drafts
        WHERE owner_user_id = ? AND session_id = ? AND client_photo_id IN (${photos.map(() => "?").join(",")})`,
      ownerUserId,
      sessionId,
      ...photos.map((photo) => photo.clientPhotoId),
    );
    const existing = new Set(existingIds.map((row) => row.client_photo_id));
    const newPhotos = photos.filter((photo) => !existing.has(photo.clientPhotoId));
    if (Number(capacity?.count || 0) + newPhotos.length > 100) throw new Error("mobile_photo_limit_conflict");
    const availablePositions = availablePhotoPositions(
      occupiedRows.map((row) => Number(row.position)),
    );
    const now = Date.now();
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      for (const photo of newPhotos) {
        const original = photo.objects.find((object) => object.variant === "original");
        const display = photo.objects.find((object) => object.variant === "display");
        if (!original || !display || original.byteSize <= 0 || display.byteSize <= 0) {
          throw new Error("empty_mobile_photo_file");
        }
        const position = availablePositions.shift();
        if (!position) throw new Error("mobile_photo_limit_conflict");
        await transaction.runAsync(
          `INSERT INTO photo_drafts (
             owner_user_id, session_id, client_photo_id,
             category, category_source, room_ref, room_label, caption, source,
             captured_at, capture_metadata_json,
             original_client_object_id, original_uri, original_file_name,
             original_content_type, original_byte_size, original_width, original_height,
             display_client_object_id, display_uri, display_file_name,
             display_content_type, display_byte_size, display_width, display_height,
             position, state, attempts, next_attempt_at, created_at, updated_at
           ) VALUES (
             ?, ?, ?,
             ?, ?, ?, ?, ?, ?,
             ?, ?,
             ?, ?, ?,
             ?, ?, ?, ?,
             ?, ?, ?,
             ?, ?, ?, ?,
             ?, 'queued', 0, ?, ?, ?
           )`,
          ownerUserId,
          sessionId,
          photo.clientPhotoId,
          photo.category,
          photo.categorySource,
          photo.roomRef,
          photo.roomLabel,
          photo.caption,
          photo.source,
          photo.capturedAt,
          JSON.stringify(photo.captureMetadata),
          original.clientObjectId,
          original.uri,
          original.fileName,
          original.contentType,
          original.byteSize,
          original.width,
          original.height,
          display.clientObjectId,
          display.uri,
          display.fileName,
          display.contentType,
          display.byteSize,
          display.width,
          display.height,
          position,
          now,
          now,
          now,
        );
      }
    });
  }

  async photoDrafts(ownerUserId: string, sessionId: string) {
    const rows = await this.database.getAllAsync<PhotoDraftRow>(
      `SELECT * FROM photo_drafts
        WHERE owner_user_id = ? AND session_id = ?
        ORDER BY position, created_at, client_photo_id`,
      ownerUserId,
      sessionId,
    );
    return rows.map(localPhoto);
  }

  async duePhotoDrafts(ownerUserId: string, limit = 10) {
    const rows = await this.database.getAllAsync<PhotoDraftRow>(
      `SELECT * FROM photo_drafts
        WHERE owner_user_id = ?
          AND state IN ('queued', 'failed', 'metadata_pending', 'remove_pending')
          AND COALESCE(next_attempt_at, 0) <= ?
        ORDER BY created_at, client_photo_id LIMIT ?`,
      ownerUserId,
      Date.now(),
      limit,
    );
    return rows.map(localPhoto);
  }

  async markPhotoDraftState(
    ownerUserId: string,
    clientPhotoId: string,
    state: LocalPhotoState,
    { incrementAttempts = false }: { incrementAttempts?: boolean } = {},
  ) {
    await this.database.runAsync(
      `UPDATE photo_drafts
          SET state = ?, attempts = attempts + ?, error_code = NULL,
              next_attempt_at = NULL, updated_at = ?
        WHERE owner_user_id = ? AND client_photo_id = ?`,
      state,
      incrementAttempts ? 1 : 0,
      Date.now(),
      ownerUserId,
      clientPhotoId,
    );
  }

  async recordPhotoFailure(ownerUserId: string, photo: LocalPhotoDraft, errorCode: string) {
    const attempt = photo.attempts + 1;
    const now = Date.now();
    await this.database.runAsync(
      `UPDATE photo_drafts
          SET state = 'failed', attempts = ?, error_code = ?, next_attempt_at = ?, updated_at = ?
        WHERE owner_user_id = ? AND client_photo_id = ?`,
      attempt,
      errorCode,
      now + retryDelayMs(attempt, Math.random()),
      now,
      ownerUserId,
      photo.clientPhotoId,
    );
  }

  async cacheRegisteredPhoto(ownerUserId: string, clientPhotoId: string, photo: MobilePhoto) {
    await this.database.runAsync(
      `UPDATE photo_drafts
          SET server_photo_id = ?, server_revision = ?, server_photo_json = ?,
              state = 'uploading', error_code = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE owner_user_id = ? AND client_photo_id = ?`,
      photo.id,
      photo.revision,
      JSON.stringify(photo),
      Date.now(),
      ownerUserId,
      clientPhotoId,
    );
  }

  async applyServerPhoto(ownerUserId: string, clientPhotoId: string, photo: MobilePhoto) {
    const state: LocalPhotoState = photo.status === "excluded" ? "excluded" : "synchronized";
    await this.database.runAsync(
      `UPDATE photo_drafts
          SET server_photo_id = ?, server_revision = ?, server_photo_json = ?,
              caption = COALESCE(?, caption), state = ?, attempts = 0,
              next_attempt_at = NULL, error_code = NULL,
              metadata_operation_id = NULL, remove_operation_id = NULL, updated_at = ?
        WHERE owner_user_id = ? AND client_photo_id = ?`,
      photo.id,
      photo.revision,
      JSON.stringify(photo),
      photo.caption,
      state,
      Date.now(),
      ownerUserId,
      clientPhotoId,
    );
  }

  async queuePhotoCaption(ownerUserId: string, clientPhotoId: string, caption: string) {
    const row = await this.database.getFirstAsync<PhotoDraftRow>(
      "SELECT * FROM photo_drafts WHERE owner_user_id = ? AND client_photo_id = ?",
      ownerUserId,
      clientPhotoId,
    );
    if (!row) throw new Error("offline_photo_not_found");
    const normalized = caption.trim().slice(0, 200);
    const operationId = row.server_photo_id ? Crypto.randomUUID() : null;
    await this.database.runAsync(
      `UPDATE photo_drafts
          SET caption = ?, state = ?, metadata_operation_id = ?,
              next_attempt_at = ?, error_code = NULL, updated_at = ?
        WHERE owner_user_id = ? AND client_photo_id = ?`,
      normalized || row.room_label || row.category,
      row.server_photo_id ? "metadata_pending" : "queued",
      operationId,
      Date.now(),
      Date.now(),
      ownerUserId,
      clientPhotoId,
    );
  }

  async queuePhotoRemoval(ownerUserId: string, clientPhotoId: string) {
    const row = await this.database.getFirstAsync<PhotoDraftRow>(
      "SELECT * FROM photo_drafts WHERE owner_user_id = ? AND client_photo_id = ?",
      ownerUserId,
      clientPhotoId,
    );
    if (!row) throw new Error("offline_photo_not_found");
    if (!row.server_photo_id) {
      await this.database.runAsync(
        "DELETE FROM photo_drafts WHERE owner_user_id = ? AND client_photo_id = ?",
        ownerUserId,
        clientPhotoId,
      );
      return { localOnly: true, photo: localPhoto(row) };
    }
    await this.database.runAsync(
      `UPDATE photo_drafts
          SET state = 'remove_pending', remove_operation_id = ?,
              next_attempt_at = ?, error_code = NULL, updated_at = ?
        WHERE owner_user_id = ? AND client_photo_id = ?`,
      Crypto.randomUUID(),
      Date.now(),
      Date.now(),
      ownerUserId,
      clientPhotoId,
    );
    return { localOnly: false, photo: localPhoto(row) };
  }

  async pruneEmptyPhotoPlaceholders(ownerUserId: string, sessionId: string) {
    const rows = await this.database.getAllAsync<PhotoDraftRow>(
      `SELECT * FROM photo_drafts
        WHERE owner_user_id = ? AND session_id = ? AND server_photo_id IS NULL
          AND (
            trim(original_uri) = '' OR original_byte_size <= 0
            OR trim(display_uri) = '' OR display_byte_size <= 0
          )`,
      ownerUserId,
      sessionId,
    );
    await this.database.runAsync(
      `DELETE FROM photo_drafts
        WHERE owner_user_id = ? AND session_id = ? AND server_photo_id IS NULL
          AND (
            trim(original_uri) = '' OR original_byte_size <= 0
            OR trim(display_uri) = '' OR display_byte_size <= 0
          )`,
      ownerUserId,
      sessionId,
    );
    return rows.map(localPhoto);
  }

  async photoQueueSummary(ownerUserId: string, sessionId: string): Promise<PhotoQueueSummary> {
    const row = await this.database.getFirstAsync<{
      total: number;
      pending: number;
      synchronized: number;
      failed: number;
    }>(
      `SELECT count(*) AS total,
              COALESCE(sum(CASE WHEN state IN ('queued', 'registering', 'uploading', 'verifying', 'metadata_pending', 'remove_pending') THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(sum(CASE WHEN state = 'synchronized' THEN 1 ELSE 0 END), 0) AS synchronized,
              COALESCE(sum(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) AS failed
         FROM photo_drafts WHERE owner_user_id = ? AND session_id = ? AND state <> 'excluded'`,
      ownerUserId,
      sessionId,
    );
    return {
      total: Number(row?.total || 0),
      pending: Number(row?.pending || 0),
      synchronized: Number(row?.synchronized || 0),
      failed: Number(row?.failed || 0),
    };
  }

  photoUploadRequest(photo: LocalPhotoDraft): PhotoUploadRequest {
    return {
      client_photo_id: photo.clientPhotoId,
      category: photo.category,
      category_source: photo.categorySource,
      room_ref: photo.roomRef,
      room_label: photo.roomLabel,
      caption: photo.caption,
      source: photo.source,
      captured_at: photo.capturedAt,
      capture_metadata: photo.captureMetadata,
      objects: photo.objects.map((object) => ({
        client_object_id: object.clientObjectId,
        variant: object.variant,
        file_name: object.fileName,
        content_type: object.contentType,
        byte_size: object.byteSize,
        width: object.width,
        height: object.height,
      })),
    };
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
