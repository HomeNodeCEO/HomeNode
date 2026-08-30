import assert from "node:assert/strict";
import test from "node:test";

import { indexAssignmentFileDetails } from "../src/services/assignmentFileDetails.js";

test("indexes assignment details in source order with the existing response shape", () => {
  const indexed = indexAssignmentFileDetails({
    sectionRows: [
      { assignment_file_id: "2", section_key: "market", section_value: { a: 1 }, revision: "3", last_applied_session_id: "session", updated_at: "today" },
      { assignment_file_id: 1, section_key: "sales", section_value: { b: 2 }, revision: 4, last_applied_session_id: null, updated_at: "yesterday" },
    ],
    mobilePhotoRows: [
      { assignment_file_id: 2, id: "p1", client_photo_id: "client-p1", origin_channel: "mobile", category: "Front", room_ref: null, room_label: null, caption: "first", position: "1", captured_at: "c1", status: "verified", revision: "3", verified_at: "v1", retention_until: "r1", required_retention_years: "5", view_url: "https://photos.example/p1", view_url_expires_in_seconds: "300" },
      { assignment_file_id: 2, id: "p2", category: "Rear", room_ref: null, room_label: null, caption: "second", position: 2, verified_at: "v2", retention_until: "r2", required_retention_years: 5 },
    ],
    mobileSketchRows: [
      { assignment_file_id: 2, id: "s1", revision: "7", document: { rooms: [] }, summary: { area: 100 }, measurement_standard: "ANSI", measurement_method: "laser", review_status: "confirmed", confirmed_at: "confirmed", updated_at: "updated" },
    ],
  });

  assert.deepEqual(indexed.sectionsByFile.get(2), {
    market: {
      value: { a: 1 },
      revision: 3,
      last_applied_session_id: "session",
      updated_at: "today",
    },
  });
  assert.deepEqual(indexed.photosByFile.get(2).map((photo) => photo.id), ["p1", "p2"]);
  assert.equal(indexed.photosByFile.get(2)[0].required_retention_years, 5);
  assert.equal(indexed.photosByFile.get(2)[0].revision, 3);
  assert.equal(indexed.photosByFile.get(2)[0].view_url, "https://photos.example/p1");
  assert.equal(indexed.photosByFile.get(2)[0].view_url_expires_in_seconds, 300);
  assert.equal(indexed.photosByFile.get(2)[1].origin_channel, "mobile");
  assert.equal(indexed.sketchesByFile.get(2).revision, 7);
  assert.equal(indexed.sectionsByFile.has(3), false);
});

test("returns empty indexes when optional detail tables have no rows", () => {
  const indexed = indexAssignmentFileDetails();
  assert.equal(indexed.sectionsByFile.size, 0);
  assert.equal(indexed.photosByFile.size, 0);
  assert.equal(indexed.sketchesByFile.size, 0);
});
