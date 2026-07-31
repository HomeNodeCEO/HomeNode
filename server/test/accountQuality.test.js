import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanonicalAccountId } from "../src/services/accountQuality.js";


test("resolveCanonicalAccountId follows a legacy alias", async () => {
  const aliases = new Map([
    ["28208500000000000", "28208500120070000"],
    ["28208500120070000", null],
  ]);
  const pool = {
    async query(_sql, params) {
      return { rows: [{ canonical_account_id: aliases.get(params[0]) || null }] };
    },
  };

  assert.equal(
    await resolveCanonicalAccountId(pool, "28208500000000000"),
    "28208500120070000",
  );
});

test("resolveCanonicalAccountId stops safely on an alias cycle", async () => {
  const aliases = new Map([
    ["AAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBB"],
    ["BBBBBBBBBBBBBBBBB", "AAAAAAAAAAAAAAAAA"],
  ]);
  const pool = {
    async query(_sql, params) {
      return { rows: [{ canonical_account_id: aliases.get(params[0]) || null }] };
    },
  };

  assert.equal(
    await resolveCanonicalAccountId(pool, "AAAAAAAAAAAAAAAAA"),
    "AAAAAAAAAAAAAAAAA",
  );
});
