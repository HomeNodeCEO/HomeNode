import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CURRENT_UAD_RELEASE_KEY,
  UAD_ROLE_CODES,
} from "../src/modules/uad/constants.js";
import {
  buildUadObjectKey,
  createR2PresignedUrl,
  createUadObjectStorage,
  sanitizeUadFileName,
} from "../src/modules/uad/r2Storage.js";
import {
  normalizeUadAccountId,
  normalizeUadFileNumber,
  normalizeUadWorkfileId,
} from "../src/modules/uad/workfiles.js";

test("locks the current UAD release and future user roles", () => {
  assert.equal(CURRENT_UAD_RELEASE_KEY, "uad-3.6-2026-08-13-h1.5");
  assert.deepEqual(UAD_ROLE_CODES, [
    "appraiser",
    "supervisory_appraiser",
    "reviewer",
    "organization_admin",
    "homenode_admin",
  ]);
});

test("the official specification manifest matches the locked release", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(directory, "../src/modules/uad/spec/manifest.json"), "utf8"),
  );
  assert.equal(manifest.releaseKey, CURRENT_UAD_RELEASE_KEY);
  assert.equal(manifest.components.length, 9);
  assert.ok(manifest.components.every((component) => /^[a-f0-9]{64}$/.test(component.sha256)));
});

test("normalizes UAD workfile identity without accepting unsafe values", () => {
  assert.equal(normalizeUadAccountId(" 12345678901234567 "), "12345678901234567");
  assert.throws(() => normalizeUadAccountId(""), /invalid_account_id/);
  assert.equal(
    normalizeUadWorkfileId("c164248f-645d-48aa-a389-dc668e6c5dc9"),
    "c164248f-645d-48aa-a389-dc668e6c5dc9",
  );
  assert.throws(() => normalizeUadWorkfileId("1"), /invalid_uad_workfile_id/);
  assert.equal(normalizeUadFileNumber(" FAS-2026-001 ", {}), "FAS-2026-001");
  assert.match(
    normalizeUadFileNumber("", {
      accountId: "12345678901234567",
      workfileId: "c164248f-645d-48aa-a389-dc668e6c5dc9",
    }),
    /^HN-UAD-\d{4}-01234567-c164248f$/,
  );
});

test("builds private mobile-upload object keys without trusting the original filename", () => {
  assert.equal(sanitizeUadFileName(" Front / Entry (1).HEIC "), "Front-Entry-1-.HEIC");
  assert.equal(
    buildUadObjectKey({
      organizationId: "org-1",
      workfileId: "workfile-1",
      assetId: "asset-1",
      fileName: "front door.jpg",
    }),
    "organizations/org-1/uad/workfile-1/assets/asset-1/front-door.jpg",
  );
});

test("creates a bounded R2 presigned PUT URL and requires complete configuration", () => {
  const unconfigured = createUadObjectStorage({});
  assert.equal(unconfigured.configured, false);
  assert.throws(
    () => unconfigured.createUploadUrl({ objectKey: "a", contentType: "image/jpeg" }),
    /not_configured/,
  );

  const url = new URL(createR2PresignedUrl({
    accountId: "example-account",
    accessKeyId: "example-key",
    secretAccessKey: "example-secret",
    bucket: "homenode-uad",
    objectKey: "organizations/org/uad/workfile/assets/asset/front.jpg",
    contentType: "image/jpeg",
    expiresInSeconds: 900,
    now: new Date("2026-08-16T12:00:00.000Z"),
  }));
  assert.equal(url.hostname, "example-account.r2.cloudflarestorage.com");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-type;host");
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
});
