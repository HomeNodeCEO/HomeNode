import assert from "node:assert/strict";
import test from "node:test";
import { loadAccountDetailSections } from "../src/services/accountDetailSections.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("account detail sections launch independent indexed lookups concurrently", async () => {
  const calls = [];
  const pending = [];
  const pool = {
    query(sql, params) {
      const request = deferred();
      calls.push({ sql, params });
      pending.push(request);
      return request.promise;
    },
  };

  const loading = loadAccountDetailSections(pool, "26572500130160000");
  assert.equal(calls.length, 9);
  assert.ok(calls.every((call) => call.params[0] === "26572500130160000"));

  const responses = [
    [{ living_area_sqft: 1800 }],
    [{ housing_type: "Single Family Detached" }],
    [{ owner_name: "OWNER", owner_parties: [{ owner_name: "OWNER" }] }],
    [{ legal_text: "LOT 1" }],
    [{ legal_text: "PRIOR LOT" }],
    [
      { tax_year: 2026, homestead_exemption: "100000" },
      { tax_year: 2026, homestead_exemption: "0" },
      { tax_year: 2025, homestead_exemption: "90000" },
    ],
    [{ number: 1, area_sqft: 9000 }],
    [{ number: 1, improvement_type: "Attached Garage" }],
    [],
  ];
  pending.forEach((request, index) => request.resolve({ rows: responses[index] }));

  const result = await loading;
  assert.equal(result.primaryImprovement.living_area_sqft, 1800);
  assert.equal(result.housingProfile.housing_type, "Single Family Detached");
  assert.equal(result.owner.owner_name, "OWNER");
  assert.equal(result.exemptionYear, 2026);
  assert.equal(result.exemptions.length, 2);
  assert.equal(result.homesteadYes, true);
  assert.equal(result.landRows.length, 1);
  assert.equal(result.additionalImprovements.length, 1);

  const landCalls = calls.filter((call) => /FROM core\.land_detail/.test(call.sql));
  assert.equal(landCalls.length, 1);
  assert.match(landCalls[0].sql, /SELECT MAX\(latest\.tax_year\)/);
});

test("latest raw DCAD snapshot fills normalized CAD fields that are still blank", async () => {
  const pool = {
    query(sql) {
      if (/FROM core\.primary_improvements/.test(sql)) {
        return Promise.resolve({ rows: [{ living_area_sqft: 1812, building_class: null }] });
      }
      if (/FROM core\.owner_summary/.test(sql)) {
        return Promise.resolve({ rows: [{
          owner_name: null,
          mailing_address: null,
          tax_year: 2026,
          owner_parties: [],
        }] });
      }
      if (/FROM core\.legal_description_current/.test(sql)) {
        return Promise.resolve({ rows: [{ legal_text: "LOT 19", deed_transfer_date: null }] });
      }
      if (/FROM core\.dcad_json_raw/.test(sql)) {
        return Promise.resolve({ rows: [{
          tax_year: 2026,
          detail: {
            primary_improvements: { living_area_sqft: 1700, building_class: null },
            owner: {
              owner_name: null,
              mailing_address: "1402 AARON PL, DUNCANVILLE, TX 75137",
              multi_owner: [{ owner_name: "AARON PLACE OWNER", ownership_pct: "100%" }],
            },
            legal_description: {
              lines: ["LOT 19"],
              deed_transfer_date: "2020-05-14",
            },
            land_detail: [{ number: 1, zoning: "PD, Planned Development District" }],
          },
          source_attributes: {
            OWNERNME1: "AARON PLACE OWNER",
            PSTLADDRESS: "1402 AARON PL",
            PSTLCITY: "DUNCANVILLE",
            PSTLSTATE: "TX",
            PSTLZIP5: "75137",
            PSTLZIP4: "4907",
            STRCLASS: "14",
          },
        }] });
      }
      if (/FROM core\.land_detail/.test(sql)) {
        return Promise.resolve({ rows: [{ number: 1, area_sqft: 9000, zoning: null }] });
      }
      return Promise.resolve({ rows: [] });
    },
  };

  const result = await loadAccountDetailSections(pool, "221508800I0190000");
  assert.equal(result.primaryImprovement.living_area_sqft, 1812);
  assert.equal(result.primaryImprovement.building_class, "14");
  assert.equal(result.owner.owner_name, "AARON PLACE OWNER");
  assert.equal(result.owner.mailing_address, "1402 AARON PL, DUNCANVILLE, TX 75137");
  assert.equal(result.owner.owner_parties[0].ownership_pct, "100%");
  assert.equal(result.legalCurrent.legal_text, "LOT 19");
  assert.equal(result.legalCurrent.deed_transfer_date, "2020-05-14");
  assert.equal(result.landRows[0].area_sqft, 9000);
  assert.equal(result.landRows[0].zoning, "PD, Planned Development District");
});

test("missing historical fields use the official DCAD parcel fallback", async () => {
  const pool = {
    query(sql) {
      if (/FROM core\.primary_improvements/.test(sql)) {
        return Promise.resolve({ rows: [{ building_class: null }] });
      }
      if (/FROM core\.owner_summary/.test(sql)) {
        return Promise.resolve({ rows: [{ owner_name: null, owner_parties: [] }] });
      }
      if (/FROM core\.dcad_json_raw/.test(sql)) {
        return Promise.resolve({ rows: [{ tax_year: 2026, detail: {}, source_attributes: {} }] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  const fetchCalls = [];
  const result = await loadAccountDetailSections(pool, "221508800I0190000", {
    fetchImpl: async (_url, options) => {
      fetchCalls.push(options);
      return {
        ok: true,
        json: async () => ({ features: [{ attributes: {
          STRCLASS: "14",
          OWNERNME1: "LAM DUNG LY",
          PSTLADDRESS: "1402 AARON PL",
          PSTLCITY: "DUNCANVILLE",
          PSTLSTATE: "TX",
          PSTLZIP5: "75137",
          PSTLZIP4: "4907",
        } }] }),
      };
    },
  });

  assert.equal(fetchCalls.length, 1);
  assert.match(String(fetchCalls[0].body), /221508800I0190000/);
  assert.equal(result.primaryImprovement.building_class, "14");
  assert.equal(result.owner.owner_name, "LAM DUNG LY");
  assert.equal(result.owner.owner_parties[0].ownership_pct, null);
  assert.equal(result.owner.mailing_address, "1402 AARON PL, DUNCANVILLE, TX 75137-4907");
});
test("optional land and secondary-improvement failures preserve the account response", async () => {
  const errors = [];
  const pool = {
    query(sql) {
      if (/FROM core\.land_detail/.test(sql)) return Promise.reject(new Error("land unavailable"));
      if (/FROM core\.secondary_improvements/.test(sql)) {
        return Promise.reject(new Error("secondary unavailable"));
      }
      return Promise.resolve({ rows: [] });
    },
  };

  const result = await loadAccountDetailSections(pool, "ACCOUNT", {
    logger: { error: (...args) => errors.push(args) },
    fetchImpl: async () => { throw new Error("should not query for a non-DCAD id"); },
  });

  assert.deepEqual(result.landRows, []);
  assert.deepEqual(result.additionalImprovements, []);
  assert.equal(errors.length, 2);
});

test("required section failures still fail the account request", async () => {
  const pool = {
    query(sql) {
      if (/FROM core\.owner_summary/.test(sql)) return Promise.reject(new Error("owner failed"));
      return Promise.resolve({ rows: [] });
    },
  };

  await assert.rejects(
    () => loadAccountDetailSections(pool, "ACCOUNT", { logger: { error() {} } }),
    /owner failed/,
  );
});
