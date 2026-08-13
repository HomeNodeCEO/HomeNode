import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATED_ZONING_SOURCE_KEYS,
  DALLAS_COUNTY_CITIES,
  DALLAS_COUNTY_ZONING_JURISDICTIONS,
  OFFICIAL_ZONING_SOURCES,
} from "../src/services/propertyZoningSources.js";
import { normalizeOfficialZoningFeature } from "../src/services/propertyContextSync.js";

test("Dallas County zoning registry covers every official municipality exactly once", () => {
  assert.equal(DALLAS_COUNTY_CITIES.length, 31);
  assert.equal(DALLAS_COUNTY_ZONING_JURISDICTIONS.length, 31);
  assert.equal(new Set(DALLAS_COUNTY_CITIES).size, 31);
  assert.deepEqual(
    DALLAS_COUNTY_ZONING_JURISDICTIONS.map((entry) => entry.city),
    DALLAS_COUNTY_CITIES,
  );
  assert.equal(
    new Set(DALLAS_COUNTY_ZONING_JURISDICTIONS.map((entry) => entry.providerKey)).size,
    31,
  );
});

test("automatic zoning is limited to verified queryable municipal sources", () => {
  const automatic = DALLAS_COUNTY_ZONING_JURISDICTIONS.filter(
    (entry) => entry.automationStatus === "automatic",
  );
  const manual = DALLAS_COUNTY_ZONING_JURISDICTIONS.filter(
    (entry) => entry.automationStatus === "manual_review",
  );
  assert.equal(automatic.length, OFFICIAL_ZONING_SOURCES.length);
  assert.equal(automatic.length, AUTOMATED_ZONING_SOURCE_KEYS.length);
  assert.equal(automatic.length + manual.length, 31);
  assert.equal(automatic.every((entry) => entry.serviceUrl?.endsWith("/query")), true);
  assert.equal(manual.every((entry) => !entry.serviceUrl), true);
  assert.equal(manual.some((entry) => entry.city === "Rowlett"), true);
});

test("manual zoning sources retain official evidence and city verification contacts", () => {
  const manual = DALLAS_COUNTY_ZONING_JURISDICTIONS.filter(
    (entry) => entry.automationStatus === "manual_review",
  );
  assert.equal(manual.length, 11);
  assert.equal(manual.every((entry) => entry.referenceUrl), true);
  assert.equal(manual.every((entry) => entry.contact?.department && entry.contact?.phone), true);
  assert.equal(manual.every((entry) => entry.contact?.sourceUrl?.startsWith("https://")), true);
  const cachedMapCities = manual
    .filter((entry) => entry.documents.length)
    .map((entry) => entry.city)
    .sort();
  assert.deepEqual(cachedMapCities, [
    "Ferris",
    "Glenn Heights",
    "Highland Park",
    "Ovilla",
    "Seagoville",
  ]);
  assert.equal(
    manual.flatMap((entry) => entry.documents).every((document) =>
      document.url.startsWith("https://") && document.title && document.key
    ),
    true,
  );
});

test("multi-layer municipal records retain a stable layer prefix", () => {
  const record = normalizeOfficialZoningFeature({
    type: "Feature",
    id: 42,
    properties: { FID: 42, NEW_ZONING: "SF-7" },
    geometry: {
      type: "Polygon",
      coordinates: [[[-96.9, 32.6], [-96.8, 32.6], [-96.8, 32.7], [-96.9, 32.6]]],
    },
  }, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", {
    providerKey: "city_duncanville_official",
    jurisdiction: "Duncanville",
    sourceRecordPrefix: "single_parcel",
    sourceIdFields: ["FID"],
    zoningCodeFields: ["NEW_ZONING"],
    descriptionFields: [],
  });
  assert.equal(record.source_record_id, "single_parcel:42");
  assert.equal(record.zoning_code, "SF-7");
});
