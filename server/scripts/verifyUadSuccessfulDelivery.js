import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createUadPdfViewModel, renderUadNativePdf } from "../src/modules/uad/uadPdf.js";
import {
  buildDeterministicZip,
  buildUadDeliveryAssetEntries,
  buildUadImagesManifest,
} from "../src/modules/uad/uadDeliveryPackage.js";
import { validateUadSubschema } from "../src/modules/uad/uadSubschema.js";
import { buildUadValidationInputDigest } from "../src/modules/uad/validation.js";
import { buildUadMismoXml } from "../src/modules/uad/uadXml.js";
import {
  uadSalesRichEditorFixture,
  uadNativePdfSignerFixture,
} from "../test/fixtures/uadNativePdfFixture.js";
import { requireSalesRichUadDelivery } from "./lib/uadSalesDeliveryEvidence.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function syntheticDeliveryAsset({ id, entityId = null, sectionNumber, captionType, fileName }) {
  return {
    id,
    entity_id: entityId,
    asset_kind: "photo",
    section_number: sectionNumber,
    caption_type: captionType,
    caption: entityId ? "Synthetic comparable front" : "Synthetic subject front",
    object_key: `synthetic-only/${fileName}`,
    original_file_name: fileName,
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
  const editor = uadSalesRichEditorFixture();
  const signer = uadNativePdfSignerFixture();
  const subjectDwelling = editor.entities.find((entity) => entity.entity_type === "dwelling");
  const assets = [
    syntheticDeliveryAsset({
      id: "10000000-0000-4000-8000-000000000001",
      entityId: subjectDwelling?.id || null,
      sectionNumber: 8,
      captionType: "DwellingFront",
      fileName: "subject-front.png",
    }),
    syntheticDeliveryAsset({
      id: "10000000-0000-4000-8000-000000000002",
      entityId: subjectDwelling?.id || null,
      sectionNumber: 8,
      captionType: "DwellingRear",
      fileName: "subject-rear.png",
    }),
    syntheticDeliveryAsset({
      id: "10000000-0000-4000-8000-000000000003",
      sectionNumber: 4,
      captionType: "PropertyAccess",
      fileName: "subject-street-scene.png",
    }),
    syntheticDeliveryAsset({
      id: "10000000-0000-4000-8000-000000000004",
      sectionNumber: 22,
      captionType: "PropertyPhoto",
      fileName: "subject-property.png",
    }),
    syntheticDeliveryAsset({
      id: "10000000-0000-4000-8000-000000000005",
      sectionNumber: 22,
      captionType: "SalesComparableMap",
      fileName: "sales-comparable-map.png",
    }),
    ...editor.entities
      .filter((entity) => entity.entity_type === "sales_comparable")
      .map((entity, index) => syntheticDeliveryAsset({
        id: `10000000-0000-4000-8000-${String(index + 6).padStart(12, "0")}`,
        entityId: entity.id,
        sectionNumber: 22,
        captionType: "PropertyPhoto",
        fileName: `comparable-${index + 1}-front.png`,
      })),
  ];
  const salesComparison = requireSalesRichUadDelivery(editor);
  const inputDigest = buildUadValidationInputDigest(editor, assets, []);
  const xml = buildUadMismoXml(editor, { signers: [signer], assets });
  const schema = await validateUadSubschema(xml.xml);
  if (!schema.valid) {
    const error = new Error("uad_successful_delivery_schema_invalid");
    error.details = schema.errors;
    throw error;
  }

  const pdfView = createUadPdfViewModel(editor, { signers: [signer], assets });
  const pdfSalesSection = pdfView.sections.find((section) => section.number === 22);
  const pdfComparableGroupCount = pdfSalesSection?.groups.filter((group) => (
    group.entity?.entity_type === "sales_comparable"
  )).length || 0;
  if (pdfComparableGroupCount < salesComparison.comparable_count) {
    throw new Error("uad_successful_delivery_pdf_sales_grid_missing");
  }
  const pdf = await renderUadNativePdf(editor, {
    signers: [signer],
    assets: assets.map((asset) => ({ ...asset, body: PNG })),
  });
  const deliveryEntries = buildUadDeliveryAssetEntries(assets, editor.entities).map((entry) => ({
    ...entry,
    body: PNG,
    byte_size: PNG.length,
    checksum_sha256: sha256(PNG),
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
    validation_scope: {
      home_node_sales_delivery_gate: "passed",
      official_gse_subschema: "passed",
      appendix_h_local_rule_engine: "not_executed_by_this_deterministic_smoke_fixture",
      fannie_uad_compliance_api: "not_executed_credentials_required",
      freddie_uad_compliance_api: "not_executed_credentials_required",
      ucdp_and_collateral_underwriter: "not_executed_lender_submission_required",
      gse_acceptance_claimed: false,
    },
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
    sales_comparison: salesComparison,
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
      sales_comparable_count: (xml.xml.match(/ValuationUseType="SalesComparable"/g) || []).length,
      adjustment_count: (xml.xml.match(/<ComparableAdjustmentAmount>/g) || []).length,
      reconciliation_count: (xml.xml.match(/<SalesComparisonCommentDescription>/g) || []).length,
    },
    pdf: {
      file_name: pdf.file_name,
      byte_size: pdf.byte_size,
      checksum_sha256: pdf.checksum_sha256,
      page_count: pdf.page_count,
      signer_count: pdf.signer_count,
      rendered_asset_count: pdf.rendered_asset_count,
      sales_comparable_group_count: pdfComparableGroupCount,
      renderer_version: pdf.renderer_version,
    },
    manifest: {
      file_name: "images-manifest.json",
      byte_size: manifest.byte_size,
      checksum_sha256: manifest.checksum_sha256,
      image_count: manifest.manifest.image_count,
      private_object_keys_excluded: assets.every((asset) => !manifest.content.includes(Buffer.from(asset.object_key))),
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
  if (evidence.xml.sales_comparable_count < salesComparison.comparable_count) {
    throw new Error("uad_successful_delivery_xml_sales_comparables_missing");
  }
  if (evidence.xml.adjustment_count < salesComparison.nonzero_adjustment_count) {
    throw new Error("uad_successful_delivery_xml_adjustments_missing");
  }
  if (evidence.xml.reconciliation_count < 1) {
    throw new Error("uad_successful_delivery_xml_sales_reconciliation_missing");
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
