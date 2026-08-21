import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAssignmentPhotoObjectKey,
  normalizeAssignmentPhotoUpload,
} from "../src/services/assignmentPhotos.js";

const directory = path.dirname(fileURLToPath(import.meta.url));

test("normalizes a desktop appraisal photo with original and display objects", () => {
  const normalized = normalizeAssignmentPhotoUpload({
    client_photo_id: "10000000-0000-4000-8000-000000000001",
    category: "Front",
    caption: "Subject front",
    captured_at: "2026-08-20T12:00:00.000Z",
    objects: [
      {
        client_object_id: "10000000-0000-4000-8000-000000000002",
        variant: "original",
        file_name: "front.png",
        content_type: "image/png",
        byte_size: 1_000,
      },
      {
        client_object_id: "10000000-0000-4000-8000-000000000003",
        variant: "display",
        file_name: "front-display.jpg",
        content_type: "image/jpeg",
        byte_size: 500,
        width: 1600,
        height: 1200,
      },
    ],
  });
  assert.equal(normalized.category, "Front");
  assert.equal(normalized.objects.length, 2);
  assert.match(normalized.requestSha256, /^[a-f0-9]{64}$/);
});

test("requires an original and rejects an unsafe display content type", () => {
  assert.throws(() => normalizeAssignmentPhotoUpload({
    client_photo_id: "10000000-0000-4000-8000-000000000001",
    category: "Front",
    objects: [{
      client_object_id: "10000000-0000-4000-8000-000000000002",
      variant: "display",
      file_name: "front.png",
      content_type: "image/png",
      byte_size: 100,
    }],
  }), /invalid_assignment_photo_display_content_type/);
});

test("builds a file-scoped private photo object key", () => {
  assert.equal(buildAssignmentPhotoObjectKey({
    organizationId: null,
    reportFileId: "report-1",
    photoId: "photo-1",
    objectId: "object-1",
    variant: "original",
    fileName: "Front View.JPG",
  }), "organizations/unassigned/report-files/report-1/photos/photo-1/original/object-1/Front-View.JPG");
});

test("desktop photo migration preserves mobile rows while enabling file-scoped desktop evidence", () => {
  const source = fs.readFileSync(
    path.resolve(directory, "../migrations/20260921_desktop_report_photos.sql"),
    "utf8",
  );
  assert.match(source, /origin_channel text NOT NULL DEFAULT 'mobile'/);
  assert.match(source, /inspection_session_id DROP NOT NULL/);
  assert.match(source, /inspection_photos_report_client_uidx/);
  assert.doesNotMatch(source, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);
});
