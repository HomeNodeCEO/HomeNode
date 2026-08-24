import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRedTeamSalesFixtures,
  REDTEAM_COMPARABLE_COUNT,
  REDTEAM_RECONCILIATION_COUNT,
} from "../src/security/redTeamSalesFixtures.js";

test("builds a bounded sales-rich synthetic comparable population", () => {
  const fixtures = buildRedTeamSalesFixtures();
  assert.equal(fixtures.comparables.length, REDTEAM_COMPARABLE_COUNT);
  assert.equal(fixtures.reconciliation.length, REDTEAM_RECONCILIATION_COUNT);
  assert.ok(fixtures.comparables.length >= 30);
  assert.equal(
    new Set(fixtures.comparables.map((fixture) => fixture.account_id)).size,
    fixtures.comparables.length,
  );
  assert.ok(fixtures.comparables.every(
    (fixture) => /^UAD-REDTEAM-COMP-[0-9]{4}$/.test(fixture.account_id),
  ));
  assert.ok(fixtures.comparables.every(
    (fixture) => fixture.sale_price > 0 && fixture.living_area > 0 && fixture.site_size > 0,
  ));
  assert.ok(new Set(fixtures.comparables.map((fixture) => fixture.close_date.slice(0, 7))).size >= 12);
  assert.ok(new Set(fixtures.comparables.map((fixture) => fixture.condition_rating)).size >= 4);
  assert.ok(new Set(fixtures.comparables.map((fixture) => fixture.quality_rating)).size >= 3);
  assert.ok(fixtures.comparables.some((fixture) => fixture.pool));
  assert.ok(fixtures.comparables.some((fixture) => !fixture.pool));
});

test("keeps reconciliation evidence synthetic and intentionally unresolved", () => {
  const fixtures = buildRedTeamSalesFixtures();
  assert.ok(fixtures.reconciliation.every(
    (fixture) => fixture.listing_id.startsWith("RT-RECON-")
      && fixture.parcel_number_raw.startsWith("RT-UNRESOLVED-"),
  ));
  assert.ok(fixtures.reconciliation.every(
    (fixture) => fixture.address.includes("Synthetic") && fixture.sale_price > 0,
  ));
});
