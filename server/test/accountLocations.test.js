import test from "node:test";
import assert from "node:assert/strict";
import {
  accountLocationInternals,
  findDcadParcelsByAddress,
  refreshAccountLocations,
} from "../src/services/accountLocations.js";

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function testPool() {
  const queryCalls = [];
  return {
    queryCalls,
    pool: {
      async query(sql, params) {
        queryCalls.push({ sql, params });
        return { rows: [] };
      },
    },
  };
}

test("official DCAD address lookup returns every exact situs parcel", async () => {
  let requestedWhere = "";
  const fetchImpl = async (_url, options) => {
    requestedWhere = new URLSearchParams(String(options.body)).get("where") || "";
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.equal(
      options.headers["content-type"],
      "application/x-www-form-urlencoded",
    );
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return jsonResponse({
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
    });
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

test("official DCAD address lookup rejects and cancels oversized responses", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(
        accountLocationInternals.MAX_DCAD_RESPONSE_BYTES + 1,
      ));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    () => findDcadParcelsByAddress("10010 Strait Ln", {
      fetchImpl: async () => new Response(body),
    }),
    { message: "dcad_parcel_address_query_response_too_large" },
  );
  assert.equal(cancelled, true);
});

test("official DCAD address lookup sanitizes provider errors", async () => {
  const providerMessage = "sensitive upstream query diagnostics";
  await assert.rejects(
    () => findDcadParcelsByAddress("10010 Strait Ln", {
      fetchImpl: async () => jsonResponse({
        error: { code: 400, message: providerMessage },
      }),
    }),
    (error) => {
      assert.equal(error.message, "dcad_parcel_address_query_400");
      assert.equal(error.message.includes(providerMessage), false);
      return true;
    },
  );
});

test("official DCAD address lookup refuses to follow redirects", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () => findDcadParcelsByAddress("10010 Strait Ln", {
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        assert.equal(options.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/internal" },
        });
      },
    }),
    { message: "dcad_parcel_address_query_http_302" },
  );
  assert.equal(fetchCalls, 1);
});

test("account location refresh retries a transient DCAD GIS failure", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error("temporary network failure");
    return jsonResponse({
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
    });
  };
  const { pool, queryCalls } = testPool();

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

test("account location refresh sanitizes DCAD transport errors", async () => {
  const { pool } = testPool();
  const transportMessage = "socket detail containing a private hostname";
  await assert.rejects(
    () => refreshAccountLocations(
      pool,
      [{
        account_id: "005530000001A0000",
        address: "10010 STRAIT LN, DALLAS, TX 75229",
        county: "Dallas",
      }],
      {
        fetchImpl: async () => {
          throw new Error(transportMessage);
        },
        maximumAttempts: 1,
      },
    ),
    (error) => {
      assert.equal(error.message, "dcad_parcel_query_unavailable");
      assert.equal(error.message.includes(transportMessage), false);
      return true;
    },
  );
});

test("account location refresh rejects oversized declared DCAD responses", async () => {
  const { pool } = testPool();
  await assert.rejects(
    () => refreshAccountLocations(
      pool,
      [{
        account_id: "005530000001A0000",
        address: "10010 STRAIT LN, DALLAS, TX 75229",
        county: "Dallas",
      }],
      {
        fetchImpl: async (_url, options) => {
          assert.equal(options.redirect, "manual");
          return new Response("[]", {
            headers: {
              "content-length": String(
                accountLocationInternals.MAX_DCAD_RESPONSE_BYTES + 1,
              ),
            },
          });
        },
        maximumAttempts: 1,
      },
    ),
    { message: "dcad_parcel_query_response_too_large" },
  );
});
