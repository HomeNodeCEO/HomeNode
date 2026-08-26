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
  buildUadGeneratedArtifactObjectKey,
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
  assert.equal(manifest.runtimeAssets.deliveryMapping.mappedUniqueIds, 834);
  assert.match(manifest.runtimeAssets.combinedSubschema.sha256, /^[a-f0-9]{64}$/);
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
  assert.equal(
    buildUadGeneratedArtifactObjectKey({
      organizationId: "org-1",
      workfileId: "workfile-1",
      revisionNumber: 7,
      artifactType: "xml",
      checksumSha256: "A".repeat(64),
      fileName: "FAS / 007.xml",
    }),
    `organizations/org-1/uad/workfile-1/generated/revision-7/xml/${"a".repeat(64)}/FAS-007.xml`,
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
  assert.equal(url.hostname, "homenode-uad.example-account.r2.cloudflarestorage.com");
  assert.equal(url.pathname, "/organizations/org/uad/workfile/assets/asset/front.jpg");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-type;host");
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
});

test("allows UAD storage to override the shared R2 bucket without mutating the environment", () => {
  const environment = {
    UAD_OBJECT_STORAGE_PROVIDER: "r2",
    R2_ACCOUNT_ID: "example-account",
    R2_ACCESS_KEY_ID: "example-key",
    R2_SECRET_ACCESS_KEY: "example-secret",
    R2_BUCKET: "homenode-shared-production",
    UAD_R2_BUCKET: "homenode-uad-production",
  };
  const sharedStorage = createUadObjectStorage(environment);
  const uadStorage = createUadObjectStorage(environment, {
    bucket: environment.UAD_R2_BUCKET || environment.R2_BUCKET,
    isolated: environment.UAD_R2_BUCKET !== environment.R2_BUCKET,
  });

  assert.equal(sharedStorage.bucket, "homenode-shared-production");
  assert.equal(uadStorage.bucket, "homenode-uad-production");
  assert.equal(sharedStorage.isolated, false);
  assert.equal(uadStorage.isolated, true);
  assert.equal(environment.R2_BUCKET, "homenode-shared-production");
});

