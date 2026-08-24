import assert from "node:assert/strict";
import test from "node:test";

import { buildMarketConditionsAnalyses } from "../src/services/marketConditions.js";
import { buildPairedSalesStudy } from "../src/services/pairedSalesAnalysis.js";
import { buildRegressionStudy } from "../src/services/regressionAnalysis.js";
import { buildSiteValuationStudy } from "../src/services/siteValuation.js";

const SYNTHETIC_ACCOUNT_ID = "UAD-REDTEAM-SFR-0001";
const allowSyntheticAccount = (value) => value === SYNTHETIC_ACCOUNT_ID;

function createAnalysisPool() {
  const statements = [];
  return {
    statements,
    async query(sql) {
      const statement = String(sql);
      statements.push(statement);
      if (/SELECT\s+account\.account_id/.test(statement)) {
        return {
          rows: [{
            account_id: SYNTHETIC_ACCOUNT_ID,
            address: "300 Red Team Test Dr",
            city: "Garland",
            county: "Dallas",
            postal_code: "75044",
            neighborhood_code: "RT-001",
            latitude: 32.95,
            longitude: -96.65,
            location_status: "matched",
            location_source: "redteam_fixture",
          }],
        };
      }
      if (/FROM core\.v_account_housing_profiles/.test(statement)) {
        return {
          rows: [{
            housing_type: "Single Family Detached",
            attachment_type: "Detached",
            architectural_style: "Traditional",
          }],
        };
      }
      if (/SELECT SUM\(area_sqft\)::numeric AS site_size_sqft/.test(statement)) {
        return { rows: [{ site_size_sqft: "8000" }] };
      }
      return { rows: [] };
    },
  };
}

const studies = [
  [
    "paired-sales",
    (pool, accountIdAllowed) => buildPairedSalesStudy(pool, {
      subjectAccountId: SYNTHETIC_ACCOUNT_ID,
      marketKey: "city",
      asOfDate: "2026-08-24",
      accountIdAllowed,
    }),
  ],
  [
    "market-conditions",
    (pool, accountIdAllowed) => buildMarketConditionsAnalyses(pool, {
      subjectAccountId: SYNTHETIC_ACCOUNT_ID,
      areaKeys: ["city"],
      asOfDate: "2026-08-24",
      periodMonths: 12,
      accountIdAllowed,
    }),
  ],
  [
    "regression",
    (pool, accountIdAllowed) => buildRegressionStudy(pool, {
      subjectAccountId: SYNTHETIC_ACCOUNT_ID,
      marketKey: "city",
      asOfDate: "2026-08-24",
      accountIdAllowed,
    }),
  ],
  [
    "site-valuation",
    (pool, accountIdAllowed) => buildSiteValuationStudy(pool, {
      subjectAccountId: SYNTHETIC_ACCOUNT_ID,
      marketKey: "city",
      asOfDate: "2026-08-24",
      accountIdAllowed,
    }),
  ],
];

for (const [name, buildStudy] of studies) {
  test(`${name} preserves the strict production account-id policy`, async () => {
    const pool = createAnalysisPool();
    await assert.rejects(() => buildStudy(pool), /invalid_subject_account_id/);
    assert.equal(pool.statements.length, 0);
  });

  test(`${name} accepts an explicitly injected isolated account-id policy`, async () => {
    const pool = createAnalysisPool();
    const result = await buildStudy(pool, allowSyntheticAccount);
    assert.equal(result.subject.account_id ?? result.subject.accountId, SYNTHETIC_ACCOUNT_ID);
    assert.ok(pool.statements.some((statement) => /core\.accounts account/.test(statement)));
  });
}
