import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { renderUadNativePdf } from "../src/modules/uad/uadPdf.js";
import {
  buildDeterministicZip,
  buildUadDeliveryAssetEntries,
  buildUadImagesManifest,
} from "../src/modules/uad/uadDeliveryPackage.js";
import { validateUadSubschema } from "../src/modules/uad/uadSubschema.js";
import { buildUadValidationInputDigest } from "../src/modules/uad/validation.js";
import { buildUadMismoXml } from "../src/modules/uad/uadXml.js";
import {
  uadNativePdfEditorFixture,
  uadNativePdfSignerFixture,
} from "../test/fixtures/uadNativePdfFixture.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function syntheticDeliveryAsset() {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    entity_id: null,
    asset_kind: "photo",
    section_number: 8,
    caption_type: "DwellingFront",
    caption: "Synthetic subject front",
    object_key: "synthetic-only/subject-front.png",
    original_file_name: "subject-front.png",
    content_type: "image/png",
    byte_size: PNG.length,
    checksum_sha256: sha256(PNG),
    status: "verified",
    created_at: "2026-08-21T00:00:00.000Z",
  };
}

function readStoredZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const byteSize = buffer.readUInt32LE(offset + 18);
    const nameSize = buffer.readUInt16LE(offset + 26);
    const extraSize = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const bodyStart = nameStart + nameSize + extraSize;
    const bodyEnd = bodyStart + byteSize;
    if (bodyEnd > buffer.length) throw new Error("uad_successful_delivery_zip_truncated");
    const name = buffer.subarray(nameStart, nameStart + nameSize).toString("utf8");
    entries.set(name, buffer.subarray(bodyStart, bodyEnd));
    offset = bodyEnd;
  }
  return entries;
}

export async function verifyUadSuccessfulDelivery({ outputDirectory = null } = {}) {
  const editor = uadNativePdfEditorFixture();
  const signer = uadNativePdfSignerFixture();
  const asset = syntheticDeliveryAsset();
  const inputDigest = buildUadValidationInputDigest(editor, [asset], []);
  const xml = buildUadMismoXml(editor, { signers: [signer], assets: [asset] });
  const schema = await validateUadSubschema(xml.xml);
  if (!schema.valid) {
    const error = new Error("uad_successful_delivery_schema_invalid");
    error.details = schema.errors;
    throw error;
  }

  const pdf = await renderUadNativePdf(editor, {
    signers: [signer],
    assets: [{ ...asset, body: PNG }],
  });
  const deliveryEntries = buildUadDeliveryAssetEntries([asset], editor.entities).map((entry) => ({
    ...entry,
    body: PNG,
    byte_size: PNG.length,
    checksum_sha256: asset.checksum_sha256,
  }));
  const manifest = buildUadImagesManifest({
    workfile: editor.workfile,
    inputDigest,
    entries: deliveryEntries,
  });
  const xmlFileName = `${editor.workfile.file_number}.xml`;
  const zipFiles = [
    { path: pdf.file_name, body: pdf.content },
    { path: xmlFileName, body: Buffer.from(xml.xml, "utf8") },
    ...deliveryEntries.map((entry) => ({ path: entry.package_path, body: entry.body })),
  ];
  const deliveryPackage = buildDeterministicZip(zipFiles);
  const repeatPackage = buildDeterministicZip([...zipFiles].reverse());
  if (!deliveryPackage.content.equals(repeatPackage.content)) {
    throw new Error("uad_successful_delivery_package_not_deterministic");
  }
  const packageEntries = readStoredZipEntries(deliveryPackage.content);
  for (const file of zipFiles) {
    const packaged = packageEntries.get(file.path);
    if (!packaged || !packaged.equals(Buffer.from(file.body))) {
      throw new Error(`uad_successful_delivery_package_entry_mismatch:${file.path}`);
    }
  }

  const evidence = {
    ok: true,
    fixture: {
      synthetic_only: true,
      property_type: "single_family",
      file_number: editor.workfile.file_number,
      revision_number: Number(editor.workfile.current_revision),
      workfile_status: editor.workfile.status,
      signer_count: 1,
      image_count: deliveryEntries.length,
      input_digest_sha256: inputDigest,
    },
    xml: {
      file_name: xmlFileName,
      byte_size: xml.byte_size,
      checksum_sha256: xml.checksum_sha256,
      mapped_value_count: xml.mapped_value_count,
      image_reference_count: xml.image_reference_count,
      schema_valid: schema.valid,
      schema_error_count: schema.errors.length,
      validator_version: schema.validator_version,
      schema_sha256: schema.schema_sha256,
    },
    pdf: {
      file_name: pdf.file_name,
      byte_size: pdf.byte_size,
      checksum_sha256: pdf.checksum_sha256,
      page_count: pdf.page_count,
      signer_count: pdf.signer_count,
      rendered_asset_count: pdf.rendered_asset_count,
      renderer_version: pdf.renderer_version,
    },
    manifest: {
      file_name: "images-manifest.json",
      byte_size: manifest.byte_size,
      checksum_sha256: manifest.checksum_sha256,
      image_count: manifest.manifest.image_count,
      private_object_keys_excluded: !manifest.content.includes(Buffer.from(asset.object_key)),
    },
    package: {
      file_name: `${editor.workfile.file_number}-revision-${editor.workfile.current_revision}.zip`,
      byte_size: deliveryPackage.byte_size,
      checksum_sha256: deliveryPackage.checksum_sha256,
      entry_count: deliveryPackage.entry_count,
      entries: [...packageEntries.keys()].sort(),
      deterministic: deliveryPackage.content.equals(repeatPackage.content),
    },
  };
  if (!evidence.manifest.private_object_keys_excluded) {
    throw new Error("uad_successful_delivery_manifest_storage_key_leak");
  }

  if (outputDirectory) {
    const resolved = path.resolve(outputDirectory);
    await fs.mkdir(resolved, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(resolved, xmlFileName), xml.xml, "utf8"),
      fs.writeFile(path.join(resolved, pdf.file_name), pdf.content),
      fs.writeFile(path.join(resolved, "images-manifest.json"), manifest.content),
      fs.writeFile(path.join(resolved, evidence.package.file_name), deliveryPackage.content),
      fs.writeFile(path.join(resolved, "uad-successful-delivery.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
    ]);
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputIndex = process.argv.indexOf("--output-dir");
  const outputDirectory = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  const evidence = await verifyUadSuccessfulDelivery({ outputDirectory });
  console.log(JSON.stringify(evidence, null, 2));
}
