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
import {
  UAD_PHASE_ONE_FIELDS,
  buildUadPrefillValues,
  getUadField,
  normalizeAndValidateUadValue,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";

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

test("locks the phase-one Assignment and Subject catalog to context-aware official field IDs", () => {
  assert.ok(UAD_PHASE_ONE_FIELDS.length >= 50);
  assert.equal(new Set(UAD_PHASE_ONE_FIELDS.map((field) => field.key)).size, UAD_PHASE_ONE_FIELDS.length);
  assert.equal(getUadField("assignment", "1000.0034")?.reportFieldId, "2.000");
  assert.equal(getUadField("subject_address", "0100.0007")?.reportFieldId, "3.000");
  assert.equal(getUadField("assignment_commentary", "0100.0044")?.reportFieldId, "2.061");
  assert.equal(getUadField("subject_commentary", "0100.0044")?.reportFieldId, "3.032");
});

test("prefills trusted HomeNode subject values without marking them appraiser-confirmed", () => {
  const values = buildUadPrefillValues({
    account: {
      address: "1909 Snowmass Ln",
      city: "Garland",
      county: "Dallas",
      postal_code: "75044",
      subdivision: "Springpark",
      legal_description: "LOT 1 BLOCK A",
    },
    location: { metadata: {} },
    primary_improvements: { number_units: 1 },
  });
  const byKey = new Map(values.map((item) => [item.field.key, item]));
  assert.equal(byKey.get("subject_address:0100.0007")?.value, "1909 Snowmass Ln");
  assert.equal(byKey.get("subject_address:0100.0012")?.value, "TX");
  assert.equal(byKey.get("subject:0100.0022")?.value, 1);
  assert.equal(byKey.get("assignment:1000.0158")?.value, "TraditionalAppraisal");
});

test("validates UAD values by official type, enumeration, and format", () => {
  const assignmentType = getUadField("assignment", "1000.0034");
  assert.equal(normalizeAndValidateUadValue(assignmentType, "Purchase").value, "Purchase");
  assert.equal(normalizeAndValidateUadValue(assignmentType, "Unsupported").error?.code, "enumeration");

  const postalCode = getUadField("subject_address", "0100.0011");
  assert.equal(normalizeAndValidateUadValue(postalCode, "75044-1234").value, "75044-1234");
  assert.equal(normalizeAndValidateUadValue(postalCode, "7504").error?.code, "postal_code");

  assert.throws(
    () => validateUadSectionValues("subject", [{ context_key: "assignment", uid: "1000.0034", value: "Purchase" }]),
    /invalid_uad_field_values/,
  );
});
