import assert from "node:assert/strict";
import test from "node:test";

import { ensurePropertyContextSchema } from "../src/services/propertyContextStore.js";

test("property context schema retains influence versions and queues changed sales", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };

  await ensurePropertyContextSchema(pool);
  const schemaSql = statements.join("\n");
  assert.match(schemaSql, /property_influence_context_versions/);
  assert.match(schemaSql, /queue_property_influence_for_sale/);
  assert.match(schemaSql, /UPDATE OF primary_account_id ON core\.sales_source_records/);
  assert.match(schemaSql, /NEW\.record_type = ''closed_sale''/);
  assert.match(schemaSql, /UPDATE OF account_id ON core\.sales/);
  assert.doesNotMatch(schemaSql, /DROP TRIGGER/);
});
