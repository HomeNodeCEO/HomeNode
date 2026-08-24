import assert from "node:assert/strict";
import test from "node:test";

import { CURRENT_UAD_RELEASE_KEY } from "../src/modules/uad/constants.js";
import { loadSyntheticUadWorkfileFixture } from "../scripts/lib/uadSyntheticWorkfileFixture.js";

test("the canonical synthetic UAD fixture is complete, ordered, and checksum-locked", async () => {
  const fixture = await loadSyntheticUadWorkfileFixture();
  assert.equal(fixture.format, "homenode_uad_synthetic_fixture_v1");
  assert.equal(fixture.specification_release_key, CURRENT_UAD_RELEASE_KEY);
  assert.equal(fixture.source.classification, "synthetic_only");
  assert.equal(fixture.counts.entities, 75);
  assert.equal(fixture.counts.field_values, 439);
  assert.equal(fixture.counts.sales_comparables, 1);
  assert.equal(fixture.entities.filter((entity) => entity.entity_type === "sales_comparable").length, 1);
  assert.equal(fixture.field_values.some((value) => value.field_context === "sales_comparison_summary"
    && value.uad_uid === "1300.0006" && value.value === 445000), true);
  assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
});
