import assert from "node:assert/strict";
import test from "node:test";

import { verifyUadSuccessfulDelivery } from "../scripts/verifyUadSuccessfulDelivery.js";
import { requireSalesRichUadDelivery } from "../scripts/lib/uadSalesDeliveryEvidence.js";
import { uadSalesRichEditorFixture } from "./fixtures/uadNativePdfFixture.js";

test("builds a deterministic schema-valid signed synthetic UAD delivery package", async () => {
  const evidence = await verifyUadSuccessfulDelivery();

  assert.equal(evidence.ok, true);
  assert.equal(evidence.fixture.synthetic_only, true);
  assert.equal(evidence.fixture.workfile_status, "signed");
  assert.equal(evidence.xml.schema_valid, true);
  assert.equal(evidence.xml.schema_error_count, 0);
  assert.equal(evidence.xml.image_reference_count, 8);
  assert.equal(evidence.sales_comparison.comparable_count, 3);
  assert.equal(evidence.sales_comparison.settled_sale_count, 3);
  assert.equal(evidence.sales_comparison.adjusted_comparable_count, 3);
  assert.equal(evidence.sales_comparison.nonzero_adjustment_count, 6);
  assert.equal(evidence.sales_comparison.calculation_consistent_count, 3);
  assert.equal(evidence.sales_comparison.sales_reconciliation_present, true);
  assert.equal(evidence.xml.sales_comparable_count, 3);
  assert.equal(evidence.xml.adjustment_count, 6);
  assert.equal(evidence.xml.reconciliation_count, 1);
  assert.ok(evidence.pdf.page_count > 0);
  assert.equal(evidence.pdf.signer_count, 1);
  assert.equal(evidence.pdf.rendered_asset_count, 8);
  assert.ok(evidence.pdf.sales_comparable_group_count >= 3);
  assert.equal(evidence.manifest.private_object_keys_excluded, true);
  assert.equal(evidence.package.deterministic, true);
  assert.equal(evidence.package.entries.length, 10);
  assert.ok(evidence.package.entries.some((entry) => entry.endsWith("subject-street-scene.png")));
  assert.ok(evidence.package.entries.some((entry) => entry.endsWith("subject-rear.png")));
  assert.ok(evidence.package.entries.some((entry) => entry.endsWith("subject-property.png")));
  assert.ok(evidence.package.entries.some((entry) => entry.endsWith("sales-comparable-map.png")));
  assert.ok(evidence.package.entries.includes("UAD-STAGING-SFR-0001.pdf"));
  assert.ok(evidence.package.entries.includes("UAD-STAGING-SFR-0001.xml"));
});

test("rejects a delivery fixture when sales, adjustments, or reconciliation are absent", () => {
  const withoutSales = uadSalesRichEditorFixture();
  withoutSales.entities = [];
  withoutSales.values = withoutSales.values.filter((value) => (
    value.context_key !== "sales_comparison_reconciliation"
    && !value.context_key.startsWith("sales_comparable")
  ));
  assert.throws(
    () => requireSalesRichUadDelivery(withoutSales),
    /insufficient_sales_comparables.*insufficient_settled_sales.*comparables_without_nonzero_adjustments.*sales_reconciliation_missing/,
  );
});

test("rejects inconsistent adjusted-price calculations", () => {
  const editor = uadSalesRichEditorFixture();
  const comparable = editor.entities.find((entity) => entity.entity_type === "sales_comparable");
  const adjustedPrice = editor.values.find((value) => (
    value.entity_id === comparable.id
    && value.context_key === "sales_comparable_summary"
    && value.uid === "1800.0309"
  ));
  adjustedPrice.value += 1;
  assert.throws(() => requireSalesRichUadDelivery(editor), /sales_calculation_mismatch/);
});