test("allows dedicated UAD R2 credentials without changing shared storage credentials", () => {
  const environment = {
    UAD_OBJECT_STORAGE_PROVIDER: "r2",
    R2_ACCOUNT_ID: "shared-account",
    R2_ACCESS_KEY_ID: "shared-key",
    R2_SECRET_ACCESS_KEY: "shared-secret",
    R2_BUCKET: "homenode-shared-production",
    UAD_R2_ACCOUNT_ID: "uad-account",
    UAD_R2_ACCESS_KEY_ID: "uad-key",
    UAD_R2_SECRET_ACCESS_KEY: "uad-secret",
    UAD_R2_BUCKET: "homenode-uad-production",
  };
  const sharedStorage = createUadObjectStorage(environment);
  const uadStorage = createUadObjectStorage(environment, {
    accountId: environment.UAD_R2_ACCOUNT_ID || environment.R2_ACCOUNT_ID,
    accessKeyId: environment.UAD_R2_ACCESS_KEY_ID || environment.R2_ACCESS_KEY_ID,
    secretAccessKey: environment.UAD_R2_SECRET_ACCESS_KEY || environment.R2_SECRET_ACCESS_KEY,
    bucket: environment.UAD_R2_BUCKET || environment.R2_BUCKET,
    isolated: environment.UAD_R2_BUCKET !== environment.R2_BUCKET,
  });

  assert.equal(sharedStorage.bucket, "homenode-shared-production");
  assert.equal(uadStorage.bucket, "homenode-uad-production");
  const upload = new URL(uadStorage.createUploadUrl({
    objectKey: "organizations/org/uad/workfile/assets/asset/front.jpg",
    contentType: "image/jpeg",
  }).url);
  assert.equal(upload.hostname, "homenode-uad-production.uad-account.r2.cloudflarestorage.com");
  assert.match(upload.searchParams.get("X-Amz-Credential"), /^uad-key\//);
});

test("uploads generated artifacts through a private signed R2 request", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(null, { status: 200, headers: { etag: '"artifact-etag"' } });
  };
  try {
    const storage = createUadObjectStorage({
      UAD_OBJECT_STORAGE_PROVIDER: "r2",
      R2_ACCOUNT_ID: "example-account",
      R2_ACCESS_KEY_ID: "example-key",
      R2_SECRET_ACCESS_KEY: "example-secret",
      R2_BUCKET: "homenode-uad",
    });
    const result = await storage.putObject({
      objectKey: "organizations/org/uad/workfile/generated/revision-1/xml/hash/file.xml",
      contentType: "application/xml",
      body: "<MESSAGE/>",
    });
    assert.equal(request.init.method, "PUT");
    assert.equal(request.init.headers["content-type"], "application/xml");
    assert.equal(request.init.body, "<MESSAGE/>");
    assert.match(request.url, /^https:\/\/homenode-uad\.example-account\.r2\.cloudflarestorage\.com\//);
    assert.deepEqual(result, {
      etag: '"artifact-etag"',
      byte_size: 10,
      content_type: "application/xml",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deletes private R2 objects with a short-lived method-bound signature", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(null, { status: 204 });
  };
  try {
    const storage = createUadObjectStorage({
      UAD_OBJECT_STORAGE_PROVIDER: "r2",
      R2_ACCOUNT_ID: "example-account",
      R2_ACCESS_KEY_ID: "example-key",
      R2_SECRET_ACCESS_KEY: "example-secret",
      R2_BUCKET: "homenode-uad-redteam",
    });
    assert.deepEqual(await storage.deleteObject({ objectKey: "organizations/org/uad/workfile/assets/id/file.png" }), {
      deleted: true,
    });
    assert.equal(request.init.method, "DELETE");
    assert.match(request.url, /^https:\/\/homenode-uad-redteam\.example-account\.r2\.cloudflarestorage\.com\//);
    assert.match(request.url, /X-Amz-Expires=60/);
    assert.doesNotMatch(request.url, /example-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloads private object bytes through a short-lived signed R2 request", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(Buffer.from("%PDF-test"), {
      status: 200,
      headers: { "content-type": "application/pdf", etag: '"pdf-etag"' },
    });
  };
  try {
    const storage = createUadObjectStorage({
      UAD_OBJECT_STORAGE_PROVIDER: "r2",
      R2_ACCOUNT_ID: "example-account",
      R2_ACCESS_KEY_ID: "example-key",
      R2_SECRET_ACCESS_KEY: "example-secret",
      R2_BUCKET: "homenode-uad",
    });
    const result = await storage.getObject({ objectKey: "documents/example.pdf" });
    assert.equal(request.init.method, "GET");
    assert.equal(result.body.toString("ascii"), "%PDF-test");
    assert.equal(result.byte_size, 9);
    assert.equal(result.content_type, "application/pdf");
    assert.equal(result.etag, '"pdf-etag"');
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("the staging bootstrap is guarded against production execution", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(directory, "../scripts/prepareUadStagingDatabase.js"),
    "utf8",
  );
  assert.match(source, /NODE_ENV !== "staging"/);
  assert.match(source, /databaseName\.toLowerCase\(\)\.includes\("staging"\)/);
  assert.match(source, /UAD-STAGING-SFR-0001/);
  assert.match(source, /UAD-STAGING-MH-0001/);
  assert.match(source, /HN-UAD-STAGING-MH-0001/);
  assert.match(source, /uad_staging_fixture\.manufactured_construction/);
  assert.doesNotMatch(source, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("casts the subject snapshot parameter before using PostgreSQL JSON operators", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(directory, "../src/modules/uad/workfiles.js"),
    "utf8",
  );
  assert.match(source, /\(\(\$3::jsonb\)->'account'->>'updated_at'\)::timestamptz/);
});
