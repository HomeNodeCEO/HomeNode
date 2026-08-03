import test from "node:test";
import assert from "node:assert/strict";
import {
  findDcadParcelsByAddress,
  refreshAccountLocations,
} from "../src/services/accountLocations.js";

test("official DCAD address lookup returns every exact situs parcel", async () => {
  let requestedWhere = "";
  const fetchImpl = async (_url, options) => {
    requestedWhere = new URLSearchParams(String(options.body)).get("where") || "";
    return {
      ok: true,
      async json() {
        return {
          features: [
            {
              attributes: {
                LOWPARCELID: "00000416188000000",
                PARCELID: "00000416188000000",
                SITEADDRESS: "10010 STRAIT LN",
                NGHBRHDCD: "5DSZ04",
                PRPRTYDSCRP: "BLK A/5530 LT 2 ACS 1.107",
                USEDSCRP: "Residential",
                RESFLRAREA: 0,
                LNDVALUE: 3321000,
                IMPVALUE: 0,
                CNTASSDVAL: 3321000,
              },
              geometry: {
                rings: [[
                  [-96.824, 32.881],
                  [-96.823, 32.881],
                  [-96.823, 32.882],
                  [-96.824, 32.881],
                ]],
              },
            },
            {
              attributes: {
                LOWPARCELID: "005530000001A0000",
                PARCELID: "005530000001A0000",
                SITEADDRESS: "10010 STRAIT LN",
                RESFLRAREA: 12421,
              },
              geometry: {
                rings: [[
                  [-96.825, 32.881],
                  [-96.824, 32.881],
                  [-96.824, 32.882],
                  [-96.825, 32.881],
                ]],
              },
            },
            {
              attributes: {
                LOWPARCELID: "99999999999999999",
                PARCELID: "99999999999999999",
                SITEADDRESS: "10012 STRAIT LN",
              },
            },
          ],
        };
      },
    };
  };

  const result = await findDcadParcelsByAddress(
    "10010 Strait Lane, Dallas, TX 75229",
    { fetchImpl },
  );
  assert.equal(requestedWhere, "SITEADDRESS = '10010 STRAIT LN'");
  assert.equal(result.parcels.length, 2);
  assert.deepEqual(
    result.parcels.map((parcel) => parcel.account_id),
    ["00000416188000000", "005530000001A0000"],
  );
  assert.equal(result.parcels[0].land_value, 3321000);
  assert.equal(typeof result.parcels[0].latitude, "number");
});

test("DCAD related parcel lookup requires a full numbered address", async () => {
  await assert.rejects(
    () => findDcadParcelsByAddress("STRAIT LN", { fetchImpl: async () => null }),
    /invalid_dcad_site_address/,
  );
});

test("account location refresh retries a transient DCAD GIS failure", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error("temporary network failure");
    return {
      ok: true,
      async json() {
        return {
          features: [{
            attributes: {
              LOWPARCELID: "005530000001A0000",
              PARCELID: "005530000001A0000",
              SITEADDRESS: "10010 STRAIT LN",
              RESFLRAREA: 12421,
            },
            geometry: {
              rings: [[
                [-96.825, 32.881],
                [-96.824, 32.881],
                [-96.824, 32.882],
                [-96.825, 32.881],
              ]],
            },
          }],
        };
      },
    };
  };
  const queryCalls = [];
  const pool = {
    async query(sql, params) {
      queryCalls.push({ sql, params });
      return { rows: [] };
    },
  };

  const summary = await refreshAccountLocations(
    pool,
    [{
      account_id: "005530000001A0000",
      address: "10010 STRAIT LN, DALLAS, TX 75229",
      county: "Dallas",
    }],
    {
      fetchImpl,
      retryDelayMs: 0,
      sleepImpl: async () => {},
    },
  );

  assert.equal(fetchCalls, 2);
  assert.equal(summary.retries, 1);
  assert.equal(summary.matched, 1);
  assert.ok(queryCalls.length >= 2);
});
