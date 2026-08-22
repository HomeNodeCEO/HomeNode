import { createHash } from "node:crypto";

import { sanitizeUadFileName } from "./r2Storage.js";

export const UAD_DELIVERY_IMAGE_CONTENT_TYPES = Object.freeze([
  "application/pdf",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

const DELIVERY_IMAGE_CONTENT_TYPES = new Set(UAD_DELIVERY_IMAGE_CONTENT_TYPES);
export const UAD_ZIP_LIMITS = Object.freeze({
  max_entries: 502,
  max_path_bytes: 240,
  max_uncompressed_bytes: 500 * 1024 * 1024,
});
const IMAGE_CATEGORY_TYPES = new Set([
  "AbsorptionRateGraph", "AssignmentExhibit", "CostApproachExhibit", "DisasterMitigationExhibit",
  "DwellingExteriorExhibit", "DwellingFront", "DwellingRear", "Encroachment",
  "EnergyEfficientAndGreenFeaturesExhibit", "FloorPlan", "FunctionalObsolescenceExhibit",
  "GrossRentMultiplierComparableMap", "HighestAndBestUseExhibit", "IncomeApproachExhibit",
  "LandComparableMap", "LegalDescription", "ManufacturedHomeExhibit",
  "ManufacturedHomeFinancingProgramEligibilityCertification", "ManufacturedHomeHUDCertificationLabel",
  "ManufacturedHomeHUDDataPlate", "MarketAnalysisExhibit", "MedianDaysOnMarketGraph",
  "NoncontinuousArea", "NonResidentialUse", "OutbuildingExhibit", "PercentOfDistressedSalesGraph",
  "PermanentWaterfrontFeature", "PriceTrendGraph", "PriorSaleAndTransferHistoryExhibit",
  "ProjectAmenity", "ProjectDeficiency", "ProjectExhibit", "PropertyAccess", "PropertyBoundaries",
  "PropertyPhoto", "ReconciliationExhibit", "RentalComparableMap", "RentalInformationExhibit",
  "SalesComparableMap", "SalesComparisonApproachExhibit", "SalesContractExhibit", "SiteCharacteristic",
  "SiteExhibit", "SiteInfluence", "SubjectListingExhibit", "SubjectPropertyAmenitiesExhibit",
  "SubjectPropertyExhibit", "SubjectPropertyImprovementSketch", "SupplementalExhibit",
  "UnitInteriorExhibit", "VehicleStorageExhibit", "View", "WaterFrontage", "YearBuiltOfSalesGraph",
]);

function deliveryBranch(entityType, captionType) {
  if (String(entityType || "").includes("defect") || String(captionType || "").endsWith("Defect")) {
    return "defect";
  }
  // ROOM is a PROPERTY_UNIT branch. Outbuilding rooms are summarized under
  // INTERIOR_ROOM_SUMMARY, which has no image child in the pinned XSD, so
  // their photos remain report evidence on the subject inspection branch.
  if (entityType === "unit_room") return "room";
  if (entityType === "unit_interior_feature") return "interior_component";
  if (entityType === "vehicle_storage") return "vehicle_storage";
  if (entityType === "amenity") return "amenity";
  return "property_inspection";
}

function packageFileName(asset, index) {
  const original = sanitizeUadFileName(asset.original_file_name || `${asset.caption_type || "image"}.bin`);
  const identity = String(asset.id || "asset").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "asset";
  return `${String(index + 1).padStart(3, "0")}-${identity}-${original}`;
}

export function buildUadDeliveryAssetEntries(assets = [], entities = []) {
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  return [...assets]
    .filter((asset) => (
      asset.status === "verified"
      && asset.asset_kind !== "signature"
      && DELIVERY_IMAGE_CONTENT_TYPES.has(String(asset.content_type || "").toLowerCase())
    ))
    .sort((left, right) => (
      Number(left.section_number || 999) - Number(right.section_number || 999)
      || String(left.entity_id || "").localeCompare(String(right.entity_id || ""))
      || String(left.created_at || "").localeCompare(String(right.created_at || ""))
      || String(left.id).localeCompare(String(right.id))
    ))
    .map((asset, index) => {
      const fileName = packageFileName(asset, index);
      const contentType = String(asset.content_type).toLowerCase();
      const entity = asset.entity_id ? entitiesById.get(asset.entity_id) : null;
      return Object.freeze({
        asset_id: asset.id,
        entity_id: asset.entity_id || null,
        entity_type: entity?.entity_type || null,
        section_number: asset.section_number == null ? null : Number(asset.section_number),
        caption_type: asset.caption_type || null,
        caption: asset.caption || null,
        original_file_name: asset.original_file_name || null,
        content_type: contentType,
        expected_byte_size: asset.byte_size == null ? null : Number(asset.byte_size),
        expected_checksum_sha256: asset.checksum_sha256 || null,
        object_key: asset.object_key,
        file_name: fileName,
        package_path: `Images/${fileName}`,
        xml_object_url: `\\\\Images\\${fileName}`,
        image_category_type: IMAGE_CATEGORY_TYPES.has(asset.caption_type) ? asset.caption_type : null,
        xml_branch: deliveryBranch(entity?.entity_type, asset.caption_type),
      });
    });
}

export function buildUadImagesManifest({ workfile, inputDigest, entries }) {
  const manifest = {
    manifest_version: "1.0",
    package_profile: "UAD 3.6 URAR Delivery Specification 1.4",
    workfile_id: workfile.id,
    file_number: workfile.file_number || null,
    revision_number: Number(workfile.current_revision),
    specification_release_key: workfile.specification_release_key,
    input_digest_sha256: inputDigest,
    image_count: entries.length,
    images: entries.map((entry) => ({
      asset_id: entry.asset_id,
      entity_id: entry.entity_id,
      section_number: entry.section_number,
      caption_type: entry.caption_type,
      caption: entry.caption,
      source_file_name: entry.original_file_name,
      package_path: entry.package_path,
      xml_object_url: entry.xml_object_url,
      content_type: entry.content_type,
      byte_size: entry.byte_size,
      checksum_sha256: entry.checksum_sha256,
    })),
  };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  return {
    manifest,
    content: Buffer.from(json, "utf8"),
    byte_size: Buffer.byteLength(json, "utf8"),
    checksum_sha256: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

let crcTable;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    return value >>> 0;
  });
  return crcTable;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  const table = getCrcTable();
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validateZipPath(value) {
  const path = String(value || "").normalize("NFKC").replaceAll("\\", "/");
  const segments = path.split("/");
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes(":")
    || /[\0-\x1f\x7f]/.test(path) || Buffer.byteLength(path, "utf8") > UAD_ZIP_LIMITS.max_path_bytes
    || segments.some((segment) => !segment || segment === "." || segment === ".."
      || /[. ]$/.test(segment) || reserved.test(segment))) {
    throw new Error("uad_package_entry_path_invalid");
  }
  return path;
}

export function buildDeterministicZip(files = []) {
  if (!Array.isArray(files) || files.length > UAD_ZIP_LIMITS.max_entries) {
    throw new Error("uad_package_entry_count_exceeded");
  }
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const seen = new Set();
  let totalUncompressedBytes = 0;
  for (const file of [...files].sort((left, right) => String(left.path).localeCompare(String(right.path)))) {
    const path = validateZipPath(file.path);
    const portablePath = path.toLocaleLowerCase("en-US");
    if (seen.has(portablePath)) throw new Error("uad_package_entry_duplicate");
    seen.add(portablePath);
    const name = Buffer.from(path, "utf8");
    const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body);
    totalUncompressedBytes += body.length;
    if (totalUncompressedBytes > UAD_ZIP_LIMITS.max_uncompressed_bytes) {
      throw new Error("uad_package_bytes_exceeded");
    }
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  const content = Buffer.concat([...localParts, centralDirectory, end]);
  return {
    content,
    byte_size: content.length,
    checksum_sha256: createHash("sha256").update(content).digest("hex"),
    entry_count: files.length,
  };
}
