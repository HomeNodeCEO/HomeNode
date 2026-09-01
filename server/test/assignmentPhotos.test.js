import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAssignmentPhotoVersion,
  buildAssignmentPhotoObjectKey,
  normalizeAssignmentPhotoUpload,
  uploadAssignmentPhotoObject,
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

test("builds a stable photo change token that reacts to mobile updates", () => {
  const rows = [{
    id: "10000000-0000-4000-8000-000000000001",
    position: 1,
    revision: 1,
    status: "pending_upload",
    updated_at: "2026-08-20T12:00:00.000Z",
  }];
  const initial = buildAssignmentPhotoVersion(rows);
  assert.equal(buildAssignmentPhotoVersion(rows), initial);
  assert.notEqual(buildAssignmentPhotoVersion([{ ...rows[0], revision: 2, status: "verified" }]), initial);
  assert.notEqual(buildAssignmentPhotoVersion([]), initial);
});

test("same-application photo fallback uploads only the registered file-scoped object", async () => {
  const content = Buffer.from("verified-photo-bytes");
  const writes = [];
  const pool = {
    async query(sql, values = []) {
      if (/FROM app\.assignment_files assignment_file/.test(sql)) {
        return { rows: [{ id: "report-1", workfile_status: "draft" }] };
      }
      if (/FROM app\.inspection_photo_objects photo_object/.test(sql)) {
        return { rows: [{
          id: "20000000-0000-4000-8000-000000000003",
          photo_id: "20000000-0000-4000-8000-000000000002",
          variant: "original",
          object_key: "private/photo.jpg",
          content_type: "image/jpeg",
          expected_byte_size: content.length,
        }] };
      }
      if (/UPDATE app\.inspection_photo_objects/.test(sql)) {
        writes.push(values);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const stored = [];
  const result = await uploadAssignmentPhotoObject(pool, {
    configured: true,
    bucket: "private",
    async putObject(input) {
      stored.push(input);
      return { etag: "verified" };
    },
  }, {
    accountId: "26355500170360000",
    assignmentFileId: 91,
    photoId: "20000000-0000-4000-8000-000000000002",
    objectId: "20000000-0000-4000-8000-000000000003",
    contentType: "image/jpeg",
    content,
  });
  assert.equal(result.uploaded, true);
  assert.equal(result.byte_size, content.length);
  assert.equal(stored[0].objectKey, "private/photo.jpg");
  assert.equal(stored[0].body, content);
  assert.equal(writes.length, 1);
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

test("desktop photo listing is bulk-loaded and preserves mobile room metadata", () => {
  const source = fs.readFileSync(
    path.resolve(directory, "../src/services/assignmentPhotos.js"),
    "utf8",
  );
  assert.match(source, /photo_id = ANY\(\$1::uuid\[\]\)/);
  assert.match(source, /room_ref: row\.room_ref \|\| null/);
  assert.match(source, /room_label: row\.room_label \|\| null/);
  assert.match(source, /required_retention_years: Number\(row\.required_retention_years \|\| 5\)/);
});

test("desktop photo center watches the exact active file for mobile changes", () => {
  const center = fs.readFileSync(
    path.resolve(directory, "../../dcad-frontend/src/components/AssignmentPhotoCenter.tsx"),
    "utf8",
  );
  const report = fs.readFileSync(
    path.resolve(directory, "../../dcad-frontend/src/pages/PropertyReport.tsx"),
    "utf8",
  );
  const api = fs.readFileSync(
    path.resolve(directory, "../../dcad-frontend/src/lib/api.ts"),
    "utf8",
  );
  assert.match(center, /const LIVE_REFRESH_MS = 5_000/);
  assert.match(center, /const PHOTO_FEED_RETRY_DELAY_MS = 30_000/);
  assert.match(center, /if \(!accountId \|\| !assignmentFileId\) return;\s+void load\(\)/);
  assert.doesNotMatch(center, /\[accountId, assignmentFileId, load, open\]/);
  assert.match(center, /document\.addEventListener\('visibilitychange', refreshWhenVisible\)/);
  assert.match(center, /window\.addEventListener\('focus', refreshWhenVisible\)/);
  assert.match(center, /photoVersionSignature/);
  assert.match(center, /getAssignmentEvidenceVersion/);
  assert.doesNotMatch(center, /getAssignmentPhotoVersion/);
  assert.match(center, /onSketchChanged/);
  assert.match(center, /void checkForUpdates\(\)/);
  assert.match(center, /versionRecoveryAtRef/);
  assert.match(center, /Date\.now\(\) \+ PHOTO_FEED_RETRY_DELAY_MS/);
  assert.match(center, /const refreshNow = useCallback/);
  assert.match(center, /viewUrlsRefreshedAt\.current = 0/);
  assert.match(center, /onError=\{\(\) => recoverPhotoPreview\(photo\)\}/);
  assert.match(center, /Refreshing secure preview/);
  assert.match(center, /generation !== loadGeneration\.current/);
  assert.match(center, /getAssignmentFiles\(accountId, assignmentFileId\)/);
  assert.match(center, /uploadAssignmentPhotoObjectViaApi/);
  assert.match(center, /Direct photo upload failed/);
  assert.match(api, /photos\/\$\{encodeURIComponent\(photoId\)\}\/objects/);
  assert.match(center, /loadAssignmentFileFallback/);
  assert.match(api, /getAssignmentPhotos[\s\S]*retryTransient: true/);
  assert.match(center, /Refresh now/);
  assert.match(report, /view_url: photo\.view_url/);
  assert.match(report, /assignmentFileNumber=\{activeAssignmentFile\?\.file_number \|\| null\}/);
  assert.match(report, /onPhotosChanged=\{handleAssignmentPhotosChanged\}/);
  assert.match(report, /const subjectPhotos = useMemo<SubjectCarouselPhoto\[]>/);
  assert.match(report, /activeSubjectPhoto\.label/);
  assert.match(report, /compact/);
  assert.match(report, /createPortal/);
  assert.match(report, /role="dialog"/);
  assert.match(report, /className="max-h-full max-w-full select-none object-contain"/);
  assert.match(report, /event\.key === "Escape"/);
  assert.match(report, /event\.key === "ArrowLeft"/);
  assert.doesNotMatch(report, /className="order-6"[\s\S]{0,160}onPhotosChanged=\{handleAssignmentPhotosChanged\}/);
  assert.match(center, /if \(changed \|\| refreshViewUrls\) onPhotosChanged\?\.\(nextPhotos\)/);
});

test("assignment file refresh includes signed mobile photo previews", () => {
  const server = fs.readFileSync(
    path.resolve(directory, "../src/oldServer.js"),
    "utf8",
  );
  const details = fs.readFileSync(
    path.resolve(directory, "../src/services/assignmentFileDetails.js"),
    "utf8",
  );
  assert.match(server, /LEFT JOIN LATERAL \(\s+SELECT object_key/);
  assert.match(server, /sharedObjectStorage\.createDownloadUrl/);
  assert.match(server, /req\.query\.assignment_file_id/);
  assert.match(details, /view_url: photo\.view_url \|\| null/);
  assert.match(details, /view_url_expires_in_seconds/);
});
