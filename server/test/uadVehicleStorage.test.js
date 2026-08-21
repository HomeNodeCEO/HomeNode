import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UAD_PHASE_ONE_FIELDS,
  UAD_REPEATABLE_ENTITY_GROUPS,
  getUadEditorSections,
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldIsRequired,
  uadFieldIsVisible,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import {
  UAD_VEHICLE_STORAGE_TYPES,
  isVerifiedVehicleStorageAsset,
} from "../src/modules/uad/vehicleStorageCatalog.js";

test("adds official always-displayed URAR Section 13", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "vehicle_storage");
  assert.deepEqual(sections.map((item) => item.officialSectionNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 26, 29]);
  assert.equal(section?.title, "Vehicle Storage");
  assert.equal(section?.appliesWhen, undefined);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "vehicle_storage").length, 16);
  assert.equal(getUadField("vehicle_storage", "3200.0006")?.reportFieldId, "13.000 / 13.001");
  assert.equal(getUadField("vehicle_storage_defect", "3900.0185")?.reportFieldId, "13.009");
});

test("uses exact Appendix A-1 vehicle storage enumerations and formats", () => {
  assert.deepEqual(UAD_VEHICLE_STORAGE_TYPES, [
    "Carport", "CommonCarport", "Driveway", "Garage", "None", "OpenLot",
    "Other", "ParkingGarage", "SharedDriveway",
  ]);
  assert.equal(normalizeAndValidateUadValue(getUadField("vehicle_storage", "3200.0006"), "StreetParking").error?.code, "enumeration");
  assert.deepEqual(
    normalizeAndValidateUadValue(getUadField("vehicle_storage", "3200.0004"), { amount: 440, unit: "SquareFeet" }).value,
    { amount: 440, unit: "SquareFeet" },
  );
  assert.equal(normalizeAndValidateUadValue(getUadField("vehicle_storage", "3200.0004"), { amount: 0, unit: "SquareFeet" }).error?.code, "measurement");
});

test("models mandatory vehicle storage and child defect relationships", () => {
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.vehicle_storage.minItems, 1);
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.vehicle_storage_defect.parentEntityType, "vehicle_storage");

  const storageId = "423742c9-f8e2-4c2e-91d9-bb2790aa04a4";
  const valid = validateUadSectionValues("vehicle_storage", [
    { entity_id: storageId, context_key: "vehicle_storage", uid: "3200.0006", value: "Garage" },
  ], { entityTypesById: new Map([[storageId, "vehicle_storage"]]) });
  assert.equal(valid.errors.length, 0);
});

test("applies garage, driveway, and project-parking conditional requirements", () => {
  const area = getUadField("vehicle_storage", "3200.0004");
  const tenOrMore = getUadField("vehicle_storage", "3200.0011");
  const spaces = getUadField("vehicle_storage", "3200.0010");
  const assignment = getUadField("vehicle_storage", "3200.0012");
  const garage = (key) => ({ "vehicle_storage:3200.0006": "Garage" })[key];
  const driveway = (key) => ({
    "vehicle_storage:3200.0006": "Driveway",
    "vehicle_storage:3200.0011": false,
  })[key];
  const largeDriveway = (key) => ({
    "vehicle_storage:3200.0006": "Driveway",
    "vehicle_storage:3200.0011": true,
  })[key];
  const openLot = (key) => ({ "vehicle_storage:3200.0006": "OpenLot" })[key];

  assert.equal(uadFieldIsVisible(area, garage), true);
  assert.equal(uadFieldIsRequired(area, garage), true);
  assert.equal(uadFieldIsRequired(tenOrMore, driveway), true);
  assert.equal(uadFieldIsRequired(spaces, driveway), true);
  assert.equal(uadFieldIsVisible(spaces, largeDriveway), false);
  assert.equal(uadFieldIsRequired(assignment, openLot), true);
});

test("recognizes only verified entity-linked Section 13 images", () => {
  const entityId = "3189f8d6-28bc-4758-a911-c61a276f529a";
  const asset = {
    entity_id: entityId,
    section_number: 13,
    caption_type: "VehicleStorageDefect",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedVehicleStorageAsset(asset, "VehicleStorageDefect", entityId), true);
  assert.equal(isVerifiedVehicleStorageAsset({ ...asset, section_number: 12 }, "VehicleStorageDefect", entityId), false);
  assert.equal(isVerifiedVehicleStorageAsset({ ...asset, status: "pending" }, "VehicleStorageDefect", entityId), false);
  assert.equal(isVerifiedVehicleStorageAsset({ ...asset, content_type: "application/pdf" }, "VehicleStorageDefect", entityId), false);
});

test("seeds Section 13 fields, enumerations, assets, and rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260826_uad_vehicle_storage.sql"), "utf8");
  assert.match(sql, /CarStorageType/);
  assert.match(sql, /vehicle_storage_defect_asset/);
  assert.match(sql, /UAD1667/);
  assert.match(sql, /UAD1736/);
  assert.match(sql, /HN-UAD-VEHICLE-STORAGE-006/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.match(sql, /Appendix H-1 v1\.5/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server validation protects Section 13 cross-record and photo requirements", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  assert.match(source, /vehicle_storage_required/);
  assert.match(source, /vehicle_storage_parent_conflict/);
  assert.match(source, /vehicle_storage_none_conflict/);
  assert.match(source, /vehicle_storage_defects_indicator_required/);
  assert.match(source, /vehicle_storage_defect_required/);
  assert.match(source, /vehicle_storage_driveway_space_count/);
  assert.match(source, /shared_driveway_commentary_required/);
  assert.match(source, /vehicle_storage_defect_photo_required/);
});
