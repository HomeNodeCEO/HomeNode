import assert from "node:assert/strict";
import test from "node:test";

import {
  failPropertyInfluenceQueueItem,
  getPropertyInfluenceStatus,
  propertyInfluenceFailureCode,
  seedPropertyInfluenceQueue,
} from "../src/services/propertyInfluenceStore.js";

test("influence queue stores bounded failure codes rather than raw exception text", async () => {
  const privateDetail = "password in a private database connection URL";
  const statements = [];
  const pool = {
    async query(sql, params) {
      statements.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const outcome = await failPropertyInfluenceQueueItem(pool, {
    accountId: "26272500060150000",
    attempts: 1,
    error: new Error(privateDetail),
  });
  assert.equal(outcome, "retry");
  assert.equal(statements[0].params[3], "property_influence_failed");
  assert.equal(JSON.stringify(statements).includes(privateDetail), false);

  assert.equal(propertyInfluenceFailureCode({ code: "57014", message: privateDetail }), "57014");
  assert.equal(propertyInfluenceFailureCode({ code: "not-safe", message: privateDetail }), "property_influence_failed");
});

test("influence coverage reports current migration and unmatched MLS records separately", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("WITH queue AS")) {
        return {
          rows: [{
            queue: { pending: 7, completed: 3 },
            sale_account_count: 10,
            measured_sale_account_count: 3,
            prior_version_sale_account_count: 6,
            unmatched_closed_sale_record_count: 4,
            version_coverage: { 2: 6, 3: 3 },
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const status = await getPropertyInfluenceStatus(pool);
  assert.equal(status.current_methodology_version, 3);
  assert.equal(status.coverage.coverage_percent, 30);
  assert.equal(status.migration.prior_version_sale_account_count, 6);
  assert.equal(status.migration.recalculation_in_progress, true);
  assert.equal(status.unmatched_sales.review_required_record_count, 4);
  assert.equal(status.unmatched_sales.included_in_account_coverage, false);
  assert.match(
    statements.find((sql) => sql.includes("WITH queue AS")),
    /source\.record_type = 'closed_sale'/,
  );
});

test("influence seeding prioritizes missing current-version sale contexts", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };

  await seedPropertyInfluenceQueue(pool, { limit: 500 });

  const seedSql = statements.find((sql) => sql.includes("WITH influence_source_state AS"));
  assert.match(seedSql, /initial_influence_coverage/);
  assert.match(
    seedSql,
    /context\.account_id IS NULL OR context\.methodology_version < \$2\) DESC/,
  );
  assert.match(seedSql, /prioritized\.priority \+ CASE/);
});
