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
  assert.equal(calls.length, 8);
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
