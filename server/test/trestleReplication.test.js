import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureTrestleReplicationSchema,
  mapTrestleSourceRecord,
  resolveTrestleAccountMatches,
  runTrestlePropertyReplication,
} from "../src/services/trestleReplication.js";

test("RESO Property maps to the existing sale inventory without losing zero and false", () => {
  const mapped = mapTrestleSourceRecord({
    ListingKey: "NTREIS-1",
    ListingId: "21062330",
    OriginatingSystemName: "NTREIS",
    StandardStatus: "Closed",
    ModificationTimestamp: "2026-08-18T12:30:00Z",
    PhotosChangeTimestamp: "2026-08-18T12:00:00Z",
    PhotosCount: 12,
    UnparsedAddress: "1704 Novel Cir",
    City: "Garland",
    CountyOrParish: "Dallas",
    StateOrProvince: "TX",
    PostalCode: "75040",
    ParcelNumber: "26272500060150000",
    BedroomsTotal: 3,
    BathroomsFull: 2,
    BathroomsHalf: 1,
    LivingArea: 1760,
    LotSizeSquareFeet: 8000,
    ClosePrice: 325000,
    ListPrice: 330000,
    CloseDate: "2026-08-01",
    GarageSpaces: 0,
    PoolPrivateYN: false,
    PropertyAttachedYN: false,
    PropertySubType: "Single Family Residence",
    Latitude: 32.9,
    Longitude: -96.65,
  });

  assert.equal(mapped.listing_key, "NTREIS-1");
  assert.equal(mapped.record_type, "closed_sale");
  assert.equal(mapped.current_price, 325000);
  assert.equal(mapped.garage_spaces, 0);
  assert.equal(mapped.garage_yn, false);
  assert.equal(mapped.pool_yn, false);
  assert.equal(mapped.attachment_type, "detached");
  assert.equal(mapped.photos_count, 12);
  assert.equal(mapped.data_quality_flags.length, 0);
  assert.equal(mapped.raw_payload.ListingId, "21062330");
});

test("non-closed statuses remain listings and incomplete records are reviewable, not excluded", () => {
  const mapped = mapTrestleSourceRecord({
    ListingKey: "NTREIS-2",
    ListingId: "22000001",
    StandardStatus: "Active",
    ModificationTimestamp: "2026-08-18T12:30:00Z",
    ListPrice: 400000,
    PoolPrivateYN: false,
  });
  assert.equal(mapped.record_type, "listing");
  assert.equal(mapped.current_price, 400000);
  assert.deepEqual(
    mapped.data_quality_flags.sort(),
    ["missing_parcel_number", "missing_property_address"],
  );
});

test("Collin parcel identity tolerates an omitted R prefix and punctuation", () => {
  const mapped = mapTrestleSourceRecord({
    ListingKey: "NTREIS-COLLIN-1",
    StandardStatus: "Active",
    ModificationTimestamp: "2026-08-18T12:30:00Z",
    CountyOrParish: "Collin County",
    ParcelNumber: "1234-567-890",
    UnparsedAddress: "1 Test Ct",
    City: "Plano",
  });
  assert.equal(mapped.parcel_key, "1234567890");
});

test("schema uses ListingKey for uniqueness and creates durable cursor and media queues", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };
  await ensureTrestleReplicationSchema(pool);
  const schema = statements.join("\n");
  assert.match(schema, /DROP INDEX IF EXISTS core\.sales_source_records_listing_id_unique_idx/);
  assert.match(schema, /sales_source_records_listing_key_unique_idx/);
  assert.match(schema, /app\.trestle_replication_state/);
  assert.match(schema, /app\.trestle_replication_runs/);
  assert.match(schema, /app\.trestle_media_queue/);
  assert.match(schema, /gis\.property_influence_queue/);
});

test("account matching sends parcel and exact address evidence in one batch", async () => {
  let captured = null;
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return {
        rows: [{ listing_key: "NTREIS-3", account_id: "A-100", match_status: "normalized" }],
      };
    },
  };
  const result = await resolveTrestleAccountMatches(pool, [{
    listing_key: "NTREIS-3",
    parcel_number_raw: "A 100",
    parcel_key: "A100",
    address_key: "100 MAIN ST",
    city_key: "DALLAS",
    county_key: "DALLAS",
  }]);
  assert.deepEqual(result.get("NTREIS-3"), {
    account_id: "A-100",
    match_status: "normalized",
  });
  assert.match(captured.sql, /JSONB_TO_RECORDSET/);
  assert.match(captured.sql, /HAVING COUNT\(DISTINCT account_id\) = 1/);
  assert.equal(JSON.parse(captured.params[0])[0].parcel_key, "A100");
});

test("replication remains inert without credentials and explicit feed activation", async () => {
  let databaseCalls = 0;
  const pool = { async query() { databaseCalls += 1; } };
  const result = await runTrestlePropertyReplication(pool, {
    status: () => ({ configured: false, enabled: false, replication_ready: false }),
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "trestle_credentials_missing");
  assert.equal(databaseCalls, 0);
});

test("replication follows pages, advances the durable cursor, and aggregates outcomes", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
      if (/SELECT cursor_timestamp FROM app\.trestle_replication_state/.test(sql)) {
        return { rows: [{ cursor_timestamp: "2026-08-18T00:00:00Z" }] };
      }
      if (/INSERT INTO app\.trestle_replication_runs/.test(sql)) {
        return { rows: [{ id: 77 }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const pageRequests = [];
  const trestleClient = {
    config: {
      maximumPages: 10,
      pageSize: 1000,
      initialLookbackDays: 730,
      overlapMinutes: 10,
    },
    lastQuota: { hour_remaining: "900" },
    status: () => ({ configured: true, enabled: true, replication_ready: true }),
    async propertyChangesPage(request) {
      pageRequests.push(request);
      return pageRequests.length === 1
        ? {
          value: [{ ListingKey: "A", ModificationTimestamp: "2026-08-18T01:00:00Z" }],
          "@odata.nextLink": "https://api.cotality.com/trestle/odata/Property?$skip=1000",
        }
        : {
          value: [{ ListingKey: "B", ModificationTimestamp: "2026-08-18T02:00:00Z" }],
        };
    },
  };
  const batches = [];
  const result = await runTrestlePropertyReplication(pool, trestleClient, {
    now: () => new Date("2026-08-19T00:00:00Z"),
    persistBatch: async (_pool, records) => {
      batches.push(records);
      return {
        received: records.length,
        upserted: records.length,
        rejected: [],
        matched: records.length,
        unmatched: 0,
        mediaQueued: records.length,
        canonicalSales: records.length,
      };
    },
    logger: { info() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.run_id, 77);
  assert.equal(result.pages, 2);
  assert.equal(result.upserted, 2);
  assert.equal(result.cursor_completed_at, "2026-08-18T02:00:00.000Z");
  assert.equal(pageRequests[0].modifiedAfter, "2026-08-17T23:50:00.000Z");
  assert.equal(pageRequests[1].nextLink.includes("$skip=1000"), true);
  assert.deepEqual(batches.map((batch) => batch[0].ListingKey), ["A", "B"]);
  assert.equal(statements.some((sql) => /pg_advisory_unlock/.test(sql)), true);
});

