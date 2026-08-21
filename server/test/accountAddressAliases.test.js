import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAddressAliasEvidence,
  resolveUniqueAddressAliases,
} from "../src/services/accountAddressAliases.js";

test("account alias evidence normalizes suffixes, county, and ZIP", () => {
  assert.deepEqual(normalizeAddressAliasEvidence({
    address: "3901 Greensboro Circle",
    city: "Garland (Dallas Co)",
    county: "Dallas County",
    postalCode: "75041-4947",
  }), {
    address_key: "3901 GREENSBORO CIR",
    city_key: "GARLAND",
    county_key: "DALLAS",
    postal_code5: "75041",
  });
});

test("address alias resolver sends all geographic safeguards to indexed lookup", async () => {
  const pool = {
    async query(sql, params) {
      const statement = String(sql);
      assert.match(statement, /app\.account_address_aliases/);
      assert.match(statement, /alias\.is_current = true/);
      assert.match(statement, /HAVING COUNT\(DISTINCT account_id\) = 1/);
      const requested = JSON.parse(params[0]);
      assert.deepEqual(requested[0], {
        request_id: "44",
        address_key: "3901 GREENSBORO CIR",
        city_key: "GARLAND",
        county_key: "DALLAS",
        postal_code5: "75041",
      });
      return { rows: [{ request_id: "44", account_id: "26572500130160000" }] };
    },
  };
  const result = await resolveUniqueAddressAliases(pool, [{
    request_id: "44",
    address_key: "3901 GREENSBORO CIR",
    city_key: "GARLAND",
    county_key: "DALLAS",
    postal_code5: "75041",
  }]);
  assert.equal(result.get("44"), "26572500130160000");
});

