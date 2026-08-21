import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildDeterministicZip,
  buildUadDeliveryAssetEntries,
  buildUadImagesManifest,
} from "../src/modules/uad/uadDeliveryPackage.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

test("delivery assets are filtered, ordered, and assigned collision-safe package paths", () => {
  const entities = [{ id: "entity-1", entity_type: "sales_comparable" }];
  const assets = [
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      entity_id: "entity-1",
      asset_kind: "photo",
      section_number: 22,
      caption_type: "PropertyPhoto",
      original_file_name: "Front Photo.png",
      content_type: "image/png",
      byte_size: 2,
      status: "verified",
      created_at: "2026-08-20T00:00:00.000Z",
      object_key: "private/b",
    },
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      asset_kind: "photo",
      section_number: 8,
      caption_type: "DwellingFront",
      original_file_name: "Front Photo.png",
      content_type: "image/png",
      byte_size: 1,
      status: "verified",
      created_at: "2026-08-21T00:00:00.000Z",
      object_key: "private/a",
    },
    {
      id: "signature",
      asset_kind: "signature",
      section_number: 29,
      original_file_name: "signature.png",
      content_type: "image/png",
      status: "verified",
    },
    {
      id: "source-json",
      asset_kind: "measurement_source",
      section_number: 7,
      original_file_name: "measurements.json",
      content_type: "application/json",
      status: "verified",
    },
  ];

  const entries = buildUadDeliveryAssetEntries(assets, entities);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].package_path, "Images/001-aaaaaaaaaaaa-Front-Photo.png");
  assert.equal(entries[0].image_category_type, "DwellingFront");
  assert.equal(entries[1].package_path, "Images/002-bbbbbbbbbbbb-Front-Photo.png");
  assert.equal(entries[1].xml_branch, "property_inspection");
  assert.equal(entries[1].image_category_type, "PropertyPhoto");
});

test("images manifest contains verified package checksums without storage keys", () => {
  const entry = {
    asset_id: "asset-1",
    entity_id: null,
    section_number: 8,
    caption_type: "DwellingFront",
    caption: null,
    original_file_name: "front.jpg",
    package_path: "Images/front.jpg",
    xml_object_url: "\\\\Images\\front.jpg",
    content_type: "image/jpeg",
    byte_size: 3,
    checksum_sha256: "abc",
    object_key: "private/secret-key",
  };
  const result = buildUadImagesManifest({
    workfile: {
      id: "workfile-1",
      file_number: "FILE-1",
      current_revision: 2,
      specification_release_key: "release",
    },
    inputDigest: "digest",
    entries: [entry],
  });
  assert.equal(result.manifest.image_count, 1);
  assert.equal(result.manifest.images[0].checksum_sha256, "abc");
  assert.doesNotMatch(result.content.toString("utf8"), /secret-key/);
  assert.match(result.checksum_sha256, /^[a-f0-9]{64}$/);
});

test("ZIP output is deterministic and rejects unsafe entry paths", () => {
  const files = [
    { path: "report.xml", body: Buffer.from("xml") },
    { path: "Images/front.jpg", body: Buffer.from([1, 2, 3]) },
  ];
  const first = buildDeterministicZip(files);
  const second = buildDeterministicZip([...files].reverse());
  assert.deepEqual(first.content, second.content);
  assert.equal(first.entry_count, 2);
  assert.match(first.checksum_sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.content.readUInt32LE(0), 0x04034b50);
  assert.equal(first.content.readUInt32LE(first.content.length - 22), 0x06054b50);
  assert.throws(() => buildDeterministicZip([{ path: "../escape", body: "x" }]), /uad_package_entry_path_invalid/);
});

test("wires package routes and keeps the legacy report renderer isolated", () => {
  const router = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/modules/uad/router.js"), "utf8");
  const legacy = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/services/customAppraisalReportPdf.js"), "utf8");
  assert.match(router, /artifacts\/submission-package/);
  assert.match(router, /generateUadSubmissionPackage/);
  assert.doesNotMatch(legacy, /submission_package|images_manifest/);
});

test("keeps the audit manifest outside the strict UCDP delivery ZIP", () => {
  const service = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/modules/uad/uadPackageArtifacts.js"), "utf8");
  const zipInputs = service.match(/buildDeterministicZip\(\[([\s\S]*?)\]\);/)?.[1] || "";
  assert.match(zipInputs, /pdfFileName/);
  assert.match(zipInputs, /xmlFileName/);
  assert.match(zipInputs, /entry\.package_path/);
  assert.doesNotMatch(zipInputs, /manifest\.content|manifestFileName/);
  assert.match(service, /artifactType: "images_manifest"/);
});
