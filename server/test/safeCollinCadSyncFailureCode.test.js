import assert from "node:assert/strict";
import test from "node:test";

import { safeCollinCadSyncFailureCode } from "../src/security/safeCollinCadSyncFailureCode.js";

test("Collin CAD sync diagnostics retain bounded source and reconciliation codes", () => {
  assert.equal(safeCollinCadSyncFailureCode(new Error("database_url_required")), "database_url_required");
  assert.equal(safeCollinCadSyncFailureCode(new Error("collin_cad_open_data_503")), "collin_cad_open_data_503");
  assert.equal(safeCollinCadSyncFailureCode(new Error("collin_cad_open_data_stats_429")), "collin_cad_open_data_stats_429");
  assert.equal(safeCollinCadSyncFailureCode(new Error("collin_cad_open_data_timeout")), "collin_cad_open_data_timeout");
  assert.equal(safeCollinCadSyncFailureCode(new Error("collin_cad_open_data_response_too_large")), "collin_cad_open_data_response_too_large");
  assert.equal(safeCollinCadSyncFailureCode(new Error("collin_cad_crosswalk_conflicts:12")), "collin_cad_crosswalk_conflicts:12");
  assert.equal(safeCollinCadSyncFailureCode(new Error("collin_cad_row_count_changed:100:99")), "collin_cad_row_count_changed:100:99");
  assert.equal(safeCollinCadSyncFailureCode({ code: "42P01", message: "password=private" }), "collin_cad_sync_42P01");
});

test("Collin CAD sync diagnostics reject raw and malformed exceptions", () => {
  assert.equal(safeCollinCadSyncFailureCode(new Error("password=private")), "collin_cad_sync_failed");
  assert.equal(safeCollinCadSyncFailureCode(new Error("collin_cad_open_data_503_token=private")), "collin_cad_sync_failed");
  assert.equal(safeCollinCadSyncFailureCode(new Error(`collin_cad_crosswalk_conflicts:${"1".repeat(100)}`)), "collin_cad_sync_failed");
  assert.equal(safeCollinCadSyncFailureCode({ get message() { throw new Error("private"); }, get code() { throw new Error("private"); } }), "collin_cad_sync_failed");
});
